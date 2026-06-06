# Static pages, `'self'`, and how to drop it

Working note. Date: 2026-06-06.

## Why this exists

We integrated strict-csp-next into a real Next 16 SaaS on Vercel (a control
plane with prerendered auth pages and a dynamic dashboard). It surfaced a gap in
the library's **static / ISR hash path**: it cannot cover a prerendered page's
external scripts with hashes, so it falls back to `'self'`. `'self'` is a
host-based allowlist — exactly the thing a strict CSP exists to remove. For a
library whose entire promise is "strict CSP," that fallback is a real weakness,
not a footnote. This note records what happened, why the gap exists, and the
path to closing it.

## What we did (the sequence)

1. The app's own proxy set `script-src 'self' 'nonce-<per-request>' 'strict-dynamic'`
   on every route. On its prerendered pages, the per-request nonce could not match
   the build-time inline scripts, so all of them were blocked and the pages never
   hydrated.
2. **Fix 1:** we added the build-time inline-script hashes (from the strict-csp-next
   manifest) to `script-src` for static routes. The inline scripts were now
   covered. Header-level checks passed.
3. **Browser caught what header checks missed:** the external
   `/_next/static/chunks/*.js` `<script src>` tags were still blocked. Cause:
   `'strict-dynamic'` tells the browser to ignore `'self'`, and those external
   chunks had no nonce and no hash, so nothing allowed them.
4. **Fix 2 (shipped):** static routes now use `script-src 'self' <inline-hashes>`
   — drop `'strict-dynamic'` and the nonce. `'self'` covers the same-origin
   chunks; the hashes cover the inline scripts. Every inline and external script
   is covered; no violations. Dynamic routes keep nonce + strict-dynamic.

That works and is safe for this app. But it leans on `'self'`.

## The issue, precisely

A CSP `script-src` **hash** matches the *content* of an **inline** script. It does
nothing for an **external** `<script src>` — there is no inline body to hash. A
per-request **nonce** can't help on a prerendered page either, because the HTML is
frozen at build time and carries no request-time value. So, to allow a static
page's external chunks, the only levers today are:

- `'self'` — a host allowlist. What we ship. CSP Evaluator flags it for the
  JSONP / AngularJS / same-origin-user-upload bypass classes. It is not strict.
- **Subresource Integrity (SRI)** — covered below. The strict answer.

So the static/ISR hash path is currently "strict for inline scripts, host-allowlist
for external scripts." The nonce path (dynamic / PPR) is fully strict because Next
stamps the nonce onto *every* script it emits, inline and external, at render
time. Prerendered pages can't do that, which is the whole reason this path exists
— and the reason it stops short of fully strict.

## The fix: SRI to pin external scripts by hash

CSP Level 3 lets a `script-src` hash match an **external** script via its
Subresource Integrity metadata. If a chunk tag is rendered as
`<script src="/_next/…" integrity="sha256-H">` and `script-src` lists
`'sha256-H'`, the browser allows that external script **because its bytes hash to
H** — no host allowlist involved. Pin every initial chunk this way and `'self'`
is no longer needed.

Next has the build half of this: `experimental.sri` (verified present in 16.2.7,
`{ algorithm: 'sha256' | 'sha384' | 'sha512' }`) adds `integrity` attributes to
the script/link tags it generates. strict-csp-next would supply the policy half:
read those `integrity` values out of the prerendered HTML and list them in
`script-src`.

### Recommended policy shape for a static page

```
script-src <inline-content-hashes> <external-integrity-hashes> 'strict-dynamic'
```

- inline scripts → their content hashes (what we already extract),
- the page's initial external chunks → their SRI integrity hashes (new),
- `'strict-dynamic'` → so those now-trusted (hash-matched) initial chunks can load
  the **runtime** chunks they pull in, without `'self'` and without having to
  enumerate every lazy chunk at build time.

No `'self'`, no nonce, no host allowlist. Every initial script is pinned by hash;
runtime scripts inherit trust through strict-dynamic. This is the version of the
static path that actually lives up to "strict." Note the inversion from Fix 2:
strict-dynamic is *fine* here precisely because the external chunks now carry
hashes — it was only harmful before because they didn't.

## Implementation sketch in this library

1. **Scanner.** Extend the tokenizer (`src/hash.ts`) to also collect the
   `integrity` attribute value from external `<script src … integrity="…">` tags.
   Today `scanInlineScripts` classifies those as non-executable-for-our-purposes
   (they have `src`); we'd add a parallel `extractExternalIntegrity(html)` that
   returns the integrity hashes.
2. **Manifest.** Add a field per route, e.g. `externalIntegrity: string[]`,
   alongside `shellHashes`. The build/postbuild flow and the buildId-pinned,
   deploy-sourced manifest workflow are unchanged — integrity hashes are just more
   build-specific hashes captured at the same time.
3. **Policy.** Add a mode/option (e.g. `externalIntegrity: true`, or auto-detected
   when the manifest has integrity entries) so `buildPolicy` / `staticCspHeaders`
   emit `script-src <inline> <integrity> 'strict-dynamic'` and **omit `'self'`**
   for static/ISR routes.
4. **Self-check.** The three-signal guard should also count external script tags
   vs. integrity attributes, so a Next change that drops or reshapes `integrity`
   fails the build instead of silently shipping an uncovered chunk.
5. **Docs.** Tell users to enable `experimental.sri` and what the trade-offs are.

## Open questions / risks (verify before building)

- **Turbopack.** The SRI implementation is a *webpack* plugin
  (`node_modules/next/dist/build/webpack/plugins/subresource-integrity-plugin.js`).
  Next 16 builds with Turbopack by default. So `experimental.sri` may only apply
  to webpack builds today. If Turbopack doesn't emit `integrity`, this path
  requires opting the build back to webpack — or waiting for Turbopack support.
  This is the biggest unknown and should be checked first.
- **Runtime chunks under strict-dynamic.** Confirm in real browsers that an
  external script allowed via an integrity-hash match counts as a trusted seed for
  strict-dynamic propagation (so runtime-injected chunks load). The spec says a
  hash-allowed script propagates; verify behavior across Chromium/Firefox/WebKit.
- **Does Next set `integrity` on dynamically-injected chunks too,** or only on the
  initial HTML tags? If only initial, we rely entirely on strict-dynamic
  propagation for the rest (the recommended shape already assumes this).
- **Header size.** A page can reference ~12 initial chunks plus ~6 inline scripts;
  that's ~18 sha256 tokens (~1 KB) in the header per route. Fine, but dedupe
  shared chunks across routes where the delivery allows.
- **Algorithm.** SRI commonly uses sha384; our inline hashes default to sha256.
  CSP matches per-algorithm, so the policy must list each script's hash in
  whatever algorithm its `integrity` uses. Keep the algorithms aligned (configure
  `experimental.sri.algorithm` to match, or list both).

## Status / recommendation

The `'self'` static path ships today (v0.2.0) and is correct and safe for apps
without JSONP, AngularJS, or same-origin user-uploaded scripts. But it is not
fully strict, and the library should not be satisfied with that. The SRI +
strict-dynamic shape above is the way to make the static/ISR path allowlist-free,
matching the strictness the nonce path already gives dynamic routes. Next step is
to confirm Turbopack `experimental.sri` behavior, then implement the scanner +
manifest + policy changes behind an opt-in flag.
