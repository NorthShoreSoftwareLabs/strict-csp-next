# Deployment

The proxy needs the manifest at runtime. How it gets there depends on where you
run. Pick the section that matches your host.

## The matcher

Every deployment uses a `config.matcher` to decide which requests the proxy runs
on. The proxy runs before the response, so it cannot read the content-type and
branch on it. Anything the matcher lets through that has no prerendered HTML (a
`route.ts` handler, an `opengraph-image`) gets a nonce and `Cache-Control:
no-store`, which makes that feed or image uncacheable.

```ts
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

This excludes static assets by extension, Next internals, and the file-based
metadata routes. The metadata names are anchored to a full path segment: the name
must be followed by end of path, `.`, or `/`. So a real page that shares a prefix
(`/icons`, `/opengraph-image-gallery`) is still proxied and keeps its CSP rather
than being excluded by accident, which would silently ship that page with no CSP
at all. Extension-less custom Route Handlers (an `/rss` feed, say) are not
auto-excluded, so add your own non-HTML routes to the list.

> **Good to know.** Under `basePath`, Next prefixes the matcher `source` with the
> base path for you. Leave the matcher as written.

## Next.js 15

The host sections below show `proxy.ts`, the Next.js 16 entry file. On Next.js 15
the entry file is `middleware.ts`. Next 15 ignores `proxy.ts` and ships no CSP if
you create one, with no error, so a Next 15 app must wire `middleware.ts`. The
runtime function is the same. Only the file name and the export name change.

The proxy runs only on the Node.js runtime, because it statically imports
`node:fs` (via the manifest loader) to read the manifest from disk. Nonces are
minted with Web Crypto (`globalThis.crypto`), which runs on either runtime, so
the disk read is the constraint. Next 15 middleware runs on the Edge runtime by
default, so opt the middleware into the Node.js runtime with `runtime: 'nodejs'`
in `config`. The disk read then finds the
manifest exactly as the self-hosted server default does, with no manifest import.
This wiring uses the [matcher above](#the-matcher) unchanged:

```ts
// middleware.ts  (Next 15, Node.js runtime)
export { strictCsp as middleware } from 'strict-csp-next/proxy'
export const config = {
  runtime: 'nodejs',
  matcher: [ /* the matcher above */ ],
}
```

Next 15.5 is the clean floor: the Node.js middleware runtime is stable there. On
15.2 through 15.4 it is experimental and needs `experimental: { nodeMiddleware:
true }` in `next.config`.

Everything the [Server](#server-self-hosted-node) and host sections below describe
about manifest delivery applies unchanged. On Vercel, follow the
[Vercel section](#vercel-and-other-bundledserverless-hosts) for the manifest.

## Server (self-hosted Node)

The default. The proxy reads `<distDir>/strict-csp-manifest.json` from the project
root, which sits next to the running process.

```ts
// proxy.ts
export { strictCsp as proxy } from 'strict-csp-next/proxy'
```

```json
{ "scripts": { "build": "next build && strict-csp-next postbuild" } }
```

## Vercel (and other bundled/serverless hosts)

On Vercel the proxy runs from `/var/task` as its own traced bundle, and Vercel's
file tracing only includes files it can see in a static `import` or `require`.
The manifest `postbuild` writes is not traced in automatically, so the runtime
disk read returns nothing and every prerendered route falls back to a nonce-only
policy. That breaks hydration on static and PPR shells. The proxy logs a one-time
warning when the manifest is missing, so this is diagnosable rather than silent.

### Recommended: trace the manifest into the proxy bundle

Tell Next to include the manifest in the proxy bundle, then let the runtime disk
read find it. This serves *this* build's manifest with no extra build steps:

```js
// next.config.mjs
export default {
  outputFileTracingIncludes: {
    // The key that targets the proxy bundle can vary by Next version, so verify
    // on a preview deploy that the proxy's "no CSP manifest found" warning does
    // NOT appear in the logs.
    '/proxy': ['./.next/strict-csp-manifest.json'],
  },
}
```

### Alternative: pass the manifest in

Passing the manifest to `createStrictCsp` sidesteps the runtime disk read. The
catch is timing: a bare `import` inlines the file at build time, but `postbuild`
writes the manifest *after* `next build`, so the import captures the *previous*
build's manifest and can ship stale hashes that block the shell. If you import,
build twice so the second pass sees this build's manifest:

```jsonc
// package.json
{ "scripts": { "build": "next build && strict-csp-next postbuild && next build" } }
```

```ts
// proxy.ts
import { createStrictCsp } from 'strict-csp-next/proxy'
import manifest from './.next/strict-csp-manifest.json' with { type: 'json' }

