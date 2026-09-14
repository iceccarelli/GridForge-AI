#!/usr/bin/env bash
# Apply every patch waiting in inbox/, test it, and keep it only if it passes.
#
#   bash scripts/apply-inbox.sh            apply, test, commit
#   bash scripts/apply-inbox.sh --dry-run  say what would happen, change nothing
#
# The patch file is removed in the SAME commit that applies it. That is the whole
# point: a patch is an instruction, not a source file, and a repository that keeps
# every instruction it was ever given ends up with a root nobody can read.
set -Eeuo pipefail

cd "$(dirname "$0")/.."
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

say()  { printf '%s\n' "$*"; }
ok()   { printf '\033[32m  ok  %s\033[0m\n' "$*"; }
warn() { printf '\033[33m  !!  %s\033[0m\n' "$*"; }
die()  { printf '\033[31m  XX  %s\033[0m\n' "$*" >&2; exit 1; }
head_() { printf '\n\033[2m== %s\033[0m\n' "$*"; }

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
  if ! python3 -m pytest tests -q; then
    warn "tests failed; rolling back to ${before:0:8}"
    git reset -q --hard "$before"
    die "$name reverted. Nothing was kept. The patch is gone from inbox/ but the
      copy you uploaded is still wherever you uploaded it from."
  fi
  ok "tests pass"
done

head_ "done"
ok "$(git rev-list --count HEAD) commit(s); inbox is empty"
say ""
say "  Now:  npx tsc --noEmit && npm run build"
say "  Then: git push origin main"
