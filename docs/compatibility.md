# Compatibility

What works, what needs configuration, and what does not work in v0.1. The
library reads the build output and the manifest from disk and matches routes by
path, so the settings that matter are the ones that change paths, rendering mode,
or how scripts are emitted.

## Next.js version support

The declared peer floor is Next.js 15.5.0 (`peerDependencies.next: ">=15.5.0"`),
which covers the App Router on 15.5 and up, including Next 16. 15.5 is the floor
because the proxy runs only on the Node.js middleware runtime and that runtime is
stable there. 15.2 through 15.4 may work with `experimental: { nodeMiddleware:
true }` in `next.config`, but that runtime is experimental on those versions and
sits below the declared peer range, so expect peer warnings and treat it as
best-effort rather than supported. The entry file differs by version:
`middleware.ts` on Next 15, `proxy.ts` on Next 16. The runtime function is the
same in both. See [deployment](./deployment.md#nextjs-15) for the Next 15 wiring.

Dropping `'self'` with SRI needs Next 15.2 or later. `experimental.sri` emits the
`integrity` attribute on the Node render only from 15.2. The config key parses on
15.0 and 15.1 but does nothing on Node pages, so below 15.2 the static and export
paths keep the `script-src 'self'` plus inline-hash shape instead of the
zero-`'self'` path. Everything else works from 15.2.

## next.config settings

| Setting | Status |
| --- | --- |
| `distDir` | Supported. Pass `--dist-dir` to the build step; the proxy auto-detects `__NEXT_DIST_DIR` at runtime. |
| `basePath` | Works with no configuration. Next strips it from the request path, and prefixes the matcher and `headers()` sources for you, so the bare routes the manifest stores match everywhere. |
| `assetPrefix` | No effect. It changes where bundle files load from, not the bytes of the inline scripts, which are hashed by content. If assets move to another origin, add it to `script-src` or use `strictDynamic`. |
| `trailingSlash` | Handled. The proxy normalizes a trailing slash at lookup, and route classification tolerates trailing-slash manifest keys. |
| `output: 'standalone'` | Supported. The build step copies the manifest into the bundle. See [deployment](./deployment.md#output-standalone-docker). |
| `output: 'export'` | Supported via a `<meta>` CSP. See [deployment](./deployment.md#output-export-static-cdn-no-server). |
| `cacheComponents` / `experimental.ppr` | Supported. Every prerendered route becomes PPR. On Next 16 this is `cacheComponents: true`; on Next 15 the equivalent is `experimental: { ppr: 'incremental', dynamicIO: true }`. See [limitations](#limitations). |
| `crossOrigin`, `generateBuildId`, `cleanDistDir`, `compress` | No effect. Hashes are content-based and recomputed from the actual built HTML. |
| `useFileSystemPublicRoutes: false` | Not supported. A custom server that owns routing is outside the manifest model. |

## Features

| Feature | Status |
| --- | --- |
| `generateStaticParams` | Supported. Each prerendered param value is a concrete route in the manifest and is hash-covered. |
| Route Handlers (`route.ts`) | Produce no HTML, so they are not in the manifest. Exclude them from the matcher. |
| File-based metadata (`opengraph-image`, `sitemap`, `robots`, icons) | Produce no HTML. The recommended matcher excludes them. |
| Dynamic segments without prerendered HTML | Fall through to the nonce-only policy. Safe and strict, but not hash-covered. |
| Parallel (`@slot`) and intercepting (`(.)`) routes | Not derived in v0.1. The parent page is covered; standalone slot HTML is not. |
| App Router i18n (`[lang]` segments) | Dynamic-segment routing, so localized routes use the nonce path unless prerendered via `generateStaticParams`. The Pages-Router `i18n` config does not apply to the App Router. |
| `experimental.nextScriptWorkers` (Partytown) | Not compatible. It relocates third-party scripts into a worker using inline scripts and eval. |
| `experimental.inlineCss` | Covered by the default `style-src 'unsafe-inline'`. With `styleNonce`, only dynamic/PPR routes get nonced styles. |

## Do not set your own CSP header

If you also emit `Content-Security-Policy` from `next.config` `headers()`,
`vercel.json`, or a CDN, the browser enforces the intersection of both policies,
which usually breaks the page. Let the proxy own the policy. For the
static-on-CDN split, use `skipStatic` with `staticCspHeaders()`, which is built
to not conflict (see [deployment](./deployment.md#keeping-static-routes-cdn-terminal)).

## Limitations

- **`cacheComponents: true` makes every prerendered route `ppr`.** Next.js 16
  treats that flag as enabling PPR app-wide, and per-route `revalidate` /
  `dynamic` config becomes a build error. So in cacheComponents mode the `static`
  / `isr` classification is unreachable. Every route is `ppr` (hashes for the
  shell, nonce for the resume), which is correct and verified, just not
  CDN-cacheable. The `static` / `isr` paths apply to classic App Router apps. On
  Next 15 the same app-wide PPR behavior comes from `experimental.ppr` with
  `dynamicIO`; Next 16 unifies both under `cacheComponents`. The
  `withStrictCsp({ cacheComponents: true })` config example is Next 16 only; on
  Next 15, set `experimental: { ppr: 'incremental', dynamicIO: true }` yourself.
- **Route matching is by concrete path.** A fully static route the manifest
  misses will not hydrate, because its hash is absent and there is no nonce to
  fall back to. A miss on a dynamic or PPR route is safe, since Next stamps the
  nonce. Verify static routes are covered.
- **The cache handler is self-hosted only.** `withStrictCspCache` works by having
  Next replay the cache entry's headers when it serves the page. Vercel ignores a
  custom `cacheHandler` and owns the ISR cache itself, so the header never reaches
  the edge there (verified on a real deploy; stated by the Vercel team in
  [vercel/next.js#52203](https://github.com/vercel/next.js/discussions/52203)). Use
  it on `next start`, Docker `standalone`, or any Node host. On Vercel, an `isr`
  route whose inline data changes has no hash path; serve it dynamically with a
  nonce or keep the data stable.
- **Build-frozen hashes assume stable bytes.** An ISR route whose inline data
  changes on revalidation will not match a hash frozen in `vercel.json` at build
  time. Self-hosted, cover it with the cache handler (`withStrictCspCache`), which
  recomputes the hash on every revalidation, plus `injectPrerenderMetaCsp` for the
  build-time prerender, and keep it out of the static-header set with
  `staticCspHeaders(manifest, opts, { includeIsr: false })`. Without the cache
  handler, route such pages through the nonce path instead.
- **Vercel needs a pinned build id for `static` / `ppr` hashes.** Next stamps a
  fresh `buildId` into the inline RSC payload each build, and the client chunk
  filenames it embeds are environment-specific. So the imported manifest must come
  from a build on the deploy host, and `generateBuildId` must be pinned, or one
  shell script per page is left uncovered. See [deployment](./deployment.md#vercel-and-other-bundledserverless-hosts).
- **Cache-fill coverage is undocumented Next behavior, and differs by Next
  version.** The cache handler covers the cache-fill `MISS` render by writing the
  header onto the same value object Next sends, in place. On Next 16 this lands on
  the served response, because Next 16 awaits `cacheHandler.set()` before sending
  the response. Next 15 resolves the HTTP response *before* awaiting
  `cacheHandler.set()` on an ordinary `MISS`, so on Next 15 that one fill render is
  a timing race and may fail-open (the page renders, no CSP on that first request;
  every later hit still covered). On-demand revalidation (`revalidatePath` /
  `revalidateTag`), `HIT`, and `STALE` are covered on both 15 and 16. Neither
  ordering is a documented contract, so a change on either version is possible. The
  `examples/isr-cache` e2e asserts the `MISS` case, so it is the tripwire for that
  drift when run against a new Next version.

## Roadmap

- Dynamic-segment and parallel/intercepting/i18n route matching, derived
  authoritatively from Next's route manifests.
- A dev-mode runtime drift check that warns when served HTML contains an inline
  script the manifest does not cover.
- A wrapper (`withStrictCsp`) and an init codemod that wire the postbuild step and
  proxy automatically instead of by hand.
