// Route: /dynamic — fully dynamic content via connection() inside Suspense.
// In Next 16 cacheComponents mode, uncached dynamic access must be inside
// <Suspense>. This page has NO static shell — the entire content is dynamic.
import { Suspense } from 'react'
import { connection } from 'next/server'
import Counter from '../counter.js'

async function DynamicContent() {
  await connection()
  const ts = new Date().toISOString()
  return (
    <>
      <p>Rendered per request. Timestamp: <code data-ts>{ts}</code></p>
      <p>All inline scripts covered by the nonce. No build-time hashes needed.</p>
      <Counter label="dynamic" />
    </>
  )
}

export default function DynamicPage() {
  return (
    <main>
      <h1>/dynamic — fully dynamic</h1>
      <Suspense fallback={<p>loading dynamic content…</p>}>
        <DynamicContent />
      </Suspense>
    </main>
  )
}
