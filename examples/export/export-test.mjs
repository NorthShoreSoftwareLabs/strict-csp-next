// Serve out/ with NO CSP header (the injected <meta> is the policy) and assert
// zero violations + hydration in Chromium. Exits non-zero on failure.
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'out')
const PORT = Number(process.env.PORT || 4322)
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
}

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0])
  if (p === '/') p = '/index.html'
  let file = path.join(OUT, p)
  if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html'
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404
    return res.end('nf')
  }
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream')
  // No Content-Security-Policy header on purpose: the meta tag is the policy.
  res.end(fs.readFileSync(file))
})
await new Promise((r) => server.listen(PORT, r))

const browser = await chromium.launch()
const page = await browser.newPage()
await page.addInitScript(() => {
  window.__v = []
  document.addEventListener('securitypolicyviolation', (e) =>
    window.__v.push(e.violatedDirective + ' :: ' + (e.blockedURI || 'inline'))
  )
})
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'networkidle' })
await page.waitForTimeout(500)
const violations = await page.evaluate(() => window.__v)
const metaPresent = (await page.locator('meta[http-equiv="Content-Security-Policy"]').count()) > 0
let hydrated = false
try {
  const btn = page.locator('[data-hydration-button]')
  await btn.click({ timeout: 1500 })
  hydrated = /clicked 1 times/.test(await btn.innerText())
} catch {}

await browser.close()
server.close()

const ok = violations.length === 0 && hydrated && metaPresent
console.log(JSON.stringify({ violations: violations.length, sample: violations.slice(0, 3), hydrated, metaPresent }, null, 2))
console.log(ok ? 'EXPORT PASS - zero violations, meta-delivered policy' : 'EXPORT FAIL')
process.exit(ok ? 0 : 1)
