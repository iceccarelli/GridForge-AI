#!/usr/bin/env bash
# Apply the branch-protection rulesets in .github/rulesets/*.json to the GitHub repository, idempotently.
#
#   bash scripts/apply-rulesets.sh                  # DRY RUN (the default): reads, prints what it would do, changes nothing
#   bash scripts/apply-rulesets.sh --apply          # create / update the rulesets that differ
#   bash scripts/apply-rulesets.sh --verify         # read-only: diff live against the files, exit 1 on drift
#   bash scripts/apply-rulesets.sh --repo OWNER/NAME [--dir DIR]
#
# Needs: bash, jq, and the GitHub CLI (`gh`) authenticated as someone with repository ADMINISTRATION (rulesets are a repository
# setting; an Actions token cannot write them). Nothing here reads, prints or stores a token: authentication is `gh`'s own.
#
# This script is run by the OWNER, by hand. It refuses to run at all under CI (CI / GITHUB_ACTIONS set) unless BOTH --apply and
# --yes-i-am-the-owner are given, so a workflow can never change branch protection by accident. Nothing in .github/workflows calls it.
#
# What it does, per .github/rulesets/*.json
#   1. Validates every file as JSON with the fields a ruleset needs, BEFORE any request is made (one bad file stops the run: no
#      half-applied state).
#   2. Looks up an existing ruleset of the SAME NAME in this repository (not inherited ones) and
#        - none exists            -> POST   repos/OWNER/NAME/rulesets
#        - exists and differs     -> PUT    repos/OWNER/NAME/rulesets/ID   (GitHub's update verb for rulesets)
#        - exists and is the same -> nothing. Running --apply twice makes NO write the second time.
#      "The same" is judged on normalised JSON: key order and list order do not matter, and fields the server adds on its own (id,
#      timestamps, parameter defaults) are ignored because only the keys the file declares are compared.
#   3. NEVER deletes. A ruleset in the repository that has no file here is listed as "left alone" and not touched.
#
# Exit codes: 0 ok / no drift, 1 drift (--verify) or a request failed, 2 bad usage or an invalid ruleset file, 3 gh/jq missing, not
# authenticated, or (with --apply) not an administrator, 4 refused under CI.
#
# ---- Why the files say what they say (read before editing them) ----------------------------------------------------------------
# REQUIRED CHECKS are exactly the jobs that run on EVERY pull request, with no path filter and no skipping `if:`. They are the
# job names GitHub reports as check contexts: `site`, `real-database`, ..., and a matrix job is "<job> (<value>)", e.g. `test (3.12)`.
# That is 13 contexts: test x3, build x3 (package.yml), site, real-database, real-storage, api, observatory, reference, deliverables.
# tests/test_rulesets.py recomputes that set from the workflow YAML and fails if a ruleset requires something that can be skipped, or
# omits a job that always runs.
#   - NOT `stress` (stress-harness.yml). It keeps a pull_request `paths:` filter on purpose (it only matters when the engine, examples or
#     its own workflow change). A required check whose workflow never starts reports nothing, and GitHub then waits for it for ever:
#     every unrelated pull request would hang, and so would the pull request that fixes a gap the harness found. It stays advisory.
#   - NOT the Vercel check. It is posted by the Vercel GitHub integration, not by a job in this repository; making it required ties
#     merging to that integration's availability and to a name this repository does not control.
# MERGE METHOD is "merge" only, and required_linear_history is deliberately NOT enabled: the owner merges pull requests with merge
# commits (Merge pull request #N ...). Linear history forbids merge commits, so enabling it would block the owner's own workflow.
# bypass_actors is empty: nobody, the owner included, pushes straight to a protected branch; the way in is a pull request.
# `release/*` (protect-release.json) is the same rule set on release branches. It differs in one field: do_not_enforce_on_create is
# true, because cutting a release branch from a commit that has already passed CI cannot go through a pull request or a status check.
set -euo pipefail

