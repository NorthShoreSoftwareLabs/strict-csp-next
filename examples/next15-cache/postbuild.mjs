// postbuild.mjs — run after `next build`. Two jobs:
//   1) Generate the CSP manifest the middleware reads at runtime (so it can
//      classify each route and skip static/isr).
//   2) Patch the build prerender: `patchPrerenderHeaders: true` stamps the
//      hash-only CSP into the .meta sidecar of every static/isr route, so Next
//      serves the policy from its own cache on the very FIRST request — before
//      any runtime revalidation runs the cache handler.
import { runPostbuild } from 'strict-csp-next'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const projectDir = dirname(fileURLToPath(import.meta.url))
const result = runPostbuild({ projectDir, patchPrerenderHeaders: true })
console.log('strict-csp-next postbuild:', JSON.stringify(result, null, 2))
