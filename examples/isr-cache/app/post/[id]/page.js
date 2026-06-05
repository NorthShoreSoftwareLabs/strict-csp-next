// Route: /post/[id] — ISR with dynamic params. Only id=1 is prerendered at build;
// any other id is generated ON FIRST REQUEST (a cache MISS served straight from
// the render pipeline). This is the case the cache handler's in-place header
// mutation must cover: the fill render itself, with no build prerender to fall
// back on.
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
