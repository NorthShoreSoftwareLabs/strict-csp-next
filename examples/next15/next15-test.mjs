// next15-test.mjs — End-to-end CSP test for strict-csp-next on Next.js 15.
// Run AFTER next build && node postbuild.mjs && next start -p 4300.
// Usage: node next15-test.mjs
//
// This test is written to FAIL on a security downgrade, not just on a broken
// page. It captures the raw `script-src` directive per route and asserts on its
// exact shape: no 'unsafe-inline', no 'unsafe-eval', hashes on static routes, a
// UNIQUE per-request nonce on the dynamic route. A predictable/static nonce is a
// full CSP bypass, so /dynamic is fetched twice and the two nonces must differ.
import { chromium } from 'playwright'

const BASE = process.env.BASE || 'http://localhost:4300'

// Whether static routes achieve a zero-'self' policy via SRI. This is set to the
// empirically observed shape of `/` (see the report accompanying this change):
// when true, static routes must additionally drop 'self', carry 'strict-dynamic',
// and ship <script integrity=...> attributes. When false, we assert only the
// honest baseline (hashes present, no unsafe-*), because without an integrity
// backfill Next keeps 'self' in the policy. Do NOT flip this to true unless the
// real `/` script-src proves it — an unearned zero-'self' claim is a lie.
const STATIC_ZERO_SELF = false

// Pull the script-src directive out of a CSP header string.
function scriptSrc(cspHeader) {
  const m = cspHeader
    .split(';')
    .map((d) => d.trim())
    .find((d) => d.startsWith('script-src'))
  return m || ''
}

// Analyze the shape of a script-src directive into auditable booleans/counts.
function analyzeScriptSrc(directive) {
  return {
    directive,
    hasUnsafeInline: directive.includes("'unsafe-inline'"),
    hasUnsafeEval: directive.includes("'unsafe-eval'"),
    hasSelf: /(^|\s)'self'(\s|$)/.test(directive),
    hasStrictDynamic: directive.includes("'strict-dynamic'"),
    hashCount: (directive.match(/'sha\d{3}-[^']+'/g) || []).length,
    hasNonce: directive.includes("'nonce-"),
    nonce: (directive.match(/'nonce-([^']+)'/) || [])[1] || null,
  }
}

// Fetch a route and return its raw HTML, CSP header, cache-control, and the
// analyzed script-src. Fetched directly (not via the browser) so header/HTML
// analysis is deterministic and not subject to page timing.
async function fetchRoute(path) {
  const res = await fetch(`${BASE}${path}`)
  const html = await res.text()
  const csp = res.headers.get('content-security-policy') || ''
  const cacheControl = res.headers.get('cache-control') || ''
  return {
    html,
    csp,
    cacheControl,
    scriptSrc: analyzeScriptSrc(scriptSrc(csp)),
  }
}

async function testRoute(browser, path, waitMs = 1500) {
  const ctx = await browser.newContext()
  const page = await ctx.newPage()

  // Capture native CSP violation events — the authoritative source.
  await page.addInitScript(() => {
    window.__cspv = []
    document.addEventListener('securitypolicyviolation', (e) => {
      window.__cspv.push({
        directive: e.violatedDirective,
        uri: e.blockedURI || 'inline',
        sample: (e.scriptSample || '').slice(0, 60),
      })
    })
  })

  let loadError = null
  try {
    await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 20000 })
    await new Promise((r) => setTimeout(r, waitMs))
  } catch (e) {
    loadError = e.message.slice(0, 100)
  }

  const violations = await page.evaluate(() => window.__cspv || []).catch(() => [])

  // Hydration check: click the counter button, assert state update.
  let hydrated = false
  try {
    const btn = page.locator('[data-hydration-button]').first()
    if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
      await btn.click({ timeout: 2000 })
      await new Promise((r) => setTimeout(r, 300))
      hydrated = /clicked 1 times/.test(await btn.innerText())
    }
  } catch {}

  await ctx.close()

  // Raw HTML + header analysis. For the dynamic route, fetch TWICE so we can
  // prove the nonce is per-request unique; a reused nonce defeats the policy.
  const first = await fetchRoute(path)
  const second = await fetchRoute(path)

  const raw = first.html
  const bareScripts = [
    ...raw.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)[^>]*>([\s\S]*?)<\/script>/g),
  ].length
  const noncedScripts = [...raw.matchAll(/<script[^>]*\bnonce=/g)].length
  const integrityCount = [...raw.matchAll(/<script[^>]*\bintegrity=/g)].length

  const s = first.scriptSrc
  const nonceA = first.scriptSrc.nonce
  const nonceB = second.scriptSrc.nonce
  // Two nonces are "distinct" only if both are present and they differ.
  const noncesDiffer = Boolean(nonceA && nonceB && nonceA !== nonceB)
  // A static route must not be marked no-store (it should stay cacheable).
  const hasNoStore = /no-store/.test(first.cacheControl)

  return {
    path,
    violations: violations.length,
    violationDetails: violations.slice(0, 3),
    hydrated,
    loadError,
    bareScriptsInHTML: bareScripts,
    noncedScriptsInHTML: noncedScripts,
    integrityCount,
    cspPresent: first.csp.length > 0,
    scriptSrcPresent: s.directive.length > 0,
    rawScriptSrc: s.directive,
    hasUnsafeInline: s.hasUnsafeInline,
    hasUnsafeEval: s.hasUnsafeEval,
    hasSelf: s.hasSelf,
    hasStrictDynamic: s.hasStrictDynamic,
    hashCount: s.hashCount,
    hasNonce: s.hasNonce,
    nonceA,
    nonceB,
    noncesDiffer,
    cacheControl: first.cacheControl,
    hasNoStore,
  }
}

