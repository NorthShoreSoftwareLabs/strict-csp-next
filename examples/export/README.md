# strict-csp-next export example

A statically exported Next.js app (`output: 'export'`) served from a plain file
server with no CSP response header. The policy lives in an injected
`<meta http-equiv="Content-Security-Policy">`, so it works on any CDN.

`postbuild.mjs` runs `runPostbuild({ exportDir: 'out' })`, which injects the meta
CSP (inline-script hashes) into every file in `out/`. `experimental.sri` adds
`integrity` to the external bundles, so the result is `script-src 'self'` plus
hashes for inline and integrity for bundles.

## Run it

```bash
bash export-e2e.sh            # against the pinned Next.js
bash export-e2e.sh canary     # against next@canary
```

`export-test.mjs` serves `out/` with no CSP header and asserts zero violations
plus hydration in Chromium.
