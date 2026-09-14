#!/usr/bin/env bash
# Deploy the capacity engine to Fly.io from a Codespace or any Linux shell.
#
#   bash scripts/deploy-engine.sh
#
# Installs flyctl if it is missing, creates the app, generates an API key, deploys,
# and prints the two environment variables the website needs. The engine has no
# database and no dependencies: it scales to zero and costs single-digit euros a
# month.
set -euo pipefail

APP="${FLY_APP:-gridforge-engine}"
REGION="${FLY_REGION:-ams}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }

if ! command -v flyctl >/dev/null 2>&1 && ! command -v fly >/dev/null 2>&1; then
  say "Installing flyctl"
  curl -L https://fly.io/install.sh | sh
  export FLYCTL_INSTALL="${FLYCTL_INSTALL:-$HOME/.fly}"
  export PATH="$FLYCTL_INSTALL/bin:$PATH"
  echo 'export FLYCTL_INSTALL="$HOME/.fly"' >> "$HOME/.bashrc"
  echo 'export PATH="$FLYCTL_INSTALL/bin:$PATH"' >> "$HOME/.bashrc"
fi
FLY="$(command -v flyctl || command -v fly)"

if ! "$FLY" auth whoami >/dev/null 2>&1; then
  say "Sign in to Fly (a browser window or a device code will follow)"
  "$FLY" auth login
fi

if ! "$FLY" apps list 2>/dev/null | grep -q "^$APP"; then
  say "Creating app $APP"
  "$FLY" apps create "$APP" || true
fi

KEY="${GRIDFORGE_API_KEY_VALUE:-$(openssl rand -hex 24)}"
say "Setting the API key"
"$FLY" secrets set GRIDFORGE_API_KEYS="$KEY" --app "$APP" --stage

say "Deploying"
"$FLY" deploy --app "$APP" --regions "$REGION" --ha=false

URL="https://$APP.fly.dev"
say "Checking health"
for _ in $(seq 1 30); do
  if curl -sf "$URL/health" >/dev/null; then break; fi
  sleep 2
done
curl -s "$URL/v1/version" || true

cat <<EOF

────────────────────────────────────────────────────────────────────────
The engine is live at $URL

Set these on the website (Vercel → Settings → Environment Variables):

  GRIDFORGE_API_URL=$URL
  GRIDFORGE_API_KEY=$KEY

GRIDFORGE_API_URL alone powers the free qualifier at /qualify.
GRIDFORGE_API_KEY is additionally required to generate a purchased deliverable.

Then run the Supabase migrations:
  supabase/migrations/0002_qualifications.sql
  supabase/migrations/0003_deliverables.sql
────────────────────────────────────────────────────────────────────────
EOF
