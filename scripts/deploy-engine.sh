#!/usr/bin/env bash
# Deploy the capacity engine to Fly.io.
#
#   bash scripts/deploy-engine.sh              # deploy; never touches a credential
#   bash scripts/deploy-engine.sh --bootstrap  # first run: also mint missing secrets
#   bash scripts/deploy-engine.sh --check      # everything except the deploy itself
#
# Needs a Fly credential (FLY_API_TOKEN, or a prior `fly auth login`). Without one the script exits 3 before creating,
# setting or deploying anything. After a deploy it runs scripts/check-engine-drift.py and exits 1 if the engine now running
# still differs from this repository. The same steps run from .github/workflows/deploy-engine.yml.
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
    -h|--help)   sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\n\033[33m%s\033[0m\n' "$*"; }

# FLY_BIN means the caller named a binary. Honour it or fail — never reach out and
# install something. A test or a CI job that silently downloads a real flyctl is
# one step from a test that uses it.
if [ -z "${FLY_BIN:-}" ] \
   && ! command -v flyctl >/dev/null 2>&1 && ! command -v fly >/dev/null 2>&1; then
  say "Installing flyctl"
  curl -L https://fly.io/install.sh | sh
  export FLYCTL_INSTALL="${FLYCTL_INSTALL:-$HOME/.fly}"
  export PATH="$FLYCTL_INSTALL/bin:$PATH"
  grep -q 'FLYCTL_INSTALL' "$HOME/.bashrc" 2>/dev/null || {
    echo 'export FLYCTL_INSTALL="$HOME/.fly"' >> "$HOME/.bashrc"
    echo 'export PATH="$FLYCTL_INSTALL/bin:$PATH"' >> "$HOME/.bashrc"
  }
fi
# FLY_BIN lets a caller name the binary explicitly. Tests set it, because
# resolving by name alone picked up a REAL flyctl installed elsewhere on PATH and
# ran `apps create` against a live account — a test that touches production is a
# worse bug than the one it was written to catch.
FLY="${FLY_BIN:-$(command -v flyctl || command -v fly)}"
if [ ! -x "$FLY" ]; then
  echo "flyctl not found (looked for FLY_BIN, flyctl, fly)" >&2
  exit 2
fi

# AUTH IS CHECKED FIRST AND FAILS CLOSED. Nothing below this point (apps create, secrets set, volumes create, deploy) runs
# unless Fly has accepted a credential. There is no interactive `fly auth login` fallback any more: in CI it hangs or half-works,
# and a deploy that "signs in" halfway through a run has already decided to mutate things. The token itself is never printed.
if [ "${FLY_API_TOKEN+set}" = "set" ] && [ -z "${FLY_API_TOKEN}" ]; then
  unset FLY_API_TOKEN   # an empty token is "no token", not a credential to hand to flyctl
  warn "FLY_API_TOKEN is set but empty."
fi
if ! "$FLY" auth whoami >/dev/null 2>&1; then
  warn "Not authenticated to Fly.io — stopping before anything is created, set or deployed."
  if [ -n "${FLY_API_TOKEN:-}" ]; then
    echo "  FLY_API_TOKEN is set, but Fly rejected it (expired, revoked, or for another app)." >&2
    echo "  Create a new one:  fly tokens create deploy -a $APP" >&2
  else
    echo "  Add repository secret FLY_API_TOKEN (fly tokens create deploy -a $APP)" >&2
    echo "  or, on your own machine:  fly auth login   (then re-run this script)" >&2
  fi
  exit 3
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
# Only a LIST is a secret list. An error object ({"error": ...}) or any other shape means "could not read", never "none exist":
# reading it as empty would let --bootstrap overwrite credentials that are in fact set.
if isinstance(rows, dict):
    rows = rows.get("secrets") if "secrets" in rows else rows.get("Secrets") if "Secrets" in rows else None
if not isinstance(rows, list):
    raise SystemExit(1)
names = [r.get("Name") or r.get("name") for r in rows if isinstance(r, dict)]
print("\n".join(n for n in names if n))
' 2>/dev/null)"; then
    DETECTED=1
  fi
fi
if [ "$DETECTED" -eq 0 ]; then
  # A table has a NAME header row; anything else (an error message, a banner) is not a list and must not be read as one.
  if RAW_TXT="$("$FLY" secrets list --app "$APP" 2>/dev/null)" && printf '%s' "$RAW_TXT" | head -n1 | grep -qiE '^[[:space:]]*NAME\b'; then
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
# Fly volume names are NOT unique, and a second volume is a second, empty ledger. So: the exact name, from the machine-readable list,
# and a listing that fails or cannot be read is "unknown", which never resolves to creating one (the old `volumes list | grep -q`
# treated a failed or truncated listing, and a substring such as ${VOLUME}_old, as "absent" or "present").
VOLUME_STATE="unknown"
if VOLS_JSON="$("$FLY" volumes list --app "$APP" --json 2>/dev/null)" && [ -n "$VOLS_JSON" ]; then
  VOLUME_STATE="$(printf '%s' "$VOLS_JSON" | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
except Exception:
    print("unknown"); raise SystemExit(0)
if isinstance(rows, dict):
    rows = rows.get("volumes") if isinstance(rows.get("volumes"), list) else None
if not isinstance(rows, list):
    print("unknown"); raise SystemExit(0)
names = [r.get("Name") or r.get("name") for r in rows if isinstance(r, dict)]
print("present" if sys.argv[1] in names else "absent")
' "$VOLUME" 2>/dev/null || echo unknown)"
fi
case "$VOLUME_STATE" in
  present)
    say "Usage volume $VOLUME exists" ;;
  absent)
    warn "No usage volume — metered usage would not survive a restart."
    echo "  Creating a 1GB volume in $REGION (a few cents a month)."
    "$FLY" volumes create "$VOLUME" --app "$APP" --region "$REGION" --size 1 --yes || {
      warn "Volume creation failed. The engine will still serve; usage will be in-memory"
      warn "only, and /v1/usage will say so rather than pretending otherwise."
    } ;;
  *)
    warn "Could not read the volume list for $APP."
    echo "  Not creating $VOLUME. Uncertainty must never resolve to a second volume (and a second, empty ledger)."
    echo "  Check:  $FLY volumes list --app $APP" ;;
