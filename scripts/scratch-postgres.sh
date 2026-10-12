#!/usr/bin/env bash
# A throwaway local PostgreSQL for restore verification. Never touches anything but /tmp/gf-scratch-pg.
#
#   eval "$(bash scripts/scratch-postgres.sh start)"   # starts it and exports PGHOST/PGPORT/PGUSER for this shell
#   bash scripts/scratch-postgres.sh stop              # stops and deletes it
#
# Needs PostgreSQL server binaries (apt: postgresql). Runs as the current non-root user on a unix socket only.
set -euo pipefail
DIR=/tmp/gf-scratch-pg
SOCK=/tmp/gf-scratch-sock
PORT=5599

bin() {
  for d in /usr/lib/postgresql/*/bin /usr/local/pgsql/bin /opt/homebrew/bin; do
    [ -x "$d/initdb" ] && { echo "$d"; return; }
  done
  command -v initdb >/dev/null && { dirname "$(command -v initdb)"; return; }
  echo "PostgreSQL server binaries not found. Install them: sudo apt-get update && sudo apt-get install -y postgresql" >&2
  exit 1
}

case "${1:-}" in
  start)
    B="$(bin)"
    [ "$(id -u)" = 0 ] && { echo "run as a normal user, not root" >&2; exit 1; }
    mkdir -p "$SOCK"
    if [ ! -d "$DIR" ]; then "$B/initdb" -D "$DIR" -U postgres --auth=trust >&2; fi
    "$B/pg_ctl" -D "$DIR" -o "-p $PORT -k $SOCK -c listen_addresses=''" -l "$DIR/log" -w start >&2 || true
    echo "export PGHOST=$SOCK PGPORT=$PORT PGUSER=postgres"
    ;;
  stop)
    B="$(bin)"
    "$B/pg_ctl" -D "$DIR" -m immediate stop >&2 || true
    rm -rf "$DIR" "$SOCK"
    echo "scratch PostgreSQL removed" >&2
    ;;
  *) echo "usage: scratch-postgres.sh start|stop" >&2; exit 2 ;;
esac
