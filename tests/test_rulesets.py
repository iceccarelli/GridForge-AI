"""The branch-protection rulesets in .github/rulesets/ must require exactly the checks a pull request always gets.

A required check that never starts is a pull request that can never merge (GitHub waits for it for ever), and a check that always runs
but is not required protects nothing. So the required set is COMPUTED from the workflow files, not typed twice: it must equal the jobs
that run on every pull_request (no `paths:` or other filter on the trigger, no job-level `if:`), with matrix jobs expanded the way
GitHub names them (`test (3.12)`).

`stress` (stress-harness.yml) is deliberately NOT required: it keeps a pull_request path filter, so a required `stress` would hang every
unrelated pull request and deadlock the one that fixes a gap the harness found. See the header of scripts/apply-rulesets.sh.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from workflow_jobs import UnreadableWorkflow, load_workflows, parse_workflow_text

ROOT = Path(__file__).resolve().parent.parent
RULESETS = sorted((ROOT / ".github" / "rulesets").glob("*.json"))
WORKFLOWS = load_workflows(ROOT / ".github" / "workflows")

EXPECTED_CONTEXTS = {
    "test (3.11)", "test (3.12)", "test (3.13)",
    "site", "real-database", "real-storage", "api", "observatory", "reference", "deliverables",
    "build (3.11)", "build (3.12)", "build (3.13)",
}


def _load(name: str) -> dict:
    return json.loads((ROOT / ".github" / "rulesets" / name).read_text())


def _rule(rs: dict, kind: str) -> dict:
    found = [r for r in rs["rules"] if r["type"] == kind]
    assert len(found) == 1, f"{rs['name']}: want exactly one {kind} rule, found {len(found)}"
    return found[0]


def _required(rs: dict) -> list[str]:
    return [c["context"] for c in _rule(rs, "required_status_checks")["parameters"]["required_status_checks"]]


def _always_reported() -> set[str]:
    return {c for w in WORKFLOWS for c in w.always_reported_contexts()}


def _every_context() -> set[str]:
    return {c for w in WORKFLOWS for c in w.all_contexts()}


# ---- the reader itself (a wrong reader would make every other test here meaningless) ---------------------------------------------

_WF = """name: x
on:
  push:
    branches: [main]
  pull_request:%s
jobs:
  plain:
    runs-on: ubuntu-latest
    steps:
      - run: true
  matrix:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        v: ['1', '2']
    steps:
      - run: true
  skippable:
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    steps:
      - run: true
  after_skippable:
    needs: skippable
    runs-on: ubuntu-latest
    steps:
      - run: true
  named:
    name: A readable name
    runs-on: ubuntu-latest
    steps:
      - if: always()
        run: true
