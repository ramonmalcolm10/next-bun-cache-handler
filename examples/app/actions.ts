"use server";

import { revalidateTag } from "next/cache";

/**
 * Invalidate the cached value; routes through the handler's `updateTags`.
 * Next 16 requires a cacheLife profile as the second argument — it determines
 * the `durations.expire` passed to the handler.
 */
export async function revalidate() {
  revalidateTag("demo-time", "max");
}
