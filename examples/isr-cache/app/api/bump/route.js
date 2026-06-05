// Rewrites data.txt with a fresh value and revalidates /isr, so the next request
// regenerates the ISR page with different inline data.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { revalidatePath } from 'next/cache'

export const dynamic = 'force-dynamic'

export async function POST() {
  const value = `bumped-${Math.random().toString(36).slice(2, 12)}`
  await writeFile(join(process.cwd(), 'data.txt'), value, 'utf8')
  revalidatePath('/isr')
  return Response.json({ ok: true, value })
}
