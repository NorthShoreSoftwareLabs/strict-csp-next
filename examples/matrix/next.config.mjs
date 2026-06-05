import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  // cacheComponents enables PPR (Partial Prerendering / Cache Components) in Next 16.
  cacheComponents: true,
  // Cover ISR routes with cache-write-time hashing instead of build-frozen
  // headers. Uncomment to recompute the CSP on every revalidation so changing
  // inline data never breaks the policy. See ./cache-handler.cjs.
  // cacheHandler: new URL('./cache-handler.cjs', import.meta.url).pathname,
  // Allow the CI standalone-mode run to flip output without a separate app.
  output: process.env.NEXT_OUTPUT || undefined,
  // This example lives inside the library repo; pin the tracing root so a
  // standalone build does not climb to the repo root and nest the output.
  outputFileTracingRoot: here,
}

export default nextConfig
