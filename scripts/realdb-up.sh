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
# GF_REAL_STORAGE=1 additionally starts the REAL Supabase Storage service (the official supabase/storage-api image,
# pinned below) against the same database BEFORE the migrations are applied, exactly as a Supabase project has its
# `storage` schema before user migrations. It initialises its own schema (storage.buckets, storage.objects, RLS) and the
# anon/authenticated/service_role roles; the stand-in `storage.buckets` table is NOT created in this mode, so migrations
# 0015/0023 insert their private buckets into the real table. It serves /object/... on $GF_STORAGE_PORT (hosted Supabase
# puts a gateway in front that adds the /storage/v1 prefix; the tests do the same with a path-mapping proxy). Needs docker.
# It is still not a Supabase project: no GoTrue, no gateway, a local-file object backend, test-only JWT secret.
#
# Needs: psql, python3, curl, tar. Set POSTGREST_BIN to use an existing binary instead of downloading.
set -euo pipefail
cd "$(dirname "$0")/.."

DB="${GF_PG_DB:-gf}"
PORT="${GF_PGRST_PORT:-3300}"
WORK="${GF_REALDB_DIR:-/tmp/gf-realdb}"
VERSION="${POSTGREST_VERSION:-v12.2.3}"
mkdir -p "$WORK"

REAL_STORAGE="${GF_REAL_STORAGE:-0}"
STORAGE_IMAGE="${GF_STORAGE_IMAGE:-supabase/storage-api:v1.81.5@sha256:ce875c6d1a2fb932fafcc24b823605276e7b03d4145880c155348f16306d67f0}"
STORAGE_PORT="${GF_STORAGE_PORT:-5000}"
STORAGE_NAME="${GF_STORAGE_CONTAINER:-gf-storage}"
# Test-only secret; never a production value. The same secret signs the service_role token PostgREST and Storage accept.
SECRET="gridforge-local-test-secret-32-chars-minimum!!"


mint_jwt() {
python3 - "$SECRET" <<'PY'
import base64, hashlib, hmac, json, sys, time
b = lambda x: base64.urlsafe_b64encode(x).rstrip(b"=")
head = b(json.dumps({"alg": "HS256", "typ": "JWT"}).encode())
body = b(json.dumps({"role": "service_role", "exp": int(time.time()) + 86400}).encode())
sig = b(hmac.new(sys.argv[1].encode(), head + b"." + body, hashlib.sha256).digest())
print((head + b"." + body + b"." + sig).decode())
PY
}
JWT="$(mint_jwt)"

# Never print a token, a key, or a document: diagnostics are redacted and bounded.
storage_diag() {
  echo "[realdb] storage container state: $(docker inspect -f '{{.State.Status}} exit={{.State.ExitCode}}' "$STORAGE_NAME" 2>&1)"
  docker logs "$STORAGE_NAME" 2>&1 | tail -40 | sed -E 's/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/[redacted-jwt]/g' | cut -c1-400 || true
}

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
"${DBQ[@]}" -c "create extension if not exists pgcrypto"

if [ "$REAL_STORAGE" = 1 ]; then
  command -v docker >/dev/null || { echo "[realdb] FAILED: GF_REAL_STORAGE=1 needs docker"; exit 1; }
  echo "[realdb] starting REAL Supabase Storage: ${STORAGE_IMAGE%%@*}"
  docker rm -f "$STORAGE_NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK/storage-data"; mkdir -p "$WORK/storage-data"; chmod 777 "$WORK/storage-data"
  HOSTP="${PGHOST:-localhost}"
  docker run -d --name "$STORAGE_NAME" --network host -v "$WORK/storage-data:/var/lib/storage" \
    -e SERVER_PORT="$STORAGE_PORT" -e SERVER_REGION=local -e IS_MULTITENANT=false -e TENANT_ID=gridforge-test \
    -e AUTH_JWT_SECRET="$SECRET" -e AUTH_JWT_ALGORITHM=HS256 -e ANON_KEY="$JWT" -e SERVICE_KEY="$JWT" \
    -e DATABASE_URL="postgres://${PGUSER:-postgres}:${PGPASSWORD:-postgres}@${HOSTP}:${PGPORT:-5432}/$DB" -e DB_INSTALL_ROLES=true \
    -e STORAGE_BACKEND=file -e STORAGE_FILE_BACKEND_PATH=/var/lib/storage -e FILE_STORAGE_BACKEND_PATH=/var/lib/storage \
    -e POSTGREST_URL="http://127.0.0.1:$PORT" -e ENABLE_IMAGE_TRANSFORMATION=false "$STORAGE_IMAGE" >/dev/null \
    || { echo "[realdb] FAILED: the Storage container did not start"; exit 1; }
  # Ready = its HTTP status answers AND it has finished creating its own schema in our database.
  for _ in $(seq 1 90); do
    if curl -fsS "http://127.0.0.1:$STORAGE_PORT/status" >/dev/null 2>&1 \
       && [ "$("${DBQ[@]}" -At -c "select to_regclass('storage.objects') is not null and exists (select 1 from storage.migrations)" 2>/dev/null)" = t ]; then
      st_ready=1; break
    fi
    sleep 1
  done
  [ "${st_ready:-0}" = 1 ] || { echo "[realdb] FAILED: Storage did not become ready"; storage_diag; exit 1; }
  echo "[realdb] Storage $(curl -fsS "http://127.0.0.1:$STORAGE_PORT/version") ready; its schema exists before the migrations"