esac
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

Database migrations are applied one at a time, in filename order, behind safety gates:
  python3 scripts/apply-migration.py <number>      (see docs/10_PAYG_LAUNCH_CHECKLIST.md)
────────────────────────────────────────────────────────────────────────
EOF
}

if [ "$SKIP_DEPLOY" = "1" ]; then
  say "--check: stopping before deploy"
  summary
  exit 0
fi

say "Deploying"
# --ha=false: one machine, one volume. Never pass a count or scale here (usage, ledger and revocations are local state).
"$FLY" deploy --app "$APP" --regions "$REGION" --ha=false --remote-only

# GRIDFORGE_ENGINE_URL exists so the post-deploy verification can be exercised against a local engine; a real run leaves it unset.
URL="${GRIDFORGE_ENGINE_URL:-https://$APP.fly.dev}"
say "Checking health"
for _ in $(seq 1 "${GRIDFORGE_HEALTH_TRIES:-30}"); do
  curl -sf "$URL/health" >/dev/null && break
  sleep 2
done
VERSION_JSON="$(curl -s "$URL/v1/version" || true)"

VERIFY_FAILED=0
python3 - "$VERSION_JSON" <<'PY' || VERIFY_FAILED=1
import json, sys
try:
    d = json.loads(sys.argv[1] or "{}")
except Exception:
    print("  ! could not read /v1/version"); raise SystemExit(1)