const routes = [
  { path: '/', kind: 'static', waitMs: 1500 },
  { path: '/isr', kind: 'static', waitMs: 1500 },
  { path: '/dynamic', kind: 'dynamic', waitMs: 2000 },
]

const browser = await chromium.launch()
const results = []

for (const route of routes) {
  process.stdout.write(`Testing ${route.path}... `)
  const r = await testRoute(browser, route.path, route.waitMs)
  r.kind = route.kind

  // Universal assertions — true for EVERY route regardless of render mode. These
  // are the invariants that a security downgrade would break.
  const failures = []
  if (r.hasUnsafeInline) failures.push("script-src has 'unsafe-inline'")
  if (r.hasUnsafeEval) failures.push("script-src has 'unsafe-eval'")
  if (!r.cspPresent) failures.push('no CSP header')
  if (!r.scriptSrcPresent) failures.push('no script-src directive')
  if (!r.hydrated) failures.push('did not hydrate')
  if (r.loadError) failures.push(`load error: ${r.loadError}`)
  if (r.violations !== 0) failures.push(`${r.violations} CSP violation(s)`)

  if (route.kind === 'static') {
    // Static routes: covered by build-time hashes, no nonce, still cacheable.
    if (!(r.hashCount > 0)) failures.push('static route has no hashes in script-src')
    if (r.hasNonce) failures.push('static route unexpectedly carries a nonce')
    if (r.hasNoStore) failures.push('static route marked no-store (should stay cacheable)')
    // Zero-'self' SRI claim — only enforced when the real policy earns it.
    if (STATIC_ZERO_SELF) {
      if (r.hasSelf) failures.push("static route retains 'self' (zero-'self' claim broken)")
      if (!r.hasStrictDynamic) failures.push("static route missing 'strict-dynamic'")
      if (!(r.integrityCount > 0)) failures.push('static route has no <script integrity=> attributes')
    }
  } else if (route.kind === 'dynamic') {
    // Dynamic route: per-request nonce that MUST be unique across requests.
    if (!r.hasNonce) failures.push('dynamic route missing nonce')
    if (!r.noncesDiffer) {
      failures.push(
        `dynamic nonce not per-request unique (a=${r.nonceA || 'none'} b=${r.nonceB || 'none'})`,
      )
    }
  }

  r.ok = failures.length === 0
  r.failures = failures
  console.log(r.ok ? 'PASS' : 'FAIL')
  results.push(r)
}

await browser.close()

// Summary table.
console.log('\n=== CSP RESULTS (Next 15) ===\n')
const zeroSelfLabel = STATIC_ZERO_SELF
  ? "zero-'self' (SRI: hashes + strict-dynamic + integrity)"
  : "hashes; 'self' retained (no SRI backfill)"
const labels = {
  '/': `static (${zeroSelfLabel})`,
  '/isr': `isr (revalidate=60; ${zeroSelfLabel})`,
  '/dynamic': 'dynamic (force-dynamic, per-request nonce)',
}
for (const r of results) {
  console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.path}`)
  console.log(`       mode: ${labels[r.path] || r.path}`)
  console.log(`       violations: ${r.violations} | hydrated: ${r.hydrated}`)
  console.log(`       HTML bareScripts: ${r.bareScriptsInHTML} | noncedScripts: ${r.noncedScriptsInHTML} | integrity: ${r.integrityCount}`)
  console.log(`       csp present: ${r.cspPresent} | script-src present: ${r.scriptSrcPresent}`)
  console.log(
    `       shape: hashes=${r.hashCount} | nonce=${r.hasNonce} | self=${r.hasSelf} | strict-dynamic=${r.hasStrictDynamic} | unsafe-inline=${r.hasUnsafeInline} | unsafe-eval=${r.hasUnsafeEval}`,
  )
  if (r.kind === 'dynamic') {
    console.log(`       nonce uniqueness: a=${r.nonceA} b=${r.nonceB} differ=${r.noncesDiffer}`)
  } else {
    console.log(`       cache-control: ${r.cacheControl || '(none)'}`)
  }
  console.log(`       raw script-src: ${r.rawScriptSrc || '(none)'}`)
  if (r.failures && r.failures.length) console.log(`       FAILURES: ${JSON.stringify(r.failures)}`)
  if (r.violationDetails.length) console.log(`       VIOLATION DETAILS: ${JSON.stringify(r.violationDetails)}`)
  if (r.loadError) console.log(`       loadError: ${r.loadError}`)
  console.log()
}

// Guard against a vacuous pass: every declared route must have produced a result
// AND every result must pass. `results.every` alone is true for an empty array.
const allPass = results.length === routes.length && results.every((r) => r.ok)
console.log(
  allPass
    ? 'ALL PASS - zero CSP violations, hydration works, strict script-src on all routes'
    : 'SOME FAILURES - see details above',
)
if (!allPass) process.exit(1)
