// Route: /dynamic — fully dynamic, rendered per request. Inline scripts are
// covered by the per-request nonce from middleware. A dynamic route keeps 'self'
// by design (the nonce path is not the SRI zero-'self' path), so this route is
// the deliberate contrast to the static routes and is NOT asserted zero-'self'.
import Counter from '../counter.js'

export const dynamic = 'force-dynamic'

export default function DynamicPage() {
  const ts = new Date().toISOString()
  return (
    <main>
      <h1>/dynamic — fully dynamic</h1>
      <p>Rendered per request. Timestamp: <code data-ts>{ts}</code></p>
      <p>All inline scripts covered by the nonce. Keeps 'self' by design.</p>
      <Counter label="dynamic" />
    </main>
  )
}