GH="${GH_BIN:-gh}"
MODE=dry
REPO=""
DIR=""
YES_OWNER=0
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() { sed -n '2,8p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { local rc="$1"; shift; echo "apply-rulesets: $*" >&2; exit "$rc"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) [ "$MODE" = verify ] && die 2 "--apply and --verify are mutually exclusive"; MODE=apply ;;
    --verify) [ "$MODE" = apply ] && die 2 "--apply and --verify are mutually exclusive"; MODE=verify ;;
    --dry-run) ;; # accepted for clarity; it is the default
    --yes-i-am-the-owner) YES_OWNER=1 ;;
    --repo) [ $# -ge 2 ] || die 2 "--repo needs OWNER/NAME"; REPO="$2"; shift ;;
    --dir) [ $# -ge 2 ] || die 2 "--dir needs a directory"; DIR="$2"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die 2 "unknown argument: $1 (see --help)" ;;
  esac
  shift
done

# Under CI this script changes nothing unless the owner says so twice. Even a read is refused: there is no reason for a workflow to run it.
in_ci=0
if { [ -n "${CI:-}" ] && [ "${CI}" != "false" ]; } || [ -n "${GITHUB_ACTIONS:-}" ]; then in_ci=1; fi
if [ "$in_ci" = 1 ] && { [ "$MODE" != apply ] || [ "$YES_OWNER" != 1 ]; }; then
  die 4 "refusing to run under CI. Branch protection is changed by the repository owner by hand; under CI this needs both --apply and --yes-i-am-the-owner."
fi

command -v jq >/dev/null 2>&1 || die 3 "jq is required"
command -v "$GH" >/dev/null 2>&1 || die 3 "the GitHub CLI ($GH) is required: https://cli.github.com"

DIR="${DIR:-$ROOT/.github/rulesets}"
[ -d "$DIR" ] || die 2 "no such directory: $DIR"
shopt -s nullglob
FILES=("$DIR"/*.json)
shopt -u nullglob
[ "${#FILES[@]}" -gt 0 ] || die 2 "no *.json ruleset files in $DIR"

# ---- 1. validate every file before a single request ------------------------------------------------------------------------
declare -A NAME_OF
for f in "${FILES[@]}"; do
  jq -e . "$f" >/dev/null 2>&1 || die 2 "$f is not valid JSON; nothing was requested"
  jq -e 'type == "object"
         and (.name | type == "string" and length > 0)
         and (.target == "branch" or .target == "tag" or .target == "push")
         and (.enforcement == "active" or .enforcement == "evaluate" or .enforcement == "disabled")
         and (.rules | type == "array" and length > 0)
         and (.conditions.ref_name.include | type == "array" and length > 0)' "$f" >/dev/null 2>&1 \
    || die 2 "$f is not a ruleset (needs name, target, enforcement, rules[], conditions.ref_name.include[]); nothing was requested"
  n="$(jq -r .name "$f")"
  for other in "${!NAME_OF[@]}"; do
    [ "${NAME_OF[$other]}" = "$n" ] && die 2 "$f and $other both define the ruleset named '$n'"
  done
  NAME_OF["$f"]="$n"
done

# ---- 2. the repository and the caller -------------------------------------------------------------------------------------
"$GH" auth status >/dev/null 2>&1 || die 3 "gh is not authenticated (run: gh auth login). No token is read by this script."
if [ -z "$REPO" ]; then
  REPO="$("$GH" repo view --json nameWithOwner 2>/dev/null | jq -r '.nameWithOwner // empty')" || true
  [ -n "$REPO" ] || die 3 "could not work out the repository from 'gh repo view'; pass --repo OWNER/NAME"
fi
case "$REPO" in */*) ;; *) die 2 "--repo must look like OWNER/NAME, got: $REPO" ;; esac

repo_json="$("$GH" api "repos/$REPO")" || die 3 "cannot read repos/$REPO with this login"
is_admin="$(printf '%s' "$repo_json" | jq -r '.permissions.admin // false')"
if [ "$is_admin" != true ]; then
  if [ "$MODE" = apply ]; then die 3 "this login is not an administrator of $REPO; rulesets cannot be written"; fi
  echo "note: this login is not an administrator of $REPO; --apply would be refused (reading is fine)." >&2
fi

list_json="$("$GH" api "repos/$REPO/rulesets?includes_parents=false&per_page=100" --paginate | jq -s 'add // []')" \
  || die 1 "could not list rulesets of $REPO"

