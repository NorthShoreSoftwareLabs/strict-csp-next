# Security model

This package exists to make a strict script policy hold without giving up static
rendering. This page states what it guarantees, how it defends those guarantees,
and where the edges are.

## The guarantee

Every inline script the App Router emits is covered by a hash or a nonce, so
`script-src` never needs `'unsafe-inline'` or `'unsafe-eval'` in production. An
attacker who injects an inline `<script>` into your markup has no matching hash
and no valid nonce, so the browser blocks it.

The library owns `script-src`. You cannot remove `'self'`, the route's hashes, or
the nonce through configuration. Additions are merged, never substitutions.

## Defenses

### Banned sources cannot be added back

`'unsafe-inline'`, `'unsafe-eval'`, and `'unsafe-hashes'` are stripped from every
script-governing directive you pass: `script-src`, `script-src-elem`,
`script-src-attr`, and `default-src`. The strip splits each value on whitespace
first, so a single entry that packs two tokens together
(`"'self' 'unsafe-inline'"`) cannot smuggle a banned source past an exact-match
check. CSP3 browsers consult the more specific `-elem` and `-attr` directives
before `script-src`, which is why the strip covers all of them and not just
`script-src`.

### Policy injection is rejected

Directive names and values containing `;`, `,`, CR, or LF are rejected at build
time. A caller-supplied value cannot terminate the policy early and append a
second, weaker one, and cannot split the response header. `reportTo` and
`reportToEndpoint` reject CR, LF, and `"` for the same reason, since they flow
into the `Reporting-Endpoints` header.

### Nonces are unguessable and single-use

Each nonce is 16 bytes (128 bits) from `crypto.getRandomValues`, encoded URL-safe
base64 with the padding stripped so it never trips a proxy. A fresh nonce is
minted per request. Enforced nonced responses carry `Cache-Control: no-store`, so
a nonce can never be cached and replayed against a later request. In
`report-only` mode nothing is enforced, so a replayed nonce gates nothing and the
proxy keeps the response cacheable.

### The self-check

The strength of a hash-based policy is only as good as the scanner that produced
the hashes. If the scanner misses an executable inline script, the manifest ships
without its hash and the browser blocks it at runtime, which is a broken page.

The build step defends against that with three independent signals per page:

1. a quote-aware tokenizer that parses each `<script>` open tag respecting quoted
   attribute values, so a `src=` or `>` inside an attribute value cannot
   misclassify a script;
2. a coarse regex with a different structure, as a cross-check; and
3. the open/close `<script>` tag balance, to catch a truncated or malformed tag.

If the signals disagree, the build fails with the offending route. Because the
two counting methods are structurally different, a single parsing bug is unlikely
to fool both the same way, so a real miss surfaces as a disagreement rather than
a silent zero.

A scheduled CI job runs the browser matrix against `next@canary`, so a change in
how Next emits inline scripts is caught before it reaches a release you depend on.

## Known tradeoffs

### `style-src 'unsafe-inline'` is the default

Inline styles default to `'unsafe-inline'`, which covers styled-jsx, CSS-in-JS,
and Next's inline CSS. This affects styles, not scripts, and does not permit
script execution. It is a deliberate choice, since fully nonced styles break
common styling approaches. Opt into nonced styles with `styleNonce: true`, which
takes effect on dynamic and PPR routes (where a nonce exists) and never in dev.

### Static export cannot set every directive

A `<meta>` CSP cannot express `frame-ancestors`, `report-uri`, `report-to`, or
`sandbox`, because browsers ignore those when the policy arrives via `<meta>`. An
exported site therefore has no clickjacking protection from the policy alone. Set
`frame-ancestors` or `X-Frame-Options` at your CDN. The export step warns about
this, and warns about any exported page that ships inline scripts but has no
`<head>` to anchor a meta tag.

### Hash coverage assumes stable bytes

A hash matches exact bytes. An ISR route whose inline data changes on
revalidation will not match a hash frozen in `vercel.json` at build time. Two
ways to keep such a route strict and correct:

- **Cache handler (keeps caching).** `withStrictCspCache` recomputes the hash at
  cache-write time, so the policy tracks the bytes on every revalidation. The
  route stays CDN-cacheable with no nonce. Pair it with `injectPrerenderMetaCsp`
  (in postbuild) so the build-time prerender is covered before the first
  revalidation, and keep it out of the build-frozen set with
  `staticCspHeaders(manifest, opts, { includeIsr: false })`. Every cache state is
  covered, including the cache-fill `MISS` (the first request to an un-prebuilt
  path or after `revalidatePath`): the handler writes the policy onto the same
  value object Next sends, in place, before the response goes out. If the
  cache-write self-check ever detects drift, it omits the header for that entry,
  failing open to no policy (page works, CSP absent on that route) and logging
  once, rather than caching a policy that blocks.
- **Nonce path (gives up caching).** Leave the route out of the static-header
  set entirely. The default proxy mints a nonce for any route that renders at
  request time, at the cost of `Cache-Control: no-store`.

## Reporting a vulnerability

Open a private security advisory on the GitHub repository. Include the Next.js
version, the rendering mode of the affected route, and the policy the browser
received.
