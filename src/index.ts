/**
 * next-bun-cache-handler
 *
 * A Bun-native cache handler for Next.js Cache Components (the `"use cache"`
 * directive / `cacheHandlers` config), backed by Bun's built-in Redis client.
 */

export type {
  CacheEntry,
  CacheHandler,
  Compression,
  TagManifestEntry,
  Timestamp,
} from "./types";

export {
  createBunRedisCacheHandler,
  type BunRedisCacheHandlerOptions,
} from "./redis-handler";

export {
  createMemoryCacheHandler,
  type MemoryCacheHandlerOptions,
} from "./memory-handler";

export {
  createBunIncrementalCacheHandler,
  type BunIncrementalCacheHandlerOptions,
} from "./incremental-handler";

import type { CacheHandler } from "./types";
import {
  createBunRedisCacheHandler,
  type BunRedisCacheHandlerOptions,
} from "./redis-handler";
import {
  createMemoryCacheHandler,
  type MemoryCacheHandlerOptions,
} from "./memory-handler";

/** Backend selection for {@link createCacheHandler}. */
export type CacheHandlerConfig =
  | ({ type: "redis" | "valkey" } & BunRedisCacheHandlerOptions)
  | ({ type: "memory" } & MemoryCacheHandlerOptions);

/**
 * Convenience factory that picks a handler by `type`. `redis`/`valkey` use
 * Bun's Redis client; `memory` uses the in-process handler.
 *
 * If `type` is omitted, it defaults to `redis` when a Redis URL is configured
 * (`REDIS_URL` / `VALKEY_URL`) and `memory` otherwise — handy for local dev.
 *
 * @example
 * // cache-handler.ts
 * import { createCacheHandler } from "next-bun-cache-handler";
 * export default createCacheHandler({ type: "redis", compression: "zstd" });
 */
export function createCacheHandler(
  config: CacheHandlerConfig | (BunRedisCacheHandlerOptions & { type?: undefined }) = {},
): CacheHandler {
  const type =
    config.type ??
    (Bun.env.REDIS_URL || Bun.env.VALKEY_URL ? "redis" : "memory");

  if (type === "memory") {
    return createMemoryCacheHandler(config as MemoryCacheHandlerOptions);
  }
  return createBunRedisCacheHandler(config as BunRedisCacheHandlerOptions);
}
