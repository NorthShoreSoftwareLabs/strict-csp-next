# strict-csp-next

Strict Content-Security-Policy for the Next.js 16 App Router. No `'unsafe-inline'`
and no `'unsafe-eval'` for scripts, and your pages stay static.

```bash
npm install strict-csp-next
# or: pnpm add strict-csp-next
# or: yarn add strict-csp-next
```

> Requires Next.js 16+ (App Router, `proxy.ts`).
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

| Mode | Credential | Cacheable |
| --- | --- | --- |
| `static` | build-time hashes of the shell's inline scripts | yes |
| `isr` | hashes recomputed on every revalidation (cache handler) | yes |
| `ppr` | hashes for the shell **and** a per-request nonce for the resume | no (nonced) |
| `dynamic` | a per-request nonce | no (nonced) |

`isr` revalidates with changing data, so its inline-script bytes change. The
cache handler (`withStrictCspCache`) recomputes the hash at cache-write time so
the policy tracks the bytes; the route stays cacheable with no nonce. See
[how it works](./docs/how-it-works.md#3-the-cache-handler-isr).

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

## Deployment at a glance

| Host | How the manifest reaches the proxy |
| --- | --- |
| Self-hosted Node | Read from disk next to the process. Nothing extra. |
| Vercel / serverless | Trace it into the proxy bundle with `outputFileTracingIncludes`, or pass it to `createStrictCsp({ manifest })`. |
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
