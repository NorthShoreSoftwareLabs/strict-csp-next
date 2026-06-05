# How it works

This page explains the mechanism in full: why a strict CSP is hard on the App
Router, the insight that makes a static-friendly strict policy possible, and the
two pieces that implement it.

## The problem

The Next.js App Router hydrates with inline `<script>` blocks. Every page ships
at least a `self.__next_f.push(...)` payload plus React's streaming instruction
scripts, all inline and all without a `src`. A strict `script-src` blocks every
inline script unless it carries one of two credentials:

- a **nonce**, a random token minted per request and stamped on both the policy
  and each script, or
- a **hash**, the base64 digest of the script's exact bytes, listed in the
  policy.

Each credential fits a different rendering model. A nonce is fresh per request,
so it only exists when the page is rendered per request. A hash is fixed at build
time, so it only works for bytes that are known at build time. The official
guidance pairs a nonce with `force-dynamic`, which makes every route dynamic and
gives up static and CDN caching. `experimental.sri` adds integrity to external
bundle files and does nothing for the inline scripts, so a strict policy still
blocks the page.

The result is a real tradeoff: a strict script policy, or static rendering, but
not both. This package removes it.

## The insight

Two facts about Next.js 16, both verified against its source, make a single
static-friendly strict policy possible.

1. **Next reads a nonce you give it.** When the incoming request carries a
   `Content-Security-Policy` header with a `'nonce-...'` token in `script-src`
   (or `default-src`), Next parses that token and reuses it for the scripts it
   renders and streams. You do not have to let Next generate the nonce.
2. **Providing a nonce does not force dynamic rendering. Reading it does.** A
   component that calls `headers()` to read the nonce opts into dynamic
   rendering. Setting the nonce on the request from the proxy does not. So the
   prerendered shell stays static while the streamed resume still gets a nonce.

That asymmetry is the load-bearing part. It lets one policy carry a build-time
hash for the static shell and a per-request nonce for the dynamic resume at the
same time.

## One credential per rendering mode

The package classifies every route from `prerender-manifest.json` and picks the
credential that fits:

| Mode | What renders when | Credential | Cacheable |
| --- | --- | --- | --- |
| `static` | fully at build | build-time hashes of the shell's inline scripts | yes |
| `isr` | at build, revalidated | hashes recomputed on every revalidation (cache handler) | yes |
| `ppr` | shell at build, holes per request | hashes for the shell **and** a nonce for the resume | no (nonced) |
| `dynamic` | fully per request | a nonce | no (nonced) |

The `isr` row is the one that needs care. A hash matches exact bytes, and ISR
exists precisely so the bytes can change: when a route revalidates and its data
changes, the streamed `self.__next_f.push(...)` scripts get new bytes and new
hashes. A header frozen at build time would no longer list them, and a strict
policy would block the page. The fix is to hash at the moment Next regenerates
the page, covered next.

A PPR route carries both in one header:

```
script-src 'self' 'sha256-<shell hash>' 'nonce-<per request>'
```

The hash covers the bare prerendered shell script. The nonce covers everything
the request-time resume streams. Neither credential alone is enough for PPR: a
nonce-only policy leaves the shell script blocked, and a hash-only policy leaves
the streamed scripts blocked.

## The two pieces

### 1. The build step

`strict-csp-next postbuild` runs after `next build`. It scans the prerendered
HTML under `<distDir>/server/app`, extracts the hash of every executable bare
inline script per route, classifies the route, and writes
`<distDir>/strict-csp-manifest.json`.