export const proxy = createStrictCsp({ manifest })
```

Use the current import-attribute syntax (`with { type: 'json' }`), not the
deprecated `assert`.

**Pin the build id when you import.** Next stamps a fresh `buildId` into the
inline RSC payload (`"b":"…"`) on every `next build`, so the manifest captured in
the first pass lists a hash for the first pass's build id, while the second pass
serves a different one — one shell script ends up uncovered and blocked. Pin the
build id so both passes (and redeploys) produce byte-identical inline scripts:

```ts
// next.config.ts
export default {
  generateBuildId: () => process.env.VERCEL_GIT_COMMIT_SHA ?? 'app',
}
```

One more constraint specific to bundled hosts: the inline payload also embeds the
client chunk filenames, whose content hashes differ between build environments. So
the imported manifest must be generated by a build in the **same** environment
that serves the pages (a manifest hashed on your laptop will not match a Vercel
build). The double-build above satisfies this because the first pass runs on the
deploy host; do not commit a locally generated manifest and import that.

This is the verified path on Vercel for `static` and `ppr` routes. The runtime
disk read (the "trace" option above) was observed falling back to nonce-only
inside Vercel's middleware bundle even with the manifest present, which blocks
prerendered shells — so prefer importing, and always confirm on a preview that the
proxy's "no CSP manifest found" warning is absent and the shell scripts are
covered.

## `output: 'standalone'` (Docker)

`postbuild` detects a standalone build and copies the manifest next to the
bundle's `server.js`, inside the bundle's own `<distDir>` directory. The
conventional Docker copy then carries it along. Run `postbuild` before you copy
the bundle:

```dockerfile
# after `next build && strict-csp-next postbuild`
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# the manifest rides along inside .next/standalone/.next/
```

The proxy reads the manifest from the working directory, so no extra wiring is
needed. If your Dockerfile copies files individually, make sure
`.next/strict-csp-manifest.json` ends up next to the server.

## `output: 'export'` (static CDN, no server)

There is no server to set a header or mint a nonce, so the policy ships inside the
HTML as a `<meta http-equiv="Content-Security-Policy">` carrying each page's
inline-script hashes:

```json
{ "scripts": { "build": "next build && strict-csp-next postbuild --export" } }
```

Serve `out/` from any CDN and the policy is enforced with no `proxy.ts` and no
header config. Pair it with `experimental.sri` so external bundle `<script src>`
tags carry `integrity`. That gives you `script-src 'self'` with hashes for inline
scripts and integrity for bundles. Verified in a real browser at zero violations.

> **Clickjacking.** A `<meta>` CSP cannot express `frame-ancestors` (browsers
> ignore it there). `postbuild --export` warns about this. Set `frame-ancestors`
> (or `X-Frame-Options`) at your CDN, since there is no server to set the header.

## Dev (`next dev`)

`postbuild` does not run in dev, so there is no manifest and every route uses the
nonce-only policy. Next stamps the nonce natively, so pages still hydrate. In
development the policy adds `'unsafe-eval'` and keeps `style-src 'unsafe-inline'`
so React's dev runtime, fast refresh, and the error overlay work.

Run dev in `report-only` while you tune the policy, so violations are logged
rather than enforced:

```ts
export const proxy = createStrictCsp({
  mode: process.env.NODE_ENV === 'development' ? 'report-only' : 'enforce',
})
```

## Report-only rollout

For a first production adoption, ship the policy in report-only mode before you
enforce it. In report-only mode the browser reports each violation to your collector
and blocks nothing, so a missed inline script or a forgotten third-party origin
surfaces as a report instead of a broken page.

Set `mode: 'report-only'` and point `reportTo` at a group name wired through a
`Reporting-Endpoints` header. The proxy sets that header for you when you also pass
`reportToEndpoint` (see `src/types.ts`):

```ts
// proxy.ts  (or middleware.ts on Next 15)
import { createStrictCsp } from 'strict-csp-next/proxy'

