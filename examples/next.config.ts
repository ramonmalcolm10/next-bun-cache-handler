import type { NextConfig } from "next";

// `images.customCacheHandler` (routing optimized images through the singular
// cacheHandler) was introduced in Next 16.2.0. Detect the installed version so
// this example also builds on 16.0.x / 16.1.x (core "use cache" only).
const nextVersion: string = require("next/package.json").version;
const [maj = 0, min = 0] = nextVersion.split(".").map(Number);
const supportsImageCache = maj > 16 || (maj === 16 && min >= 2);

const nextConfig: NextConfig = {
  // Enable Cache Components / the `"use cache"` directive (Next 16+).
  cacheComponents: true,

  // Keep the handlers (and their `import "bun"`) out of the bundle; loaded at
  // runtime under the Bun runtime instead.
  serverExternalPackages: ["next-bun-cache-handler"],

  // This example is its own project root (silences the multi-lockfile notice).
  turbopack: { root: import.meta.dirname },

  // PLURAL handler — used by the `"use cache"` directive (works on Next 16.0.0+).
  cacheHandlers: {
    default: require.resolve("./cache-handler.ts"),
    remote: require.resolve("./cache-handler.ts"),
  },
};

if (supportsImageCache) {
  // SINGULAR handler — incremental cache: ISR, route handlers, and optimized
  // images. Assigned via a loose cast because `images.customCacheHandler` only
  // exists in Next 16.2.0+ and would otherwise fail typecheck on 16.0.x/16.1.x.
  const cfg = nextConfig as Record<string, unknown>;
  cfg.cacheHandler = require.resolve("./cache-handler-image.ts");
  cfg.cacheMaxMemorySize = 0; // every read goes to Redis (no in-memory layer)
  cfg.images = { customCacheHandler: true };
}

export default nextConfig;
