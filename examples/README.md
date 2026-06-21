# Example: next-bun-cache-handler

A minimal Next.js 16 app (App Router, Cache Components) wired to the Bun-native
cache handler from the parent package.

## Run it

This app **must run on the Bun runtime** (the handler uses Bun's built-in Redis
client), so start it with `bun --bun`.

```sh
cd examples
bun install
bun run dev          # -> http://localhost:3000
```

`bun run dev` is `bun --bun next dev`, so Next itself runs under Bun. The handler
is pulled in as a `file:..` dependency and listed in `serverExternalPackages`,
so Next loads it at runtime (keeping its `import "bun"` intact) rather than
bundling it.

Open http://localhost:3000 and reload a few times:

- The **cached computedAt / nonce** stay the same — the page is static, served
  from the cache handler.
- Click **Revalidate** (calls `revalidateTag("demo-time", "max")`), then reload —
  the values change, because the handler's `updateTags` invalidated the entry.

## Use Redis (recommended)

With no Redis configured the example falls back to an in-memory handler. To
exercise the Bun Redis path (binary storage, `SET EX`, pub/sub invalidation),
point it at a Redis/Valkey instance:

```sh
REDIS_URL=redis://localhost:6379 bun run dev
```

`debug: true` is set in `cache-handler.ts`, so you'll see `[next-bun-cache]`
logs for every get / set / updateTags, e.g.:

```
[next-bun-cache] get [...] miss
[next-bun-cache] set [...] stored { bytes: 175, ttl: 86400, tags: [ "demo-time" ] }
```

## Optimized images in Redis

The example also caches `next/image` output in Redis via the **singular**
`cacheHandler` (`cache-handler-image.ts`), enabled in `next.config.ts` with
`cacheHandler` + `images.customCacheHandler: true` + `cacheMaxMemorySize: 0`.
The page renders `/test.png` through `next/image`; the optimized result is stored
under a `next:isr:*` key as raw binary. You'll see `[next-bun-cache:isr]` logs:

```
[next-bun-cache:isr] get <hash> miss
[next-bun-cache:isr] set <hash> stored { kind: "IMAGE", bytes: 17396, ttl: 14400 }
[next-bun-cache:isr] get <hash> hit
```

Inspect it: `redis-cli KEYS 'next:isr:*'`.

## Files

- `next.config.ts` — enables `cacheComponents`, registers the plural
  `cacheHandlers` (use cache) **and** the singular `cacheHandler` (ISR/image),
  and marks the package as a server-external package.
- `cache-handler.ts` — the `"use cache"` handler module (`export default`).
- `cache-handler-image.ts` — the singular ISR/image handler (`export default`).
- `app/page.tsx` — a static `"use cache"` page plus a cached `next/image`.
- `app/deferred/page.tsx` — the **build-without-a-data-source** pattern:
  `connection()` + `<Suspense>` + `"use cache"`, so the cached fetch runs at
  runtime (not build). Visit `/deferred` or follow the link on the home page.
- `app/actions.ts` — a server action calling `revalidateTag`.
- `public/test.png` — the demo image.
