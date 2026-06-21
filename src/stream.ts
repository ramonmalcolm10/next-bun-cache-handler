/**
 * Helpers for moving cache payloads between Next.js `ReadableStream`s and the
 * raw byte buffers we persist in Redis.
 */

/**
 * Fully drain a `ReadableStream<Uint8Array>` into a single `Uint8Array`.
 *
 * Next hands us a stream that may still be producing and may error partway
 * through. We read it chunk by chunk to completion so the stored payload is the
 * complete render output.
 */
export async function streamToBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Wrap raw bytes back into a one-shot `ReadableStream<Uint8Array>` suitable for
 * returning from `get`. Each call produces a fresh, independently consumable
 * stream, so a cached entry can be served any number of times.
 *
 * The bytes are copied into a fresh, zero-offset `Uint8Array`. `decodeEntry`
 * may return a `subarray` view into a larger frame buffer (non-zero
 * `byteOffset`, shared `ArrayBuffer`); consumers that read `chunk.buffer`
 * directly would otherwise see neighbouring metadata bytes and corrupt the
 * payload. The copy guarantees `chunk.buffer` contains exactly the payload.
 */
export function bytesToStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(copy);
      controller.close();
    },
  });
}
