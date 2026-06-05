// matrix-test.mjs — End-to-end CSP matrix test for strict-csp-next.
// Run AFTER next build && node postbuild.mjs && next start -p 4200.
// Usage: node matrix-test.mjs
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const BASE = process.env.BASE || 'http://localhost:4200'

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

  // PPR hole checks.
  const holeA = await page.locator('[data-hole="a"]').count().then((n) => n > 0).catch(() => false)
  const holeB = await page.locator('[data-hole="b"]').count().then((n) => n > 0).catch(() => false)

  // /third-party: vendor.js executed.
  const vendorRan = await page.locator('#vendor-result').innerText()
    .then((t) => t.includes('vendor.js loaded'))
    .catch(() => false)

  // Raw HTML analysis (fetch separately to avoid browser timing).
  const raw = await fetch(`${BASE}${path}`).then((r) => r.text()).catch(() => '')
  const bareScripts = [...raw.matchAll(/<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)[^>]*>([\s\S]*?)<\/script>/g)].length
  const noncedScripts = [...raw.matchAll(/<script[^>]*\bnonce=/g)].length
  const cspHeader = await fetch(`${BASE}${path}`).then((r) => r.headers.get('content-security-policy') || '').catch(() => '')
  const hashesInPolicy = (cspHeader.match(/'sha256-[^']+'/g) || []).length
  const hasNonce = cspHeader.includes("'nonce-")

  await ctx.close()

  return {
    path,
    violations: violations.length,
    violationDetails: violations.slice(0, 3),
    hydrated,
    holeA,
    holeB,
    vendorRan,
    bareScriptsInHTML: bareScripts,
    noncedScriptsInHTML: noncedScripts,
    policyHashes: hashesInPolicy,
    policyHasNonce: hasNonce,
    loadError,
  }
}

const routes = [
  { path: '/', waitMs: 1500 },
  { path: '/isr', waitMs: 1500 },
  { path: '/dynamic', waitMs: 2000 },
  { path: '/ppr', waitMs: 2000 },
  { path: '/inline', waitMs: 2000 },
  { path: '/third-party', waitMs: 2000 },
]

const browser = await chromium.launch()
const results = []

for (const route of routes) {
  process.stdout.write(`Testing ${route.path}... `)
  const r = await testRoute(browser, route.path, route.waitMs)
  const ok = r.violations === 0 && !r.loadError
  console.log(ok ? 'PASS' : `FAIL (${r.violations} violations${r.loadError ? ', loadError' : ''})`)
  results.push(r)
}

await browser.close()

// Summary table.
console.log('\n=== CSP MATRIX RESULTS ===\n')
const labels = {
  '/': 'static (PPR shell, no dynamic holes)',
  '/isr': 'isr (cacheComponents forces ppr; revalidate incompatible)',
  '/dynamic': 'dynamic (connection() in Suspense hole)',
  '/ppr': 'ppr (rich shell + 2 Suspense holes, Counter button)',
  '/inline': 'inline (author <script nonce={nonce}> from x-nonce header)',
  '/third-party': 'third-party (next/script /vendor.js same-origin)',
}
for (const r of results) {
  const status = r.violations === 0 && !r.loadError ? 'PASS' : 'FAIL'
  console.log(`[${status}] ${r.path}`)
  console.log(`       mode: ${labels[r.path] || r.path}`)
  console.log(`       violations: ${r.violations} | hydrated: ${r.hydrated} | holeA: ${r.holeA} | holeB: ${r.holeB} | vendorRan: ${r.vendorRan}`)
  console.log(`       HTML bareScripts: ${r.bareScriptsInHTML} | noncedScripts: ${r.noncedScriptsInHTML}`)
  console.log(`       policy: ${r.policyHashes} hashes | nonce: ${r.policyHasNonce}`)
  if (r.violationDetails.length) console.log(`       VIOLATION DETAILS: ${JSON.stringify(r.violationDetails)}`)
  if (r.loadError) console.log(`       loadError: ${r.loadError}`)
  console.log()
}

const allPass = results.every((r) => r.violations === 0 && !r.loadError)
console.log(allPass ? 'ALL PASS - zero CSP violations across all routes' : 'SOME FAILURES - see details above')
