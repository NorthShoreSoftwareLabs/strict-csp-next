// Route: /isr — ISR with 60s revalidation. Prerendered with revalidation;
// hashes and integrity are stable until Next revalidates. Like `/`, the backfill
// pins every external chunk, so this route also earns the zero-'self' policy.
import Counter from '../counter.js'

export const revalidate = 60

export default function IsrPage() {
  return (
    <main>
      <h1>/isr — ISR (revalidate=60, zero-'self' SRI)</h1>
      <p>Prerendered with revalidation. Hashes are stable until Next revalidates.</p>
      <Counter label="isr" />
    </main>
  )
}
