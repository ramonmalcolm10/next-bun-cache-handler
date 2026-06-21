/**
 * Shared payload (de)compression built on Bun's native codecs. Used by both the
 * `"use cache"` handler (`serialization.ts`) and the incremental/image handler.
 */

import type { Compression } from "./types";

export const CODEC_NONE = 0;
export const CODEC_GZIP = 1;
export const CODEC_ZSTD = 2;

export function codecToByte(c: Compression): number {
  switch (c) {
    case "gzip":
      return CODEC_GZIP;
    case "zstd":
      return CODEC_ZSTD;
    default:
      return CODEC_NONE;
  }
}

// Bun's (de)compression helpers are typed for `ArrayBuffer`-backed views; our
// buffers always are (never SharedArrayBuffer), so the cast is sound.
type ArrayBufferView8 = Uint8Array<ArrayBuffer>;
const asView = (b: Uint8Array): ArrayBufferView8 => b as ArrayBufferView8;

export function compress(bytes: Uint8Array, codec: number): Uint8Array {
  switch (codec) {
    case CODEC_GZIP:
      return Bun.gzipSync(asView(bytes));
    case CODEC_ZSTD:
      return Bun.zstdCompressSync(asView(bytes));
    default:
      return bytes;
  }
}

export function decompress(bytes: Uint8Array, codec: number): Uint8Array {
  switch (codec) {
    case CODEC_GZIP:
      return Bun.gunzipSync(asView(bytes));
    case CODEC_ZSTD:
      return Bun.zstdDecompressSync(asView(bytes));
    default:
      return bytes;
  }
}
