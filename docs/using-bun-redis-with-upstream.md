# Using Bun's Redis client with `@mrjasonroy/better-nextjs-cache-handler`

You do **not** need a separate package to run that library on Bun. Its Redis data
handler accepts an **injectable client** (`createRedisDataCacheHandler({ redis })`)
shaped like ioredis. Bun's built-in `RedisClient` exposes the same primitives
under different names, so a ~12-line adapter bridges them — no `ioredis`
dependency required.

This is the "one package" path: keep using the upstream library, just feed it
Bun's client.

## The adapter (works today)

```ts
// bun-redis-adapter.ts
import { RedisClient } from "bun";

/**
 * Adapts Bun's built-in RedisClient to the injectable client interface used by
 * `@mrjasonroy/better-nextjs-cache-handler` (get / set / del / exists / ttl /
 * hGet / hSet / hGetAll). Mirrors the library's own ioredis `createRedisAdapter`.
 */
export function createBunRedisAdapter(client: RedisClient = new RedisClient()) {
  return {
    get: (key: string) => client.get(key),
    // The library calls set(key, value, "EX", ttl); Bun's set takes the same
    // variadic flags. Cast keeps it simple across Bun's strict overloads.
    set: (key: string, value: string, ...args: unknown[]) =>
      (client.set as (...a: unknown[]) => Promise<unknown>)(key, value, ...args),
    del: (...keys: string[]) => client.del(...keys),
    // Bun's exists takes one key and returns a boolean; the interface wants a
    // count, so tally across keys.
    exists: async (...keys: string[]) => {
      let n = 0;
      for (const k of keys) if (await client.exists(k)) n++;
      return n;
    },
    ttl: (key: string) => client.ttl(key),
    hGet: (key: string, field: string) => client.hget(key, field),
    hSet: (key: string, field: string, value: string) =>
      client.hset(key, { [field]: value }),
    hGetAll: (key: string) => client.hgetall(key),
  };
}
```

## Wiring it up

```ts
// cache-handler.ts
import { createRedisDataCacheHandler } from "@mrjasonroy/better-nextjs-cache-handler";
import { createBunRedisAdapter } from "./bun-redis-adapter";

export default createRedisDataCacheHandler({
  redis: createBunRedisAdapter(), // reads REDIS_URL by default
});
```

> Check the upstream package's exact export name for the direct Redis handler
> (e.g. `createRedisDataCacheHandler`) against the version you install — the
> top-level `createCacheHandler({ type: "redis" })` deliberately pulls in
> `ioredis`, so use the lower-level handler to inject the Bun client instead.

## What you get — and don't

✅ Runs the upstream library on Bun with **no `ioredis` dependency**.

❌ Does **not** add this package's Bun-native optimizations, because the upstream
Redis path stores values as **JSON + base64** (not raw binary via `getBuffer`),
reads **`hGetAll` per tag on every `get`** (no local manifest), and has **no
compression or pub/sub invalidation**.

If those matter, use `next-bun-cache-handler` instead — that's its reason to exist.

## Proposed upstream change (PR/issue draft)

> **Title:** Add a first-class Bun Redis adapter (use Bun's built-in client, no ioredis)
>
> Bun ships a built-in Redis client (`Bun.RedisClient`). Projects running on the
> Bun runtime can already inject it into `createRedisDataCacheHandler` via a tiny
> adapter (below), avoiding the `ioredis` dependency entirely. Could we ship this
> as a documented `createBunRedisAdapter()` export so it's discoverable, and add
> a "Bun" note to the docs?
>
> *(include the adapter above)*
>
> This is purely additive — no change to the storage format or existing Node
> path. Happy to open the PR.

Keeping this small and additive maximizes the odds of acceptance. Larger,
architecture-changing ideas (binary storage, pub/sub tag manifest) are better as
separate discussions.
