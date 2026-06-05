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

### ISR with changing data

The static header above freezes an ISR route's hashes at build time, which only
holds while its inline data stays byte-identical across revalidations. For an ISR
route whose data changes (the usual reason to use ISR), cover it with the cache
handler instead, which recomputes the hash every time Next revalidates the page:

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

Every response then carries a matching policy with full CDN caching and no nonce,
in every cache state: the build prerender, fresh hits, the stale-while-revalidate
stale serve, and the cache-fill `MISS` (the first request to an un-prebuilt ISR
path or after `revalidatePath`). The fill render is covered because the handler
writes the header onto the same value object Next streams, in place, before the
response is sent. This is verified end to end against a real `next start`; see
`examples/isr-cache`. On Vercel, confirm the stored CSP header survives the
managed-ISR/CDN hop on a real deploy before relying on it in production.

## Custom `distDir`

If you renamed the build directory in `next.config`, tell the build step:

```json
{ "scripts": { "build": "next build && strict-csp-next postbuild --dist-dir=build" } }
```

The proxy auto-detects the build dir from Next's `__NEXT_DIST_DIR` at runtime, so
you usually do not set it there. Pass `createStrictCsp({ distDir })` to be
explicit.
