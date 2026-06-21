/**
 * Bun-native Redis cache handler for Next.js Cache Components (`"use cache"`).
 *
 * Built entirely on Bun primitives:
 *   - `Bun.RedisClient` for storage (no ioredis / node-redis dependency)
 *   - binary `SET`/`getBuffer` so payloads are stored as raw bytes, not base64
 *   - inline `SET ... EX` for atomic write-with-expiry
 *   - pub/sub (`subscribe`/`publish` over a `.duplicate()` connection) to keep a
 *     local tags manifest hot across instances (see {@link TagsManifest})
 *   - optional `Bun.zstdCompressSync` / `Bun.gzipSync` payload compression
 */

import { RedisClient } from "bun";
import type { RedisOptions } from "bun";

import type { CacheEntry, CacheHandler, Compression, Timestamp } from "./types";
import { decodeEntry, encodeEntry } from "./serialization";
import { bytesToStream, streamToBytes } from "./stream";
import { TagsManifest } from "./tags";

/** Next's "cache forever" sentinel (`INFINITE_CACHE`), in seconds. */
const INFINITE_CACHE = 0xfffffffe;

export interface BunRedisCacheHandlerOptions {
  /**
   * An existing `Bun.RedisClient` to use. If omitted, one is created from
   * {@link BunRedisCacheHandlerOptions.url}.
   */
  client?: RedisClient;
  /**
   * Redis connection URL. Defaults to `REDIS_URL`, then `VALKEY_URL`, then
   * `redis://localhost:6379`. Ignored when `client` is provided.
   */
  url?: string;
  /** Connection options forwarded to `new Bun.RedisClient`. */
  redisOptions?: RedisOptions;
  /** Prefix for cache entry keys. Default `"next:cache:"`. */
  keyPrefix?: string;
  /** Prefix for the shared tags manifest hash. Default `"next:tags:"`. */
  tagPrefix?: string;
  /** Pub/sub channel for tag invalidations. Default `"next:cache:invalidations"`. */
  channel?: string;
  /** Payload compression codec. Default `"none"`. */
  compression?: Compression;
  /** Payloads smaller than this (bytes) are never compressed. Default `1024`. */
  minCompressBytes?: number;
  /**
   * TTL (seconds) applied to entries whose `expire` is Next's infinite sentinel.
   * Set to `0` to persist such entries without any TTL. Default `86400` (24h).
   */
  defaultTTL?: number;
  /** Log verbose diagnostics to the console. Default `false`. */
  debug?: boolean;
}

