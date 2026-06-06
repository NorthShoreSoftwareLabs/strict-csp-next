# Compatibility

What works, what needs configuration, and what does not work in v0.1. The
library reads the build output and the manifest from disk and matches routes by
path, so the settings that matter are the ones that change paths, rendering mode,
or how scripts are emitted.

## next.config settings

| Setting | Status |
| --- | --- |
| `distDir` | Supported. Pass `--dist-dir` to the build step; the proxy auto-detects `__NEXT_DIST_DIR` at runtime. |
| `basePath` | Works with no configuration. Next strips it from the request path, and prefixes the matcher and `headers()` sources for you, so the bare routes the manifest stores match everywhere. |
| `assetPrefix` | No effect. It changes where bundle files load from, not the bytes of the inline scripts, which are hashed by content. If assets move to another origin, add it to `script-src` or use `strictDynamic`. |
| `trailingSlash` | Handled. The proxy normalizes a trailing slash at lookup, and route classification tolerates trailing-slash manifest keys. |
| `output: 'standalone'` | Supported. The build step copies the manifest into the bundle. See [deployment](./deployment.md#output-standalone-docker). |
| `output: 'export'` | Supported via a `<meta>` CSP. See [deployment](./deployment.md#output-export-static-cdn-no-server). |
| `cacheComponents` / `experimental.ppr` | Supported. Every prerendered route becomes PPR. See [limitations](#limitations). |
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
  CDN-cacheable. The `static` / `isr` paths apply to classic App Router apps.
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
- **Cache-fill coverage is undocumented Next behavior.** The cache handler covers
  the cache-fill `MISS` render by writing the header onto the same value object
  Next sends, in place, which works because Next 16 awaits the cache `set` before
  sending the response. That ordering is not a documented contract. If a future
  Next version sends before awaiting `set`, the fill render reverts to fail-open
  (page renders, no CSP on that one request; every later hit still covered). The
  `examples/isr-cache` e2e asserts the `MISS` case, so it is the tripwire for that
  drift when run against a new Next version.

## Roadmap

- Dynamic-segment and parallel/intercepting/i18n route matching, derived
  authoritatively from Next's route manifests.
- A dev-mode runtime drift check that warns when served HTML contains an inline
  script the manifest does not cover.
- A wrapper (`withStrictCsp`) and an init codemod that wire the postbuild step and
  proxy automatically instead of by hand.
