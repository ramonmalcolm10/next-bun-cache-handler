/**
 * Singular `cacheHandler` module (for ISR / route / **image** caching).
 * Referenced by `cacheHandler` in next.config.ts. Must default-export the class.
 */
import { createBunIncrementalCacheHandler } from "next-bun-cache-handler";

export default createBunIncrementalCacheHandler({
  debug: true,
  compression: "zstd", // compresses HTML/RSC entries; images stay raw
  // url defaults to REDIS_URL / VALKEY_URL / redis://localhost:6379
});
