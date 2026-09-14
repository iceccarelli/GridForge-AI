#!/usr/bin/env bash
# Deploy the capacity engine to Fly.io from a Codespace or any Linux shell.
#
#   bash scripts/deploy-engine.sh
#
# Idempotent by design. Run it as often as you like: it will not create an app that
# exists, and — this is the one that mattered — it will NOT rotate a key that is
# already working.
#
# The previous version generated a fresh GRIDFORGE_API_KEYS on every run. Every
# deploy therefore invalidated the key sitting in Vercel, and the website's paid
# deliverable generation started returning 401 until someone noticed and re-pasted
# it. A deploy script that breaks production on success is worse than one that
# fails, because nothing tells you.
set -euo pipefail

APP="${FLY_APP:-gridforge-engine}"
REGION="${FLY_REGION:-ams}"
VOLUME="${FLY_VOLUME:-gridforge_data}"

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

# --- secrets: add what is missing, rotate nothing -----------------------------
EXISTING="$("$FLY" secrets list --app "$APP" 2>/dev/null || true)"
has_secret() { grep -q "^$1[[:space:]]" <<<"$EXISTING"; }

STAGED=()

if has_secret GRIDFORGE_API_KEYS; then
  say "GRIDFORGE_API_KEYS is already set — not touching it"
  echo "  To rotate deliberately:"
  echo "    $FLY secrets set GRIDFORGE_API_KEYS=\"\$(openssl rand -hex 24)\" --app $APP"
  echo "  and paste the same value into Vercel as GRIDFORGE_API_KEY."
else
  KEY="${GRIDFORGE_API_KEY_VALUE:-$(openssl rand -hex 24)}"
  STAGED+=("GRIDFORGE_API_KEYS=$KEY")
  NEW_KEY="$KEY"
fi

# The signing secret for self-serve keys. The SAME value must be set on the website,
# or every key it issues will be rejected here — so it is generated once and printed
# once, and never regenerated.
if has_secret GRIDFORGE_KEY_SECRET; then
  say "GRIDFORGE_KEY_SECRET is already set — not touching it"
else
  SECRET="${GRIDFORGE_KEY_SECRET_VALUE:-$(openssl rand -hex 32)}"
  STAGED+=("GRIDFORGE_KEY_SECRET=$SECRET")
  NEW_SECRET="$SECRET"
fi

if [ ${#STAGED[@]} -gt 0 ]; then
  say "Staging ${#STAGED[@]} new secret(s)"
  "$FLY" secrets set "${STAGED[@]}" --app "$APP" --stage
fi

# --- usage volume -------------------------------------------------------------
# GRIDFORGE_USAGE_FILE on a path with no volume behind it silently discards every
# usage record, and looks identical to a working configuration until the first
# invoice. The engine now probes the path at startup and reports the truth at
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
if ! grep -q "\[mounts\]" fly.toml; then
  warn "fly.toml has no [mounts] section, so the volume will not be attached."
  warn "Add:  [mounts]\n        source = \"$VOLUME\"\n        destination = \"/data\""
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
echo "$VERSION_JSON"

python3 - "$VERSION_JSON" <<'PY' || true
import json, sys
try:
    d = json.loads(sys.argv[1] or "{}")
except Exception:
    sys.exit(0)
if not d.get("auth_configured"):
    print("\n  ! paid endpoints are DISABLED: neither GRIDFORGE_API_KEYS nor "
          "GRIDFORGE_KEY_SECRET is set on this app.")
if not d.get("signed_keys"):
    print("\n  ! self-serve keys are DISABLED: GRIDFORGE_KEY_SECRET is not set, so "
          "keys issued by the website will be rejected.")
if not (d.get("metering") or {}).get("durable"):
    print("\n  ! metered usage is NOT durable on this instance. Check the volume is "
          "mounted at /data, then GET /v1/usage — it names the exact problem.")
PY

cat <<EOF

────────────────────────────────────────────────────────────────────────
The engine is live at $URL

Website environment (Vercel → Settings → Environment Variables):

  GRIDFORGE_API_URL=$URL
EOF

if [ -n "${NEW_KEY:-}" ]; then
  cat <<EOF
  GRIDFORGE_API_KEY=$NEW_KEY        <- NEW, set this now
EOF
else
  cat <<EOF
  GRIDFORGE_API_KEY=<unchanged>     <- the existing key still works
EOF
fi

if [ -n "${NEW_SECRET:-}" ]; then
  cat <<EOF
  GRIDFORGE_KEY_SECRET=$NEW_SECRET
      ^ NEW. The website signs self-serve API keys with this and the engine
        verifies them. Both sides must hold the SAME value. Printed once.
EOF
else
  cat <<EOF
  GRIDFORGE_KEY_SECRET=<unchanged>  <- must match what the website already has
EOF
fi

cat <<EOF

Verify:
  curl -s $URL/v1/version | python3 -m json.tool | head -20
  curl -s $URL/v1/tools   | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["tools"]), "tools")'

Migrations still to run in Supabase:
  supabase/migrations/0002_qualifications.sql … 0007_api_accounts.sql
────────────────────────────────────────────────────────────────────────
EOF