It then runs a **self-check**. Three independent signals count the executable
inline scripts on each page: a quote-aware tokenizer, a coarse regex with a
different structure, and the open/close `<script>` tag balance. If they disagree,
the build fails with the offending route. A disagreement means Next emitted a
script shape the scanner did not expect, usually after a version bump, and the
build should not ship a policy that silently blocks it. See
[security](./security.md#the-self-check) for why this guard matters.

### 2. The proxy

`proxy.ts` (Next.js 16 renamed `middleware.ts`, and it always runs on the Node.js
runtime) runs per request. It looks up the route in the manifest, mints a fresh
nonce for routes that render anything at request time, and builds the policy. It
sets that policy on the request header, so Next stamps the nonce onto what it
streams, and on the response header, so the browser enforces it. Enforced nonced
responses also get `Cache-Control: no-store`, so a nonce is never cached and
replayed.

No egress proxy. No fork of Next. No change to how you write components.

### 3. The cache handler (ISR)

`withStrictCspCache` (from `strict-csp-next/cache-handler`) wraps your Next cache
handler and moves hashing from build time to **cache-write time**. Next renders
or revalidates a page, serializes the document to a string, and stores it in the
incremental cache together with the response headers. The wrapper hooks `set`:
for every `APP_PAGE` entry it hashes the exact HTML being cached and stamps a
matching policy onto that same entry's headers. Body and header are cached
atomically and revalidate together, so the hashes always match the bytes the
browser receives, even after the inline data changed.

It runs the same three-signal self-check the build step does. If the counts ever
disagree on a revalidated page, it omits the CSP header from that entry (and logs
once) rather than cache a policy that might block, so the route falls back to the
nonce path instead of breaking.

Two delivery details make this cover every cache state, not just later hits:

1. **The build prerender.** The page that ships in the build output is written by
   the build worker, which never runs the handler, so its `.meta` has no policy
   until the first revalidation. `injectPrerenderMetaCsp` (run it in postbuild, or
   pass `patchPrerenderHeaders` to `runPostbuild`) stamps the same hash-only policy
   into those prerender `.meta` sidecars, so the very first request is covered.
2. **The cache-fill render.** The request that regenerates a cold or
   on-demand-invalidated entry (a cache `MISS`: the first hit on an un-prebuilt ISR
   path, or the first after `revalidatePath`) streams from the render pipeline, not
   from the cache. Next builds that response from the **same value object** it
   hands the cache handler, and awaits the handler's `set` before sending. So the
   handler writes the header onto that object **in place**, and it lands on the
   fill render's response too. A copy would be cached but never reach the wire.

Verified end to end against a real `next start` on Next 16 (`examples/isr-cache`):
the build prerender, every fresh hit, the stale-while-revalidate stale serve, and
the cache-fill `MISS` all carry a CSP whose hashes cover the document, and the
policy tracks the bytes when the data changes.

The fill-render coverage leans on Next awaiting `set` before it sends the response
and on the response sharing the cached value's `headers` object, which is how Next
16 behaves but is not a documented contract. If a future version sent the response
before awaiting `set`, the fill render would revert to fail-open (page renders,
no CSP on that one request, every later hit still covered). The `examples/isr-cache`
e2e asserts the `MISS` case, so running it against a new Next version surfaces that
drift.

Wire it in a small file Next loads as `cacheHandler`, composing the filesystem
cache (or your own Redis handler) as the base:

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

Then keep ISR out of the build-frozen set with
`staticCspHeaders(manifest, opts, { includeIsr: false })` and run the proxy with
`{ skipStatic: true }`, so each route has exactly one source of truth: `static`
from `vercel.json`, `isr` from the cache handler, `ppr` / `dynamic` from the
proxy.

## What this depends on

Next's own CSP guide calls Partial Prerendering "incompatible with nonce-based
CSP," because the static shell's scripts cannot see a per-request nonce
([vercel/next.js#89754](https://github.com/vercel/next.js/issues/89754)). Hashing
the shell is what resolves that, and it is proven in a real browser on the pinned
Next version (see [the proof](../README.md#proven)). It leans on how Next emits
the prerendered shell's inline scripts, which is not a documented contract and
could change on a minor release.

The self-check is the guard against that. If a Next change ever emits an
executable inline script the manifest does not cover, the build fails rather than
shipping a page that breaks in production. A scheduled CI job
(`.github/workflows/next-compat.yml`) runs the browser matrix against `next@canary`
so drift surfaces before it reaches a release you depend on.
