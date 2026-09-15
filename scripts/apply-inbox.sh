#!/usr/bin/env bash
# Apply every patch waiting in inbox/, test it, and keep it only if it passes.
#
#   bash scripts/apply-inbox.sh            sweep, apply, test, commit
#   bash scripts/apply-inbox.sh --dry-run  say what would happen, change nothing
#
# The patch file is removed in the SAME commit that applies it. That is the whole
# point: a patch is an instruction, not a source file, and a repository that keeps
# every instruction it was ever given ends up with a root nobody can read.
#
# Two things this script learned the hard way, both on live main:
#
#   1. A patch uploaded through the GitHub web interface lands at the REPOSITORY
#      ROOT, never in inbox/, because the web uploader has no folder picker worth
#      using. So the script sweeps root patches into inbox/ itself instead of
#      failing and telling a human to do a git mv.
#
#   2. It used to roll back a patch whenever the suite was red AFTER applying it —
#      which is wrong whenever the suite was ALREADY red BEFORE. That is exactly
#      what happened: a stray patch file at the root was failing the root-hygiene
#      test, and a good, unrelated patch was reverted twice for it. So the script
#      now records which tests already fail, and rolls back only on NEW failures.
set -Eeuo pipefail

cd "$(dirname "$0")/.."
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

PYTEST=${PYTEST:-}

say()  { printf '%s\n' "$*"; }
ok()   { printf '\033[32m  ok  %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  !!  %s\033[0m\n' "$*"; }
die()  { printf '\033[31m  XX  %s\033[0m\n' "$*" >&2; exit 1; }
head_() { printf '\n\033[2m== %s\033[0m\n' "$*"; }

# --- the test runner -------------------------------------------------------
# This script decides whether a patch may stay on main, and it decides it from the
# test suite. So "the suite passed" and "the runner never ran" must never look the
# same: an absent pytest used to read as green through the `|| true` below, which
# would have applied and committed a patch that breaks everything, on a machine
# whose only fault was not having pytest installed. Resolve a runner that actually
# works, up front, and refuse to run at all if there is not one.
resolve_pytest() {
  local cand
  if [ -n "$PYTEST" ]; then
    # shellcheck disable=SC2086
    $PYTEST --version >/dev/null 2>&1 \
      || die "PYTEST='$PYTEST' cannot run: \`\$PYTEST --version\` failed. Fix it or
      unset PYTEST to let the script find a runner itself."
    return
  fi
  for cand in "./.venv/bin/python -m pytest" "python3 -m pytest" "python -m pytest" "pytest"; do
    # shellcheck disable=SC2086
    if $cand --version >/dev/null 2>&1; then PYTEST=$cand; return; fi
  done
  die "no working pytest found (tried .venv/bin/python, python3, python, pytest).
      This script may not apply a patch it cannot test — a missing test runner is
      not a passing test suite. Install pytest, or set PYTEST to a command that
      works:  PYTEST='/path/to/python -m pytest' bash scripts/apply-inbox.sh"
}

# Failing node ids, one per line, sorted. Empty output means green.
#
# pytest exit codes: 0 all passed, 1 tests failed, 2 interrupted, 3 internal error,
# 4 usage error, 5 no tests collected. Only 0 and 1 are a verdict about the code.
# Anything else means the run itself is not trustworthy, and a run we cannot trust
# must stop the script rather than quietly report an empty failure list.
failures() {
  local out rc
  # The failure must not take `set -e` with it — a red suite is an expected result
  # here, not an error.
  set +e
  # shellcheck disable=SC2086
  out=$($PYTEST tests -q --tb=no -rf 2>&1); rc=$?
  set -e
  if [ "$rc" -gt 1 ]; then
    printf '%s\n' "$out" >&2
    die "the test runner exited $rc — it did not produce a verdict about the code.
      Nothing is applied and nothing is rolled back; HEAD is where you left it."
  fi
  printf '%s\n' "$out" | awk '/^(FAILED|ERROR) /{print $2}' | sort -u
}

