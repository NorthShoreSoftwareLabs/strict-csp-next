// Close the build-time-prerender window: stamp the hash-only CSP into the .meta
// sidecar of static/isr routes so Next serves the policy from its own cache on
// the very first request, before any runtime revalidation runs the cache
// handler. The cache handler then keeps it correct on every later revalidation.
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectPrerenderMetaCsp } from 'strict-csp-next'

const projectDir = dirname(fileURLToPath(import.meta.url))
const { patched } = injectPrerenderMetaCsp(projectDir)
console.log('strict-csp-next: patched prerender meta for', patched)
