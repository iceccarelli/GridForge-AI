#!/usr/bin/env bash
# Deploy the capacity engine to Fly.io.
#
#   bash scripts/deploy-engine.sh              # deploy; never touches a credential
#   bash scripts/deploy-engine.sh --bootstrap  # first run: also mint missing secrets
#
# THE RULE THIS SCRIPT EXISTS TO OBEY: a deploy must never change a credential.
#
# Two earlier versions broke that. The first generated GRIDFORGE_API_KEYS on every
# run, so every deploy invalidated the key in Vercel. The second tried to detect an
# existing secret by grepping `fly secrets list`, the grep did not match the output
# format, and it rotated the key anyway — the same failure with an extra step.
#
# So detection is no longer load-bearing. Minting is opt-in (--bootstrap), and when
# detection is uncertain the script refuses to write rather than guessing. A deploy
# script that breaks production on success is worse than one that fails, because
# nothing tells you.
#
# tests/test_deploy_script.py runs this against a fake `fly` and asserts it never
# calls `secrets set` on a secret that already exists. That test is the actual fix.
set -euo pipefail

APP="${FLY_APP:-gridforge-engine}"
REGION="${FLY_REGION:-ams}"
VOLUME="${FLY_VOLUME:-gridforge_data}"
BOOTSTRAP="${GRIDFORGE_BOOTSTRAP:-0}"
SKIP_DEPLOY="${GRIDFORGE_SKIP_DEPLOY:-0}"

