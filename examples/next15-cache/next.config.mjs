import { withStrictCsp } from 'strict-csp-next'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Classic Next 15 App Router (NO cacheComponents — that is Next 16 only), so
  // per-route `revalidate` gives real ISR and the cache handler stamps a fresh
  // CSP onto every cached page on every revalidation.
  cacheHandler: require.resolve('./cache-handler.cjs'),
  // This example lives inside the library repo; pin the tracing root so the build
  // does not climb to the repo root and nest the output.
  outputFileTracingRoot: here,
}

// withStrictCsp enables `experimental.sri` and leaves the segment configs
// (`export const dynamic` / `export const revalidate`) intact. The middleware
// (`createStrictCsp({ skipStatic: true })`) then nonces dynamic/ppr routes while
// leaving static/isr to the cache-handler header path.
export default withStrictCsp(nextConfig)
