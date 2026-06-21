import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryCacheHandler } from "../src/memory-handler.ts";
import { readBody, setEntry } from "./helpers.ts";

describe("memory handler", () => {
  test("stores and retrieves an entry", async () => {
    const h = createMemoryCacheHandler();
    await setEntry(h, "k1", "value-1");
    expect(await readBody(await h.get("k1", []))).toBe("value-1");
  });

  test("misses unknown keys", async () => {
    const h = createMemoryCacheHandler();
    expect(await h.get("nope", [])).toBeUndefined();
  });

  test("a concurrent get awaits an in-flight set", async () => {
    const h = createMemoryCacheHandler();
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

  test("revalidateTag-style updateTags expires matching entries", async () => {
    const h = createMemoryCacheHandler();
    await setEntry(h, "tagged", "v", { tags: ["products"], timestamp: Date.now() - 10 });
    await h.updateTags(["products"]); // immediate hard expiry
    expect(await h.get("tagged", [])).toBeUndefined();
  });

  test("durations.expire marks stale (revalidate -1) before hard expiry", async () => {
    const h = createMemoryCacheHandler();
    await setEntry(h, "swr", "v", { tags: ["news"], timestamp: Date.now() - 10 });
    await h.updateTags(["news"], { expire: 3600 });
    const got = await h.get("swr", []);
    expect(got).toBeDefined();
    expect(got!.revalidate).toBe(-1);
  });

  test("getExpiration returns max expired timestamp", async () => {
    const h = createMemoryCacheHandler();
    await h.updateTags(["x"], { expire: 100 });
    const exp = await h.getExpiration(["x"]);
    expect(exp).toBeGreaterThan(Date.now());
  });

  test("respects age expiry", async () => {
    const h = createMemoryCacheHandler();
    await setEntry(h, "old", "v", {
      timestamp: Date.now() - 10_000,
      revalidate: 1,
      expire: 1,
    });
    expect(await h.get("old", [])).toBeUndefined();
  });

  test("maxSize 0 disables caching", async () => {
    const h = createMemoryCacheHandler({ maxSize: 0 });
    await setEntry(h, "k", "v");
    expect(await h.get("k", [])).toBeUndefined();
  });

  test("evicts oldest entries past maxSize", async () => {
    const h = createMemoryCacheHandler({ maxSize: 32 });
    await setEntry(h, "a", "0123456789"); // 10 bytes
    await setEntry(h, "b", "0123456789");
    await setEntry(h, "c", "0123456789");
    await setEntry(h, "d", "0123456789"); // total 40 > 32 -> evict oldest (a)
    expect(await h.get("a", [])).toBeUndefined();
    expect(await readBody(await h.get("d", []))).toBe("0123456789");
  });
});
