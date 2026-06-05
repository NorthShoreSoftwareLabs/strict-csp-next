# strict-csp-next matrix example

A Next.js 16 (`cacheComponents`) app that exercises every rendering mode under a
strict CSP, and a Playwright test asserting zero violations on each route. It is
also the package's end-to-end test (run in CI).

## Routes

| Route | What it exercises |
| --- | --- |
| `/` | static shell, client-component hydration |
| `/isr` | ISR config (forced to PPR by cacheComponents) |
| `/dynamic` | a fully dynamic hole via `connection()` |
| `/ppr` | rich PPR shell plus two Suspense holes |
| `/inline` | an author `<script nonce={nonce}>` reading the `x-nonce` header |
| `/third-party` | a same-origin `next/script` |

## Run it

The example consumes the library from a packed tarball, so use the helper script
(it packs, installs, builds, starts, and runs the browser matrix):

```bash
bash ci-e2e.sh            # default server output, against the pinned Next.js
bash ci-e2e.sh canary     # against next@canary
bash standalone-e2e.sh    # output: 'standalone', via the real standalone server
```

Wiring is in `proxy.js` (the per-request policy) and `postbuild.mjs` (the build
step that writes the manifest). `matrix-test.mjs` is the Playwright runner.
