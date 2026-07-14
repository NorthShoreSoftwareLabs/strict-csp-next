// Route: / — fully static with a client component for hydration testing.
// A page with no dynamic APIs is static by default. This example runs the
// integrity backfill (postbuild --backfill) so EVERY external <script src> is
// hash-pinned. Once coverage is 100%, the policy drops 'self' and adds
// 'strict-dynamic' — the zero-'self' SRI path this example exists to prove.
import Counter from './counter.js'

export default function StaticPage() {
  return (
    <main>
      <h1>/ — static (zero-'self' SRI)</h1>
      <p>This page is fully prerendered. The button below tests client hydration.</p>
      <Counter label="static" />
    </main>
  )
}
