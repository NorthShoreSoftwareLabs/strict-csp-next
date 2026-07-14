#!/usr/bin/env bash
# Build this Next.js 15 example against the freshly packed library and prove which
# ISR cache states carry the strict-CSP header on Next 15. Usage:
#   e2e.sh [next-version]   (e.g. e2e.sh 15, e2e.sh 15.2)
# Exits non-zero if any expected-covered state (build prerender, HIT, STALE,
# on-demand revalidate) is uncovered. The plain first-fill MISS is recorded, not
# gated — that is the documented Next 15 caveat.
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
# Rename to a version-agnostic filename so the example pins a stable path
# (file:../../strict-csp-next.tgz) that does not rot on every version bump.
mv "$(ls strict-csp-next-*.tgz)" strict-csp-next.tgz

cd "$HERE"
pnpm install
pnpm add "../../strict-csp-next.tgz"
if [ -n "$NEXT_VERSION" ]; then
  pnpm add "next@${NEXT_VERSION}" react@latest react-dom@latest
fi

# Reset the changing-data file to a known seed so reruns are deterministic.
printf 'gen1-initial' > data.txt

pnpm build
pnpm start &
SERVER_PID=$!
# `pnpm start` spawns a child `next start` that holds port 4600; a bare
# `kill $SERVER_PID` orphans that child and the next run on 4600 collides. Kill
# the child process tree first, then the pnpm parent.
trap 'pkill -P "$SERVER_PID" 2>/dev/null; kill "$SERVER_PID" 2>/dev/null || true' EXIT

# Wait for the server to accept connections.
for _ in $(seq 1 60); do
  if curl -fsS http://localhost:4600/isr >/dev/null 2>&1; then break; fi
  sleep 1
done

# Capture with `|| true` so a failing verify (process.exit(1)) does not abort
# under `set -e` before we print its STATE->header diagnostic table; the grep
# gate below is the authoritative pass/fail signal.
OUTPUT="$(node verify.mjs)" || true
echo "$OUTPUT"
if echo "$OUTPUT" | grep -q 'ALL PASS'; then
  echo "e2e-next15-cache: expected cache states carry a covering CSP on Next 15"
else
  echo "e2e-next15-cache: an expected-covered cache state was uncovered (see above)" >&2
  exit 1
fi
