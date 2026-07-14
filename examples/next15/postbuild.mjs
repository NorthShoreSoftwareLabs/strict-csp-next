// postbuild.mjs — Run after next build to generate the CSP manifest.
// Invoke as: node postbuild.mjs
// Wired into package.json build script: "next build && node postbuild.mjs".
import { runPostbuild } from 'strict-csp-next'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const projectDir = dirname(fileURLToPath(import.meta.url))
// failOnUncovered defaults to true: the build fails if any executable inline
// script is left uncovered (drift). This is the tripwire you want on.
const result = runPostbuild({ projectDir })
console.log('strict-csp-next postbuild:', JSON.stringify(result, null, 2))
