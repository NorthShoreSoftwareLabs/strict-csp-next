#!/usr/bin/env bash
# Build the static export, inject the meta CSP, and verify zero violations in a
# browser with no CSP response header. Usage: export-e2e.sh [next-dist-tag]
set -euo pipefail

NEXT_TAG="${1:-}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

# Pack the library into $ROOT -- the example pins
# `file:../../strict-csp-next.tgz`, so the tarball must live there for the
# first `pnpm install` to resolve it. Discard pack's stdout and find the file by
# glob, so any build output folded into stdout can't corrupt the filename.
cd "$ROOT"
pnpm build >/dev/null 2>&1
rm -f strict-csp-next-*.tgz strict-csp-next.tgz
pnpm pack >/dev/null 2>&1
# Rename to a version-agnostic filename so the examples can pin a stable path
# (file:../../strict-csp-next.tgz) that does not rot on every version bump.
mv "$(ls strict-csp-next-*.tgz)" strict-csp-next.tgz
TARBALL="strict-csp-next.tgz"

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

pnpm build             # next build (export) && node postbuild.mjs (inject meta)
node export-test.mjs   # serves out/ with no CSP header, exits non-zero on failure
