// Route: /post/[id] — ISR with dynamic params. Only id=1 is prerendered at build;
// any other id is generated ON FIRST REQUEST (a cache MISS served straight from
// the render pipeline). On Next 15 the response-cache resolves the HTTP response
// BEFORE awaiting cacheHandler.set() on an ordinary MISS, so this first-fill MISS
// is the case the verify script records as the documented Next 15 caveat.
export const revalidate = 60
export const dynamicParams = true

export function generateStaticParams() {
  return [{ id: '1' }]
}

export default async function PostPage({ params }) {
  const { id } = await params
  return (
    <main>
      <h1>/post/{id}</h1>
      <p id="value">post-body-for-{id}</p>
    </main>
  )
}
