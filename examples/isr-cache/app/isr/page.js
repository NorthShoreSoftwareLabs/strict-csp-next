// Route: /isr — real ISR (revalidate=60). It renders a value read from data.txt
// at render time, so when /api/bump rewrites that file and revalidates, the
// regenerated page carries different inline-script bytes. If the cache handler
// works, the CSP header regenerates with it and still matches.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const revalidate = 5

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
