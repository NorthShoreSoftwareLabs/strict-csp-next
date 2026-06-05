#!/usr/bin/env bash
# Build the example against the local library and run the browser CSP matrix.
# Usage: ci-e2e.sh [next-dist-tag]   (e.g. ci-e2e.sh canary). Exits non-zero on
# any CSP violation, which is how scheduled runs catch a breaking Next.js change.
set -euo pipefail

NEXT_TAG="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

# Pack the library so the example consumes the real published shape, and install
# the freshly packed tarball so we test the current build, not a cached one. The
# example pins `file:../../strict-csp-next-<ver>.tgz`, so the tarball must land in
# $ROOT for the first `pnpm install` to resolve it. Discard pack's stdout and find
# the file by glob, so any build output folded into stdout can't corrupt the
# filename.
cd "$ROOT"
pnpm build >/dev/null 2>&1
rm -f strict-csp-next-*.tgz
pnpm pack >/dev/null 2>&1
TARBALL="$(ls strict-csp-next-*.tgz)"

cd "$HERE"
pnpm install
pnpm add "../../${TARBALL}"
if [ -n "$NEXT_TAG" ]; then
  pnpm add "next@${NEXT_TAG}" react@latest react-dom@latest
fi
if [ "$(uname)" = "Linux" ]; then
  pnpm exec playwright install --with-deps chromium
else
  pnpm exec playwright install chromium
fi

pnpm build
pnpm start &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

# Wait for the server to accept connections.
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:4200/ >/dev/null 2>&1; then break; fi
  sleep 1
done

OUTPUT="$(node matrix-test.mjs)"
echo "$OUTPUT"
if echo "$OUTPUT" | grep -q 'ALL PASS'; then
  echo "e2e: all routes clean under strict CSP"
else
  echo "e2e: CSP violations detected (see matrix above)" >&2
  exit 1
fi
