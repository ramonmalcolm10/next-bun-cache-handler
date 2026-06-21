/**
 * Distributed tags manifest.
 *
 * Tag revalidation state ({@link TagManifestEntry}) lives in a single Redis hash
 * shared by every instance, but each instance also keeps a local in-memory copy
 * so that the hot path (`get` / `getExpiration`) never has to round-trip Redis.
 *
 * The copies are kept coherent two ways:
 *   1. Pub/sub — `updateTags` publishes the delta on a channel that every
 *      instance subscribes to (via a dedicated `.duplicate()` connection, since
 *      a subscribed connection cannot run normal commands).
 *   2. `refreshTags()` — Next calls this before each request batch; it reloads
 *      the full hash, bounding staleness if a pub/sub message is ever missed.
 */

import type { RedisClient } from "bun";
import type { TagManifestEntry, Timestamp } from "./types";

interface TagsManifestOptions {
  /** Primary client used for hash reads/writes and publishing. */
  redis: RedisClient;
  /** Redis key of the shared manifest hash. */
  manifestKey: string;
  /** Pub/sub channel for cross-instance invalidation deltas. */
  channel: string;
  debug?: (...args: unknown[]) => void;
}

/** Wire shape of a published invalidation delta. */
interface TagsDelta {
  [tag: string]: TagManifestEntry;
}

export class TagsManifest {
  private readonly redis: RedisClient;
  private readonly manifestKey: string;
  private readonly channel: string;
  private readonly debug?: (...args: unknown[]) => void;

  private readonly local = new Map<string, TagManifestEntry>();
  private subscriber?: RedisClient;
  private subscribed = false;

  constructor(opts: TagsManifestOptions) {
    this.redis = opts.redis;
    this.manifestKey = opts.manifestKey;
    this.channel = opts.channel;
    this.debug = opts.debug;
  }

  /** Open the subscriber connection and load the initial manifest. */
  async init(): Promise<void> {
    await this.ensureSubscribed();
    await this.refresh();
  }

  private async ensureSubscribed(): Promise<void> {
    if (this.subscribed) return;
    // A subscribed connection is monopolized by pub/sub, so use a dedicated one.
    this.subscriber = await this.redis.duplicate();
    await this.subscriber.subscribe(this.channel, (message) => {
      try {
        const delta = JSON.parse(message) as TagsDelta;
        this.merge(delta);
        this.debug?.("tags: applied pub/sub delta", delta);
      } catch (err) {
        this.debug?.("tags: failed to apply pub/sub delta", err);
      }
    });
    this.subscribed = true;
  }

  /** Reload the entire manifest from Redis into the local map. */
  async refresh(): Promise<void> {
    await this.ensureSubscribed();
    const hash = await this.redis.hgetall(this.manifestKey);
    this.local.clear();
    for (const tag in hash) {
      const raw = hash[tag];
      if (!raw) continue;
      try {
        this.local.set(tag, JSON.parse(raw) as TagManifestEntry);
      } catch {
        // Ignore corrupt manifest fields rather than failing the request.
      }
    }
    this.debug?.("tags: refreshed", this.local.size, "tags");
  }

  /** Merge a delta into the local map, keeping the most recent timestamps. */
  private merge(delta: TagsDelta): void {
    for (const tag in delta) {
      const incoming = delta[tag];
      if (!incoming) continue;
      const existing = this.local.get(tag) ?? {};
      this.local.set(tag, {
        stale: maxDefined(existing.stale, incoming.stale),
        expired: maxDefined(existing.expired, incoming.expired),
      });
    }
  }

  /**
   * Max hard-expiration timestamp across `tags`, or 0 if none. Used by Next to
   * decide soft-tag expiry without a `get`.
   */
  getExpiration(tags: string[]): Timestamp {
    let max = 0;
    for (const tag of tags) {
      const expired = this.local.get(tag)?.expired;
      if (expired && expired > max) max = expired;
    }
    return max;
  }

  /**
   * True if any tag hard-expired entries created at `entryTimestamp`. Matches
   * Next's semantics: the expiry must already have elapsed (`<= now`) and must
   * post-date the entry (`> entryTimestamp`).
   */
  isExpired(tags: string[], entryTimestamp: number, now: number): boolean {
    for (const tag of tags) {
      const expired = this.local.get(tag)?.expired;
      if (expired != null && expired <= now && expired > entryTimestamp) {
        return true;
      }
    }
    return false;
  }

  /** True if any tag marks entries created at `entryTimestamp` as stale. */
  isStale(tags: string[], entryTimestamp: number, now: number): boolean {
    for (const tag of tags) {
      const stale = this.local.get(tag)?.stale;
      if (stale != null && stale <= now && stale > entryTimestamp) {
        return true;
      }
    }
    return false;
  }

  /**
   * Record revalidation for `tags`. With `durations.expire`, the tags are marked
   * stale now and hard-expire `expire` seconds later; otherwise they hard-expire
   * immediately. Writes through to Redis, updates the local map, and broadcasts.
   */
  async update(
    tags: string[],
    durations: { expire?: number } | undefined,
    now: number,
  ): Promise<void> {
    if (tags.length === 0) return;

    const delta: TagsDelta = {};
    for (const tag of tags) {
      const existing = this.local.get(tag) ?? {};
      let next: TagManifestEntry;
      if (durations) {
        next = { ...existing, stale: now };
        if (durations.expire !== undefined) {
          next.expired = now + durations.expire * 1000;
        }
      } else {
        next = { ...existing, expired: now };
      }
      delta[tag] = next;
      this.local.set(tag, next);
    }

    const fields: Record<string, string> = {};
    for (const tag in delta) {
      fields[tag] = JSON.stringify(delta[tag]);
    }

    await this.redis.hset(this.manifestKey, fields);
    await this.redis.publish(this.channel, JSON.stringify(delta));
    this.debug?.("tags: updated", delta);
  }

  /** Tear down the subscriber connection. */
  close(): void {
    this.subscriber?.close();
    this.subscribed = false;
  }
}

function maxDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return a > b ? a : b;
}