for arg in "$@"; do
  case "$arg" in
    --bootstrap) BOOTSTRAP=1 ;;
    --check)     SKIP_DEPLOY=1 ;;
    -h|--help)   sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\n\033[33m%s\033[0m\n' "$*"; }

if ! command -v flyctl >/dev/null 2>&1 && ! command -v fly >/dev/null 2>&1; then
  say "Installing flyctl"
  curl -L https://fly.io/install.sh | sh
  export FLYCTL_INSTALL="${FLYCTL_INSTALL:-$HOME/.fly}"
  export PATH="$FLYCTL_INSTALL/bin:$PATH"
  grep -q 'FLYCTL_INSTALL' "$HOME/.bashrc" 2>/dev/null || {
    echo 'export FLYCTL_INSTALL="$HOME/.fly"' >> "$HOME/.bashrc"
    echo 'export PATH="$FLYCTL_INSTALL/bin:$PATH"' >> "$HOME/.bashrc"
  }
fi
FLY="$(command -v flyctl || command -v fly)"

if ! "$FLY" auth whoami >/dev/null 2>&1; then
  say "Sign in to Fly (a browser window or a device code will follow)"
  "$FLY" auth login
fi

# `fly apps list` has shipped several table formats. Asking the app about itself is
# the only check that does not depend on the shape of a table.
if "$FLY" status --app "$APP" >/dev/null 2>&1; then
  say "App $APP already exists — leaving it alone"
else
  say "Creating app $APP"
  "$FLY" apps create "$APP"
fi

# --- which secrets exist ------------------------------------------------------
# --json first, because a machine-readable list cannot be broken by a column
# realignment. The text fallback is whitespace-tolerant and anchored on a word
# boundary rather than the start of a line, since flyctl has indented rows before.
SECRET_NAMES=""
DETECTED=0
if RAW_JSON="$("$FLY" secrets list --app "$APP" --json 2>/dev/null)" && [ -n "$RAW_JSON" ]; then
  if SECRET_NAMES="$(printf '%s' "$RAW_JSON" | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
if isinstance(rows, dict):
    rows = rows.get("secrets") or rows.get("Secrets") or []
names = [r.get("Name") or r.get("name") for r in rows if isinstance(r, dict)]
print("\n".join(n for n in names if n))
' 2>/dev/null)"; then
    DETECTED=1
  fi
fi
if [ "$DETECTED" -eq 0 ]; then
  if RAW_TXT="$("$FLY" secrets list --app "$APP" 2>/dev/null)" && [ -n "$RAW_TXT" ]; then
    SECRET_NAMES="$(printf '%s' "$RAW_TXT" | awk 'NR>1 {print $1}')"
    DETECTED=1
  fi
fi

has_secret() { printf '%s\n' "$SECRET_NAMES" | grep -qx -- "$1"; }

# --- secrets: opt-in minting, and never a rotation ----------------------------
STAGED=()

consider() {           # consider NAME GENERATOR_COMMAND DESCRIPTION
  local name="$1" gen="$2" what="$3"
  if [ "$DETECTED" -eq 0 ]; then
    warn "Could not read the secret list for $APP."
    echo "  Not writing $name. Uncertainty must never resolve to overwriting a credential."
    echo "  Set it yourself if it is missing:"
    echo "    $FLY secrets set $name=\"\$($gen)\" --app $APP"
    return
  fi
  if has_secret "$name"; then
    echo "  $name — already set, untouched"
    return
  fi
  if [ "$BOOTSTRAP" != "1" ]; then
    warn "$name is NOT set on $APP ($what)."
    echo "  This script will not mint it without --bootstrap. Either:"
    echo "    bash scripts/deploy-engine.sh --bootstrap"
    echo "  or set it yourself:"
    echo "    $FLY secrets set $name=\"\$($gen)\" --app $APP"
    return
  fi
  local value
  value="$(eval "$gen")"
  STAGED+=("$name=$value")
  eval "NEW_${name}=\$value"
}

say "Secrets"
consider GRIDFORGE_API_KEYS   "openssl rand -hex 24" "the website's key for paid endpoints"
consider GRIDFORGE_KEY_SECRET "openssl rand -hex 32" "signs self-serve API keys; the website needs the same value"

if [ ${#STAGED[@]} -gt 0 ]; then
  say "Staging ${#STAGED[@]} NEW secret(s) — nothing existing is being replaced"
  "$FLY" secrets set "${STAGED[@]}" --app "$APP" --stage
fi

# --- usage volume -------------------------------------------------------------
# GRIDFORGE_USAGE_FILE on a path with no volume behind it silently discards every
# usage record, and looks identical to a working configuration until the first
# invoice. The engine probes the path at startup and reports the truth at
# /v1/usage; this makes the path real so it has something true to report.
if "$FLY" volumes list --app "$APP" 2>/dev/null | grep -q "$VOLUME"; then
  say "Usage volume $VOLUME exists"
else
  warn "No usage volume — metered usage would not survive a restart."
  echo "  Creating a 1GB volume in $REGION (a few cents a month)."
  "$FLY" volumes create "$VOLUME" --app "$APP" --region "$REGION" --size 1 --yes || {
    warn "Volume creation failed. The engine will still serve; usage will be in-memory"
    warn "only, and /v1/usage will say so rather than pretending otherwise."
  }
fi
grep -q "\[mounts\]" fly.toml || warn "fly.toml has no [mounts] section — the volume will not attach."

summary() {
  cat <<EOF

────────────────────────────────────────────────────────────────────────
Website environment (Vercel → Settings → Environment Variables):

  GRIDFORGE_API_URL=https://$APP.fly.dev
EOF
  if [ -n "${NEW_GRIDFORGE_API_KEYS:-}" ]; then
    echo "  GRIDFORGE_API_KEY=$NEW_GRIDFORGE_API_KEYS        <- NEW, set this now"
  else
    echo "  GRIDFORGE_API_KEY=<unchanged>     <- this run did not touch it"
  fi
  if [ -n "${NEW_GRIDFORGE_KEY_SECRET:-}" ]; then
    cat <<EOF
  GRIDFORGE_KEY_SECRET=$NEW_GRIDFORGE_KEY_SECRET
      ^ NEW, set this now. Both sides must hold the SAME value. Printed once.
EOF
  else
    echo "  GRIDFORGE_KEY_SECRET=<unchanged>  <- this run did not touch it"
  fi
  cat <<EOF

To rotate deliberately (this script never will):
  $FLY secrets set GRIDFORGE_API_KEYS="\$(openssl rand -hex 24):gridforge-site" --app $APP
  …then paste the same value into Vercel as GRIDFORGE_API_KEY.

Migrations still to run in Supabase:
  supabase/migrations/0002_qualifications.sql … 0007_api_accounts.sql
────────────────────────────────────────────────────────────────────────
EOF
}

if [ "$SKIP_DEPLOY" = "1" ]; then
  say "--check: stopping before deploy"
  summary
  exit 0
fi

say "Deploying"
"$FLY" deploy --app "$APP" --regions "$REGION" --ha=false

URL="https://$APP.fly.dev"
say "Checking health"
for _ in $(seq 1 30); do
  curl -sf "$URL/health" >/dev/null && break
  sleep 2
done
VERSION_JSON="$(curl -s "$URL/v1/version" || true)"

python3 - "$VERSION_JSON" <<'PY' || true
import json, sys
try:
    d = json.loads(sys.argv[1] or "{}")
except Exception:
    print("  ! could not read /v1/version"); raise SystemExit(0)
rows = [
    ("paid endpoints", d.get("auth_configured"),
     "set GRIDFORGE_API_KEYS or GRIDFORGE_KEY_SECRET"),
    ("self-serve keys", d.get("signed_keys"),
     "set GRIDFORGE_KEY_SECRET to the same value as the website"),
    ("durable metering", (d.get("metering") or {}).get("durable"),
     "check the volume is mounted at /data, then GET /v1/usage for the exact problem"),
]
print(f"\n  engine {d.get('version', '?')}")
for label, ok, fix in rows:
    print(f"  {'OK ' if ok else '!! '} {label:18s}" + ("" if ok else f"  -> {fix}"))
PY

say "The engine is live at $URL"
summary
