# API reference

Two entry points:

- `strict-csp-next` holds the build step, manifest helpers, and policy builders.
- `strict-csp-next/proxy` is the request-time proxy. Import it only from
  `proxy.ts`, since it pulls in `next/server`.

## Proxy

### `createStrictCsp(options?)`

Creates the proxy function for `proxy.ts`. Returns `(request: NextRequest) =>
NextResponse`.

```ts
import { createStrictCsp } from 'strict-csp-next/proxy'

export const proxy = createStrictCsp({ strictDynamic: true })
```

#### `StrictCspProxyOptions`

Extends [`StrictCspOptions`](#strictcspoptions) with:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `manifest` | `CspManifest` | reads from disk | Pass the manifest directly instead of reading it from disk. On bundled hosts, prefer tracing the on-disk manifest in; passing it via `import` needs a two-pass build to avoid stale hashes. See [deployment](./deployment.md#vercel-and-other-bundledserverless-hosts). |
| `projectDir` | `string` | `process.cwd()` | Project root used to locate the manifest. |
| `distDir` | `string` | `.next` (or `__NEXT_DIST_DIR`) | Build directory if you set a custom `distDir`. The proxy auto-detects Next's `__NEXT_DIST_DIR` at runtime, so you rarely set this. |
| `skipStatic` | `boolean` | `false` | Leave `static` and `isr` routes untouched. Set this when you serve their policy as static headers. See [CDN-terminal static delivery](./deployment.md#keeping-static-routes-cdn-terminal). |

### `strictCsp`

A ready-made proxy with defaults (`createStrictCsp()`), reading the manifest from
disk.

```ts
// proxy.ts
export { strictCsp as proxy } from 'strict-csp-next/proxy'
```

## Shared options

### `StrictCspOptions`

Accepted by the proxy, the static-header builder, and the policy builders.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `mode` | `'enforce' \| 'report-only'` | `'enforce'` | `report-only` emits `Content-Security-Policy-Report-Only` and does not set `no-store`. |
| `directives` | `Record<string, string[] \| true>` | `{}` | Extra directives merged into the policy. `true` emits a valueless directive. Banned sources are stripped from script directives (see below). |
| `reportUri` | `string` | none | Adds `report-uri`. Deprecated in the spec but widely supported. |
| `reportTo` | `string` | none | Adds `report-to <group>`. Pair with `reportToEndpoint`. |
| `reportToEndpoint` | `string` | none | URL for the `report-to` group. When both are set, the proxy emits `Reporting-Endpoints: <group>="<url>"`. |
| `strictDynamic` | `boolean` | `false` | Adds `'strict-dynamic'` to `script-src`. See [third-party scripts](#third-party-scripts). |
| `styleNonce` | `boolean` | `false` | Cover inline styles with the nonce instead of `style-src 'unsafe-inline'`. Only takes effect on routes that have a nonce (dynamic / PPR), and never in dev. |
| `algorithm` | `'sha256' \| 'sha384' \| 'sha512'` | `'sha256'` | Hash algorithm for inline-script hashes. |

#### What the policy always sets

`script-src` is owned by the library. You cannot remove `'self'`, the route's
hashes, or the nonce. Additions you pass through `directives['script-src']` are
merged in. `'unsafe-inline'`, `'unsafe-eval'`, and `'unsafe-hashes'` are stripped
from every script-governing directive you pass (`script-src`, `script-src-elem`,
`script-src-attr`, `default-src`), so a strict script policy cannot be reopened
through a more specific directive.

The defaults: `default-src 'self'`, `base-uri 'self'`, `object-src 'none'`,
`frame-ancestors 'none'`, `img-src 'self' blob: data:`, `font-src 'self'`,
`form-action 'self'`, `upgrade-insecure-requests`, and `style-src 'self'
'unsafe-inline'`. Override any of them through `directives`.

#### Validation

Directive names and values containing `;`, `,`, CR, or LF are rejected, so a
caller-supplied value cannot inject a second, weaker policy. `reportTo` and
`reportToEndpoint` reject CR, LF, and `"` to prevent header splitting.

#### Third-party scripts

A static `script-src` allowlist only covers scripts whose origin you know at
build time. A tag manager that injects more scripts (Google Tag Manager loading
analytics, Segment, `next/script`'s `afterInteractive`) needs more. Set
`strictDynamic: true` and the hashed shell scripts and the per-request nonce
vouch for the scripts they load, so you do not allowlist each host.

With `'strict-dynamic'` present, CSP3 browsers ignore host and `'self'`
allowlists in `script-src`. Hashes and nonces still apply. On a static route
there is no nonce, only hashes, and those hashed scripts can still inject further
scripts. Test the modes you ship.

## Build step

### `runPostbuild(options?)`

Programmatic form of the CLI. Scans the build, writes the manifest, runs the
self-check, and returns a [`PostbuildResult`](#postbuildresult).

```ts
import { runPostbuild } from 'strict-csp-next'

runPostbuild({ failOnUncovered: true })
```

#### `PostbuildOptions`

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `projectDir` | `string` | `process.cwd()` | Project root. |
| `distDir` | `string` | `.next` | Build directory if you set a custom `distDir`. |
| `algorithm` | `'sha256' \| 'sha384' \| 'sha512'` | `'sha256'` | Hash algorithm. |
| `failOnUncovered` | `boolean` | `false` (CLI: `true`) | Throw if the self-check finds a count mismatch. The CLI enables this unless `--no-strict`. |
| `emitHeaders` | `boolean` | `false` | Also write `<distDir>/strict-csp-headers.json` for CDN-terminal static delivery. |
| `headerOptions` | `StrictCspOptions` | `{}` | Policy options applied to the emitted static headers and the export meta CSP. Programmatic only; the CLI has no flag for it. |
| `exportDir` | `string` | none | For `output: 'export'`: inject a `<meta>` CSP into every HTML file under this directory. |

#### `PostbuildResult`

| Field | Type | Description |
| --- | --- | --- |
| `manifestPath` | `string` | Where the manifest was written. |
| `headersPath` | `string?` | Where static headers were written, if `emitHeaders`. |
| `standalonePath` | `string?` | Where the manifest was copied for `output: 'standalone'`, if detected. |
| `exportFilesPatched` | `number?` | Count of HTML files a meta CSP was injected into, if `exportDir`. |
| `routeCount` | `number` | Prerendered routes in the manifest. |
| `totalHashes` | `number` | Total inline-script hashes across all routes. |
| `uncovered` | `Array<{ route, inlineScripts, coarseScripts, reason }>` | Routes where the self-check signals disagreed. |

### CLI

```
strict-csp-next postbuild [projectDir] [options]
```

| Flag | Description |
| --- | --- |
| `--emit-headers` | Write `<distDir>/strict-csp-headers.json` for static routes. |
| `--export[=<dir>]` | Inject a `<meta>` CSP into exported HTML (default dir `out`). |
| `--dist-dir=<dir>` | Next build dir if you set a custom `distDir`. |
| `--no-strict` | Do not fail the build on a self-check mismatch. |

Wire it after `next build`:

```json
{ "scripts": { "build": "next build && strict-csp-next postbuild" } }
```

## Lower-level helpers

These back the proxy and build step. Reach for them to build custom tooling.

| Export | Purpose |
| --- | --- |
| `planCsp(manifest, pathname, options)` | The proxy's pure decision core. Returns `{ skip, policy, nonce, headerName, noStore, reportingEndpoints }` with no `next/server` dependency. |
| `generateNonce()` | A URL-safe base64 nonce with 128 bits of entropy. |
| `buildPolicy(shellHashes, nonce, options)` | Build one policy string. `nonce` is `null` for hash-only routes. |
| `buildMetaPolicy(shellHashes, options)` | A hashes-only policy for a `<meta>` tag, dropping directives a meta tag cannot express. |
| `cspHeaderName(options)` | The header name for the chosen `mode`. |
| `generateManifest(projectDir, algorithm?, distDir?)` | Scan the build and return the manifest. |
| `writeManifest(projectDir, manifest, distDir?)` | Write the manifest to disk; returns the path. |
| `loadManifest(projectDir?, distDir?)` | Read the manifest, cached per build path. Misses are not cached. |
| `clearManifestCache()` | Drop the cache (after a rebuild, or in tests). |
| `manifestPath(projectDir, distDir?)` | The manifest path inside the build dir. |
| `lookupRoute(manifest, pathname)` | Match a pathname to a route entry, normalizing a trailing slash. No filesystem access. |
| `extractInlineHashes(html, algorithm?)` | Deduplicated hashes for every executable bare inline script in an HTML string. |
| `hashInlineScript(content, algorithm?)` | The CSP hash of one script body. |
| `staticCspHeaders(manifest, options?, deliveryOptions?)` | Header entries for `static` / `isr` routes, in the shape `headers()` and `vercel.json` expect. Pass `{ includeIsr: false }` when ISR is covered by the cache handler. |
| `injectMetaCsp(exportDir, algorithm?, options?)` | Inject a `<meta>` CSP into every HTML file under a directory. Returns the count patched. |
| `injectPrerenderMetaCsp(projectDir?, options?, distDir?)` | Stamp the hash-only CSP into the prerender `.meta` sidecar of every `static` / `isr` route, so Next serves it from its own cache on the first request. Companion to the cache handler. Returns `{ patched }`. Also available as `runPostbuild`'s `patchPrerenderHeaders` option. |
| `withStrictCsp(nextConfig?)` | A pass-through config wrapper reserving a place for future automatic wiring. |

### `strict-csp-next/cache-handler`

Cache-write-time CSP for ISR (and any on-demand-revalidated) routes.

| Export | What it does |
| --- | --- |
| `withStrictCspCache(BaseCacheHandler, options?)` | Wrap a Next.js cache handler so every cached `APP_PAGE` entry carries a CSP header whose hashes match its exact bytes, recomputed on every revalidation. Compose the built-in `FileSystemCache` or your own (Redis, etc.) as the base. |
| `cspHeaderForHtml(html, options?)` | Pure helper: the CSP header value (and name) for one document, or a `null` policy with a `driftReason` if the self-check fails. |
| `applyCspHeader(headers, html, options?)` | Pure helper: returns headers with any existing CSP stripped and the computed one set (omitted on drift). |

## Reading the nonce

If you render your own inline `<script>`, read the nonce the proxy set and pass
it through:

```tsx
import { headers } from 'next/headers'

export default async function Page() {
  const nonce = (await headers()).get('x-nonce')
  return <script nonce={nonce ?? undefined}>{`/* ... */`}</script>
}
```

Reading the nonce with `headers()` opts that route into dynamic rendering, the
same as any other dynamic header read.
