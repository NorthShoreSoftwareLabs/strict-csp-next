# strict-csp-next — Next.js 15 verification example

A minimal but real Next.js 15 App Router app that proves the library works on
Next 15. It is the artifact CI job `e2e-next15` runs.

Unlike the `matrix` example (Next 16, wired via `proxy.js` and `cacheComponents`),
this app wires the library through **`middleware.js`**. Next 16 renamed
`middleware.js` to `proxy.js`; Next 15 ignores `proxy.js`, so the per-request CSP
handler must be exported from `middleware.js` here:

```js
// middleware.js
export { strictCsp as middleware } from 'strict-csp-next/proxy'
export const config = {
  runtime: 'nodejs', // Node runtime so the disk-read manifest works; stable in 15.5
  matcher: [ /* excludes static assets, route handlers, metadata routes */ ],
}
```

`next.config.mjs` wraps the config with `withStrictCsp` (which enables
`experimental.sri` so static/ISR routes get integrity hashes). `cacheComponents`
is deliberately not used — it is Next 16 only.

## Routes

| Route | What it exercises |
| --- | --- |
| `/` | static shell, client-component hydration, build-time hashes + SRI |
| `/isr` | ISR via `export const revalidate = 60` |
| `/dynamic` | fully dynamic via `export const dynamic = 'force-dynamic'`, per-request nonce |

Each route asserts: zero `securitypolicyviolation` events, working hydration
(counter click → "clicked 1 times"), a CSP header whose `script-src` covers
scripts with hashes (static/ISR) or a nonce (dynamic), and no `'unsafe-inline'`.

## Run it

The example consumes the library from a packed tarball, so use the helper script
(it packs, installs, builds, starts on port 4300, and runs the browser test):

```bash
bash e2e.sh 15       # against next@15 (latest 15.x)
bash e2e.sh 15.2     # against a specific 15.x
```

Wiring is in `middleware.js` (per-request policy) and `postbuild.mjs` (writes the
manifest). `next15-test.mjs` is the Playwright runner.
