import { withStrictCsp } from 'strict-csp-next'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  // This is a Next 15 app, so we do NOT use cacheComponents (Next 16 only). The
  // segment config `export const dynamic` drives the dynamic route.
  // This example lives inside the library repo; pin the tracing root so the build
  // does not climb to the repo root.
  outputFileTracingRoot: here,
  // Pin the build id so the Edge middleware bundle's committed manifest import
  // stays stable across the e2e double-build.
  generateBuildId: () => 'edge',
  // The Edge middleware statically imports `.next/strict-csp-manifest.json`, which
  // `postbuild` writes into the build dir. `next build` wipes `.next` at the start
  // by default, which would delete the manifest before the next build can bundle
  // it. Keep the dir so the double-build works: build #1's postbuild writes the
  // real manifest, build #2 bundles it into the Edge middleware. See e2e.sh.
  cleanDistDir: false,
}

// withStrictCsp enables `experimental.sri` (default algorithm sha256) so static
// routes get integrity hashes and a fully strict CSP.
export default withStrictCsp(nextConfig)
