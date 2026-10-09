#!/usr/bin/env bash
# Bring up the REAL-database test stack, the same way in CI and on a developer machine:
#
#   PostgreSQL (you provide it, via the usual PG* variables, as a superuser)
#     -> roles (anon, authenticator, service_role) as Supabase has them
#     -> a database with EVERY supabase/migrations/*.sql applied, in order, ON_ERROR_STOP
#     -> PostgREST 12.2.3 in front of it
#     -> a service_role token
#
# It writes $GF_REALDB_DIR/realdb.env (GF_PGRST_URL, GF_PGRST_JWT, GF_PG_DB), which the real-database
# tests read. What this stack is NOT: Supabase. There is no Supabase Storage, no GoTrue, no gateway, and
# the `storage.buckets` table is a stand-in so the bucket insert in 0015 has somewhere to land. It proves
# the SQL and the PostgREST contract; it does not prove a Supabase deployment.
#
# Needs: psql, python3, curl, tar. Set POSTGREST_BIN to use an existing binary instead of downloading.
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${GF_PG_DB:-gf}"
PORT="${GF_PGRST_PORT:-3300}"
WORK="${GF_REALDB_DIR:-/tmp/gf-realdb}"
VERSION="${POSTGREST_VERSION:-v12.2.3}"
mkdir -p "$WORK"

ADMIN=(psql -v ON_ERROR_STOP=1 -X -q -d postgres)

echo "[realdb] roles and database '$DB'"
"${ADMIN[@]}" <<SQL
do \$\$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator noinherit login password 'x'; end if;
end \$\$;
grant anon, service_role to authenticator;
drop database if exists "$DB" with (force);
create database "$DB";
SQL

DBQ=(psql -v ON_ERROR_STOP=1 -X -q -d "$DB")
"${DBQ[@]}" -c "create extension if not exists pgcrypto" \
            -c "create schema if not exists storage" \
            -c "create table if not exists storage.buckets (id text primary key, name text, public boolean)"

echo "[realdb] applying migrations in order"
for f in $(ls supabase/migrations/*.sql | sort); do
  # A failing migration must stop this script: capture the output and test psql's OWN status.
  if ! out="$("${DBQ[@]}" -f "$f" 2>&1)"; then
    echo "$out"
    echo "[realdb] FAILED: $(basename "$f") did not apply"
    exit 1
  fi
  echo "  $(basename "$f")"
done
# Belt and braces: the objects the latest migrations create must really exist.
"${DBQ[@]}" -At -c "select count(*) from pg_proc where proname in ('gf_attach_purchase','gf_submit_observation','gf_submit_supplier_actual')" \
  | grep -qx 3 || { echo "[realdb] FAILED: expected migration objects are missing"; exit 1; }

"${DBQ[@]}" -c "grant usage on schema public to anon, service_role" \
            -c "grant all on all tables in schema public to service_role" \
            -c "alter default privileges in schema public grant all on tables to service_role"

# ---- PostgREST
BIN="${POSTGREST_BIN:-}"
if [ -z "$BIN" ]; then
  BIN="$WORK/postgrest"
  if [ ! -x "$BIN" ]; then
    echo "[realdb] downloading PostgREST $VERSION"
    curl -fsSL -o "$WORK/p.tar.xz" \
      "https://github.com/PostgREST/postgrest/releases/download/$VERSION/postgrest-$VERSION-linux-static-x64.tar.xz"
    tar -xf "$WORK/p.tar.xz" -C "$WORK"
  fi
fi

HOST="${PGHOST:-localhost}"
URI="postgres://authenticator:x@/$DB?host=$HOST&port=${PGPORT:-5432}"
case "$HOST" in /*) ;; *) URI="postgres://authenticator:x@$HOST:${PGPORT:-5432}/$DB" ;; esac
SECRET="gridforge-local-test-secret-32-chars-minimum!!"
cat > "$WORK/pgrst.conf" <<CONF
db-uri = "$URI"
db-schemas = "public"
db-anon-role = "anon"
jwt-secret = "$SECRET"
server-port = $PORT
CONF

if [ -f "$WORK/pgrst.pid" ] && kill -0 "$(cat "$WORK/pgrst.pid")" 2>/dev/null; then
  kill "$(cat "$WORK/pgrst.pid")" 2>/dev/null || true; sleep 1
fi
nohup "$BIN" "$WORK/pgrst.conf" > "$WORK/pgrst.log" 2>&1 &
echo $! > "$WORK/pgrst.pid"

JWT="$(python3 - "$SECRET" <<'PY'
import base64, hashlib, hmac, json, sys, time
b = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=")
head = b(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
body = b(json.dumps({"role": "service_role", "exp": int(time.time()) + 86400}).encode())
sig = b(hmac.new(sys.argv[1].encode(), head + b"." + body, hashlib.sha256).digest())
print((head + b"." + body + b"." + sig).decode())
PY
)"

echo "[realdb] waiting for PostgREST on :$PORT"
for _ in $(seq 1 60); do
  if curl -fsS -H "Authorization: Bearer $JWT" "http://127.0.0.1:$PORT/projects?limit=1" >/dev/null 2>&1; then
    ready=1; break
  fi
  sleep 0.5
done
[ "${ready:-0}" = 1 ] || { echo "[realdb] FAILED: PostgREST did not come up"; tail -20 "$WORK/pgrst.log"; exit 1; }

cat > "$WORK/realdb.env" <<ENV
GF_PGRST_URL=http://127.0.0.1:$PORT
GF_PGRST_JWT=$JWT
GF_PG_DB=$DB
ENV
echo "[realdb] ready: $WORK/realdb.env"
