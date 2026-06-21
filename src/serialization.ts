/**
 * Binary serialization for cache entries.
 *
 * Unlike JSON+base64 approaches, we store the payload as raw bytes alongside a
 * small JSON metadata header in a single Redis value. This avoids the ~33% size
 * penalty of base64 and the cost of JSON-encoding binary render output.
 *
 * Frame layout (all integers big-endian):
 *
 *   byte  0      : format version (1)
 *   byte  1      : compression codec (0=none, 1=gzip, 2=zstd)
 *   bytes 2..5   : uint32 metadata length (N)
 *   bytes 6..6+N : metadata JSON (UTF-8)
 *   bytes 6+N..  : payload bytes (compressed per codec)
 */

import type { CacheEntry, Compression } from "./types";
import { CODEC_NONE, codecToByte, compress, decompress } from "./compression";

const VERSION = 1;
const HEADER_BYTES = 6;

/** Metadata persisted next to the payload (everything in CacheEntry but value). */
interface EntryMeta {
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}

/**
 * Encode an entry's metadata and already-drained payload into a single frame.
 *
 * @param entry      the entry whose metadata to persist
 * @param payload    the fully-drained value stream
 * @param compression payload codec; payloads below `minCompressBytes` are stored
 *                    uncompressed regardless, since tiny payloads rarely shrink.
 */
export function encodeEntry(
  entry: CacheEntry,
  payload: Uint8Array,
  compression: Compression,
  minCompressBytes: number,
): Uint8Array {
  const meta: EntryMeta = {
    tags: entry.tags,
    stale: entry.stale,
    timestamp: entry.timestamp,
    expire: entry.expire,
    revalidate: entry.revalidate,
  };
  const metaBytes = new TextEncoder().encode(JSON.stringify(meta));

  let codec = codecToByte(compression);
  if (codec !== CODEC_NONE && payload.byteLength < minCompressBytes) {
    codec = CODEC_NONE;
  }
  const body = compress(payload, codec);

  const frame = new Uint8Array(HEADER_BYTES + metaBytes.byteLength + body.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint8(0, VERSION);
  view.setUint8(1, codec);
  view.setUint32(2, metaBytes.byteLength);
  frame.set(metaBytes, HEADER_BYTES);
  frame.set(body, HEADER_BYTES + metaBytes.byteLength);
  return frame;
}

/** A decoded frame: entry metadata plus the decompressed payload bytes. */
export interface DecodedEntry extends EntryMeta {
  payload: Uint8Array;
}

/** Decode a frame produced by {@link encodeEntry}. Throws on malformed input. */
export function decodeEntry(frame: Uint8Array): DecodedEntry {
  if (frame.byteLength < HEADER_BYTES) {
    throw new Error("cache frame too short");
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const version = view.getUint8(0);
  if (version !== VERSION) {
    throw new Error(`unsupported cache frame version ${version}`);
  }
  const codec = view.getUint8(1);
  const metaLen = view.getUint32(2);
  const metaStart = HEADER_BYTES;
  const payloadStart = metaStart + metaLen;
  if (payloadStart > frame.byteLength) {
    throw new Error("cache frame metadata length out of range");
  }

  const meta = JSON.parse(
    new TextDecoder().decode(frame.subarray(metaStart, payloadStart)),
  ) as EntryMeta;
  const payload = decompress(frame.subarray(payloadStart), codec);

  return { ...meta, payload };
}
