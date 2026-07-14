// Next.js 15 runtime e2e for the cache handler (withStrictCspCache).
//
// It drives an ISR route through every cache state against a real `next start`
// and records, per state, whether the served response carried a CSP header whose
// hashes cover the document's inline scripts. It prints a STATE -> header table.
//
// Why this exists: on Next 15 the response-cache resolves the HTTP response
// BEFORE awaiting cacheHandler.set() on an ordinary MISS, so a plain first-fill
// MISS may ship WITHOUT the CSP header (a timing race). HIT, STALE, and on-demand
// revalidate (revalidatePath/revalidateTag) do NOT have this race and stay
// covered. This test asserts the covered states and RECORDS the plain-MISS
// behavior as the documented Next 15 caveat rather than failing on it.
//
// No next.config headers() and no proxy for static/isr: the middleware runs with
// skipStatic:true, so the only CSP sources for /isr are the postbuild .meta patch
// (build prerender) and the cache handler (every set). A correct policy on a
// served /isr response is therefore attributable to the package.
import { writeFileSync } from 'node:fs'
import { extractInlineHashes } from 'strict-csp-next'

const BASE = process.env.BASE || 'http://localhost:4600'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { headers: { 'cache-control': 'no-cache' } })
  return {
    status: res.status,
    cacheState: res.headers.get('x-nextjs-cache') || '(none)',
    csp:
      res.headers.get('content-security-policy') ||
      res.headers.get('content-security-policy-report-only') ||
      null,
    html: await res.text(),
  }
}

const valueOf = (html) => (html.match(/<p id="value">([^<]*)<\/p>/) || [])[1] ?? null

// A response is "covered" when it carries a CSP with at least one sha256 hash and
// every inline-script hash in the served HTML appears in that policy.
function coverage(r) {
  const bodyHashes = extractInlineHashes(r.html)
  const present = !!r.csp
  const uncovered = present ? bodyHashes.filter((h) => !r.csp.includes(h)) : bodyHashes
  const covered =
    present && r.csp.includes("'sha256-") && bodyHashes.length > 0 && uncovered.length === 0
  return { present, covered, bodyHashes, uncovered }
}

// Per-cache-state record for the table.
const table = []
function record(state, r, { gated }) {
  const c = coverage(r)
  table.push({ state, cacheState: r.cacheState, present: c.present, covered: c.covered, gated, c })
  return c
}

let failed = false
function assert(cond, msg) {
  console.log(`${cond ? 'ok  ' : 'FAIL'} - ${msg}`)
  if (!cond) failed = true
}

