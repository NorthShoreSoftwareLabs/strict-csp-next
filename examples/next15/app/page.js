// Route: / — fully static with a client component for hydration testing.
// A page with no dynamic APIs is static by default; its inline scripts are
// covered by build-time hashes plus SRI integrity.
import Counter from './counter.js'

export default function StaticPage() {
  return (
    <main>
      <h1>/ — static</h1>
      <p>This page is fully prerendered. The button below tests client hydration.</p>
      <Counter label="static" />
    </main>
  )
}
