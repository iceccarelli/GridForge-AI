#!/usr/bin/env bash
# Regenerate public/observatory/scenarios.json: engine output for three approved SYNTHETIC halls.
#
# Same discipline as scripts/build-reference.sh. The Observatory shows engine results, so the file is the CURRENT output
# of the repository's own request handlers (called in-process, no network, no server), generated at a pinned date, and CI
# fails when the committed file differs from a fresh run by a single byte.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="public/observatory"
DATE="${GRIDFORGE_REPORT_DATE:-2026-09-14}"

rm -rf "$OUT"
mkdir -p "$OUT"

GRIDFORGE_REPORT_DATE="$DATE" python3 scripts/build-observatory.py -o "$OUT/scenarios.json"

echo "wrote:"
find "$OUT" -type f | sort | sed 's/^/  /'
