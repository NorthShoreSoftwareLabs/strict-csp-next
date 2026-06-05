# ISR cache-handler proof

A classic App Router app (no `cacheComponents`, so per-route `revalidate` gives
real ISR) that proves `withStrictCspCache` keeps an ISR route strict-CSP-correct
when its data changes on revalidation, in every cache state.

There is **no** `next.config` `headers()` and **no** proxy here. The only things
that can set a CSP are:

- `postbuild.mjs` → `injectPrerenderMetaCsp`, which stamps the policy into the
  build prerender's `.meta` (covers the first request to a prebuilt path), and
- `cache-handler.cjs` → `withStrictCspCache`, which hashes the exact HTML on every
  cache write and writes the header onto the same value object Next sends (covers
  every fresh hit, the stale-while-revalidate stale serve, and the cache-fill
  `MISS` render).

So a correct policy on any served response is attributable to the package.

## Run it

```bash
./e2e.sh
```

It packs the library, installs it, builds, serves on port 4310, and runs
`verify.mjs`, which asserts that the build prerender, a cache-fill `MISS` on an
un-prebuilt `/post/[id]`, the stale-while-revalidate serve, and the
post-`revalidatePath` render all carry a CSP covering every inline script, and
that the hash set tracks the data when it changes.

## Routes

- `/isr` — `revalidate = 5`, renders a value read from `data.txt`. Changing the
  file and waiting out the window exercises time-based stale-while-revalidate.
- `/post/[id]` — `generateStaticParams` prebuilds only `/post/1`; any other id is
  generated on first request, which is the cache-fill `MISS` the handler must
  cover.
- `/api/bump` — rewrites `data.txt` and calls `revalidatePath('/isr')` to exercise
  on-demand (hard) invalidation.
