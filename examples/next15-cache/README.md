# Next 15 cache-handler proof

A classic **Next.js 15** App Router app (no `cacheComponents` — that is Next 16
only, so per-route `revalidate` gives real ISR) that records which ISR cache
states carry the strict-CSP header from `withStrictCspCache` on Next 15.

There is **no** `next.config` `headers()` for static/isr. The only things that can
set a CSP on `/isr` are:

- `postbuild.mjs` → `runPostbuild({ patchPrerenderHeaders: true })`, which stamps
  the policy into the build prerender's `.meta` (covers the first request), and
- `cache-handler.cjs` → `withStrictCspCache`, which hashes the exact HTML on every
  cache write and writes the header onto the same value object Next sends.

The middleware runs `createStrictCsp({ skipStatic: true })`, so it leaves
static/isr to the cache-handler path and mints a per-request nonce for
`/dynamic`.

## The Next 15 caveat

On Next 15 the response-cache resolves the HTTP response BEFORE awaiting
`cacheHandler.set()` on an ordinary MISS, so a **plain first-fill MISS** (the
first request to an un-prebuilt ISR path such as `/post/<new-id>`) may ship
WITHOUT the CSP header. HIT, STALE, and on-demand revalidate
(`revalidatePath`/`revalidateTag`) do not have this race and stay covered.

`verify.mjs` therefore **asserts** the covered states and **records** the plain
first-fill MISS behavior in the table rather than failing on it.

This example measures the MISS reading with the nonce fallback intentionally
disabled: `/post` is excluded from the middleware matcher so the value reflects
the cache handler alone. In a normal app you keep `/post` matched, and the nonce
path covers first-fills, so the race above is only a concern when the cache
handler is the sole CSP source for a route.

## Run it

```bash
./e2e.sh 15
```

It packs the library, installs it, pins `next@15`, builds, serves on port 4600,
and runs `verify.mjs`, which prints a `STATE -> header` table and exits non-zero
only if an expected-covered state (build prerender, HIT, STALE,
on-demand-revalidate) is uncovered.

## Routes

- `/isr` — `revalidate = 2`, renders a value read from `data.txt`. Changing the
  file and waiting out the window exercises time-based stale-while-revalidate.
- `/post/[id]` — `generateStaticParams` prebuilds only `/post/1`; any other id is
  generated on first request, which is the plain first-fill `MISS` (the Next 15
  caveat).
- `/dynamic` — `force-dynamic`; the middleware nonces it (the non-skipped path).
- `/api/revalidate` — rewrites `data.txt` and calls `revalidatePath('/isr')` to
  exercise on-demand invalidation.
