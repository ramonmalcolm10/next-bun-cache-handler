/**
 * In-memory cache handler — a dependency-free implementation of the same
 * Next.js Cache Components contract, suitable for development or the `default`
 * (single-instance) cache slot. Eviction is size-based (approximate LRU).
 *
 * Tag state is held in a module-level map shared across every instance created
 * in the process, because `revalidateTag` must invalidate across all handlers
 * (Next may construct several, e.g. `default` + `remote`).
 */

import type {
  CacheEntry,
  CacheHandler,
  TagManifestEntry,
  Timestamp,
} from "./types";
import { bytesToStream, streamToBytes } from "./stream";

const globalTagsManifest = new Map<string, TagManifestEntry>();

interface StoredEntry {
  payload: Uint8Array;
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
  size: number;
}

export interface MemoryCacheHandlerOptions {
  /** Maximum total payload bytes to retain. `0` disables caching. Default 50MB. */
  maxSize?: number;
  debug?: boolean;
}

export function createMemoryCacheHandler(
  options: MemoryCacheHandlerOptions = {},
): CacheHandler {
  const maxSize = options.maxSize ?? 50 * 1024 * 1024;
  const debug = options.debug
    ? (...args: unknown[]) => console.debug("[next-bun-cache:memory]", ...args)
    : undefined;

  // A no-op handler when caching is disabled.
  if (maxSize === 0) {
    return {
      async get() {
        return undefined;
      },
      async set() {},
      async refreshTags() {},
      async getExpiration() {
        return 0;
      },
      async updateTags() {},
    };
  }

  // Map preserves insertion order, which we use for cheap LRU eviction:
  // re-inserting on access moves an entry to the most-recently-used end.
  const cache = new Map<string, StoredEntry>();
  let totalSize = 0;
  const pendingSets = new Map<string, Promise<void>>();

  const evictIfNeeded = (): void => {
    while (totalSize > maxSize) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      const entry = cache.get(oldest.value);
      if (entry) totalSize -= entry.size;
      cache.delete(oldest.value);
      debug?.("evicted", oldest.value);
    }
  };

  const isExpired = (tags: string[], timestamp: number, now: number): boolean =>
    tags.some((tag) => {
      const expired = globalTagsManifest.get(tag)?.expired;
      return expired != null && expired <= now && expired > timestamp;
    });

  const isStale = (tags: string[], timestamp: number, now: number): boolean =>
    tags.some((tag) => {
      const stale = globalTagsManifest.get(tag)?.stale;
      return stale != null && stale <= now && stale > timestamp;
    });

  return {
    async get(cacheKey, softTags) {
      const pending = pendingSets.get(cacheKey);
      if (pending) await pending;

      const stored = cache.get(cacheKey);
      if (!stored) return undefined;

      const now = Date.now();
      const maxAge = Bun.env.__NEXT_DEV_SERVER ? stored.expire : stored.revalidate;
      if (now > stored.timestamp + maxAge * 1000) {
        totalSize -= stored.size;
        cache.delete(cacheKey);
        return undefined;
      }

      if (isExpired(stored.tags, stored.timestamp, now)) {
        totalSize -= stored.size;
        cache.delete(cacheKey);
        return undefined;
      }

      let revalidate = stored.revalidate;
      if (isStale(stored.tags, stored.timestamp, now)) revalidate = -1;

      // Mark as recently used.
      cache.delete(cacheKey);
      cache.set(cacheKey, stored);

      void softTags;
      return {
        value: bytesToStream(stored.payload),
        tags: stored.tags,
        stale: stored.stale,
        timestamp: stored.timestamp,
        expire: stored.expire,
        revalidate,
      };
    },

    async set(cacheKey, pendingEntry) {
      let resolvePending: () => void = () => {};
      pendingSets.set(
        cacheKey,
        new Promise<void>((resolve) => {
          resolvePending = resolve;
        }),
      );

      try {
        const entry: CacheEntry = await pendingEntry;
        const payload = await streamToBytes(entry.value);

        const existing = cache.get(cacheKey);
        if (existing) totalSize -= existing.size;

        const size = payload.byteLength;
        cache.set(cacheKey, {
          payload,
          tags: entry.tags,
          stale: entry.stale,
          timestamp: entry.timestamp,
          expire: entry.expire,
          revalidate: entry.revalidate,
          size,
        });
        totalSize += size;
        evictIfNeeded();
        debug?.("set", cacheKey, { size });
      } catch (err) {
        debug?.("set", cacheKey, "failed", err);
      } finally {
        resolvePending();
        pendingSets.delete(cacheKey);
      }
    },

    async refreshTags() {
      // In-process manifest; nothing to refresh.
    },

    async getExpiration(tags): Promise<Timestamp> {
      let max = 0;
      for (const tag of tags) {
        const expired = globalTagsManifest.get(tag)?.expired;
        if (expired && expired > max) max = expired;
      }
      return max;
    },

    async updateTags(tags, durations) {
      const now = Date.now();
      for (const tag of tags) {
        const existing = globalTagsManifest.get(tag) ?? {};
        if (durations) {
          const next: TagManifestEntry = { ...existing, stale: now };
          if (durations.expire !== undefined) {
            next.expired = now + durations.expire * 1000;
          }
          globalTagsManifest.set(tag, next);
        } else {
          globalTagsManifest.set(tag, { ...existing, expired: now });
        }
      }
      debug?.("updateTags", tags, durations);
    },
  };
}
