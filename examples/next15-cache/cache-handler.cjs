// The cache handler under test on Next.js 15. On every cache write (build
// prerender and each ISR revalidation) it hashes the exact HTML being cached and
// stamps a matching CSP onto the same entry. No next.config headers(): the only
// runtime CSP source for `static`/`isr` routes is this handler (plus the
// postbuild .meta patch for the build prerender), so a correct policy on a served
// ISR page is attributable to it.
//
// The internal path `next/dist/server/lib/incremental-cache/file-system-cache`
// (default export FileSystemCache) exists in Next 15.x.
const { withStrictCspCache } = require('strict-csp-next/cache-handler')
const FileSystemCache =
  require('next/dist/server/lib/incremental-cache/file-system-cache').default

module.exports = withStrictCspCache(FileSystemCache, { strictDynamic: true })
