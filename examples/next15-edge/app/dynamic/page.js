// Route: /dynamic — fully dynamic, rendered per request. Inline scripts are
// covered by the per-request nonce from the Edge middleware; no build-time
// hashes needed.
import Counter from '../counter.js'

export const dynamic = 'force-dynamic'

export default function DynamicPage() {
  const ts = new Date().toISOString()
  return (
    <main>
      <h1>/dynamic — fully dynamic</h1>
      <p>Rendered per request. Timestamp: <code data-ts>{ts}</code></p>
      <p>All inline scripts covered by the nonce. No build-time hashes needed.</p>
      <Counter label="dynamic" />
    </main>
  )
}
