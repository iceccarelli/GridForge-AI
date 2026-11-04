#!/usr/bin/env bash
# Run ONE command against a FRESH real-database stack: rebuild the database from every migration (scripts/realdb-up.sh drops and
# recreates it and restarts PostgREST), load its GF_PGRST_URL / GF_PGRST_JWT / GF_PG_DB, then exec the command.
#
#   bash scripts/realdb-run.sh npx vitest run tests/site/payg.realdb.test.ts
#
# Why: the *.realdb.test.ts files share one database and one PostgREST. A file that leaves rows, a changed sequence or a half-finished
# state behind can make the NEXT file pass or fail for a reason that has nothing to do with it. One file per fresh database means a
# failure is that file's own, and an order change cannot hide it. The cost is one migration replay (seconds) per file.
#
# Same PG* variables as realdb-up.sh (a superuser). Its chatter is hidden on success and shown in full on failure.
set -euo pipefail
cd "$(dirname "$0")/.."
[ "$#" -gt 0 ] || { echo "usage: bash scripts/realdb-run.sh <command> [args...]" >&2; exit 2; }

LOG="$(mktemp)"
trap 'rm -f "$LOG"' EXIT
if ! bash scripts/realdb-up.sh > "$LOG" 2>&1; then
  cat "$LOG" >&2
  echo "[realdb-run] FAILED: could not bring up a fresh database" >&2
  exit 1
fi
echo "[realdb-run] fresh database ready: $(tail -1 "$LOG")"
set -a
# shellcheck disable=SC1091
. "${GF_REALDB_DIR:-/tmp/gf-realdb}/realdb.env"
set +a
exec "$@"
