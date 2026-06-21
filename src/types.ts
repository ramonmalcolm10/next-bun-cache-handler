/**
 * Type definitions for the Next.js "Cache Components" cache handler contract
 * (the `cacheHandlers` plural config used by the `"use cache"` directive).
 *
 * These mirror the interface declared in Next.js at
 * `next/dist/server/lib/cache-handlers/types`. We re-declare them here so the
 * package has no hard dependency on Next.js internals — the handler is
 * structurally compatible and works across Next versions that share this shape.
 */

/** A timestamp in milliseconds elapsed since the epoch. */
export type Timestamp = number;

/**
 * A single cache entry as produced and consumed by Next.js.
 *
 * The `value` is a streaming payload that may still be in flight when handed to
 * `set` and may error partway through — handlers must read it defensively.
 */
export interface CacheEntry {
  /** The rendered payload. May error and contain only partial data. */
  value: ReadableStream<Uint8Array>;
  /** Explicit tags configured for the entry (excludes soft/implicit tags). */
  tags: string[];
  /** Client-facing staleness hint, in seconds. Not used for expiry math. */
  stale: number;
  /** When the entry was created, in milliseconds since the epoch. */
  timestamp: Timestamp;
  /** Maximum lifetime in seconds (should be >= `revalidate`). */
  expire: number;
  /** Seconds until the entry should be revalidated. */
  revalidate: number;
}

/**
 * The Next.js Cache Components cache handler interface.
 *
 * @see https://nextjs.org/docs/app/api-reference/config/next-config-js/cacheHandlers
 */
export interface CacheHandler {
  /**
   * Retrieve a cache entry, or `undefined` if there is no valid entry or the
   * given soft tags are stale.
   */
  get(cacheKey: string, softTags: string[]): Promise<CacheEntry | undefined>;

  /**
   * Store a cache entry. The entry may still be pending (its stream still
   * writing), so it must be awaited. A concurrent `get` for the same key must
   * wait for an in-flight `set` to finish rather than returning `undefined`.
   */
  set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>;

  /**
   * Called periodically, always before starting a new request. Refreshes the
   * local view of the tags manifest from the shared tags service.
   */
  refreshTags(): Promise<void>;

  /**
   * Returns the maximum revalidation timestamp across the given tags, `0` if
   * none were ever revalidated, or `Infinity` to signal that the soft tags
   * should instead be checked inside `get`.
   */
  getExpiration(tags: string[]): Promise<Timestamp>;

  /**
   * Called when tags are revalidated/expired. Updates the shared tags manifest.
   * With `durations.expire` the tag is marked stale immediately and hard-expires
   * later; without `durations` it hard-expires immediately.
   */
  updateTags(
    tags: string[],
    durations?: { expire?: number },
  ): Promise<void>;
}

/** State recorded for a tag in the manifest. All timestamps are in ms. */
export interface TagManifestEntry {
  /** Entries created at/before this time are stale (serve-while-revalidate). */
  stale?: Timestamp;
  /** Entries created at/before this time are hard-expired (treated as a miss). */
  expired?: Timestamp;
}

/** Supported on-the-wire compression for cache payloads. */
export type Compression = "none" | "gzip" | "zstd";
