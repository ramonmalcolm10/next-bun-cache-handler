/**
 * Bun-native **singular** `cacheHandler` for Next.js — the incremental cache used
 * for ISR pages, route handlers, and (the focus here) **optimized images** from
 * `next/image`. This is a different contract from the `"use cache"`
 * (`cacheHandlers`, plural) handler in `redis-handler.ts`.
 *
 * Next instantiates this as a class (`new Handler(ctx)`) and calls:
 *   - `get(key, ctx)   -> { lastModified, value } | null`
 *   - `set(key, data, ctx) -> void`           (`data === null` deletes)
 *   - `revalidateTag(tags, durations?)`
 *   - `resetRequestCache()`
 *
 * Image entries (`value.kind === "IMAGE"`) are `{ etag, upstreamEtag, buffer,
 * extension, revalidate }` — the `buffer` is stored as **raw binary** in Redis
 * via Bun's binary `SET`/`getBuffer` (no base64). Other kinds (APP_PAGE, PAGES,
 * APP_ROUTE, REDIRECT, FETCH) are stored too, JSON-serialized with Buffer/Map
 * support, so configuring this handler doesn't disable ISR/route caching.
 *
 * @see https://nextjs.org/docs/app/api-reference/config/next-config-js/incrementalCacheHandlerPath
 */

import { RedisClient } from "bun";
import type { RedisOptions } from "bun";

import type { Compression } from "./types";
import { CODEC_NONE, codecToByte, compress, decompress } from "./compression";

const INFINITE_CACHE = 0xfffffffe;

const FRAME_VERSION = 1;
const HEADER_BYTES = 6;

/** What Next hands us as the cached value (the subset of fields we persist). */
interface AnyCacheValue {
  kind: string;
  [key: string]: unknown;
}

/** The object Next expects back from `get`. */
interface CacheHandlerValue {
  lastModified: number;
  value: AnyCacheValue | null;
}

export interface BunIncrementalCacheHandlerOptions {
  /** An existing `Bun.RedisClient`. If omitted, one is created from `url`. */
  client?: RedisClient;
  /** Connection URL. Defaults to `REDIS_URL` / `VALKEY_URL` / localhost. */
  url?: string;
  redisOptions?: RedisOptions;
  /** Prefix for incremental-cache keys. Default `"next:isr:"`. */
  keyPrefix?: string;
  /** Redis hash holding tag→revalidation-timestamp. Default `"next:isr:tags"`. */
  tagsKey?: string;
  /** TTL (seconds) for entries with no finite `revalidate`. Default `86400`. */
  defaultTTL?: number;
  /**
   * Compression for **non-image** payloads (HTML / RSC / route bodies), which
   * compress well. Images are always stored raw (already compressed).
   * Default `"none"`.
   */
  compression?: Compression;
  /** Non-image payloads below this many bytes are stored uncompressed. Default `1024`. */
  minCompressBytes?: number;
  debug?: boolean;
}

// --- Buffer/Map-aware JSON (de)serialization for non-image values ----------

function pack(input: unknown): unknown {
  if (input == null) return input;
  if (input instanceof Uint8Array) {
    return { __t: "B", d: Buffer.from(input).toString("base64") };
  }
  if (input instanceof Map) {
    return { __t: "M", e: [...input.entries()].map(([k, v]) => [k, pack(v)]) };
  }
  if (Array.isArray(input)) return input.map(pack);
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input)) out[k] = pack(v);
    return out;
  }
  return input;
}

function unpack(input: unknown): unknown {
  if (input == null || typeof input !== "object") return input;
  const tagged = input as { __t?: string; d?: string; e?: [unknown, unknown][] };
  if (tagged.__t === "B") return Buffer.from(tagged.d ?? "", "base64");
  if (tagged.__t === "M") {
    return new Map((tagged.e ?? []).map(([k, v]) => [k, unpack(v)]));
  }
  if (Array.isArray(input)) return input.map(unpack);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = unpack(v);
  return out;
}

// --- Binary frame: [version][flags][uint32 metaLen][meta JSON][payload] -----

interface FrameMeta {
  k: string; // value.kind
  lm: number; // lastModified
  tags: string[];
  rev?: number; // revalidate seconds
  img?: { etag: string; upstreamEtag: string; extension: string };
}

// Frame: [version][codec][uint32 metaLen][meta JSON][payload].
// The payload holds the image buffer (raw) or the compressed non-image value.
function encodeFrame(meta: FrameMeta, payload: Uint8Array, codec: number): Uint8Array {
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));
  const frame = new Uint8Array(HEADER_BYTES + metaBytes.byteLength + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, FRAME_VERSION);
  view.setUint8(1, codec);
  view.setUint32(2, metaBytes.byteLength);
  frame.set(metaBytes, HEADER_BYTES);
  frame.set(payload, HEADER_BYTES + metaBytes.byteLength);
  return frame;
}

function decodeFrame(frame: Uint8Array): { meta: FrameMeta; payload: Uint8Array; codec: number } {
  if (frame.byteLength < HEADER_BYTES) throw new Error("isr frame too short");
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  if (view.getUint8(0) !== FRAME_VERSION) throw new Error("isr frame version");
  const codec = view.getUint8(1);
  const metaLen = view.getUint32(2);
  const metaStart = HEADER_BYTES;
  const payloadStart = metaStart + metaLen;
  const meta = JSON.parse(
    new TextDecoder().decode(frame.subarray(metaStart, payloadStart)),
  ) as FrameMeta;
  return { meta, payload: frame.subarray(payloadStart), codec };
}

/**
 * Build a Bun+Redis singular cache handler class. The returned class is what you
 * `export default` from the module referenced by `cacheHandler` in next.config.
 *
 * @example
 * // cache-handler-image.ts
 * import { createBunIncrementalCacheHandler } from "next-bun-cache-handler";
 * export default createBunIncrementalCacheHandler();
 */