export const proxy = createStrictCsp({
  mode: 'report-only',
  reportTo: 'csp',
  reportToEndpoint: '/api/csp-report',
})
```

Collect the reports in a Route Handler. Browsers POST violation reports as
`application/reports+json`, a batched array of report objects. The endpoint is
unauthenticated, so rate-limit it (via the platform WAF or middleware) and validate
what you accept:

```ts
// app/api/csp-report/route.ts
export async function POST(request: Request) {
  const ct = request.headers.get('content-type') || ''
  if (!ct.includes('json')) return new Response(null, { status: 415 })
  const len = Number(request.headers.get('content-length') || 0)
  if (len > 64 * 1024) return new Response(null, { status: 413 })
  let reports: unknown
  try { reports = await request.json() } catch { return new Response(null, { status: 400 }) }
  if (!Array.isArray(reports)) return new Response(null, { status: 400 })
  const clean = (v: unknown) =>
    typeof v === 'string' ? v.replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 512) : ''
  for (const r of reports.slice(0, 50)) {
    const b = (r as { body?: Record<string, unknown> })?.body ?? {}
    console.error('csp-violation', clean(b.documentURL), clean(b.blockedURL), clean(b.effectiveDirective))
  }
  return new Response(null, { status: 204 })
}
```

The default matcher already excludes `/api/*`, so this route needs no matcher
change. Watch the reports against real traffic until the violations stop, then flip
to enforcement:

```ts
mode: 'enforce',
```

That one line is the whole cutover. Report-only and enforce differ only in the
response header name (`Content-Security-Policy-Report-Only` versus
`Content-Security-Policy`); the policy string is byte-identical, so what you
validated in report-only is exactly what you enforce.

## Keeping static routes CDN-terminal

By default the proxy covers every route, so even a static page takes a
per-request hop. To serve fully static and ISR routes straight from the CDN,
generate their policy as static headers instead:

```json
{ "scripts": { "build": "next build && strict-csp-next postbuild --emit-headers" } }
```

This writes `<distDir>/strict-csp-headers.json` (hashes only, no nonce) for
`static` and `isr` routes. Wire those into `vercel.json` or `next.config`
`headers()` with `staticCspHeaders(manifest)`, and tell the proxy to skip them so
the two never set conflicting policies:

```ts
import { createStrictCsp } from 'strict-csp-next/proxy'

export const proxy = createStrictCsp({ skipStatic: true })
```

Dynamic and PPR routes still flow through the proxy, since they need a per-request
nonce.

### ISR with changing data (self-hosted only)

> **Vercel does not support this.** Vercel ignores a custom `cacheHandler` and
> owns the ISR cache itself, so the header this handler sets never reaches the
> edge. Verified against a real deploy, and stated by the Vercel team
> ([vercel/next.js#52203](https://github.com/vercel/next.js/discussions/52203)).
> The cache handler below is for **self-hosted** Next: `next start`, Docker
> `standalone`, or any Node host. On Vercel, an `isr` route whose inline data
> changes cannot carry a matching hash policy; serve it dynamically with a nonce,
> or keep the data stable and use the build-time static header.

The static header above freezes an ISR route's hashes at build time, which only
holds while its inline data stays byte-identical across revalidations. On a
self-hosted server, for an ISR route whose data changes (the usual reason to use
ISR), cover it with the cache handler instead, which recomputes the hash every
time Next revalidates the page:

```js
// cache-handler.cjs
const { withStrictCspCache } = require('strict-csp-next/cache-handler')
const FileSystemCache =
  require('next/dist/server/lib/incremental-cache/file-system-cache').default
module.exports = withStrictCspCache(FileSystemCache, { strictDynamic: true })
```

```js
// next.config.mjs
export default { cacheHandler: require.resolve('./cache-handler.cjs') }
```

The cache handler covers a route once it has revalidated at runtime. The
build-time prerender that ships in the build output is written before the handler
ever runs, so cover it in postbuild with `injectPrerenderMetaCsp` (or
`runPostbuild({ patchPrerenderHeaders: true })`):

```js
// postbuild.mjs
import { injectPrerenderMetaCsp } from 'strict-csp-next'
injectPrerenderMetaCsp()
```

Keep those routes out of the build-frozen set so the two do not compete, and let
the proxy skip them as before:

```ts
staticCspHeaders(manifest, {}, { includeIsr: false })
```

On a self-hosted server, every response then carries a matching policy with full
caching and no nonce, in every cache state: the build prerender, fresh hits, the
stale-while-revalidate stale serve, and the cache-fill `MISS` (the first request
to an un-prebuilt ISR path or after `revalidatePath`). The fill render is covered
because the handler writes the header onto the same value object Next streams, in
place, before the response is sent. This is verified end to end against a real
`next start`; see `examples/isr-cache`. It does **not** work on Vercel (see the
note above).

## Custom `distDir`

If you renamed the build directory in `next.config`, tell the build step:

```json
{ "scripts": { "build": "next build && strict-csp-next postbuild --dist-dir=build" } }
```

The proxy auto-detects the build dir from Next's `__NEXT_DIST_DIR` at runtime, so
you usually do not set it there. Pass `createStrictCsp({ distDir })` to be
explicit.
