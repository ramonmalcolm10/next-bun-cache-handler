import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Enable Cache Components / the `"use cache"` directive (Next 16+).
  cacheComponents: true,

  // Keep the handlers (and their `import "bun"`) out of the bundle; loaded at
  // runtime under the Bun runtime instead.
  serverExternalPackages: ["next-bun-cache-handler"],

  // This example is its own project root (silences the multi-lockfile notice).
  turbopack: { root: import.meta.dirname },

  // PLURAL handler — used by the `"use cache"` directive.
  cacheHandlers: {
    default: require.resolve("./cache-handler.ts"),
    remote: require.resolve("./cache-handler.ts"),
  },

  // SINGULAR handler — used by the incremental cache: ISR, route handlers, and
  // (with the flag below) optimized images from `next/image`.
  cacheHandler: require.resolve("./cache-handler-image.ts"),
  // Disable Next's in-memory layer in front of the singular handler so every
  // read goes to Redis (consistent across instances).
  cacheMaxMemorySize: 0,
  images: {
    // Route optimized-image cache entries through the singular handler above.
    customCacheHandler: true,
  },
};

export default nextConfig;
