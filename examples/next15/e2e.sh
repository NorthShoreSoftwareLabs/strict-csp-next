#!/usr/bin/env bash
# Build this Next.js 15 example against the local library and run the browser CSP
# test. Usage: e2e.sh [next-version]   (e.g. e2e.sh 15, e2e.sh 15.2). Exits
# non-zero on any CSP violation or failed assertion, which is how CI catches a
# breaking change on Next 15.
set -euo pipefail

NEXT_VERSION="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

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

pnpm build
pnpm start &
SERVER_PID=$!
# `pnpm start` spawns a child `next start` that holds port 4300; a bare
# `kill $SERVER_PID` orphans that child and the next run on 4300 collides. Kill
# the child process tree first, then the pnpm parent, so two sequential CI runs
# on the same port cannot clash.
trap 'pkill -P "$SERVER_PID" 2>/dev/null; kill "$SERVER_PID" 2>/dev/null || true' EXIT

# Wait for the server to accept connections.
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:4300/ >/dev/null 2>&1; then break; fi
  sleep 1
done

OUTPUT="$(node next15-test.mjs)"
echo "$OUTPUT"
if echo "$OUTPUT" | grep -q 'ALL PASS'; then
  echo "e2e-next15: all routes clean under strict CSP"
else
  echo "e2e-next15: CSP violations or failed assertions detected (see above)" >&2
  exit 1
fi
