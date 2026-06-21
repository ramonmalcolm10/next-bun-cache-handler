# next-bun-cache-handler

A **Bun-native** cache handler for Next.js **Cache Components** (the `"use cache"`
directive and the `cacheHandlers` config), backed by **Bun's built-in Redis
client**.

It implements the same Next.js handler contract as
[`@mrjasonroy/better-nextjs-cache-handler`](https://github.com/mrjasonroy/cache-components-cache-handler)
(`get` / `set` / `refreshTags` / `getExpiration` / `updateTags`), but is built
from the ground up on Bun primitives — **no `ioredis` or `node-redis`
dependency**, and several efficiency wins that fall out of using Bun directly.

> Requires the **Bun** runtime (`bun --bun`) and Next.js 16+ with Cache
> Components enabled.

## Why Bun-native?

| Concern | This package | Typical handlers |
| --- | --- | --- |
| Redis client | `Bun.RedisClient` (built in) | `ioredis` / `node-redis` dependency |
| Payload storage | **raw binary** via `getBuffer` + binary `SET` | JSON + **base64** (~33% larger) |
| Compression | `Bun.zstdCompressSync` / `Bun.gzipSync` (built in) | usually none |
| Write + TTL | atomic inline `SET … EX` | `SET` then `EXPIRE`, or base64 string |
| Tag manifest reads | **local in-memory**, kept hot via Redis **pub/sub** | `HGETALL` per tag on every `get` |

The tag-manifest design is the biggest behavioral difference: instead of
round-tripping Redis hashes on the hot path, each instance keeps a local copy of
the tags manifest and stays coherent through a Redis **pub/sub** channel
(published over a dedicated `.duplicate()` connection). `refreshTags()` — which
Next calls before each request batch — reloads the full manifest as a safety net.

## Relationship to `@mrjasonroy/better-nextjs-cache-handler`

This package implements the same Next.js cache-handler contract as
[`@mrjasonroy/better-nextjs-cache-handler`](https://github.com/mrjasonroy/cache-components-cache-handler).
The two are meant to be **complementary, not competing**:

- **Use `@mrjasonroy/better-nextjs-cache-handler`** if you run on **Node.js**, or
  want its broader backend coverage (ioredis-based, with configs for Valkey,
  AWS ElastiCache with IAM auth, etc.). It's the general-purpose, runtime-agnostic
  option.
- **Use `next-bun-cache-handler`** if you run on **Bun** and want the Bun-native
  performance tier: zero dependencies (Bun's built-in Redis client), **raw binary
  storage** (no base64), optional **zstd/gzip** compression, and a **pub/sub-backed
  local tag manifest** (no `HGETALL` per tag on the hot path).

You can also run the upstream library **on Bun's client** (no `ioredis`) via a tiny
adapter — see [`docs/using-bun-redis-with-upstream.md`](./docs/using-bun-redis-with-upstream.md).
That gives you compatibility on a single package, but **not** the binary /
compression / pub/sub optimizations above, which are specific to this handler.

The intent is not to fragment the ecosystem: reach for whichever fits your
runtime and needs. This package exists for the case the upstream library's
Redis path can't structurally cover — the Bun-native performance optimizations.

## Compatibility

The `cacheHandlers` API was introduced in **Next.js 16.0.0** and is still
evolving — minor releases have changed behavior (e.g. `revalidateTag` gained a
required second argument, the handler interface was renamed). This package
therefore declares a major-scoped peer range and is verified against specific
versions in CI:

| | Version |
| --- | --- |
| Peer range | `next` `>=16.0.0 <17.0.0` |
| Verified | **Next.js 16.0.0 → 16.2.9** (React 19.2) |
| Bun | `>=1.2.0` (developed on 1.3.x) |

Every minor from `16.0.0` through `16.2.9` has been verified end-to-end (build +
static prerender + dev cache hits + tag invalidation) — the `cacheHandlers`
contract and the `revalidateTag(tag, profile)` two-argument form have been stable
across the whole 16.x line so far.

CI additionally smoke-tests the example against Next.js `latest` and `canary`,
so upcoming breaking changes are caught early. If you're on a newer Next.js minor
than the one listed above and hit an issue, please open an issue — support is
added by verifying the version, not by widening the range blindly.

## Install

```sh
bun add next-bun-cache-handler
```

## Usage

**1. Create a handler module** that default-exports the handler:

```ts
// cache-handler.ts
import { createCacheHandler } from "next-bun-cache-handler";

export default createCacheHandler({
  type: "redis",            // "redis" | "valkey" | "memory"
  compression: "zstd",      // "none" (default) | "gzip" | "zstd"
  // url defaults to REDIS_URL / VALKEY_URL / redis://localhost:6379
});
```

**2. Wire it into `next.config.ts`:**

```ts
// next.config.ts
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  cacheHandlers: {
    default: require.resolve("./cache-handler.ts"),
    remote: require.resolve("./cache-handler.ts"),
  },
};

export default nextConfig;
```

**3. Use the cache in your app:**

```tsx
import { cacheLife, cacheTag } from "next/cache";

async function getProduct(id: string) {
  "use cache";
  cacheLife("hours");
  cacheTag(`product:${id}`);
  return db.product.find(id);
}
```

Invalidate with `revalidateTag("product:123", "max")` — the handler's
`updateTags` broadcasts the invalidation to every instance over pub/sub.

## Optimized images & ISR (the singular `cacheHandler`)

The steps above cover the **`"use cache"`** directive (the plural `cacheHandlers`
config). Next.js has a **separate** caching subsystem — the *incremental cache* —
that handles **ISR pages, route handlers, and `next/image` optimization**. It is
wired through a **different** config key, `cacheHandler` (singular), and is *not*
used by `"use cache"`. So to put **optimized images in Redis** (shared across
instances instead of each instance's local filesystem), add the singular handler
too.

This package ships `createBunIncrementalCacheHandler` for exactly that — it stores
image buffers as **raw binary** (`getBuffer`, no base64) and serializes the other
kinds (ISR pages, routes) with Buffer/Map support so configuring it doesn't
disable their caching.

```ts
// cache-handler-image.ts  (default export must be the handler CLASS)
import { createBunIncrementalCacheHandler } from "next-bun-cache-handler";

export default createBunIncrementalCacheHandler();
```

```ts
// next.config.ts — configure BOTH handlers; they are independent keys.
const nextConfig = {
  cacheComponents: true,

  // "use cache" -> plural handler
  cacheHandlers: {
    default: require.resolve("./cache-handler.ts"),
    remote: require.resolve("./cache-handler.ts"),
  },

  // ISR / route / image -> singular handler
  cacheHandler: require.resolve("./cache-handler-image.ts"),
  cacheMaxMemorySize: 0,            // see note below
  images: { customCacheHandler: true }, // route image entries to the handler
};
```

> **Set `cacheMaxMemorySize: 0`.** It disables Next's in-memory LRU that sits in
> front of the singular handler, so **every** image/ISR read goes to Redis. Leave
> it at the default and each instance keeps its own memory cache in front, so some
> reads never reach Redis — defeating a shared cache. For multi-instance image
> caching, `0` is what you want. (This setting only affects the **singular**
> handler; it has no effect on the plural `cacheHandlers`.)

`images.customCacheHandler: true` is the opt-in that routes `kind: "IMAGE"`
entries to your handler; it's slated to become the default in a future major.

> **Image caching requires Next.js 16.2.0+.** `images.customCacheHandler` was
> introduced in 16.2.0 — on 16.0.x/16.1.x it's an unrecognized config key and the
> build fails. The `"use cache"` (plural) handler works on 16.0.0+; only the
> image/`IMAGE` routing needs 16.2.0+.

> **Should you cache images in Redis at all? Often, no.** Redis is RAM, and
> `next/image` stores a *separate* entry per `(src, width, quality)` combo — many
> multi-KB blobs add up fast and can evict your hot `"use cache"` data. Prefer, in
> order:
>
> 1. **A CDN in front of `/_next/image`** — the optimizer emits proper
>    `Cache-Control`, so the edge/browser caches the output and the optimizer
>    barely runs. With a CDN you usually don't need Redis for images at all (the
>    default on-disk cache is enough).
> 2. **Object storage (S3 / R2 / GCS)** if you want shared/persistent image
>    caching at scale — far cheaper per GB than Redis RAM.
> 3. **Redis** only for a bounded image set, or ephemeral/multi-instance setups
>    where instances should share the optimization work. If you do, guard it: set
>    `maxmemory` + `volatile-lru` eviction, keep TTLs modest, and ideally isolate
>    images in a **separate Redis DB/instance** (or at least the `next:isr:`
>    prefix) so image blobs can't evict your hot small keys.
>
> The `"use cache"` (plural) handler has none of these concerns — its entries are
> small render payloads, which is exactly what Redis is good at.

## Building without a data source (CI/CD without a DB)

A gotcha worth knowing if your build runs somewhere without database access (e.g.
a CI runner): in Cache Components, **`"use cache"` in a statically-prerendered
position is executed at build time** — so the build must reach your data source.
`<Suspense>` alone does **not** defer a cached call; and `force-dynamic` /
empty `generateStaticParams` are both disallowed under `cacheComponents`.

To let the build run **without** the data source, force the cached subtree
**dynamic** with `await connection()` inside a `<Suspense>` boundary. The static
shell prerenders at build (no DB needed); the cached fetch runs at the **first
runtime request** and fills Redis then:

```tsx
import { Suspense } from "react";
import { connection } from "next/server";
import { cacheLife, cacheTag } from "next/cache";

async function getProducts() {
  "use cache";                 // still cached in Redis — just filled at runtime
  cacheLife("hours");
  cacheTag("products");
  return db.products.findAll();
}

async function Products() {
  await connection();          // forces this subtree dynamic -> deferred to runtime
  return <List items={await getProducts()} />;
}

export default function Page() {
  return (
    <main>
      <h1>Catalog</h1>                  {/* static shell — builds with no DB */}
      <Suspense fallback={<Skeleton />}>
        <Products />                      {/* runs at first request, fills Redis */}
      </Suspense>
    </main>
  );
}
```

The route becomes a Partial Prerender (`◐`). You can't have all three of
*no Suspense* + `"use cache"` + *no build-time DB* — either give CI access to the
data source (keep the no-Suspense, build-time prerender), or defer to runtime with
`connection()` + Suspense as above. See [`examples/app/deferred/page.tsx`](./examples/app/deferred/page.tsx).

## Runnable example

A complete Next.js 16 app is in [`examples/`](./examples). It runs under the Bun
runtime, registers the handler via `cacheHandlers`, and demonstrates a static
`"use cache"` page plus tag revalidation:

```sh
cd examples
bun install
REDIS_URL=redis://localhost:6379 bun run dev   # -> http://localhost:3000
```

See [`examples/README.md`](./examples/README.md) for details.

## API

### `createCacheHandler(config)`

Convenience factory. Picks a backend by `config.type`. If `type` is omitted it
defaults to `redis` when `REDIS_URL` / `VALKEY_URL` is set, otherwise `memory`.

### `createBunRedisCacheHandler(options)`

| Option | Default | Description |
| --- | --- | --- |
| `client` | — | Bring your own `Bun.RedisClient`. |
| `url` | `REDIS_URL` ⟶ `VALKEY_URL` ⟶ `redis://localhost:6379` | Connection URL. |
| `redisOptions` | — | Passed to `new Bun.RedisClient`. |
| `keyPrefix` | `"next:cache:"` | Prefix for entry keys. |
| `tagPrefix` | `"next:tags:"` | Prefix for the shared tags-manifest hash. |
| `channel` | `"next:cache:invalidations"` | Pub/sub channel for invalidations. |
| `compression` | `"none"` | `"none"` \| `"gzip"` \| `"zstd"`. |
| `minCompressBytes` | `1024` | Payloads below this are never compressed. |
| `defaultTTL` | `86400` | Redis TTL (s) for "cache forever" entries. `0` = no TTL. |
| `debug` | `false` | Verbose console logging. |

### `createMemoryCacheHandler(options)`

In-process handler for development or single-instance deployments.

| Option | Default | Description |
| --- | --- | --- |
| `maxSize` | `52428800` (50 MB) | Max retained payload bytes. `0` disables caching. |
| `debug` | `false` | Verbose console logging. |

### `createBunIncrementalCacheHandler(options)`

The **singular** `cacheHandler` (incremental cache) for ISR / route / **image**
caching. Returns a **class** to `export default` from the module referenced by
`cacheHandler`. Image buffers are stored as raw binary; other kinds are
JSON-serialized with Buffer/Map support.

| Option | Default | Description |
| --- | --- | --- |
| `client` | — | Bring your own `Bun.RedisClient`. |
| `url` | `REDIS_URL` ⟶ `VALKEY_URL` ⟶ `redis://localhost:6379` | Connection URL. |
| `redisOptions` | — | Passed to `new Bun.RedisClient`. |
| `keyPrefix` | `"next:isr:"` | Prefix for incremental-cache keys. |
| `tagsKey` | `"next:isr:tags"` | Redis hash of tag → revalidation timestamp. |
| `defaultTTL` | `86400` | TTL (s) for entries with no finite `revalidate`. |
| `compression` | `"none"` | `"none"` \| `"gzip"` \| `"zstd"` — applied to **non-image** payloads (HTML/RSC/route bodies), which compress well. Images are always stored raw. |
| `minCompressBytes` | `1024` | Non-image payloads below this are stored uncompressed. |
| `debug` | `false` | Verbose console logging. |

> **Tip:** set `compression: "zstd"` here. Image bytes are already compressed (so
> they're stored raw), but page HTML / RSC payloads typically shrink 2–10×, which
> meaningfully cuts Redis memory for the ISR/page entries this handler stores.

## How it stores data

Each entry is one Redis value written as a compact binary frame — no base64:

```
byte  0      format version (1)
byte  1      compression codec (0 none / 1 gzip / 2 zstd)
bytes 2..5   uint32 metadata length N (big-endian)
bytes 6..6+N metadata JSON (tags, stale, timestamp, expire, revalidate)
bytes 6+N..  payload bytes (compressed per codec)
```

Tag revalidation state lives in a single Redis hash (`<tagPrefix>manifest`),
field = tag, value = `{ stale?, expired? }`. `updateTags` writes through to the
hash **and** publishes the delta; subscribers merge it into their local copy.

## Expiration semantics

Matches Next's default handler:

- **Production:** an entry is a miss once `now > timestamp + revalidate`.
- **Dev server** (`__NEXT_DEV_SERVER`): served until `now > timestamp + expire`.
- Redis TTL is set from `expire`, so hard-expired entries self-reap.
- A **stale** tag forces `revalidate = -1` (serve-while-revalidate); an
  **expired** tag is treated as a miss.

## Development

```sh
bun install
bun test          # unit tests; Redis integration tests run if Redis is reachable
bun run typecheck
bun run build     # bundles dist/index.js + emits .d.ts
```

Redis integration tests connect to `REDIS_URL` (default
`redis://localhost:6379`) and skip automatically if none is reachable.

## License

MIT
