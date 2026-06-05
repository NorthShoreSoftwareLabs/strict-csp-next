import Counter from './counter.js'

export default function Page() {
  return (
    <main style={{ fontFamily: 'system-ui', padding: 40 }}>
      <h1>Static export under a strict CSP</h1>
      <p>
        This page is statically exported and served with no CSP response header.
        The policy lives in an injected meta tag. Zero inline-script violations.
      </p>
      <Counter />
    </main>
  )
}
