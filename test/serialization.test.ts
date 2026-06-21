import { describe, expect, test } from "bun:test";

import { decodeEntry, encodeEntry } from "../src/serialization.ts";
import type { CacheEntry, Compression } from "../src/types.ts";
import { bytesToStream, streamToBytes } from "../src/stream.ts";

function makeEntry(payload: Uint8Array, overrides: Partial<CacheEntry> = {}): CacheEntry {
  return {
    value: bytesToStream(payload),
    tags: ["a", "b"],
    stale: 5,
    timestamp: 1_700_000_000_000,
    expire: 3600,
    revalidate: 60,
    ...overrides,
  };
}

describe("serialization", () => {
  const codecs: Compression[] = ["none", "gzip", "zstd"];

  for (const codec of codecs) {
    test(`round-trips metadata and payload (${codec})`, () => {
      const payload = new TextEncoder().encode("hello cache ".repeat(500));
      const frame = encodeEntry(makeEntry(payload), payload, codec, 0);
      const decoded = decodeEntry(frame);

      expect(decoded.tags).toEqual(["a", "b"]);
      expect(decoded.stale).toBe(5);
      expect(decoded.timestamp).toBe(1_700_000_000_000);
      expect(decoded.expire).toBe(3600);
      expect(decoded.revalidate).toBe(60);
      expect(new TextDecoder().decode(decoded.payload)).toBe(
        new TextDecoder().decode(payload),
      );
    });
  }

  test("compresses large payloads smaller than raw", () => {
    const payload = new TextEncoder().encode("a".repeat(10_000));
    const raw = encodeEntry(makeEntry(payload), payload, "none", 0);
    const zstd = encodeEntry(makeEntry(payload), payload, "zstd", 0);
    expect(zstd.byteLength).toBeLessThan(raw.byteLength);
  });

  test("skips compression below minCompressBytes", () => {
    const payload = new TextEncoder().encode("tiny");
    const frame = encodeEntry(makeEntry(payload), payload, "zstd", 1024);
    // codec byte (index 1) should be 0 (none) because payload < threshold.
    expect(frame[1]).toBe(0);
    expect(new TextDecoder().decode(decodeEntry(frame).payload)).toBe("tiny");
  });

  test("preserves binary payloads exactly", () => {
    const payload = new Uint8Array([0, 255, 1, 254, 128, 127, 0, 0]);
    const frame = encodeEntry(makeEntry(payload), payload, "zstd", 0);
    expect([...decodeEntry(frame).payload]).toEqual([...payload]);
  });

  test("rejects malformed frames", () => {
    expect(() => decodeEntry(new Uint8Array([1, 2]))).toThrow();
  });
});

describe("stream helpers", () => {
  test("streamToBytes drains a stream", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const out = await streamToBytes(bytesToStream(bytes));
    expect([...out]).toEqual([...bytes]);
  });

  test("bytesToStream produces independently consumable streams", async () => {
    const bytes = new Uint8Array([9, 8, 7]);
    const a = await streamToBytes(bytesToStream(bytes));
    const b = await streamToBytes(bytesToStream(bytes));
    expect([...a]).toEqual([...b]);
  });
});
