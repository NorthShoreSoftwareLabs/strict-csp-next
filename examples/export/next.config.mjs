import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  // SRI adds integrity to external bundle <script> tags; combined with the
  // injected meta CSP (hashes for inline) this gives a fully strict static site.
  experimental: { sri: { algorithm: 'sha256' } },
  outputFileTracingRoot: here,
}

export default nextConfig
