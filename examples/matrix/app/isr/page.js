// Route: /isr — ISR with 60s revalidation.
// NOTE: With cacheComponents:true, Next 16 disallows the 'revalidate' segment
// config. ISR via revalidate is incompatible with cacheComponents mode.
// This route becomes a static page in cacheComponents mode; we document it.
import Counter from '../counter.js'

export default function IsrPage() {
  return (
    <main>
      <h1>/isr — ISR (revalidate=60)</h1>
      <p>Prerendered with revalidation. Hashes are stable until Next revalidates.</p>
      <Counter label="isr" />
    </main>
  )
}