else
  "${DBQ[@]}" -c "create schema if not exists storage" \
              -c "create table if not exists storage.buckets (id text primary key, name text, public boolean)"
fi

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
"${DBQ[@]}" -At -c "select count(*) from pg_proc where proname in ('gf_attach_purchase','gf_submit_observation','gf_submit_supplier_actual','gf_deposit_guard','gf_review_cost_evidence')" \
  | grep -qx 5 || { echo "[realdb] FAILED: expected migration objects are missing"; exit 1; }

"${DBQ[@]}" -At -c "select count(*) from information_schema.columns where table_name = 'cost_evidence_runs' and column_name in ('run_fingerprint','artifact_storage_ref','artifact_sha256')" \
  | grep -qx 3 || { echo "[realdb] FAILED: migration 0023 (cost-evidence artifacts) is missing"; exit 1; }

# 0024 (the rate-limit guard) and 0025 (saved comparisons and buyer links) must be present, with their RPCs.
"${DBQ[@]}" -At -c "select count(*) from pg_proc where proname in ('gf_rate_limit_hit','gf_save_comparison','gf_issue_share','gf_revoke_share')" \
  | grep -qx 4 || { echo "[realdb] FAILED: migrations 0024/0025 (rate limit, comparisons, buyer links) are missing"; exit 1; }

# 0026 (quotation evidence behind a saved comparison) must be present.
"${DBQ[@]}" -At -c "select count(*) from information_schema.columns where table_name = 'project_comparisons' and column_name = 'evidence_ids'" \
  | grep -qx 1 || { echo "[realdb] FAILED: migration 0026 (comparison quotation evidence) is missing"; exit 1; }

# 0027 (Intelligence seats) must be present, with its RPCs and both tables.
"${DBQ[@]}" -At -c "select count(*) from pg_proc where proname in ('gf_invite_member','gf_accept_invitation','gf_member_entitlement','gf_team_overview','gf_plan_seats')" \
  | grep -qx 5 || { echo "[realdb] FAILED: migration 0027 (team seats) is missing"; exit 1; }
"${DBQ[@]}" -At -c "select count(*) from information_schema.tables where table_name in ('subscription_invitations','subscription_members')" \
  | grep -qx 2 || { echo "[realdb] FAILED: migration 0027 tables are missing"; exit 1; }

# 0028 (pay-as-you-go ledger, settlements, free allowance, founding reservations) must be present, with its RPCs and tables.
"${DBQ[@]}" -At -c "select count(*) from pg_proc where proname in ('gf_usage_ingest','gf_usage_net','gf_usage_month_totals','gf_payg_unsettled','gf_free_account_create','gf_founding_reserve')" \
  | grep -qx 6 || { echo "[realdb] FAILED: migration 0028 (pay-as-you-go) is missing"; exit 1; }
"${DBQ[@]}" -At -c "select count(*) from information_schema.tables where table_name in ('usage_events','usage_settlements','payg_cursor','usage_alerts','funnel_events','founding_reservations')" \
  | grep -qx 6 || { echo "[realdb] FAILED: migration 0028 tables are missing"; exit 1; }

if [ "$REAL_STORAGE" = 1 ]; then
  # The migrations must have created the bucket in the REAL table, and it must be private.
  [ "$("${DBQ[@]}" -At -c "select public from storage.buckets where id = 'cost-evidence-artifacts'")" = f ] \
    || { echo "[realdb] FAILED: bucket cost-evidence-artifacts is missing or not private"; exit 1; }
  [ "$("${DBQ[@]}" -At -c "select count(*) from storage.buckets where public")" = 0 ] \
    || { echo "[realdb] FAILED: a public bucket exists"; exit 1; }
fi

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
if [ "$REAL_STORAGE" = 1 ]; then
  cat >> "$WORK/realdb.env" <<ENV
GF_STORAGE_URL=http://127.0.0.1:$STORAGE_PORT
GF_STORAGE_IMAGE=${STORAGE_IMAGE}
GF_STORAGE_CONTAINER=$STORAGE_NAME
ENV
fi
echo "[realdb] ready: $WORK/realdb.env"
