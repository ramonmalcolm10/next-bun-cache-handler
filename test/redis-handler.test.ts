import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";

import { createBunRedisCacheHandler } from "../src/redis-handler.ts";
import { readBody, setEntry } from "./helpers.ts";

const URL = Bun.env.REDIS_URL ?? "redis://localhost:6379";

// Probe once; skip the whole suite if no Redis is reachable.
let redisUp = false;
let admin: RedisClient | undefined;
try {
  admin = new RedisClient(URL, { connectionTimeout: 800 });
  await admin.set("__nbch_probe", "1");
  await admin.del("__nbch_probe");
  redisUp = true;
} catch {
  redisUp = false;
}

const KEY_PREFIX = "nbch_test:cache:";
const TAG_PREFIX = "nbch_test:tags:";
const CHANNEL = "nbch_test:invalidations";

function makeHandler(opts: Record<string, unknown> = {}) {
  return createBunRedisCacheHandler({
    url: URL,
    keyPrefix: KEY_PREFIX,
    tagPrefix: TAG_PREFIX,
    channel: CHANNEL,
    ...opts,
  });
}

async function flush() {
  if (!admin) return;
  // Remove only this suite's keys.
  for (const pattern of [`${KEY_PREFIX}*`, `${TAG_PREFIX}*`]) {
    const keys: string[] = await admin.send("KEYS", [pattern]);
    if (keys.length) await admin.del(...keys);
  }
}

describe.skipIf(!redisUp)("redis handler (integration)", () => {
  beforeEach(flush);
  afterAll(async () => {
    await flush();
    admin?.close();
  });

  test("stores and retrieves an entry", async () => {
    const h = makeHandler();
    await setEntry(h, "k1", "value-1");
    expect(await readBody(await h.get("k1", []))).toBe("value-1");
  });

  test("returns undefined for a miss", async () => {
    const h = makeHandler();
    expect(await h.get("absent", [])).toBeUndefined();
  });

  test("stores payloads as raw binary (no base64)", async () => {
    const h = makeHandler();
    const bytes = new Uint8Array([0, 255, 10, 200]);
    await h.set("bin", Promise.resolve({
      value: new Response(bytes).body!,
      tags: [],
      stale: 5,
      timestamp: Date.now(),
      expire: 3600,
      revalidate: 600,
    }));
    const got = await h.get("bin", []);
    const out = new Uint8Array(await new Response(got!.value).arrayBuffer());
    expect([...out]).toEqual([...bytes]);
  });

  test("zstd compression round-trips", async () => {
    const h = makeHandler({ compression: "zstd", minCompressBytes: 0 });
    const body = "compress me ".repeat(1000);
    await setEntry(h, "z", body);
    expect(await readBody(await h.get("z", []))).toBe(body);
  });

  test("sets a Redis TTL from expire", async () => {
    const h = makeHandler();
    await setEntry(h, "ttl", "v", { expire: 120 });
    const ttl: number = await admin!.ttl(`${KEY_PREFIX}ttl`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });

  test("updateTags hard-expires matching entries", async () => {
    const h = makeHandler();
    await setEntry(h, "tagged", "v", { tags: ["cat"], timestamp: Date.now() - 50 });
    await h.updateTags(["cat"]);
    expect(await h.get("tagged", [])).toBeUndefined();
  });

  test("updateTags with durations marks stale (revalidate -1)", async () => {
    const h = makeHandler();
    await setEntry(h, "swr", "v", { tags: ["feed"], timestamp: Date.now() - 50 });
    await h.updateTags(["feed"], { expire: 3600 });
    const got = await h.get("swr", []);
    expect(got).toBeDefined();
    expect(got!.revalidate).toBe(-1);
  });

  test("getExpiration reflects updateTags", async () => {
    const h = makeHandler();
    await h.updateTags(["g"], { expire: 100 });
    await h.refreshTags();
    expect(await h.getExpiration(["g"])).toBeGreaterThan(Date.now());
    expect(await h.getExpiration(["never-touched"])).toBe(0);
  });

  test("invalidation propagates across handler instances via pub/sub", async () => {
    const writer = makeHandler();
    const reader = makeHandler();

    await setEntry(reader, "shared", "v", { tags: ["sync"], timestamp: Date.now() - 50 });
    // Warm reader's manifest + subscription.
    expect(await readBody(await reader.get("shared", []))).toBe("v");

    // Writer invalidates; the delta should reach reader over pub/sub.
    await writer.updateTags(["sync"]);

    // Give the subscriber a tick to apply the published delta.
    await Bun.sleep(100);
    expect(await reader.get("shared", [])).toBeUndefined();
  });

  test("a concurrent get awaits an in-flight set", async () => {
    const h = makeHandler();
    let resolve!: (e: any) => void;
    const pending = new Promise<any>((r) => (resolve = r));
    const setPromise = h.set("race", pending);
    const getPromise = h.get("race", []);
    resolve({
      value: new Response("late").body,
      tags: [],
      stale: 5,
      timestamp: Date.now(),
      expire: 3600,
      revalidate: 600,
    });
    await setPromise;
    expect(await readBody(await getPromise)).toBe("late");
  });
});
