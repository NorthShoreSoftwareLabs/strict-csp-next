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

// withStrictCsp enables `experimental.sri` (default algorithm sha256) so Next
// emits `integrity` on bundle scripts. Next leaves the client-component chunks
// un-pinned, which alone keeps `'self'`. This example ALSO runs the integrity
// backfill in postbuild.mjs (`runPostbuild({ backfillIntegrity: true })`), which
// hashes those on-disk chunks and injects the missing `integrity`. Once every
// external script is pinned (uncoveredExternal === 0), the coverage gate in
// src/policy.ts drops `'self'` and adds `'strict-dynamic'`. So `/` and `/isr`
// ship `script-src <hashes> <integrity> 'strict-dynamic'` with NO `'self'` — the
// zero-'self' SRI path that sri-test.mjs asserts. Contrast with examples/next15,
// which does NOT backfill and therefore keeps `'self'`.
export default withStrictCsp(nextConfig)
