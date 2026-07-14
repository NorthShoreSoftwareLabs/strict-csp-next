#!/usr/bin/env bash
# Build this Next.js 15 example against the local library and run the browser CSP
# test for the ZERO-'self' SRI path. Usage: e2e.sh [next-version] [bundler]
#   e2e.sh 15              # webpack build (default) against next@15 (latest 15.x)
#   e2e.sh 15.5 webpack    # explicit webpack build against a specific 15.x
#   e2e.sh 15 turbopack    # Turbopack build (`next build --turbopack`, Next 15.5+)
#
# The example runs `runPostbuild({ backfillIntegrity: true })`, which pins every
# external <script src>, so static/ISR routes drop 'self' and add
# 'strict-dynamic'. sri-test.mjs asserts that shape. Exits non-zero on any CSP
# violation or failed assertion, which is how CI catches a regression.
set -euo pipefail

NEXT_VERSION="${1:-}"
BUNDLER="${2:-webpack}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

if [ "$BUNDLER" != "webpack" ] && [ "$BUNDLER" != "turbopack" ]; then
  echo "e2e-next15-sri: unknown bundler '$BUNDLER' (expected 'webpack' or 'turbopack')" >&2
  exit 2
fi

# Pack the library so the example consumes the real published shape, and install
# the freshly packed tarball so we test the current build, not a cached one. The
# example pins `file:../../strict-csp-next.tgz`, so the tarball must land in
# $ROOT for the first `pnpm install` to resolve it. Discard pack's stdout and find
# the file by glob, so any build output folded into stdout can't corrupt the
# filename.
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

echo "e2e-next15-sri: building with ${BUNDLER}"
if [ "$BUNDLER" = "turbopack" ]; then
  # Turbopack production build (`next build --turbopack`, stable in Next 15.5+).
  # As of Next 15.5.x, Turbopack REFUSES to build when `experimental.sri` is set
  # (it is on the unsupported-config list), so the zero-'self' SRI path cannot be
  # produced by a Turbopack build on this Next version — SRI integrity is what
  # earns the 'self'-drop, and there is no Turbopack-native substitute. We detect
  # that exact, documented incompatibility and report it explicitly (exit 0) so
  # CI records the finding without a fake pass. Any OTHER build failure is a real
  # error (exit 1); if a future Turbopack accepts `experimental.sri`, the build
  # succeeds and the SAME assertions below run unchanged.
  set +e
  BUILD_LOG="$(pnpm exec next build --turbopack 2>&1)"
  BUILD_STATUS=$?
  set -e
  echo "$BUILD_LOG"
  if [ "$BUILD_STATUS" -ne 0 ]; then
    if echo "$BUILD_LOG" | grep -qi 'to use turbopack, remove' && echo "$BUILD_LOG" | grep -q 'experimental.sri'; then
      echo ""
      echo "e2e-next15-sri (turbopack): KNOWN INCOMPATIBILITY — this Next.js version rejects"
      echo "  experimental.sri under Turbopack, so the zero-'self' SRI path is a webpack-only"
      echo "  build here. Documented in README.md ('Turbopack'). The webpack variant"
      echo "  (bash e2e.sh 15) proves the zero-'self' path. Not a failure; nothing to assert."
      exit 0
    fi
    echo "e2e-next15-sri (turbopack): build failed for an unexpected reason (see above)" >&2
    exit 1
  fi
  node postbuild.mjs
else
  pnpm build
fi

pnpm start &
SERVER_PID=$!
# `pnpm start` spawns a child `next start` that holds port 4500; a bare
# `kill $SERVER_PID` orphans that child and the next run on 4500 collides. Kill
# the child process tree first, then the pnpm parent, so two sequential CI runs
# on the same port cannot clash.
trap 'pkill -P "$SERVER_PID" 2>/dev/null; kill "$SERVER_PID" 2>/dev/null || true' EXIT

# Wait for the server to accept connections.
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:4500/ >/dev/null 2>&1; then break; fi
  sleep 1
done

# Capture with `|| true` so a failing test (process.exit(1)) does not abort under
# `set -e` before we print its per-route diagnostic table; the grep gate below is
# the authoritative pass/fail signal.
OUTPUT="$(node sri-test.mjs)" || true
echo "$OUTPUT"
if echo "$OUTPUT" | grep -q 'ALL PASS'; then
  echo "e2e-next15-sri (${BUNDLER}): zero-'self' SRI holds on all static routes"
else
  echo "e2e-next15-sri (${BUNDLER}): CSP violations or failed assertions detected (see above)" >&2
  exit 1
fi
