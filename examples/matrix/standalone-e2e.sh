#!/usr/bin/env bash
# Build the matrix app with output: 'standalone', assert the manifest is copied
# into the bundle, run the real standalone server, and run the browser matrix
# against it. Catches regressions in standalone manifest delivery.
# Usage: standalone-e2e.sh [next-dist-tag]
set -euo pipefail

NEXT_TAG="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

# Pack the library into $ROOT -- the example pins
# `file:../../strict-csp-next-<ver>.tgz`, so the tarball must live there for the
# first `pnpm install` to resolve it. Discard pack's stdout and find the file by
# glob, so any build output folded into stdout can't corrupt the filename.
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

NEXT_OUTPUT=standalone pnpm build

# The regression this guards: postbuild must copy the manifest into the bundle.
if [ ! -f .next/standalone/.next/strict-csp-manifest.json ]; then
  echo "FAIL: manifest was not copied into .next/standalone/.next/" >&2
  exit 1
fi

# Assemble the standalone runtime the way a Dockerfile would.
rm -rf .next/standalone/.next/static .next/standalone/public
cp -r .next/static .next/standalone/.next/static
[ -d public ] && cp -r public .next/standalone/public || true

# Run the server with the bundle as cwd, so it must use the COPIED manifest.
pushd .next/standalone >/dev/null
PORT=4300 node server.js &
SERVER_PID=$!
popd >/dev/null
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -fsS http://localhost:4300/ >/dev/null 2>&1; then break; fi
  sleep 1
done

OUTPUT="$(BASE=http://localhost:4300 node matrix-test.mjs)"
echo "$OUTPUT"
if echo "$OUTPUT" | grep -q 'ALL PASS'; then
  echo "standalone e2e: all routes clean (manifest read from the bundle)"
else
  echo "standalone e2e: CSP violations detected" >&2
  exit 1
fi
