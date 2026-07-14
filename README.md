# strict-csp-next

Strict Content-Security-Policy for the Next.js App Router, version 15.5 and up. No
`'unsafe-inline'` and no `'unsafe-eval'` for scripts, and your pages stay static.

```bash
npm install strict-csp-next
# or: pnpm add strict-csp-next
# or: yarn add strict-csp-next
```

> Requires Next.js 15.5+ (App Router), where the Node.js middleware runtime is
> stable. Next 15.2 through 15.4 work with `experimental.nodeMiddleware`. The entry
> file is `proxy.ts` on Next 16 and `middleware.ts` on Next 15. See
> [Next.js 15](#nextjs-15).
>
> Status: v0.1, early. The core mechanism is proven in a real browser across
> static, dynamic, and PPR / Cache Components rendering. See [the proof](#proven).

## Why

The App Router hydrates with inline `<script>` blocks. A strict `script-src`
blocks every one of them unless it carries a nonce or a hash. A nonce only exists
when the page renders per request, and the official answer pairs a nonce with
`force-dynamic`, which throws away static and CDN caching. A hash works for bytes
fixed at build time, but Next gives you no way to hash the shell. So today you
choose a strict script policy or static rendering, but not both.

This package gives you both. It hashes the static shell at build time and lets a
per-request nonce cover whatever streams in, in one policy, with no flicker, no
injected JS, and no fork of Next.

## How it works

Different rendering modes need different credentials, because a hash needs bytes
known at build and a nonce needs a fresh value per request. The package picks the
right one per route:

| Mode | Credential | Cacheable | Vercel | Self-hosted |
| --- | --- | --- | --- | --- |
| `static` | build-time hashes of the shell's inline scripts | yes | yes | yes |
| `isr`, stable inline data | build-time hashes (treated as static) | yes | yes | yes |
| `isr`, changing inline data | hashes recomputed on every revalidation (cache handler) | yes | **no** | yes |
| `ppr` | hashes for the shell **and** a per-request nonce for the resume | no (nonced) | yes | yes |
| `dynamic` | a per-request nonce | no (nonced) | yes | yes |

The one mode that does not work on Vercel is `isr` whose inline data changes on
revalidation. That needs the cache handler (`withStrictCspCache`), which
recomputes the hash at cache-write time, and Vercel ignores a custom
`cacheHandler` and owns the ISR cache itself, so the header never reaches the
edge. It works on self-hosted Next (`next start`, Docker). Everything else works
on both. See [how it works](./docs/how-it-works.md#3-the-cache-handler-isr) and
[deployment](./docs/deployment.md).

A PPR route carries both in one header:
`script-src 'self' 'sha256-<shell>' 'nonce-<per request>'`. The insight that makes
this work: Next reads a nonce you hand it on the request header and reuses it for
what it streams, and providing a nonce does not force dynamic rendering (only
reading it does). So the shell stays static while the resume still gets a nonce.

Read the full mechanism, including why it is safe and what it depends on, in
**[How it works](./docs/how-it-works.md)**.

## Quickstart

**1. Run the build step after `next build`.** It scans the prerendered output,
writes the hash manifest, and fails the build if any inline script is left
uncovered.

```json
{ "scripts": { "build": "next build && strict-csp-next postbuild" } }
```

**2. Add the proxy.** Next.js 16 renamed `middleware.ts` to `proxy.ts`, which
always runs on the Node.js runtime.

```ts
// proxy.ts
export { strictCsp as proxy } from 'strict-csp-next/proxy'

export const config = {
  matcher: [
    {
      source:
        '/((?!api|_next/static|_next/image|favicon.ico|(?:opengraph-image|twitter-image|apple-icon|icon)(?:$|\\.|/)|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|txt|xml|json|webmanifest)$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
```

That is the whole setup for a self-hosted Node server. The matcher excludes static
assets and the file-based metadata routes that have no HTML to protect; the
reasoning, and what to add for your own non-HTML routes, is in
[Deployment](./docs/deployment.md#the-matcher). Other hosts deliver the manifest
differently. See **[Deployment](./docs/deployment.md)** for Vercel, Docker
(`standalone`), static export, and dev.

**Reading the nonce.** If you render your own inline script, read the nonce the
proxy set:

```tsx
import { headers } from 'next/headers'
const nonce = (await headers()).get('x-nonce')
```

### Next.js 15

On Next.js 15 the entry file is `middleware.ts`, not `proxy.ts`. Next 15 does not
read `proxy.ts`; if you create one it ships no CSP and raises no error, so a Next 15
app must wire `middleware.ts`. The runtime function is the same. Only the file name
and the export name change.

The proxy runs only on the Node.js runtime, because the manifest loader
statically imports `node:fs` to read the manifest from disk. (Nonces use Web
Crypto, which runs on either runtime.) Next 15 middleware runs on the Edge
runtime by default, so set `runtime: 'nodejs'` to opt in:

```ts
// middleware.ts  (Next 15, Node.js runtime)
export { strictCsp as middleware } from 'strict-csp-next/proxy'
export const config = { runtime: 'nodejs', matcher: [ /* same matcher as proxy */ ] }
```

The Node.js middleware runtime is stable in Next 15.5. On 15.2 through 15.4 it is
experimental and needs `experimental: { nodeMiddleware: true }` in `next.config`.

The postbuild step, the options, and the matcher are identical to Next 16. See
[Deployment](./docs/deployment.md#nextjs-15) for the full Next 15 wiring.

## Configuration

Pass options to `createStrictCsp`:

```ts
import { createStrictCsp } from 'strict-csp-next/proxy'

export const proxy = createStrictCsp({
  strictDynamic: true, // let trusted scripts load more (tag managers, next/script)
  directives: {
    'connect-src': ["'self'", 'https://api.example.com'],
  },
})
```

The defaults cover first-party content. Reach for `connect-src` for an external
API, `frame-src` for embeds like Stripe or YouTube, and `worker-src` for a Web
Worker. `'unsafe-inline'`, `'unsafe-eval'`, and `'unsafe-hashes'` are stripped
from any script directive you pass, so the strict guarantee cannot be reopened.

Every option, the CLI, and the lower-level exports are in the
**[API reference](./docs/api-reference.md)**.

## Dropping `'self'` with SRI

On a prerendered page the external `/_next/static/chunks/*.js` tags cannot be
covered by a nonce, so the static path falls back to `'self'`. To remove it, pin
every chunk by Subresource Integrity hash and let the postbuild backfill the tags
Next leaves un-pinned:

```js
// next.config.mjs — withStrictCsp enables experimental.sri for you
import { withStrictCsp } from 'strict-csp-next'
export default withStrictCsp({ cacheComponents: true })
```

`cacheComponents` is a Next.js 16 flag. On Next.js 15 the equivalent is
`experimental: { ppr: 'incremental', dynamicIO: true }`, and the SRI backfill
needs Next 15.2 or newer, where `experimental.sri` emits integrity on the Node.js
runtime. Below 15.2 the static path keeps `'self'`.

```json
// package.json
{ "scripts": { "build": "next build && strict-csp-next postbuild --backfill" } }
```

`--backfill` hashes each un-pinned chunk's on-disk bytes and writes the
`integrity` attribute into the prerendered HTML. Once coverage is complete, the
policy drops `'self'` and adds `'strict-dynamic'`. The pass is idempotent, and a
partial-coverage build is never allowed to drop `'self'` — if a chunk slips
through, the safe `'self' <inline> <integrity>` shape ships instead.

### Using a CDN / `assetPrefix`

When `assetPrefix` points `_next/static` at a CDN on another origin, SRI requires
a CORS-eligible fetch. With the default `crossOrigin: 'auto'` the backfill detects
the cross-origin prefix, adds `crossorigin="anonymous"` to the backfilled tags,
and prints a build-time note. **Your CDN must return
`Access-Control-Allow-Origin` for the `_next/static` files**, or the browser
blocks them as SRI failures. Same-origin deployments (no `assetPrefix`, a relative
one, or the same host — every default Vercel deploy) need no configuration. Force
the value with `--cross-origin=anonymous|use-credentials`, or disable it with
`--cross-origin=false` for a same-origin proxy whose `assetPrefix` only looks
absolute.

## Deployment at a glance

| Host | How the manifest reaches the proxy |
| --- | --- |
| Self-hosted Node | Read from disk next to the process. Nothing extra. |
| Vercel / serverless | Import it via `createStrictCsp({ manifest })` and pin `generateBuildId` — the runtime disk read is unreliable in Vercel's middleware bundle. The manifest must come from a build on the deploy host. |
| Docker (`standalone`) | The build step copies it into the bundle. |
| Static export | No server. The policy ships as a `<meta>` tag via `postbuild --export`. |

Details, including the failure mode each option avoids, are in
**[Deployment](./docs/deployment.md)**.

## Proven

Measured in real Chromium against a Next 16.2.7 app, capturing
`securitypolicyviolation` events and confirming hydration.

Static page:

| `script-src` | Inline violations | Hydrates |
| --- | --- | --- |
| `'self'` (strict baseline) | 5 | no |
| `'self' 'unsafe-inline'` (status quo) | 0 | yes |
| `'self' '<sha256 ×5>'` (this package) | 0 | yes |

PPR / Cache Components route:

| `script-src` | Violations | Hole resolves | Hydrates |
| --- | --- | --- | --- |
| `'self'` (baseline) | 6 | yes | no |
| `'self' 'nonce-X'` (no shell hash) | 1 | yes | yes |
| `'self' '<shell hash>' 'nonce-X'` (this package) | 0 | yes | yes |

The middle PPR row is the whole point. With a nonce alone, exactly one script
still violates: the bare prerendered shell script. Hash it and you reach zero,
while the shell is still served statically.

The browser matrix is the package's end-to-end test and runs in CI, including a
scheduled run against `next@canary` so a change in how Next emits inline scripts
is caught early.

## Security

The library owns `script-src`, validates every caller-supplied directive against
policy injection, mints unguessable single-use nonces, and guards the hash
scanner with a three-signal self-check that fails the build on drift. Read the
**[security model](./docs/security.md)** for the guarantees and their defenses.

## Compatibility

`basePath`, `trailingSlash`, `assetPrefix`, `generateStaticParams`, `standalone`,
and static export all work. Custom `distDir` is supported. Dynamic, parallel, and
i18n routes fall through to the nonce-only policy. The full matrix of
`next.config` settings and features is in
**[Compatibility](./docs/compatibility.md)**, which also covers the one rule worth
repeating: do not set your own CSP header, since the browser enforces the
intersection of two policies.

## Documentation

- **[How it works](./docs/how-it-works.md)** covers the mechanism in depth.
- **[API reference](./docs/api-reference.md)** documents every option, the CLI, and the exports.
- **[Deployment](./docs/deployment.md)** covers server, Vercel, Docker, export, and dev.
- **[Security model](./docs/security.md)** lists the guarantees and their defenses.
- **[Compatibility](./docs/compatibility.md)** is the full matrix of `next.config` settings, features, and limitations.

## License

MIT
