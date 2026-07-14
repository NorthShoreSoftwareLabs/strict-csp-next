# strict-csp-next — Next.js 15 zero-'self' SRI example

A minimal but real Next.js 15 App Router app that proves the **zero-`'self'` SRI
path**: on static and ISR routes, `script-src` carries NO `'self'`, HAS
`'strict-dynamic'`, and every external `<script src>` in the prerendered HTML
carries an `integrity` attribute. It is the artifact CI job `e2e-next15-sri` runs.

## How it differs from `examples/next15`

`examples/next15` wires the library the same way but does **not** run the
integrity backfill, so Next leaves the client-component chunks un-pinned and the
policy keeps `'self'`. This example adds one thing: `postbuild.mjs` calls
`runPostbuild({ backfillIntegrity: true })` (the `strict-csp-next postbuild
--backfill` equivalent). That backfill hashes the un-pinned chunks on disk and
injects the missing `integrity`. Once every external script is pinned
(`uncoveredExternal === 0`), the coverage gate in `src/policy.ts` drops `'self'`
and adds `'strict-dynamic'`.

```js
// next.config.mjs — enables experimental.sri (integrity on most bundle scripts)
export default withStrictCsp(nextConfig)

// postbuild.mjs — pins the rest and writes the manifest
runPostbuild({ projectDir, backfillIntegrity: true })

// middleware.js — Node runtime so the disk-read manifest works (stable in 15.5)
export { strictCsp as middleware } from 'strict-csp-next/proxy'
export const config = { runtime: 'nodejs', matcher: [ /* ... */ ] }
```

## Routes

| Route | Delivered policy | What it exercises |
| --- | --- | --- |
| `/` | zero-`'self'`: hashes + integrity + `'strict-dynamic'` | static shell, client-component hydration, full SRI coverage |
| `/isr` | zero-`'self'`: same shape | ISR via `export const revalidate = 60` |
| `/dynamic` | `'self'` + hashes + per-request nonce | fully dynamic; the deliberate contrast — a nonce route keeps `'self'` by design and is **not** asserted zero-`'self'` |

Static routes assert: no `'self'`, `'strict-dynamic'` present, hashes present,
`<script integrity=>` on every external script in the HTML, no nonce, still
cacheable (no `no-store`). Every route asserts: zero `securitypolicyviolation`
events, working hydration (counter click → "clicked 1 times"), a CSP header, and
no `'unsafe-inline'` / `'unsafe-eval'`. `sri-test.mjs` is the Playwright runner.

## Run it

The example consumes the library from a packed tarball, so use the helper script
(it packs, installs, builds, starts on port 4500, and runs the browser test):

```bash
bash e2e.sh 15                # webpack build against next@15 (latest 15.x)
bash e2e.sh 15.5              # a specific 15.x
bash e2e.sh 15 turbopack      # Turbopack build (next build --turbopack)
```

## Turbopack

The `turbopack` variant runs `next build --turbopack` (a stable production build
in Next 15.5+) and then the identical `sri-test.mjs` assertions — **if** the build
succeeds.

As of Next.js 15.5.x it does not. Turbopack refuses to build when
`experimental.sri` is set, rejecting it as an unsupported configuration option:

```
⨯ You are using configuration and/or tools that are not yet
supported by Next.js with Turbopack:
- Unsupported Next.js configuration option(s) (next.config.js)
  To use Turbopack, remove the following configuration options:
    - experimental.sri.algorithm
```

`experimental.sri` is what stamps `integrity` on the bundle scripts, and that
integrity coverage is what earns the `'self'`-drop. There is no Turbopack-native
substitute, so on Next 15.5.x the zero-`'self'` SRI path is a **webpack-only**
build. The `turbopack` variant detects this exact, documented incompatibility and
reports it explicitly (a clean exit, not a fake pass) rather than pretending the
assertions ran. Any other build failure is treated as a real error, and if a
future Turbopack release accepts `experimental.sri`, the build succeeds and the
same zero-`'self'` assertions run unchanged.

The webpack variant (`bash e2e.sh 15`) is the one that proves the zero-`'self'`
SRI path end-to-end.
