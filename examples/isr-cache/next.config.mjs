import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** @type {import('next').NextConfig} */
export default {
  // Classic App Router (no cacheComponents), so per-route `revalidate` is honored
  // and we get real ISR. The cache handler stamps a fresh CSP onto every cached
  // page on every revalidation.
  cacheHandler: new URL('./cache-handler.cjs', import.meta.url).pathname,
  outputFileTracingRoot: here,
}
