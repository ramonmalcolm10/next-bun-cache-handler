import Image from "next/image";
import { cacheLife, cacheTag } from "next/cache";

import { revalidate } from "./actions";

interface Post {
  id: number;
  title: string;
  body: string;
}

/**
 * A cached data fetch. On a cache miss it fetches a random post from
 * JSONPlaceholder and stores the result through the Bun cache handler; later
 * renders return the cached post until the `demo-time` tag is revalidated or the
 * `hours` lifetime elapses.
 */
async function getPost(): Promise<{ post: Post; fetchedAt: string }> {
  "use cache";
  cacheLife("hours");
  cacheTag("demo-time");

  const id = Math.floor(Math.random() * 100) + 1;
  const res = await fetch(`https://jsonplaceholder.typicode.com/posts/${id}`);
  const post = (await res.json()) as Post;

  return { post, fetchedAt: new Date().toISOString() };
}

export default async function Home() {
  const { post, fetchedAt } = await getPost();

  return (
    <main>
      <h1>next-bun-cache-handler</h1>
      <p>
        The post below is fetched inside a <code>"use cache"</code> function
        tagged <code>demo-time</code> and stored through the Bun cache handler.
        The page is static: reload it and the same post is served from cache
        (the upstream fetch does not run again) until the <code>hours</code>{" "}
        lifetime elapses or the tag is revalidated.
      </p>

      <table style={{ borderCollapse: "collapse", margin: "1.5rem 0" }}>
        <tbody>
          <Row label="Post id" value={String(post.id)} />
          <Row label="Title" value={post.title} />
          <Row label="Fetched at" value={fetchedAt} />
        </tbody>
      </table>

      <p
        style={{
          background: "#f6f6f6",
          padding: "0.75rem 1rem",
          borderRadius: 6,
          margin: "1rem 0",
        }}
      >
        {post.body}
      </p>

      <p style={{ color: "#555", marginTop: "2rem" }}>
        This optimized image is cached in Redis via the singular{" "}
        <code>cacheHandler</code> (<code>kind: &quot;IMAGE&quot;</code>):
      </p>
      <Image src="/test.png" alt="demo" width={320} height={240} />

      <form action={revalidate} style={{ marginTop: "2rem" }}>
        <button type="submit" style={buttonStyle}>
          Revalidate (revalidateTag &quot;demo-time&quot;)
        </button>
      </form>

      <p style={{ marginTop: "2rem" }}>
        <a href="/deferred">
          → Deferred-cache example (builds without a data source)
        </a>
      </p>

      <p style={{ color: "#666", fontSize: 14, marginTop: "1.5rem" }}>
        After clicking revalidate, reload — a different post is fetched because
        the handler&apos;s <code>updateTags</code> invalidated the cached entry.
      </p>
    </main>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td style={{ padding: "4px 16px 4px 0", color: "#555" }}>{label}</td>
      <td style={{ padding: "4px 0", fontFamily: "ui-monospace, monospace" }}>
        {value}
      </td>
    </tr>
  );
}

const buttonStyle = {
  padding: "8px 14px",
  fontSize: 14,
  border: "1px solid #111",
  borderRadius: 6,
  background: "#111",
  color: "#fff",
  cursor: "pointer",
} as const;
