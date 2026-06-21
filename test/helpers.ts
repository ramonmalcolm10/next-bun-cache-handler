import type { CacheEntry, CacheHandler } from "../src/types.ts";
import { bytesToStream, streamToBytes } from "../src/stream.ts";

/** Build a CacheEntry from a string body with sensible defaults. */
export function entryFrom(
  body: string,
  overrides: Partial<Omit<CacheEntry, "value">> = {},
): CacheEntry {
  return {
    value: bytesToStream(new TextEncoder().encode(body)),
    tags: [],
    stale: 5,
    timestamp: Date.now(),
    expire: 3600,
    revalidate: 600,
    ...overrides,
  };
}

/** Read a returned cache entry's stream back into a string. */
export async function readBody(entry: CacheEntry | undefined): Promise<string | undefined> {
  if (!entry) return undefined;
  return new TextDecoder().decode(await streamToBytes(entry.value));
}

/** Exercise a handler's full get/set/tag lifecycle, returning observations. */
export async function setEntry(
  handler: CacheHandler,
  key: string,
  body: string,
  overrides?: Partial<Omit<CacheEntry, "value">>,
): Promise<void> {
  await handler.set(key, Promise.resolve(entryFrom(body, overrides)));
}
