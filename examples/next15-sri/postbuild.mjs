// postbuild.mjs — Run after next build to generate the CSP manifest AND backfill
// the integrity attributes Next leaves off the client-component chunks.
// Invoke as: node postbuild.mjs
// Wired into package.json build script: "next build && node postbuild.mjs".
import { runPostbuild } from 'strict-csp-next'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const projectDir = dirname(fileURLToPath(import.meta.url))
// backfillIntegrity: true is the `postbuild --backfill` equivalent. Next's
// `experimental.sri` pins most external bundle scripts but leaves the
// client-component chunks un-pinned; the backfill hashes those on disk and
// injects the missing `integrity`. Once coverage hits 100% (uncoveredExternal
// === 0), the policy for static/ISR routes drops 'self' and adds
// 'strict-dynamic' — the zero-'self' SRI path this example proves.
// failOnUncovered defaults to true: the build fails if any executable inline
// script is left uncovered (drift). This is the tripwire you want on.
const result = runPostbuild({ projectDir, backfillIntegrity: true })
console.log('strict-csp-next postbuild:', JSON.stringify(result, null, 2))
