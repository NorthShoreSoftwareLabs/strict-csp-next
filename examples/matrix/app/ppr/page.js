// Route: /ppr — PPR (cacheComponents). Rich static shell + two dynamic holes.
// The shell has a client component (Counter) for hydration + two Suspense
// boundaries each wrapping an async function that calls connection().
// This stresses whether the prelude emits more than one bare inline script
// and whether the manifest covers all of them.
import { Suspense } from 'react'
import { connection } from 'next/server'
import Counter from '../counter.js'

async function HoleA() {
  await connection()
  const val = Math.random().toString(36).slice(2, 8)
  return (
    <p data-hole="a" style={{ background: '#e8f4fd', padding: '8px 12px', borderRadius: 4 }}>
      Hole A resolved per-request: <code>{val}</code>
    </p>
  )
}

async function HoleB() {
  await connection()
  const val = Date.now().toString(36)
  return (
    <p data-hole="b" style={{ background: '#fdf3e8', padding: '8px 12px', borderRadius: 4 }}>
      Hole B resolved per-request: <code>{val}</code>
    </p>
  )
}

export default function PprPage() {
  return (
    <main>
      <h1>/ppr — PPR (Cache Components)</h1>
      <p>Static shell paragraph one. The CSP must cover all bare prelude scripts via hashes.</p>
      <p>Static shell paragraph two. The dynamic holes below are covered by the nonce.</p>
      <Counter label="ppr shell" />
      <hr style={{ margin: '16px 0' }} />
      <h2>Dynamic holes (nonce-covered)</h2>
      <Suspense fallback={<p style={{ color: '#999' }}>loading hole A…</p>}>
        <HoleA />
      </Suspense>
      <Suspense fallback={<p style={{ color: '#999' }}>loading hole B…</p>}>
        <HoleB />
      </Suspense>
    </main>
  )
}
