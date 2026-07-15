# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and this project adheres to
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.1] - 2026-07-14

### Security

- **Manifest-sourced `script-src` tokens are now validated (defense-in-depth,
  #23).** `buildPolicy` spreads the manifest's inline-shell hashes and external
  integrity hashes into `script-src`, previously without the per-value guard that
  caller `directives` get. A corrupt or tampered manifest entry containing `;`,
  whitespace, CR, LF, or an `unsafe-*` keyword could in principle inject a
  directive or re-open `'unsafe-inline'`. Each token is now checked before it
  reaches the header (stricter than the caller-value guard — it also rejects
  inner whitespace, the vector that would smuggle a second source past the
  space-join) and a bad token throws. Not exploitable in practice today (the
  manifest is a trusted `postbuild` artifact), but the injection class is now
  closed regardless of manifest provenance.

## [0.3.0] - 2026-07-14

### Added

- **Next.js 15 cache-handler runtime e2e (`examples/next15-cache`).** A classic
  Next 15 App Router app that drives an ISR route through every cache state
  against a real `next start` and records which states carry the CSP header from
  `withStrictCspCache`. It prints a `STATE -> header` table and asserts the
  covered states (build prerender, HIT, STALE, on-demand `revalidatePath`), while
  recording the plain first-fill MISS behavior rather than failing on it: on
  Next 15 the response-cache resolves the HTTP response before awaiting
  `cacheHandler.set()` on an ordinary MISS, so a plain first-fill MISS may ship
  without the header (the documented Next 15 caveat). Wired into CI as the
  `e2e-next15-cache` job (`bash examples/next15-cache/e2e.sh 15`).
- **Build-time handler-wiring guard.** `runPostbuild` now checks the CSP
  handler is wired in the file the installed Next.js major actually reads:
  `middleware.*` on Next 15, `proxy.*` on Next 16+. A mismatch (a `proxy.*` on
  Next 15, or a `middleware.*` on Next 16+) is otherwise ignored by the
  framework with no error, silently shipping the app with no CSP. The guard
  warns loudly, scans the project root and a `src/` subdir, and reports the
  message on `PostbuildResult.wiringWarning`. It never warns when both or
  neither file is present, or when the Next version is undetectable, and never
  throws. Exposed as `checkHandlerWiring(projectDir, nextMajor)`.
- **`strict-csp-next/proxy-edge`: an Edge-runtime middleware entry.** The main
  `strict-csp-next/proxy` reads the manifest from disk, which pulls `node:fs`/
  `node:path` (and `node:crypto`, via the shared hashing module) into its import
  graph, so it cannot run in a Next.js Edge middleware bundle.
  `createStrictCspEdge(options)` has an import graph that reaches no Node
  built-ins — it imports only `next/server`, the pure `planCsp` decision core
  (nonce via `globalThis.crypto`), and the shared types. The manifest is imported
  by the caller and passed in via `options.manifest` (no disk read); absent, it
  falls back to a nonce-only policy. Same request/response header behavior as the
  Node proxy (CSP on both request and response, per-request nonce for
  dynamic/PPR, hashes for static/ISR, `no-store` on enforced nonced responses).
  Proven end to end by `examples/next15-edge`, which runs the middleware on the
  Edge runtime (no `runtime: 'nodejs'`) with zero CSP violations across `/`
  (hashes) and `/dynamic` (per-request nonce).
- **Subresource Integrity (SRI) support for static/ISR routes.** When
  `experimental.sri` is enabled (done automatically by `withStrictCsp`), the
  library extracts `integrity` hashes from `<script>` tags in prerendered HTML
  and pins them in `script-src`. With **full** external-script coverage the
  policy drops `'self'` and adds `'strict-dynamic'`, producing
  `<inline-hashes> <integrity-hashes> 'strict-dynamic'` — every initial script
  is hash-pinned and `'strict-dynamic'` propagates trust to runtime chunks, with
  no `'self'`, no nonce, and no host allowlist (green on
  [CSP Evaluator](https://csp-evaluator.withgoogle.com/)).
- **Integrity backfill (`runPostbuild({ backfillIntegrity: true })`, bin
  `--backfill`).** Next stamps integrity on its bootstrap chunks but leaves the
  client-component chunks un-pinned. The backfill hashes each un-pinned chunk's
  on-disk bytes (`base64(sha256(bytes))`, which matches Next's integrity exactly)
  and injects the `integrity` attribute into the prerendered HTML, so coverage
  reaches 100% and the policy can legitimately drop `'self'`. Idempotent
  (re-running never double-injects) and scoped to static/ISR output; the
  PPR/dynamic nonce path is never touched.
- **Asset-origin awareness + `crossOrigin` option** (`'auto'` default, or
  `'anonymous' | 'use-credentials' | false`; bin `--cross-origin=`). Same-origin
  assets get `integrity` only (matching what Next does for its own SRI tags);
  a cross-origin `assetPrefix` (CDN on another host) gets
  `crossorigin="anonymous"` plus a build-time note that the CDN must return
  `Access-Control-Allow-Origin` or the browser blocks the script as an SRI
  failure.
- **`withStrictCsp` automatically enables `experimental.sri`** and accepts
  `{ algorithm?: 'sha256' | 'sha384' | 'sha512' }` (default `sha256`). Explicit
  user `experimental.sri` config is respected; a mismatched `algorithm` option
  is ignored with a warning so inline-hash and SRI algorithms do not diverge.
- **Self-check now covers external scripts, per tag.** The postbuild guard
  counts external `<script src>` tags that lack an `integrity` attribute and
  flags any per-tag shortfall (not only the all-zero case) when
  `failOnUncovered` is set, distinguishing "SRI not enabled" from "SRI enabled
  but coverage incomplete."
- New exports: `extractExternalIntegrity`, `countExternalScripts`,
  `countUncoveredExternalScripts`, `scanScripts`, `backfillIntegrity`,
  `makeAssetResolver`, `isCrossOrigin`, and the `RouteEntry.uncoveredExternal`
  field.
- **Zero-`'self'` SRI browser e2e for Next.js 15 (`examples/next15-sri`, CI job
  `e2e-next15-sri`).** A real Next 15 App Router app that runs the integrity
  backfill (`runPostbuild({ backfillIntegrity: true })`) so every external
  `<script src>` is pinned, then asserts the headline shape in Chromium: on the
  static `/` and ISR `/isr` routes `script-src` has NO `'self'`, HAS
  `'strict-dynamic'`, lists inline + integrity hashes, and the served HTML
  carries `integrity` on every external script — with zero
  `securitypolicyviolation` events and working hydration. The dynamic `/dynamic`
  route keeps `'self'` plus a per-request nonce as the deliberate contrast.
  Includes a Turbopack build variant (`e2e.sh 15 turbopack`): Next 15.5.x rejects
  `experimental.sri` under Turbopack, so the zero-`'self'` path is a webpack-only
  build there; the variant records that documented incompatibility explicitly
  rather than passing silently, and runs the same assertions if a future
  Turbopack accepts the config.

### Fixed

- **Caller `script-src-elem` / `script-src-attr` no longer shadows the
  library-owned `script-src`.** A caller who added a more-specific script
  directive via `options.directives` had it emitted without the shell hashes or
  per-request nonce, which broke nonce routes two ways: CSP3 browsers consult
  `script-src-elem` for `<script>` elements and never fall back to `script-src`,
  so those scripts were blocked; and Next's `getScriptNonceFromHeader` reads the
  *first* `script-src*` directive it finds, so it read the credential-less one
  and stamped no nonce. Both broke dynamic/PPR hydration silently. The computed
  `script-src` sources are now mirrored into any caller-supplied
  `script-src-elem` / `script-src-attr` (their extra sources kept and deduped,
  matched case-insensitively, a lone `'none'` dropped once real credentials are
  added).
- **Partial SRI coverage no longer ships a broken page.** Previously the policy
  dropped `'self'` and forced `'strict-dynamic'` whenever *any* integrity hash
  was present, which blocked the un-pinned parser-inserted chunks that real
  Turbopack output leaves uncovered. The `'self'`-drop now requires **every**
  external script on the route to be hash-pinned; with any un-pinned chunk the
  policy keeps the safe `'self' <inline> <integrity>` shape and omits
  `'strict-dynamic'`.

### Changed

- **`mode` is set at delivery time, not on `withStrictCsp`.** The previously
  advertised `withStrictCsp(config, { mode })` was a no-op (the config wrapper
  never reaches the code that chooses the header name) and has been removed. Set
  `mode: 'report-only'` on the `StrictCspOptions` passed to `createStrictCsp`,
  `runPostbuild({ headerOptions })`, `staticCspHeaders`,
  `injectPrerenderMetaCsp`, or the cache handler — the working path that selects
  `Content-Security-Policy-Report-Only` end to end.
- Internal: the script tokenizer is centralized into a single `scanScripts`
  pass; the inline/external extractors and counters are thin filters over it.

### Security

- **Both proxies strip client-controlled CSP / nonce request headers.** The Node
  and Edge proxies now delete any inbound `content-security-policy`,
  `content-security-policy-report-only`, and `x-nonce` request header before the
  render sees it, on every path including `skipStatic`. An inbound CSP could
  otherwise influence the nonce Next reads, and a stale `x-nonce` could mislead
  app code that trusts it (notably on a static route, where the proxy mints no
  nonce and previously forwarded the client value). The proxy re-sets the CSP and
  `x-nonce` it owns afterward. Exposed as the pure `sanitizeRequestHeaders`
  helper.

## [0.2.0] - 2026-06-05

### Changed

- **The cache handler is documented as self-hosted only.** `withStrictCspCache`
  relies on Next replaying a cache entry's headers when it serves the page, which
  `next start` / Docker do but Vercel does not (Vercel ignores a custom
  `cacheHandler` and owns the ISR cache). Verified on a real Vercel deploy. The
  README mode table, how-it-works, deployment, security, and compatibility docs now
  state this, and the Vercel deployment guide adds the `generateBuildId`-pinning and
  build-host manifest requirements for `static` / `ppr` hash delivery.
- `withStrictCspCache` now swallows a wrapped-handler `set()` failure (e.g. a
  read-only filesystem on a serverless host) instead of letting it 500 the page;
  the header is already written, so the page renders uncached and a one-time
  warning explains the cause.
- `withStrictCspCache` prints a loud, boxed one-time warning when instantiated on
  Vercel (`process.env.VERCEL`), so a no-op deployment is impossible to miss in the
  build and function logs rather than silently shipping ISR routes without a CSP.
  The build still succeeds.

### Added

- `strict-csp-next/cache-handler`: cache-write-time CSP for ISR. `withStrictCspCache`
  wraps a Next.js cache handler and, on every `set`, hashes the exact HTML being
  cached and stamps a matching policy onto the same entry. ISR routes whose inline
  data changes on revalidation now stay strict and CDN-cacheable with no nonce,
  instead of breaking against a build-frozen header. The header is written onto the
  cached value object in place, which also covers the cache-fill `MISS` render (the
  first request to an un-prebuilt path or after `revalidatePath`), since Next sends
  that response from the same object it caches. Runs the build's three-signal
  self-check at write time and fails open (drops the header, warns once) on drift.
  Also exports the pure helpers `cspHeaderForHtml` and `applyCspHeader`. Verified
  end to end against a real `next start` across HIT, STALE, and MISS states
  (`examples/isr-cache`).
- `injectPrerenderMetaCsp()` and a `patchPrerenderHeaders` option on `runPostbuild`:
  stamp the hash-only CSP into the prerender `.meta` sidecar of `static` / `isr`
  routes, so Next serves the policy from its own cache on the first request, before
  any runtime revalidation runs the cache handler. Closes the build-time-prerender
  window for ISR. Verified end to end against a real `next start` (`examples/isr-cache`).
- `staticCspHeaders(manifest, options?, { includeIsr })`: exclude `isr` routes from
  the build-frozen header set when the cache handler covers them.
- `strictDynamic` option: adds `'strict-dynamic'` to `script-src` so hashed/nonced
  root scripts vouch for the scripts they inject (tag managers, `next/script`).
- `reportTo` directive and `reportToEndpoint`, which sets a modern
  `Reporting-Endpoints` response header.
- `planCsp()` / `generateNonce()` exports: the proxy's pure decision core, now
  unit-testable without the Next.js runtime.
- Custom `distDir` support: a `distDir` option on `runPostbuild`/`createStrictCsp`
  and a `--dist-dir` CLI flag, so a renamed Next build directory is honored. The
  proxy also auto-detects Next's `__NEXT_DIST_DIR` at runtime.
- Route classification tolerates trailing-slash prerender-manifest keys, so a
  PPR/ISR route under `trailingSlash: true` is not misclassified as static.

### Changed

- Documentation restructured into a scannable README plus focused `docs/` pages
  (how it works, API reference, deployment, security model, compatibility).
- The inline-script scanner is now a quote-aware tokenizer instead of a single
  regex, so a `src=`/`nonce=` substring or `>` inside a quoted attribute value no
  longer causes a script to be misclassified.
- The build self-check gained a third independent signal (open/close `<script>`
  tag balance) on top of the tokenizer and coarse-regex counts.
- The proxy logs a one-time warning when the manifest is missing at runtime, so
  the Vercel "silent broken site" failure is diagnosable.
- `loadManifest` no longer caches a miss, so a transient absence (cold start,
  not-yet-written manifest) no longer pins the process to the broken path.
- `report-only` mode no longer sets `Cache-Control: no-store` (a replayed nonce
  can't be enforced, so caching is safe).
- Example `postbuild.mjs` files keep the self-check on (`failOnUncovered`
  defaults to `true`); example matchers exclude Route Handlers and file-based
  metadata routes.

### Fixed

- The recommended proxy matcher now anchors its file-based metadata exclusions
  (`opengraph-image`, `twitter-image`, `icon`, `apple-icon`) to a full path
  segment, so a real page that merely shares a prefix (`/icons`,
  `/opengraph-image-gallery`) is no longer excluded from the proxy and silently
  served with no CSP. The
  redundant `sitemap.xml` / `robots.txt` / `manifest.webmanifest` literals were
  dropped (the file-extension rule already covers them). Pinned by
  `test/matcher.test.mjs`.
- The Vercel guide now recommends tracing the manifest into the proxy bundle via
  `outputFileTracingIncludes` (which serves this build's fresh manifest) over a
  bare `import` (which inlines the previous build's manifest and can ship stale
  hashes), and corrects the import-attribute syntax to `with { type: 'json' }`.

### Security

- `'unsafe-inline'` / `'unsafe-eval'` / `'unsafe-hashes'` are now stripped from
  every script-governing directive a caller passes (`script-src`,
  `script-src-elem`, `script-src-attr`, `default-src`), not just `script-src`, so
  inline scripts can't be reopened through the more specific directives.
- `injectMetaCsp` skips a comment-embedded `<head`, and warns loudly about
  exported pages that ship inline scripts but have no `<head>` to protect, and
  about `frame-ancestors` not being expressible via `<meta>`.

## [0.1.0]

Initial release. Strict CSP for the Next.js App Router without forcing dynamic
rendering. Proven in a real browser across static, dynamic, and PPR /
Cache Components rendering with zero CSP violations.

### Added

- `withStrictCsp(nextConfig)` config wrapper (stable extension point).
- `strict-csp-next postbuild` CLI: scans the prerendered build output, writes a
  per-route inline-script hash manifest, and runs a self-check that fails the
  build on uncovered executable inline scripts.
- `createStrictCsp()` / `strictCsp` proxy (`strict-csp-next/proxy`, Next.js 16
  `proxy.ts`): per-request nonce plus the route's build-time hashes, set on both
  the request and response headers. Next.js 16 App Router only.
- Route classification (`static` / `isr` / `ppr` / `dynamic`) from
  `prerender-manifest.json`.
- `staticCspHeaders()` and `postbuild --emit-headers` for CDN-terminal delivery
  of fully static routes, with the proxy `skipStatic` option to avoid a
  conflicting policy.
- `output: 'standalone'` support: `postbuild` copies the manifest into
  `.next/standalone/.next/` so the Docker bundle carries it.
- `output: 'export'` support: `postbuild --export` injects a
  `<meta http-equiv="Content-Security-Policy">` with per-page inline hashes into
  the exported HTML, for strict CSP on a static CDN with no server. Verified in a
  browser at zero violations.
- `report-only` mode, custom directives, `reportUri`, and configurable hash
  algorithm (sha256 / sha384 / sha512).

### Security

- Reject `;`, `,`, CR, and LF in directive names/values and `reportUri` to
  prevent policy injection (a caller-supplied value cannot inject a second,
  weaker `script-src`).
- Strip `'unsafe-inline'` / `'unsafe-eval'` from caller `script-src` additions.
- `Cache-Control: no-store` on nonced responses; static/ISR routes are hash-only
  and stay cacheable.
- URL-safe base64 nonces; `styleNonce` opt-in for nonced inline styles.