# ---- comparison ------------------------------------------------------------------------------------------------------------
# normalised: sorted keys and lists; the live object is projected onto the keys the file declares, element by element.
JQ_LIB='
def ident: if type == "object" then (.type // .context // tojson) else tojson end;
def norm: if type == "object" then with_entries(.value |= norm)
          elif type == "array" then map(norm) | sort_by(tojson)
          else . end;
def proj($r):
  if type == "object" and ($r | type) == "object" then
    . as $o | reduce ($r | keys_unsorted[]) as $k ({}; if ($o | has($k)) then .[$k] = ($o[$k] | proj($r[$k])) else . end)
  elif type == "array" and ($r | type) == "array" then
    map(. as $e | ([$r[] | select(ident == ($e | ident))] | first // null) as $m | if $m == null then $e else ($e | proj($m)) end)
  else . end;
'
normalise_file() { jq -S "$JQ_LIB"' norm' "$1"; }
normalise_live() { jq -S --slurpfile f "$1" "$JQ_LIB"' proj($f[0]) | norm'; }

created=0; updated=0; same=0; drift=0
declare -A MANAGED
for f in "${FILES[@]}"; do
  name="${NAME_OF[$f]}"
  MANAGED["$name"]=1
  rel="${f#"$ROOT"/}"
  id="$(printf '%s' "$list_json" | jq -r --arg n "$name" '[.[] | select(.name == $n and ((.source_type // "Repository") == "Repository"))][0].id // empty')"
  if [ -z "$id" ]; then
    case "$MODE" in
      dry)    echo "WOULD CREATE  $name  ($rel)"; created=$((created + 1)) ;;
      verify) echo "DRIFT         $name is missing from $REPO ($rel)"; drift=$((drift + 1)) ;;
      apply)
        "$GH" api -X POST "repos/$REPO/rulesets" -H "Accept: application/vnd.github+json" --input "$f" >/dev/null \
          || die 1 "creating '$name' failed"
        echo "CREATED       $name"; created=$((created + 1)) ;;
    esac
    continue
  fi
  live="$("$GH" api "repos/$REPO/rulesets/$id")" || die 1 "could not read ruleset '$name' (id $id)"
  want_n="$(normalise_file "$f")"
  have_n="$(printf '%s' "$live" | normalise_live "$f")"
  if [ "$want_n" = "$have_n" ]; then
    echo "UNCHANGED     $name (id $id)"; same=$((same + 1)); continue
  fi
  case "$MODE" in
    dry)    echo "WOULD UPDATE  $name (id $id)  ($rel)"; updated=$((updated + 1)) ;;
    verify) echo "DRIFT         $name (id $id) differs from $rel"; drift=$((drift + 1)) ;;
    apply)
      "$GH" api -X PUT "repos/$REPO/rulesets/$id" -H "Accept: application/vnd.github+json" --input "$f" >/dev/null \
        || die 1 "updating '$name' (id $id) failed"
      echo "UPDATED       $name (id $id)"; updated=$((updated + 1)) ;;
  esac
  if [ "$MODE" != apply ]; then
    diff <(printf '%s\n' "$have_n") <(printf '%s\n' "$want_n") | sed 's/^/    /' | sed -n '1,60p' || true
    echo "    (lines marked < are live, > are the file)"
  fi
done

# rulesets this script did not create are never touched
others="$(printf '%s' "$list_json" | jq -r --argjson m "$(printf '%s\n' "${!MANAGED[@]}" | jq -R . | jq -s .)" \
  '.[] | select((.source_type // "Repository") == "Repository") | select(.name as $n | $m | index($n) | not) | .name')"
if [ -n "$others" ]; then
  while IFS= read -r o; do echo "LEFT ALONE    $o (no file in $DIR; this script never deletes)"; done <<<"$others"
fi

echo "---"
case "$MODE" in
  dry)    echo "dry run for $REPO: $created to create, $updated to update, $same unchanged. Nothing was changed. Re-run with --apply to write." ;;
  apply)  echo "applied to $REPO: $created created, $updated updated, $same unchanged." ;;
  verify) echo "verify $REPO: $same match, $drift drifted."; [ "$drift" -eq 0 ] || exit 1 ;;
esac
