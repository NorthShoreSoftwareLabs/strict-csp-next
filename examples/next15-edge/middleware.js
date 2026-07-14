// Next.js 15 middleware on the EDGE runtime (the default — note there is NO
// `runtime: 'nodejs'` in the config below). The Edge bundle cannot use
// `strict-csp-next/proxy`, whose manifest disk read pulls in `node:fs`/`node:path`
// (and `node:crypto`, via the shared hashing module). `strict-csp-next/proxy-edge`
// reaches no Node built-ins: the manifest is imported here and passed in, and the
// nonce comes from Web Crypto. Per request it sets `script-src 'self' <hashes> 'nonce-...'`.
import { createStrictCspEdge } from 'strict-csp-next/proxy-edge'
// Import the committed build manifest so it is bundled into the Edge middleware
// (there is no disk to read on Edge). The file is written by `node postbuild.mjs`
// after `next build`; the e2e double-build ensures it is present before the build
// that references it.
import manifest from './.next/strict-csp-manifest.json' with { type: 'json' }

export const middleware = createStrictCspEdge({ manifest })

// `config.matcher` copied verbatim from examples/matrix/proxy.js. Exclude static
// assets, Route Handlers, and file-based metadata routes (og-image/twitter-image/
// icons): middleware runs before the response so it can't see the content-type,
// and matching them would slap a needless CSP and `no-store` on cacheable feeds
// and images. The metadata names are anchored to a full path segment (end, `.`,
// or `/`) so a real page that merely shares a prefix (e.g. /icons) is still
// covered. robots.txt / sitemap.xml are covered by the file-extension rule.
export const config = {
  // No `runtime` field: this middleware runs on the Edge runtime.
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
