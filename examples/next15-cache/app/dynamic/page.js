// Route: /dynamic — force-dynamic, rendered per request. The middleware
// (skipStatic:true) does NOT skip this route, so it carries a fresh per-request
// nonce from `createStrictCsp`. This proves the split: static/isr get the
// cache-handler header, dynamic/ppr get the nonce.
export const dynamic = 'force-dynamic'

export default function DynamicPage() {
  return (
    <main>
      <h1>/dynamic</h1>
      <p id="value">rendered-at-{new Date().toISOString()}</p>
    </main>
  )
}
