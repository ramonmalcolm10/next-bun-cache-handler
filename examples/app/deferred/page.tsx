/**
 * "Build without a data source" pattern.
 *
 * The page's static shell prerenders at build with NO data access. The
 * data-backed part is forced dynamic with `await connection()` inside a
 * `<Suspense>` boundary, so its `"use cache"` fetch runs at the FIRST runtime
 * request (filling Redis) rather than at build. This lets CI build the app
 * without reaching your database — while still caching at runtime.
 *
 * Contrast with `app/page.tsx`, which uses `"use cache"` in a static position:
 * that one IS prerendered at build and therefore needs the data source at build.
 */
import { Suspense } from "react";
import { connection } from "next/server";
import { cacheLife, cacheTag } from "next/cache";

interface Post {
  id: number;
  title: string;
  body: string;
}

async function getPost(): Promise<{ post: Post; fetchedAt: string }> {
  "use cache";
  cacheLife("hours");
  cacheTag("demo-time");

  const id = Math.floor(Math.random() * 100) + 1;
  const res = await fetch(`https://jsonplaceholder.typicode.com/posts/${id}`);
  const post = (await res.json()) as Post;
  return { post, fetchedAt: new Date().toISOString() };
}

async function DeferredPost() {
  // Forces this subtree dynamic -> deferred to runtime, so `getPost()` does NOT
  // run at build. (Without this, the cached call would be prerendered at build
  // and would require the data source to be reachable from CI.)
  await connection();

  const { post, fetchedAt } = await getPost();
  return (
    <>
      <p>
        <strong>{post.title}</strong>
      </p>
      <p style={{ color: "#666", fontSize: 14 }}>fetched at {fetchedAt}</p>
      <p style={{ background: "#f6f6f6", padding: "0.75rem 1rem", borderRadius: 6 }}>
        {post.body}
      </p>
    </>
  );
}

export default function DeferredPage() {
  return (
    <main>
      <h1>Deferred cache (builds without a data source)</h1>
      <p>
        This page&apos;s shell prerenders at build with no data access. The post
        below is fetched + cached at the <em>first runtime request</em> (via{" "}
        <code>connection()</code> + <code>&lt;Suspense&gt;</code> + <code>&quot;use cache&quot;</code>),
        so CI can build this without reaching the database.
      </p>
      <Suspense fallback={<p>loading post…</p>}>
        <DeferredPost />
      </Suspense>
    </main>
  );
}