export function createBunRedisCacheHandler(
  options: BunRedisCacheHandlerOptions = {},
): CacheHandler {
  const keyPrefix = options.keyPrefix ?? "next:cache:";
  const tagPrefix = options.tagPrefix ?? "next:tags:";
  const channel = options.channel ?? "next:cache:invalidations";
  const compression = options.compression ?? "none";
  const minCompressBytes = options.minCompressBytes ?? 1024;
  const defaultTTL = options.defaultTTL ?? 86_400;

  const debug = options.debug
    ? (...args: unknown[]) => console.debug("[next-bun-cache]", ...args)
    : undefined;

  const url =
    options.url ??
    Bun.env.REDIS_URL ??
    Bun.env.VALKEY_URL ??
    "redis://localhost:6379";

  const redis =
    options.client ?? new RedisClient(url, options.redisOptions);

  const manifest = new TagsManifest({
    redis,
    manifestKey: `${tagPrefix}manifest`,
    channel,
    debug,
  });

  // In-process coalescing: a `get` for a key with an in-flight `set` must wait
  // for the write to finish rather than reporting a miss.
  const pendingSets = new Map<string, Promise<void>>();

  // Lazily run one-time setup (subscriber connection + initial manifest load).
  let ready: Promise<void> | undefined;
  const ensureReady = (): Promise<void> => {
    if (!ready) {
      ready = manifest.init().catch((err) => {
        // Reset so a later call can retry; degrade to an empty local manifest.
        ready = undefined;
        debug?.("init failed; continuing without warm manifest", err);
      });
    }
    return ready;
  };

  const entryKey = (cacheKey: string): string => `${keyPrefix}${cacheKey}`;

  /** Resolve the Redis TTL (seconds) for an entry, or undefined for no TTL. */
  const ttlFor = (entry: CacheEntry): number | undefined => {
    const seconds = entry.expire >= INFINITE_CACHE ? defaultTTL : entry.expire;
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    return Math.ceil(seconds);
  };

  return {
    async get(cacheKey, softTags) {
      await ensureReady();

      // Wait out any concurrent in-flight write for this key.
      const pending = pendingSets.get(cacheKey);
      if (pending) {
        debug?.("get", cacheKey, "awaiting pending set");
        await pending;
      }

      const key = entryKey(cacheKey);
      let buf: Uint8Array | null;
      try {
        buf = await redis.getBuffer(key);
      } catch (err) {
        debug?.("get", cacheKey, "redis error", err);
        return undefined;
      }
      if (!buf) {
        debug?.("get", cacheKey, "miss");
        return undefined;
      }

      let decoded;
      try {
        decoded = decodeEntry(buf);
      } catch (err) {
        debug?.("get", cacheKey, "decode error", err);
        return undefined;
      }

      const now = Date.now();

      // Production drops entries past `revalidate`; the dev server serves them
      // until the longer `expire` window (matching Next's default handler).
      const maxAge = Bun.env.__NEXT_DEV_SERVER ? decoded.expire : decoded.revalidate;
      if (now > decoded.timestamp + maxAge * 1000) {
        debug?.("get", cacheKey, "age expired");
        return undefined;
      }

      // Hard tag expiration -> treat as a miss and evict.
      if (manifest.isExpired(decoded.tags, decoded.timestamp, now)) {
        debug?.("get", cacheKey, "tag expired");
        void redis.del(key).catch(() => {});
        return undefined;
      }

      // Stale tag -> serve but force revalidation.
      let revalidate = decoded.revalidate;
      if (manifest.isStale(decoded.tags, decoded.timestamp, now)) {
        debug?.("get", cacheKey, "tag stale");
        revalidate = -1;
      }

      debug?.("get", cacheKey, "hit", {
        tags: decoded.tags,
        revalidate,
        payloadBytes: decoded.payload.byteLength,
      });
      void softTags; // soft tags are handled via getExpiration, as in Next's default.

      return {
        value: bytesToStream(decoded.payload),
        tags: decoded.tags,
        stale: decoded.stale,
        timestamp: decoded.timestamp,
        expire: decoded.expire,
        revalidate,
      };
    },

    async set(cacheKey, pendingEntry) {
      await ensureReady();

      let resolvePending: () => void = () => {};
      pendingSets.set(
        cacheKey,
        new Promise<void>((resolve) => {
          resolvePending = resolve;
        }),
      );

      try {
        const entry = await pendingEntry;
        const payload = await streamToBytes(entry.value);
        const frame = encodeEntry(entry, payload, compression, minCompressBytes);
        const key = entryKey(cacheKey);
        const ttl = ttlFor(entry);

        if (ttl !== undefined) {
          await redis.set(key, frame, "EX", ttl);
        } else {
          await redis.set(key, frame);
        }
        debug?.("set", cacheKey, "stored", {
          bytes: frame.byteLength,
          ttl,
          tags: entry.tags,
        });
      } catch (err) {
        // Never let a cache write failure surface into the render path.
        debug?.("set", cacheKey, "failed", err);
      } finally {
        resolvePending();
        pendingSets.delete(cacheKey);
      }
    },

    async refreshTags() {
      await ensureReady();
      try {
        await manifest.refresh();
      } catch (err) {
        debug?.("refreshTags failed", err);
      }
    },

    async getExpiration(tags): Promise<Timestamp> {
      await ensureReady();
      return manifest.getExpiration(tags);
    },

    async updateTags(tags, durations) {
      await ensureReady();
      try {
        await manifest.update(tags, durations, Date.now());
      } catch (err) {
        debug?.("updateTags failed", err);
      }
    },
  };
}
