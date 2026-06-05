// Cache-write-time CSP for ISR routes.
//
// Wire this file into next.config as `cacheHandler`. On every cache write (the
// initial build and every ISR revalidation) it hashes the exact HTML Next just
// produced and stamps a matching `Content-Security-Policy` onto the same cache
// entry, so the body and its policy revalidate together. ISR data can change
// freely without breaking the strict policy, and the route stays CDN-cacheable
// with no nonce.
//
// Pair it with `staticCspHeaders(manifest, opts, { includeIsr: false })` so ISR
// routes are NOT also frozen into vercel.json, and run the proxy with
// `{ skipStatic: true }` so it leaves static and ISR routes to their hashes.
const {
  withStrictCspCache,
} = require('strict-csp-next/cache-handler')

// Compose the built-in filesystem cache as the base. Swap in your own Redis (or
// other) cache handler here for multi-instance ISR; the wrapper only overrides
// `set` to inject the header and delegates everything else to the base.
const FileSystemCache =
  require('next/dist/server/lib/incremental-cache/file-system-cache').default

module.exports = withStrictCspCache(FileSystemCache, { strictDynamic: true })