"""


def test_the_reader_expands_matrices_and_drops_what_can_be_skipped():
    w = parse_workflow_text(_WF % "")
    assert sorted(w.all_contexts()) == sorted(["plain", "matrix (1)", "matrix (2)", "skippable", "after_skippable", "A readable name"])
    # a job-level `if:` can skip it; so can needing one that can be skipped; a STEP-level `if:` cannot skip the job
    assert sorted(w.always_reported_contexts()) == sorted(["plain", "matrix (1)", "matrix (2)", "A readable name"])


@pytest.mark.parametrize("flt", ["\n    paths: ['app/**']", "\n    paths-ignore: ['docs/**']", "\n    branches: [main]", "\n    types: [labeled]"])
def test_a_pull_request_filter_removes_every_job_of_the_workflow(flt):
    assert parse_workflow_text(_WF % flt).always_reported_contexts() == []


def test_a_workflow_without_a_pull_request_trigger_reports_nothing():
    text = (_WF % "").replace("  pull_request:\n", "  workflow_dispatch:\n")
    assert parse_workflow_text(text).always_reported_contexts() == []


def test_the_reader_refuses_what_it_cannot_read():
    with pytest.raises(UnreadableWorkflow):
        parse_workflow_text(_WF.replace("        v: ['1', '2']", "        include:\n          - v: '1'") % "").all_contexts()


def test_the_reader_agrees_with_this_repositorys_workflows():
    assert len(WORKFLOWS) >= 7
    names = {w.path.name for w in WORKFLOWS}
    assert {"gridforge.yml", "package.yml", "stress-harness.yml"} <= names
    stress = next(w for w in WORKFLOWS if w.path.name == "stress-harness.yml")
    assert "paths" in stress.triggers["pull_request"], "the stress workflow's path filter is what keeps `stress` out of the required set"
    assert stress.always_reported_contexts() == []


# ---- the rulesets ----------------------------------------------------------------------------------------------------------------

def test_there_are_exactly_the_two_rulesets_the_applier_documents():
    assert [p.name for p in RULESETS] == ["protect-main.json", "protect-release.json"]
    assert _load("protect-main.json")["name"] == "protect-main"
    assert _load("protect-release.json")["name"] == "protect-release"


def test_the_required_contexts_are_exactly_the_jobs_that_run_on_every_pull_request():
    always = _always_reported()
    assert always == EXPECTED_CONTEXTS, (
        "the set of jobs that run on every pull request changed; update EXPECTED_CONTEXTS here, both ruleset files and "
        f"scripts/apply-rulesets.sh together. computed={sorted(always)}"
    )
    for f in RULESETS:
        req = _required(json.loads(f.read_text()))
        assert len(req) == len(set(req)), f"{f.name}: a context is listed twice"
        assert set(req) == always, f"{f.name}: required {sorted(set(req) ^ always)} differ from what always runs"


def test_every_required_context_is_a_real_job_and_none_can_be_skipped():
    real, always = _every_context(), _always_reported()
    for f in RULESETS:
        for c in _required(json.loads(f.read_text())):
            assert c in real, f"{f.name} requires {c!r}, which no workflow job produces: that pull request could never merge"
            assert c in always, f"{f.name} requires {c!r}, which a path filter or `if:` can prevent from starting"


def test_stress_and_the_vercel_check_are_not_required():
    for f in RULESETS:
        for c in _required(json.loads(f.read_text())):
            assert "stress" not in c.lower(), f"{f.name} requires {c!r}: stress-harness.yml has a pull_request path filter and would hang unrelated pull requests"
            assert "vercel" not in c.lower(), f"{f.name} requires {c!r}: it is posted by the Vercel integration, not a job in this repository"


def test_the_release_ruleset_is_the_main_ruleset_on_release_branches():
    main, rel = _load("protect-main.json"), _load("protect-release.json")
    assert main["target"] == rel["target"] == "branch"
    assert main["conditions"]["ref_name"]["include"] == ["~DEFAULT_BRANCH"]
    assert rel["conditions"]["ref_name"]["include"] == ["refs/heads/release/*"]
    assert main["enforcement"] == rel["enforcement"] == "active"
    assert main["bypass_actors"] == rel["bypass_actors"] == [], "nobody bypasses: the way into a protected branch is a pull request"

    def stripped(rs: dict) -> list[dict]:
        out = json.loads(json.dumps(rs["rules"]))
        for r in out:
            if r["type"] == "required_status_checks":
                r["parameters"].pop("do_not_enforce_on_create")  # the one deliberate difference, asserted below
        return sorted(out, key=lambda r: r["type"])

    assert stripped(main) == stripped(rel)
    assert _rule(rel, "required_status_checks")["parameters"]["do_not_enforce_on_create"] is True, (
        "a release branch is cut from a commit that already passed CI; creating it cannot carry a status check or a pull request"
    )
    assert _rule(main, "required_status_checks")["parameters"]["do_not_enforce_on_create"] is False


@pytest.mark.parametrize("name", ["protect-main.json", "protect-release.json"])
def test_each_ruleset_blocks_deletion_and_force_push_and_requires_a_pull_request(name):
    rs = _load(name)
    kinds = [r["type"] for r in rs["rules"]]
    assert kinds.count("deletion") == 1 and kinds.count("non_fast_forward") == 1
    pr = _rule(rs, "pull_request")["parameters"]
    # The owner merges with merge commits, so linear history must NOT be required (it forbids them) and "merge" must be allowed.
    assert "required_linear_history" not in kinds
    assert pr["allowed_merge_methods"] == ["merge"]
    assert pr["required_approving_review_count"] == 0, "a sole owner cannot approve their own pull request"
    assert pr["required_review_thread_resolution"] is True
    assert pr["dismiss_stale_reviews_on_push"] is True
    assert set(kinds) == {"deletion", "non_fast_forward", "pull_request", "required_status_checks"}, f"unreviewed rule types: {kinds}"
