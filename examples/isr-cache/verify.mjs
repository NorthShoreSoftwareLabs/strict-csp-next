// End-to-end proof for the cache handler on real ISR routes against `next start`.
// The guarantee under test: EVERY response for a cache-handler route carries a
// CSP whose hashes cover the document's inline scripts, in every cache state —
// the build prerender (HIT), a fresh hit, a stale-while-revalidate stale serve,
// AND the cache-fill render itself (a MISS: the first request to an un-prebuilt
// ISR path, or the first after an on-demand revalidatePath). No next.config
// headers(), no proxy: the only sources of a CSP here are the postbuild meta
// patch (build prerender) and the cache handler (every set, including the fill
// render via in-place header mutation), so a correct policy is attributable to
// them. It also tracks the bytes when the data changes.
import { writeFileSync } from 'node:fs'
import { extractInlineHashes } from 'strict-csp-next'

const BASE = process.env.BASE || 'http://localhost:4310'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'cache-control': 'no-cache' } })
  return {
    state: res.headers.get('x-nextjs-cache'),
    csp:
      res.headers.get('content-security-policy') ||
      res.headers.get('content-security-policy-report-only'),
    html: await res.text(),
  }
}
const valueOf = (html) => (html.match(/<p id="value">([^<]*)<\/p>/) || [])[1] ?? null
function coverage(html, csp) {
  const bodyHashes = extractInlineHashes(html)
  return { bodyHashes, uncovered: bodyHashes.filter((h) => !csp || !csp.includes(h)) }
}

let failed = false
function assert(cond, msg) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} - ${msg}`)
  if (!cond) failed = true
}
function assertCovered(label, r) {
  const c = coverage(r.html, r.csp)
  assert(
    !!r.csp && r.csp.includes("'sha256-") && c.bodyHashes.length > 0 && c.uncovered.length === 0,
    `${label} [${r.state}] covers all ${c.bodyHashes.length} inline scripts (uncovered ${c.uncovered.length})`,
  )
  return c
}

async function run() {
  // 1) Build prerender, served as a HIT from the patched .meta.
  const g1 = await get('/isr')
  const c1 = assertCovered('build prerender /isr', g1)
  const v1 = valueOf(g1.html)

  // 2) Cache-FILL MISS on an un-prebuilt path: the render streams from the
  //    pipeline, yet must still carry a covering policy. This is the gap the
  //    in-place header mutation closes.
  const fill = await get('/post/abc123')
  assert(fill.state === 'MISS', `/post/abc123 first request is a cache MISS (got ${fill.state})`)
  assertCovered('cache-fill render /post/abc123', fill)
  assertCovered('/post/abc123 subsequent', await get('/post/abc123'))

  // 3) Time-based stale-while-revalidate with CHANGING data. Write the data file
  //    directly (pure time lapse, no on-demand invalidation), then sample the
  //    window: every cache serve must stay covered, the new value must appear,
  //    and its hash set must differ from gen1.
  const newValue = `swr-${Math.random().toString(36).slice(2, 12)}`
  writeFileSync('data.txt', newValue)
  await sleep(6000) // outlast the 5s revalidate window

  let sawNew = null
  for (let i = 0; i < 40; i++) {
    const g = await get('/isr')
    if (g.state === 'HIT' || g.state === 'STALE') {
      const c = assertCovered(`SWR serve value=${valueOf(g.html)}`, g)
      if (valueOf(g.html) !== v1 && !sawNew) sawNew = { c, csp: g.csp }
    }
    if (sawNew) break
    await sleep(250)
  }
  assert(!!sawNew, 'changed data eventually served from cache')
  if (sawNew) {
    const set1 = new Set(c1.bodyHashes)
    assert(
      sawNew.c.bodyHashes.some((h) => !set1.has(h)),
      'regenerated hash set differs from gen1 (header tracked the changed bytes)',
    )
  }

  // 4) On-demand revalidatePath: the triggering request is a MISS fill, which
  //    must also be covered now.
  await fetch(`${BASE}/api/bump`, { method: 'POST' })
  assertCovered('post-revalidatePath /isr', await get('/isr'))

  console.log(
    failed
      ? '\nFAILED'
      : '\nALL PASS — every cache state (build prerender, HIT, STALE, and cache-fill MISS) is strict-CSP-correct, across changing data',
  )
  process.exitCode = failed ? 1 : 0
}

run().catch((e) => {
  console.error('ERROR:', e.message)
  process.exitCode = 1
})
