// The cache handler under test. On every cache write (build prerender and each
// ISR revalidation) it hashes the exact HTML being cached and stamps a matching
// CSP onto the same entry. No next.config headers(), no proxy: this file is the
// ONLY thing that can set a CSP, so a correct policy on the served ISR page is
// attributable to it.
const { withStrictCspCache } = require('strict-csp-next/cache-handler')
const FileSystemCache =
  require('next/dist/server/lib/incremental-cache/file-system-cache').default

module.exports = withStrictCspCache(FileSystemCache)
