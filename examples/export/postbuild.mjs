// Inject a <meta> CSP (inline-script hashes) into every file in out/.
import { runPostbuild } from 'strict-csp-next'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const projectDir = dirname(fileURLToPath(import.meta.url))
// backfillIntegrity tops up the integrity attributes Next leaves off the
// client-component chunks, so coverage reaches 100% and the meta CSP drops
// 'self'. failOnUncovered defaults to true (the tripwire stays on).
const result = runPostbuild({ projectDir, exportDir: 'out', backfillIntegrity: true })
console.log('strict-csp-next postbuild (export):', JSON.stringify(result, null, 2))
