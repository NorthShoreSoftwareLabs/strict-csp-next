#!/usr/bin/env bash
# Build the example against the freshly packed library and prove that an ISR
# route stays strict-CSP-correct in every cache state (build prerender, HIT,
# STALE, and the cache-fill MISS) across changing data. Exits non-zero if any
# served response leaves an inline script uncovered.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

# Pack the library so the example consumes the real published shape, then install
# the freshly packed tarball. The example pins file:../../strict-csp-next-*.tgz.
# Find the tarball by glob rather than capturing pack's stdout, so build output
# folded into stdout can't corrupt the filename.
cd "$ROOT"
pnpm build >/dev/null 2>&1
rm -f strict-csp-next-*.tgz
pnpm pack >/dev/null 2>&1
TARBALL="$(ls strict-csp-next-*.tgz)"

cd "$HERE"
pnpm install >/dev/null 2>&1
pnpm add "../../${TARBALL}" >/dev/null 2>&1

printf 'gen1-initial' > data.txt
pnpm build
node postbuild.mjs

pnpm start &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  if curl -fsS http://localhost:4310/isr >/dev/null 2>&1; then break; fi
  sleep 1
done

node verify.mjs
