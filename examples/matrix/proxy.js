// Next.js 16 renamed middleware.js to proxy.js. It always runs on the Node.js
// runtime, which is what strict-csp-next needs to read the manifest from disk.
// createStrictCsp() sets `script-src 'self' <hashes> 'nonce-...'` per request.
import { createStrictCsp } from 'strict-csp-next/proxy'

export const proxy = createStrictCsp()

// `config.matcher` is supported in proxy.js (only the `runtime` field is not,
// since proxy is always Node). Exclude static assets, Route Handlers, and
// file-based metadata routes (og-image/twitter-image/icons): the proxy runs
// before the response so it can't see the content-type, and matching them would
// slap a needless CSP and `no-store` on cacheable feeds and images. The metadata
// names are anchored to a full path segment (end, `.`, or `/`) so a real page
// that merely shares a prefix (e.g. /icons, /opengraph-image-gallery) is still
// proxied and keeps its CSP. robots.txt / sitemap.xml are covered by the
// file-extension rule below.
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
