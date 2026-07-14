import { withStrictCsp } from 'strict-csp-next'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  // This is a Next 15 app, so we do NOT use cacheComponents (Next 16 only). The
  // segment configs `export const dynamic`/`export const revalidate` are allowed
  // here and drive the dynamic/isr routes.
  // Allow a CI standalone-mode run to flip output without a separate app.
  output: process.env.NEXT_OUTPUT || undefined,
  // This example lives inside the library repo; pin the tracing root so a
  // standalone build does not climb to the repo root and nest the output.
  outputFileTracingRoot: here,
}

// withStrictCsp enables `experimental.sri` (default algorithm sha256) so static
// and ISR routes get integrity hashes and a fully strict CSP with zero 'self'.
export default withStrictCsp(nextConfig)
