// Next.js 15 uses middleware.js (Next 16 renamed it to proxy.js, which Next 15
// ignores). `createStrictCsp({ skipStatic: true })` leaves `static` and `isr`
// routes untouched — those carry their CSP from the cache handler
// (cache-handler.cjs) and the postbuild .meta patch — while it mints a fresh
// per-request nonce for `dynamic`/`ppr` routes. Needs the Node.js runtime so it
// can read the build-time manifest from disk (`runtime: 'nodejs'`, stable in 15.5).
import { createStrictCsp } from 'strict-csp-next/proxy'

export const middleware = createStrictCsp({ skipStatic: true })

// `config.matcher` copied from examples/next15/middleware.js, plus one extra
// exclusion: `/post` (see below). Exclude static assets, Route Handlers, and
// file-based metadata routes: middleware runs before the response so it can't see
// the content-type, and matching them would slap a needless CSP and `no-store` on
// cacheable feeds and images.
//
// `/post` is excluded on purpose. `lookupRoute` matches concrete paths only, so an
// un-prebuilt dynamic-param path like `/post/<new-id>` is unknown to the manifest
// and the middleware would nonce it — which would COVER the fill and mask the very
// thing this probe measures. Excluding `/post` leaves the cache handler as the
// SOLE CSP source there (as in examples/isr-cache), so the plain first-fill MISS
// reading reflects the cache handler alone and exposes the Next 15 race. In a real
// app you would NOT exclude it: the nonce fallback safely covers such fills.
export const config = {
  runtime: 'nodejs', // Node runtime needed so the disk-read manifest works; stable in Next 15.5.
  matcher: [
    {
      source:
        '/((?!api|post(?:$|/)|_next/static|_next/image|favicon.ico|(?:opengraph-image|twitter-image|apple-icon|icon)(?:$|\\.|/)|.*\\.(?:png|jpg|jpeg|gif|svg|webp|ico|txt|xml|json|webmanifest)$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
}
