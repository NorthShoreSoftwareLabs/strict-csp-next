// Route: /isr — ISR with 60s revalidation. Prerendered with revalidation;
// hashes are stable until Next revalidates.
import Counter from '../counter.js'

export const revalidate = 60

export default function IsrPage() {
  return (
    <main>
      <h1>/isr — ISR (revalidate=60)</h1>
      <p>Prerendered with revalidation. Hashes are stable until Next revalidates.</p>
      <Counter label="isr" />
    </main>
  )
}
