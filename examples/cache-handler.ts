/**
 * Cache handler module referenced by `next.config.ts` `cacheHandlers`.
 * It must `export default` an object implementing the handler interface.
 *
 * With no `type`, the factory uses Bun's Redis client when `REDIS_URL` /
 * `VALKEY_URL` is set, and an in-memory handler otherwise — so this example
 * runs out of the box and upgrades to shared Redis caching when one is present.
 */
import { createCacheHandler } from "next-bun-cache-handler";

export default createCacheHandler({
  compression: "zstd",
  debug: true,
});
