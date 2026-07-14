// Route: /isr — real ISR (revalidate=2). It renders a value read from data.txt
// at render time, so when /api/revalidate rewrites that file and revalidates, the
// regenerated page carries different inline-script bytes. If the cache handler
// works, the CSP header regenerates with it and still matches. The short 2s
// window makes the stale-while-revalidate serve easy to sample.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const revalidate = 2

async function readValue() {
  try {
    return (await readFile(join(process.cwd(), 'data.txt'), 'utf8')).trim()
  } catch {
    return 'missing'
  }
}

export default async function IsrPage() {
  const value = await readValue()
  return (
    <main>
      <h1>/isr</h1>
      <p id="value">{value}</p>
    </main>
  )
}