export function createBunIncrementalCacheHandler(
  options: BunIncrementalCacheHandlerOptions = {},
) {
  const keyPrefix = options.keyPrefix ?? "next:isr:";
  const tagsKey = options.tagsKey ?? "next:isr:tags";
  const defaultTTL = options.defaultTTL ?? 86_400;
  const compression = options.compression ?? "none";
  const minCompressBytes = options.minCompressBytes ?? 1024;
  const debug = options.debug
    ? (...args: unknown[]) => console.debug("[next-bun-cache:isr]", ...args)
    : undefined;

  const url =
    options.url ??
    Bun.env.REDIS_URL ??
    Bun.env.VALKEY_URL ??
    "redis://localhost:6379";
  const redis = options.client ?? new RedisClient(url, options.redisOptions);

  const entryKey = (key: string) => `${keyPrefix}${key}`;

  const ttlFor = (revalidate: unknown): number | undefined => {
    if (typeof revalidate === "number" && revalidate > 0 && revalidate < INFINITE_CACHE) {
      return Math.ceil(revalidate);
    }
    return defaultTTL > 0 ? defaultTTL : undefined;
  };

  return class BunIncrementalCacheHandler {
    // Next constructs with a context object; we don't need it for Redis storage.
    constructor(_ctx?: unknown) {}

    async get(cacheKey: string, _ctx?: unknown): Promise<CacheHandlerValue | null> {
      let buf: Uint8Array | null;
      try {
        buf = await redis.getBuffer(entryKey(cacheKey));
      } catch (err) {
        debug?.("get", cacheKey, "redis error", err);
        return null;
      }
      if (!buf) {
        debug?.("get", cacheKey, "miss");
        return null;
      }

      let meta: FrameMeta;
      let payload: Uint8Array;
      let codec: number;
      try {
        ({ meta, payload, codec } = decodeFrame(buf));
      } catch (err) {
        debug?.("get", cacheKey, "decode error", err);
        return null;
      }

      // Hard tag invalidation: any tag revalidated after this entry was written
      // means the entry is stale — report a miss so Next regenerates.
      if (meta.tags.length > 0) {
        try {
          const stamps = await redis.hmget(tagsKey, meta.tags);
          for (const s of stamps) {
            if (s != null && Number(s) > meta.lm) {
              debug?.("get", cacheKey, "tag revalidated");
              return null;
            }
          }
        } catch (err) {
          debug?.("get", cacheKey, "tag check error", err);
        }
      }

      let body: Uint8Array;
      try {
        body = decompress(payload, codec);
      } catch (err) {
        debug?.("get", cacheKey, "decompress error", err);
        return null;
      }

      let value: AnyCacheValue;
      if (meta.img) {
        value = {
          kind: meta.k,
          etag: meta.img.etag,
          upstreamEtag: meta.img.upstreamEtag,
          buffer: Buffer.from(body),
          extension: meta.img.extension,
          revalidate: meta.rev,
        };
      } else {
        value = unpack(JSON.parse(new TextDecoder().decode(body))) as AnyCacheValue;
      }

      debug?.("get", cacheKey, "hit", { kind: meta.k });
      return { lastModified: meta.lm, value };
    }

    async set(cacheKey: string, data: AnyCacheValue | null, ctx?: { tags?: string[] }): Promise<void> {
      const key = entryKey(cacheKey);
      if (data == null) {
        try {
          await redis.del(key);
        } catch (err) {
          debug?.("set", cacheKey, "delete failed", err);
        }
        return;
      }

      const tags = ctx?.tags ?? (data.tags as string[] | undefined) ?? [];
      const revalidate = data.revalidate as number | undefined;
      const meta: FrameMeta = { k: data.kind, lm: Date.now(), tags, rev: revalidate };

      let payload: Uint8Array = new Uint8Array(0);
      let codec = CODEC_NONE;
      if (data.kind === "IMAGE" && data.buffer instanceof Uint8Array) {
        meta.img = {
          etag: String(data.etag ?? ""),
          upstreamEtag: String(data.upstreamEtag ?? ""),
          extension: String(data.extension ?? ""),
        };
        payload = data.buffer as Uint8Array; // images: stored raw (already compressed)
      } else {
        // Non-image values (HTML/RSC/route bodies) compress well — serialize then
        // compress if above the threshold.
        const serialized = new TextEncoder().encode(JSON.stringify(pack(data)));
        codec =
          serialized.byteLength >= minCompressBytes ? codecToByte(compression) : CODEC_NONE;
        payload = compress(serialized, codec);
      }

      try {
        const frame = encodeFrame(meta, payload, codec);
        const ttl = ttlFor(revalidate);
        if (ttl !== undefined) {
          await redis.set(key, frame, "EX", ttl);
        } else {
          await redis.set(key, frame);
        }
        debug?.("set", cacheKey, "stored", {
          kind: data.kind,
          bytes: frame.byteLength,
          ttl,
          tags,
        });
      } catch (err) {
        debug?.("set", cacheKey, "failed", err);
      }
    }

    async revalidateTag(tags: string | string[], _durations?: { expire?: number }): Promise<void> {
      const list = Array.isArray(tags) ? tags : [tags];
      if (list.length === 0) return;
      const now = Date.now();
      const fields: Record<string, string> = {};
      for (const t of list) fields[t] = String(now);
      try {
        await redis.hset(tagsKey, fields);
        debug?.("revalidateTag", list);
      } catch (err) {
        debug?.("revalidateTag failed", err);
      }
    }

    resetRequestCache(): void {
      // No per-request in-memory layer to reset.
    }
  };
}