# --- sweep -----------------------------------------------------------------
# A patch at the root is an upload that missed, not a mistake worth stopping for.
shopt -s nullglob
stray=(./*.patch)
shopt -u nullglob
if [ ${#stray[@]} -gt 0 ]; then
  head_ "sweeping ${#stray[@]} patch file(s) off the repository root"
  mkdir -p inbox
  moved=0
  for s in "${stray[@]}"; do
    base=$(basename "$s")
    [ -e "inbox/$base" ] && die "inbox/$base already exists; refusing to overwrite it"
    if git ls-files --error-unmatch -- "$s" >/dev/null 2>&1; then
      git mv -- "$s" "inbox/$base"
      moved=1
    else
      mv -- "$s" "inbox/$base"
    fi
    ok "$base -> inbox/"
  done
  if [ "$moved" -eq 1 ] && [ "$DRY" -eq 0 ]; then
    git commit -q -m "chore(intake): move uploaded patch(es) into inbox/

A GitHub web upload lands at the repository root. scripts/apply-inbox.sh moves
it where the intake expects it so the root-hygiene test stays green."
    ok "committed the move — $(git log --oneline -1)"
  fi
fi

shopt -s nullglob
patches=(inbox/*.patch)
shopt -u nullglob

if [ ${#patches[@]} -eq 0 ]; then
  ok "inbox is empty — nothing to apply"
  exit 0
fi

head_ "waiting in the inbox"
for p in "${patches[@]}"; do say "  $(basename "$p")"; done

[ -z "$(git status --porcelain --untracked-files=no)" ] \
  || die "tracked files are modified. Commit or discard them first — a patch applied
      onto a dirty tree cannot be rolled back cleanly, and rolling back is the only
      reason this script is safe to run."

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] || warn "on '$branch', not main"

if [ "$DRY" -eq 1 ]; then
  head_ "dry run"
  for p in "${patches[@]}"; do
    if git apply --check --whitespace=nowarn "$p" 2>/dev/null; then
      ok "$(basename "$p") would apply"
    else
      warn "$(basename "$p") would NOT apply"
    fi
  done
  exit 0
fi

# --- baseline --------------------------------------------------------------
# What is already red? A patch is only responsible for what it broke.
resolve_pytest
head_ "baseline (what already fails before anything is applied)"
say "  runner: $PYTEST"
BASE=$(mktemp); trap 'rm -f "$BASE" "${NOW:-}"' EXIT
failures > "$BASE"
if [ -s "$BASE" ]; then
  warn "$(wc -l < "$BASE" | tr -d ' ') test(s) already failing on ${branch} — not caused by anything in the inbox:"
  sed 's/^/        /' "$BASE"
  warn "these will NOT roll a patch back, but they must still be fixed."
else
  ok "green"
fi

for p in "${patches[@]}"; do
  name=$(basename "$p")
  before=$(git rev-parse HEAD)
  head_ "applying $name"

  git am --abort >/dev/null 2>&1 || true
  if ! git am --3way --whitespace=nowarn "$p" >/dev/null 2>&1; then
    git am --abort >/dev/null 2>&1 || true
    die "$name did not apply. HEAD is untouched at ${before:0:8}."
  fi

  # Fold the removal of the patch itself into the commit it created. One commit
  # per patch, and the instruction does not survive its own execution.
  if git ls-files --error-unmatch -- "$p" >/dev/null 2>&1; then
    git rm -q --cached -- "$p"
  fi
  rm -f -- "$p"
  git commit -q --amend --no-edit --allow-empty
  ok "applied — $(git log --oneline -1)"

  head_ "testing"
  NOW=$(mktemp)
  failures > "$NOW"
  new=$(comm -13 "$BASE" "$NOW")
  if [ -n "$new" ]; then
    warn "$name introduced test failures that were not there before:"
    printf '%s\n' "$new" | sed 's/^/        /'
    warn "rolling back to ${before:0:8}"
    git reset -q --hard "$before"
    die "$name reverted. Nothing was kept. The patch is gone from inbox/ but the
      copy you uploaded is still wherever you uploaded it from."
  fi
  # A patch is allowed to FIX a baseline failure. Shrink the baseline so a later
  # patch cannot smuggle the same failure back in.
  cp "$NOW" "$BASE"
  if [ -s "$BASE" ]; then
    ok "no new failures ($(wc -l < "$BASE" | tr -d ' ') pre-existing still red)"
  else
    ok "tests pass"
  fi
done

head_ "done"
ok "$(git rev-list --count HEAD) commit(s); inbox is empty"
if [ -s "$BASE" ]; then
  say ""
  warn "still red, and none of it caused by the inbox:"
  sed 's/^/        /' "$BASE"
fi
say ""
say "  Now:  npx tsc --noEmit && npm run build"
say "  Then: git push origin main"
