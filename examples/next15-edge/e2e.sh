#!/usr/bin/env bash
# Build this Next.js 15 example on the EDGE runtime against the local library and
# run the browser CSP test. Usage: e2e.sh [next-version]   (e.g. e2e.sh 15). Exits
# non-zero on any CSP violation or failed assertion, which is how CI catches a
# breaking change on Next 15's Edge middleware.
#
# The whole point of this example is to PROVE that `strict-csp-next/proxy-edge`
# and its import graph reach no Node built-ins, so an Edge middleware bundle that
# imports it compiles. The main `strict-csp-next/proxy` cannot: its manifest disk
# read pulls in `node:fs`/`node:path` (and `node:crypto`, via the hashing module).
set -euo pipefail

NEXT_VERSION="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

# Pack the library so the example consumes the real published shape, and install
# the freshly packed tarball so we test the current build, not a cached one. The
# example pins `file:../../strict-csp-next.tgz`, so the tarball must land in $ROOT
# for the first `pnpm install` to resolve it. Discard pack's stdout and find the
# file by glob, so any build output folded into stdout can't corrupt the filename.
cd "$ROOT"
pnpm build >/dev/null 2>&1
rm -f strict-csp-next-*.tgz strict-csp-next.tgz
pnpm pack >/dev/null 2>&1
# Rename to a version-agnostic filename so the example can pin a stable path
# (file:../../strict-csp-next.tgz) that does not rot on every version bump.
mv "$(ls strict-csp-next-*.tgz)" strict-csp-next.tgz
TARBALL="strict-csp-next.tgz"

cd "$HERE"
pnpm install
pnpm add "../../${TARBALL}"
if [ -n "$NEXT_VERSION" ]; then
  pnpm add "next@${NEXT_VERSION}" react@latest react-dom@latest
fi
if [ "$(uname)" = "Linux" ]; then
  pnpm exec playwright install --with-deps chromium
else
  pnpm exec playwright install chromium
fi

# The Edge middleware statically imports `.next/strict-csp-manifest.json`. On a
# clean checkout that file does not exist yet, so seed a minimal empty-routes
# manifest before the FIRST build so the import resolves and the Edge bundle
# compiles. `cleanDistDir: false` (next.config.mjs) keeps this dir across builds,
# so build #1's postbuild writes the REAL manifest and build #2 bundles it.
mkdir -p .next
if [ ! -f .next/strict-csp-manifest.json ]; then
  printf '%s' '{"version":1,"algorithm":"sha256","routes":[]}' > .next/strict-csp-manifest.json
fi

# DOUBLE-BUILD. Build #1: the Edge middleware bundle is compiled importing the
# (seeded) manifest; this is where a non-Edge-clean import graph would blow up
# with a "node:fs" / "Edge Runtime" error. postbuild then writes the real manifest.
# Build #2: the middleware bundles the now-present real manifest (per-route hashes).
BUILD1_LOG="$(mktemp)"
set +e
pnpm build 2>&1 | tee "$BUILD1_LOG"
BUILD1_STATUS=${PIPESTATUS[0]}
set -e

# CRITICAL: the first Edge build must NOT fail on a Node built-in. If it did, the
# proxy-edge import graph is not Edge-clean — surface it loudly and stop.
if grep -qiE "node:(fs|crypto|path|url|buffer|stream)|not supported in the Edge Runtime|A Node\.js (module|API) is (loaded|used)|Edge Runtime does not support" "$BUILD1_LOG"; then
  echo "" >&2
  echo "############################################################" >&2
  echo "FATAL: the Edge middleware build hit a Node built-in error." >&2
  echo "strict-csp-next/proxy-edge (or something it imports) is NOT" >&2
  echo "Edge-clean. An Edge middleware bundle cannot use node:fs /" >&2
  echo "node:crypto. See the build log above for the offending module." >&2
  echo "############################################################" >&2
  rm -f "$BUILD1_LOG"
  exit 1
fi
rm -f "$BUILD1_LOG"

if [ "$BUILD1_STATUS" -ne 0 ]; then
  echo "e2e-next15-edge: first build failed (see log above)" >&2
  exit 1
fi

# Build #2: bundle the real manifest into the Edge middleware.
pnpm build

pnpm start &
SERVER_PID=$!
# `pnpm start` spawns a child `next start` that holds port 4400; a bare
# `kill $SERVER_PID` orphans that child and the next run on 4400 collides. Kill
# the child process tree first, then the pnpm parent, so two sequential CI runs
# on the same port cannot clash.
trap 'pkill -P "$SERVER_PID" 2>/dev/null; kill "$SERVER_PID" 2>/dev/null || true' EXIT

# Wait for the server to accept connections.
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:4400/ >/dev/null 2>&1; then break; fi
  sleep 1
done

OUTPUT="$(node edge-test.mjs)"
echo "$OUTPUT"
if echo "$OUTPUT" | grep -q 'ALL PASS'; then
  echo "e2e-next15-edge: all routes clean under strict CSP on the Edge runtime"
else
  echo "e2e-next15-edge: CSP violations or failed assertions detected (see above)" >&2
  exit 1
fi