async function run() {
  // 1) BUILD PRERENDER — the very first request after `next start`, served from
  //    the build output whose .meta was patched by postbuild. No revalidation has
  //    run the cache handler yet, so a covering policy here is the .meta patch.
  const g1 = record('build-prerender', await get('/isr'), { gated: true })
  const v1 = valueOf((await get('/isr')).html) // settle value read

  // 2) HIT — a subsequent request to the now-warm ISR entry. The header is
  //    replayed from the cached entry.
  const hit = await get('/isr')
  record('HIT', hit, { gated: true })

  // 3) STALE — write changed data directly (pure time lapse, no on-demand
  //    invalidation), outlast the 2s revalidate window, then catch the
  //    stale-while-revalidate serve. The stale serve replays the OLD entry's
  //    header, which still matches the OLD bytes.
  const swrValue = `swr-${Math.random().toString(36).slice(2, 12)}`
  writeFileSync('data.txt', swrValue)
  await sleep(3000) // outlast the 2s revalidate window

  let staleR = null
  for (let i = 0; i < 40; i++) {
    const g = await get('/isr')
    if (g.cacheState === 'STALE') {
      staleR = g
      break
    }
    // If we blew past the stale serve straight to a regenerated HIT, fall back to
    // recording that HIT of the new value — it is still a cache serve that must be
    // covered — but keep trying to catch a STALE first.
    if (g.cacheState === 'HIT' && valueOf(g.html) === swrValue && !staleR) staleR = g
    await sleep(150)
  }
  assert(!!staleR, 'observed a stale-while-revalidate (or regenerated) cache serve after data change')
  if (staleR) record('STALE', staleR, { gated: true })

  // 4) PLAIN MISS / cache-fill — first request to an un-prebuilt ISR path. This
  //    is the Next 15 race: the response may resolve before `set()` is awaited,
  //    so the header may be ABSENT. RECORD the actual behavior; do NOT gate on it.
  const missId = `m${Math.random().toString(36).slice(2, 10)}`
  const miss = await get(`/post/${missId}`)
  assert(miss.cacheState === 'MISS', `/post/${missId} first request is a cache MISS (got ${miss.cacheState})`)
  record('MISS-fill (plain)', miss, { gated: false })

  // 5) ON-DEMAND REVALIDATE — revalidatePath('/isr') then read it back. Unlike a
  //    plain first-fill MISS, this path is covered on Next 15.
  await fetch(`${BASE}/api/revalidate`, { method: 'POST' })
  let onDemand = null
  for (let i = 0; i < 40; i++) {
    const g = await get('/isr')
    if (g.cacheState === 'HIT' || g.cacheState === 'STALE' || g.cacheState === 'MISS') {
      onDemand = g
      if (valueOf(g.html) !== v1) break // saw the regenerated value
    }
    await sleep(150)
  }
  assert(!!onDemand, 'observed a cache serve after revalidatePath(/isr)')
  if (onDemand) record('on-demand-revalidate', onDemand, { gated: true })

  // 6) The dynamic/nonce split: /dynamic is NOT skipped by the middleware, so it
  //    must carry a per-request nonce that differs across requests (a reused nonce
  //    defeats the policy). Proves static/isr -> cache-handler header, dynamic ->
  //    nonce.
  const d1 = await get('/dynamic')
  const d2 = await get('/dynamic')
  const nonceOf = (csp) => (csp && (csp.match(/'nonce-([^']+)'/) || [])[1]) || null
  const n1 = nonceOf(d1.csp)
  const n2 = nonceOf(d2.csp)
  assert(!!n1 && !!n2 && n1 !== n2, `/dynamic carries a per-request unique nonce (a=${n1} b=${n2})`)

  // ---- STATE -> header table ----
  console.log('\n=== /isr cache state -> CSP header (Next 15) ===\n')
  const pad = (s, n) => String(s).padEnd(n)
  console.log(pad('STATE', 22) + pad('x-nextjs-cache', 16) + pad('header', 10) + pad('covered', 10) + 'gated')
  console.log('-'.repeat(66))
  for (const row of table) {
    console.log(
      pad(row.state, 22) +
        pad(row.cacheState, 16) +
        pad(row.present ? 'present' : 'ABSENT', 10) +
        pad(row.covered ? 'yes' : 'no', 10) +
        (row.gated ? 'PASS-req' : 'record-only'),
    )
  }
  console.log()

  // Gate: every gated (expected-covered) state must be covered.
  const gated = table.filter((r) => r.gated)
  const expected = ['build-prerender', 'HIT', 'STALE', 'on-demand-revalidate']
  for (const state of expected) {
    const row = gated.find((r) => r.state === state)
    assert(!!row && row.covered, `expected-covered state "${state}" carries a covering CSP`)
  }

  // The plain MISS is informational. State precisely what happened. `/post` is
  // excluded from the middleware matcher, so the cache handler is the SOLE CSP
  // source here — this reading reflects the handler alone, not a nonce fallback.
  const missRow = table.find((r) => r.state === 'MISS-fill (plain)')
  if (missRow) {
    let verdict
    if (missRow.covered) {
      verdict =
        'The cache handler covered the fill render in this build (its in-place header mutation landed before the response was sent). The documented race did not manifest here.'
    } else if (missRow.present) {
      verdict =
        'The fill shipped a CSP header that does NOT cover its inline scripts (the handler mutation raced the response). This is the documented Next 15 caveat, not a failure.'
    } else {
      verdict =
        'The fill shipped with NO cache-handler CSP header: the response resolved before cacheHandler.set() was awaited. This is the documented Next 15 caveat, not a failure.'
    }
    console.log(
      `\nNext 15 plain first-fill MISS (cache handler alone): header ` +
        `${missRow.present ? 'PRESENT' : 'ABSENT'}, ${missRow.covered ? 'covered' : 'not covered'}. ${verdict}`,
    )
  }

  console.log(
    failed
      ? '\nFAILED'
      : '\nALL PASS - HIT, STALE, on-demand-revalidate, and the build prerender all carry a covering CSP on Next 15; the plain first-fill MISS is recorded per the caveat above.',
  )
  process.exitCode = failed ? 1 : 0
}

run().catch((e) => {
  console.error('ERROR:', e.message)
  process.exitCode = 1
})
