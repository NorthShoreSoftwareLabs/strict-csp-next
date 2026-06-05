// Inject a <meta> CSP (inline-script hashes) into every file in out/.
import { runPostbuild } from 'strict-csp-next'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const projectDir = dirname(fileURLToPath(import.meta.url))
// failOnUncovered defaults to true (the tripwire stays on).
const result = runPostbuild({ projectDir, exportDir: 'out' })
console.log('strict-csp-next postbuild (export):', JSON.stringify(result, null, 2))
