// Next.js 15 uses middleware.js (Next 16 renamed it to proxy.js, which Next 15
// ignores). The library's `strictCsp` handler needs the Node.js runtime so it can
// read the build-time manifest from disk — `runtime: 'nodejs'` is stable in 15.5.
// Per request it reads the route's manifest entry: on static/ISR routes where the
// backfill pinned every external script (uncoveredExternal === 0), it emits the
// zero-'self' policy (`script-src <hashes> <integrity> 'strict-dynamic'`); on the
// dynamic route it emits `script-src 'self' <hashes> 'nonce-...'`.
export { strictCsp as middleware } from 'strict-csp-next/proxy'

// `config.matcher` copied verbatim from examples/matrix/proxy.js. Exclude static
// assets, Route Handlers, and file-based metadata routes (og-image/twitter-image/
// icons): middleware runs before the response so it can't see the content-type,
// and matching them would slap a needless CSP and `no-store` on cacheable feeds
// and images. The metadata names are anchored to a full path segment (end, `.`,
// or `/`) so a real page that merely shares a prefix (e.g. /icons) is still
// covered. robots.txt / sitemap.xml are covered by the file-extension rule.
export const config = {
  runtime: 'nodejs', // Node runtime needed so the disk-read manifest works; stable in Next 15.5.
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
