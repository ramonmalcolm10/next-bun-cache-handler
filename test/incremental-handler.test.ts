import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { RedisClient } from "bun";

import { createBunIncrementalCacheHandler } from "../src/incremental-handler.ts";

const URL = Bun.env.REDIS_URL ?? "redis://localhost:6379";

let redisUp = false;
let admin: RedisClient | undefined;
try {
  admin = new RedisClient(URL, { connectionTimeout: 800 });
  await admin.set("__nbch_isr_probe", "1");
  await admin.del("__nbch_isr_probe");
  redisUp = true;
} catch {
  redisUp = false;
}

const KEY_PREFIX = "nbch_isr_test:";
const TAGS_KEY = "nbch_isr_test:tags";

function makeHandler() {
  const Handler = createBunIncrementalCacheHandler({
    url: URL,
    keyPrefix: KEY_PREFIX,
    tagsKey: TAGS_KEY,
  });
  return new Handler();
}

async function flush() {
  if (!admin) return;
  const keys: string[] = await admin.send("KEYS", [`${KEY_PREFIX}*`]);
  if (keys.length) await admin.del(...keys);
}

describe.skipIf(!redisUp)("incremental handler (integration)", () => {
  beforeEach(flush);
  afterAll(async () => {
    await flush();
    admin?.close();
  });

  test("stores and retrieves an IMAGE entry as binary", async () => {
    const h = makeHandler();
    const buffer = Buffer.from([0, 255, 10, 200, 7, 7, 7, 42]);
    await h.set(
      "img-key",
      {
        kind: "IMAGE",
        etag: "abc",
        upstreamEtag: "up-abc",
        buffer,
        extension: "png",
        revalidate: 3600,
      },
      { tags: [] },
    );

    const got = await h.get("img-key", { kind: "IMAGE" });
    expect(got).not.toBeNull();
    expect(got!.value!.kind).toBe("IMAGE");
    expect(got!.value!.etag).toBe("abc");
    expect(got!.value!.extension).toBe("png");
    expect([...(got!.value!.buffer as Buffer)]).toEqual([...buffer]);
  });

  test("stores image payload as raw binary (not base64)", async () => {
    const h = makeHandler();
    const buffer = Buffer.alloc(1000, 0xab); // 1000 identical bytes
    await h.set(
      "img-size",
      { kind: "IMAGE", etag: "e", upstreamEtag: "u", buffer, extension: "png", revalidate: 60 },
      { tags: [] },
    );
    const raw = await admin!.getBuffer(`${KEY_PREFIX}img-size`);
    // base64 of 1000 bytes would be ~1336 bytes (a base64 frame ~1450 with meta);
    // raw binary stays ~1000 + a small (~126 byte) header/meta.
    expect(raw!.byteLength).toBeLessThan(1200);
  });

  test("round-trips a non-image kind with nested Buffer and Map", async () => {
    const h = makeHandler();
    await h.set(
      "page-key",
      {
        kind: "APP_PAGE",
        html: "<p>hi</p>",
        rscData: Buffer.from([1, 2, 3]),
        segmentData: new Map([["seg", Buffer.from([9, 9])]]),
        headers: { "x-test": "1" },
        status: 200,
        revalidate: 600,
      } as any,
      { tags: [] },
    );

    const got = await h.get("page-key", { kind: "APP_PAGE" });
    expect(got!.value!.kind).toBe("APP_PAGE");
    expect(got!.value!.html).toBe("<p>hi</p>");
    expect([...(got!.value!.rscData as Buffer)]).toEqual([1, 2, 3]);
    const seg = got!.value!.segmentData as Map<string, Buffer>;
    expect(seg).toBeInstanceOf(Map);
    expect([...seg.get("seg")!]).toEqual([9, 9]);
  });

  test("compresses non-image (HTML) payloads, round-tripping intact", async () => {
    const html = "<div class='card'>repeated content </div>".repeat(400);
    const page = (kind: string) => ({
      kind: "APP_PAGE",
      html,
      rscData: Buffer.from(html),
      headers: {},
      status: 200,
      revalidate: 600,
    });

    const Plain = createBunIncrementalCacheHandler({ url: URL, keyPrefix: KEY_PREFIX, tagsKey: TAGS_KEY, compression: "none", minCompressBytes: 0 });
    const Zstd = createBunIncrementalCacheHandler({ url: URL, keyPrefix: KEY_PREFIX, tagsKey: TAGS_KEY, compression: "zstd", minCompressBytes: 0 });

    await new Plain().set("plain-page", page("APP_PAGE") as any, { tags: [] });
    await new Zstd().set("zstd-page", page("APP_PAGE") as any, { tags: [] });

    const plainSize = (await admin!.getBuffer(`${KEY_PREFIX}plain-page`))!.byteLength;
    const zstdSize = (await admin!.getBuffer(`${KEY_PREFIX}zstd-page`))!.byteLength;
    expect(zstdSize).toBeLessThan(plainSize / 2); // highly repetitive -> big win

    // and it still decodes correctly
    const got = await new Zstd().get("zstd-page", { kind: "APP_PAGE" });
    expect(got!.value!.html).toBe(html);
    expect([...(got!.value!.rscData as Buffer)]).toEqual([...Buffer.from(html)]);
  });

  test("get returns null for a miss", async () => {
    const h = makeHandler();
    expect(await h.get("absent", { kind: "IMAGE" })).toBeNull();
  });

  test("set(null) deletes the entry", async () => {
    const h = makeHandler();
    await h.set("del-key", { kind: "IMAGE", etag: "e", upstreamEtag: "u", buffer: Buffer.from([1]), extension: "png", revalidate: 60 }, { tags: [] });
    await h.set("del-key", null, { tags: [] });
    expect(await h.get("del-key", { kind: "IMAGE" })).toBeNull();
  });

  test("revalidateTag invalidates entries tagged before the revalidation", async () => {
    const h = makeHandler();
    await h.set(
      "tagged",
      { kind: "APP_ROUTE", body: Buffer.from([1, 2]), status: 200, headers: {}, revalidate: 600 } as any,
      { tags: ["products"] },
    );
    expect(await h.get("tagged", { kind: "APP_ROUTE" })).not.toBeNull();

    // Ensure the revalidation timestamp is strictly after the entry's, so the
    // `revalidatedAt > lastModified` check fires deterministically.
    await Bun.sleep(5);
    await h.revalidateTag("products");
    expect(await h.get("tagged", { kind: "APP_ROUTE" })).toBeNull();
  });

  test("applies a TTL from revalidate", async () => {
    const h = makeHandler();
    await h.set("ttl-key", { kind: "IMAGE", etag: "e", upstreamEtag: "u", buffer: Buffer.from([1]), extension: "png", revalidate: 120 }, { tags: [] });
    const ttl: number = await admin!.ttl(`${KEY_PREFIX}ttl-key`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(120);
  });
});
