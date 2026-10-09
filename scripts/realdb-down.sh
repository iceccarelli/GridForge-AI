#!/usr/bin/env bash
# Stop the PostgREST started by scripts/realdb-up.sh. Leaves PostgreSQL alone.
WORK="${GF_REALDB_DIR:-/tmp/gf-realdb}"
[ -f "$WORK/pgrst.pid" ] && kill "$(cat "$WORK/pgrst.pid")" 2>/dev/null || true
rm -f "$WORK/pgrst.pid"
