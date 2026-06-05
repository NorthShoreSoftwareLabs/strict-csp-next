// Route: /third-party — loads an external script via next/script.
// The script src is same-origin (/vendor.js in public/) so no extra CSP
// host is needed beyond 'self'. The test documents what you need when the
// script is a real CDN origin.
import Script from 'next/script'

export default function ThirdPartyPage() {
  return (
    <main>
      <h1>/third-party — external script via next/script</h1>
      <p>
        Loads <code>/vendor.js</code> (same-origin, covered by <code>&apos;self&apos;</code>).
      </p>
      <p id="vendor-result" style={{ fontStyle: 'italic', color: '#666' }}>
        waiting for vendor script…
      </p>
      {/*
        strategy="afterInteractive" is next/script default. The script has a
        src so CSP does NOT block it on inline grounds. Same-origin src is
        covered by 'self'. For a real CDN like https://cdn.example.com/foo.js
        you must add that origin to script-src via the directives option in
        createStrictCsp({ directives: { 'script-src': ['https://cdn.example.com'] } }).
      */}
      <Script src="/vendor.js" strategy="afterInteractive" />
    </main>
  )
}