meter = d.get("metering") or {}
rows = [
    ("paid endpoints", d.get("auth_configured"),
     "set GRIDFORGE_API_KEYS or GRIDFORGE_KEY_SECRET"),
    ("self-serve keys", d.get("signed_keys"),
     "set GRIDFORGE_KEY_SECRET to the same value as the website"),
    ("durable usage counter", meter.get("durable"),
     "check the volume is mounted at /data, then GET /v1/usage for the exact problem"),
    # Free-allowance and pay-as-you-go keys are refused (503) without a writable ledger, so this one is a hard requirement.
    ("durable usage ledger", meter.get("ledger_durable"),
     "GRIDFORGE_LEDGER_FILE must be on the mounted volume; payg and free keys are refused without it"),
    ("pay-as-you-go published", bool(d.get("payg")),
     "this engine build predates the ledger: redeploy from the current repository"),
]
print(f"\n  engine {d.get('version', '?')}")
bad = 0
for label, ok, fix in rows:
    bad += 0 if ok else 1
    print(f"  {'OK ' if ok else '!! '} {label:24s}" + ("" if ok else f"  -> {fix}"))
raise SystemExit(1 if bad else 0)
PY

# Operator-tier facts need the operator key; when it is exported, revocation persistence is checked too.
if [ -n "${GRIDFORGE_ADMIN_KEY:-}" ]; then
  OP_JSON="$(curl -s -H "X-API-Key: $GRIDFORGE_ADMIN_KEY" "$URL/v1/version" || true)"
  if ! printf '%s' "$OP_JSON" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
ok = d.get("tier") == "internal" and d.get("revocation_persistable") is True
print("  " + ("OK " if ok else "!! ") + "revocation persistable (operator key accepted)" + ("" if ok else "  -> a cancelled key could not be ended: check GRIDFORGE_ADMIN_KEY and the /data volume"))
raise SystemExit(0 if ok else 1)
'; then VERIFY_FAILED=1; fi
else
  echo "  -- revocation persistence not checked: export GRIDFORGE_ADMIN_KEY to check it (never printed)"
fi

# Exactly one machine, and it mounts the volume: the usage counter, ledger, revocations and cost file are local state, so a second
# machine would split every one of them. `--ha=false` limits what a deploy creates; this is what proves what exists.
MACH_JSON="$("$FLY" machines list --app "$APP" --json 2>/dev/null || true)"
MACH_RC=0
printf '%s' "$MACH_JSON" | python3 -c '
import json, sys
vol = sys.argv[1]
try:
    rows = json.load(sys.stdin)
except Exception:
    print("  ?? machine count could not be read: run  fly machines list  and confirm exactly one machine mounts " + vol); raise SystemExit(2)
if isinstance(rows, dict):
    rows = rows.get("machines") if isinstance(rows.get("machines"), list) else None
if not isinstance(rows, list):
    print("  ?? machine count could not be read: run  fly machines list  and confirm exactly one machine mounts " + vol); raise SystemExit(2)
def mounts(m):
    cfg = (m.get("config") or {}) if isinstance(m, dict) else {}
    return [x.get("name") or x.get("volume") for x in (cfg.get("mounts") or []) if isinstance(x, dict)]
n = len(rows)
mounted = sum(1 for m in rows if vol in (mounts(m) or []) or any(vol in str(x) for x in (mounts(m) or [])))
ok = n == 1 and mounted == 1
print("  " + ("OK " if ok else "!! ") + f"machines: {n}, mounting {vol}: {mounted}" + ("" if ok else "  -> must be exactly one machine with the volume: usage, ledger and revocations are local state. Do not scale out."))
raise SystemExit(0 if ok else 1)
' "$VOLUME" || MACH_RC=$?
# 2 means "could not read" (unverified, reported above, not a failure); 1 means a wrong count (a failure).
if [ "$MACH_RC" -ne 0 ] && [ "$MACH_RC" -ne 2 ]; then VERIFY_FAILED=1; fi

# The repository's own statement of what the engine must serve, checked against what it now serves (routes, unit rates, version).
say "Post-deploy drift check (read-only)"
if ! python3 "$(dirname "$0")/check-engine-drift.py" "$URL"; then
  VERIFY_FAILED=1
  echo "  !! the engine now running does not match this repository (see the differences above)"
fi

say "The engine is live at $URL"
summary
if [ "$VERIFY_FAILED" -ne 0 ]; then
  warn "Post-deploy verification FAILED (see the !! lines above). The deploy happened; do not announce or sell against it until they are fixed."
  exit 1
fi
