// Route: /inline — author inline script that reads the nonce from x-nonce header.
// In cacheComponents mode, dynamic access (headers()) must be inside Suspense.
// The nonce-reading and script-emitting component lives inside Suspense so the
// static shell prerendering is not blocked.
import { Suspense } from 'react'
import { connection } from 'next/server'
import { headers } from 'next/headers'

async function NonceScript() {
  await connection()
  const hdrs = await headers()
  const nonce = hdrs.get('x-nonce') ?? ''
  const noncePreview = nonce ? nonce.slice(0, 8) + '...' : '(none)'
  return (
    <>
      <script
        nonce={nonce}
        dangerouslySetInnerHTML={{
          __html: `document.getElementById('inline-result').textContent = 'inline script ran OK (nonce prefix: ${noncePreview})';`,
        }}
      />
    </>
  )
}

export default function InlinePage() {
  return (
    <main>
      <h1>/inline — author inline script with nonce</h1>
      <p>The paragraph below is set by an author inline script using the nonce from middleware.</p>
      <p id="inline-result" style={{ fontStyle: 'italic', color: '#666' }}>
        waiting for inline script…
      </p>
      <Suspense fallback={null}>
        <NonceScript />
      </Suspense>
    </main>
  )
}
