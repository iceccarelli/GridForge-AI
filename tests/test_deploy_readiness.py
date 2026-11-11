"""Deploy-readiness structure that must not rot (text checks: CI installs pytest only, so no YAML parser is assumed).

* the rollback anchors the deploy workflow records before it changes anything, and the independent one-machine assertion after it;
* the CI checks that can be made REQUIRED in branch protection must report on every pull request (a path filter on pull_request means a
  website-only change never gets the check, and a required check that never reports blocks the merge for ever);
* no script, workflow or site source claims a docs/*.md file that is not in the repository;
* the persisted-format and first-boot facts stay written next to the deploy summary.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WF = ROOT / ".github" / "workflows"


def code_lines(text):
    return [ln for ln in text.splitlines() if not ln.lstrip().startswith("#")]


def steps(name):
    """[(step name, step text)] of the single job in a workflow, in order; comment lines are dropped."""
    lines = code_lines((WF / name).read_text())
    out, cur = [], None
    for ln in lines:
        m = re.match(r"^      - (?:name: (.*)|(uses: .*))$", ln)
        if m:
            cur = [m.group(1) or m.group(2), []]
            out.append(cur)
        if cur is not None:
            cur[1].append(ln)
    return [(n, "\n".join(b)) for n, b in out]


def step(name, label):
    hit = [t for n, t in steps(name) if n.startswith(label)]
    assert len(hit) == 1, f"{name}: want exactly one step named {label!r}, found {len(hit)}"
    return hit[0]


def index_of(name, label):
    return [n for n, _ in steps(name)].index(next(n for n, _ in steps(name) if n.startswith(label)))


# ---- rollback anchors: structure only; what the steps DO is executed in tests/test_deploy_workflow_exec.py -------------------------------
def test_the_anchor_steps_run_between_flyctl_setup_and_the_deploy_and_the_upload_follows_them():
    order = [n for n, _ in steps("deploy-engine.yml")]
    f = next(i for i, n in enumerate(order) if n.startswith("uses: superfly/flyctl-actions/setup-flyctl"))
    reads = index_of("deploy-engine.yml", "Read Fly state for the rollback anchors")
    anchors = index_of("deploy-engine.yml", "Record rollback anchors (read-only)")
    upload = index_of("deploy-engine.yml", "Upload the rollback anchors")
    d = index_of("deploy-engine.yml", "Deploy (never changes a credential")
    assert f < reads < anchors < upload < d, order


def test_the_upload_is_gated_on_the_anchor_step_having_run_and_publishes_only_the_reduced_files():
    t = step("deploy-engine.yml", "Upload the rollback anchors")
    assert "if: ${{ !cancelled() && steps.anchors.conclusion != 'skipped' }}" in t
    assert "id: anchors" in step("deploy-engine.yml", "Record rollback anchors (read-only)")
    assert "uses: actions/upload-artifact@v7" in t and "retention-days: 14" in t
    assert "name: engine-before-${{ github.run_id }}-${{ github.run_attempt }}" in t
    paths = re.search(r"path: \|\n((?:            .*\n?)+)", t).group(1).split()
    assert paths == ["engine-before.json", "anchors.json"], "the repository is public: raw flyctl output must never be uploaded"
    assert "-before.json" not in t.replace("engine-before.json", "")


def test_the_deployed_snapshot_artifact_is_named_per_run_and_expires():
    t = step("deploy-engine.yml", "Keep the deployed-engine snapshot")
    assert "name: engine-deployed-${{ github.run_id }}-${{ github.run_attempt }}" in t and "retention-days: 14" in t


def test_the_fly_token_is_scoped_to_the_two_flyctl_reads_in_the_anchor_steps():
    assert "FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}" in step("deploy-engine.yml", "Read Fly state for the rollback anchors")
    assert "FLY_API_TOKEN" not in step("deploy-engine.yml", "Record rollback anchors (read-only)")
    assert "FLY_API_TOKEN" not in step("deploy-engine.yml", "Upload the rollback anchors")


def test_the_last_step_is_the_one_machine_assertion():
    names = [n for n, _ in steps("deploy-engine.yml")]
    assert names[-1].startswith("Exactly one machine must exist after the deploy"), names
    t = step("deploy-engine.yml", "Exactly one machine must exist after the deploy")
    assert "steps.deploy.conclusion != 'skipped'" in t and "!cancelled()" in t
    assert "|| true" not in t and "continue-on-error" not in t


def test_the_deploy_script_still_fails_the_run_on_a_wrong_machine_count():
    s = (ROOT / "scripts" / "deploy-engine.sh").read_text()
    # exit 1 from the machine check (a wrong count) sets VERIFY_FAILED, which ends the script with exit 1; only 2 (unreadable) is tolerated
    assert 'if [ "$MACH_RC" -ne 0 ] && [ "$MACH_RC" -ne 2 ]; then VERIFY_FAILED=1; fi' in s
    assert re.search(r'if \[ "\$VERIFY_FAILED" -ne 0 \]; then\n.*\n  exit 1\nfi', s)


# ---- CI checks that can be required ---------------------------------------------------------------------------------------
def on_block(name):
    code = "\n".join(code_lines((WF / name).read_text()))
    m = re.search(r"^on:\n((?:[ ]+.*\n|\n)+?)(?=^\S)", code + "\n", re.M)
    assert m, f"{name}: no on: block"
    return m.group(1)


def trigger(name, key):
    """The body of one trigger in the on: block ('' for `key:` with nothing under it)."""
    block = on_block(name)
    m = re.search(rf"^  {key}:[ ]*(.*)\n((?:    .*\n|\n)*)", block, re.M)
    assert m, f"{name}: no {key} trigger"
    return m.group(1) + "\n" + m.group(2)


def job_body(name, job):
    text = "\n".join(code_lines((WF / name).read_text()))
    m = re.search(rf"^  {job}:\n(.*?)(?=^  [a-z][\w-]*:\n|\Z)", text, re.S | re.M)
    assert m, f"{name}: job {job} not found"
    return m.group(1)


NARROWING = ("paths", "paths-ignore", "branches", "branches-ignore", "types", "tags")


def narrowing(body):
    """The keys in a trigger body that narrow when it fires."""
    return [k for k in NARROWING if re.search(rf"^\s*{k}\s*:", body, re.M)]


def test_package_build_has_no_pull_request_narrowing_at_all_so_it_can_be_required():
    body = trigger("package.yml", "pull_request")
    assert narrowing(body) == [], f"pull_request narrows on {narrowing(body)}: a required check would not report on every PR\n{body}"
    assert body.strip() == "", body
    assert "workflow_dispatch" in on_block("package.yml")


def test_the_narrowing_check_catches_paths_branches_types_and_the_ignore_forms():
    """The check above is only worth having if it fails when it should."""
    for key, body in (("paths", "\n    paths: ['gridforge/**']\n"), ("branches", "\n    branches: [main]\n"), ("types", "\n    types: [opened]\n"),
                      ("paths-ignore", "\n    paths-ignore: ['docs/**']\n"), ("branches-ignore", "\n    branches-ignore: [x]\n")):
        assert narrowing(body) == [key], (key, narrowing(body))
    assert narrowing("\n") == []


def test_package_push_keeps_its_path_filter():
    assert "paths:" in trigger("package.yml", "push")


def test_package_publishes_the_checks_named_build_with_the_matrix_value():
    job = job_body("package.yml", "build")
    assert not re.search(r"^    name:", job, re.M), "a job name override would change the required check name"
    versions = re.search(r"python-version: \[([^\]]+)\]", job).group(1)
    published = [f"build ({v})" for v in re.findall(r"'(3\.\d+)'", versions)]
    assert published == ["build (3.11)", "build (3.12)", "build (3.13)"]


def test_stress_is_advisory_it_keeps_its_path_filter_and_the_header_says_not_to_require_it():
    """`stress` floats the harness's main and goes red (XPASS) on a pull request that fixes a gap the harness pins, so requiring it would
    deadlock exactly the pull requests that fix gaps. It stays path-filtered and non-required, and the header must say so."""
    body = trigger("stress-harness.yml", "pull_request")
    assert "paths:" in body and "'gridforge/**'" in body and "'examples/**'" in body and "'.github/workflows/stress-harness.yml'" in body
    on = on_block("stress-harness.yml")
    assert "workflow_dispatch:" in on and "harness_ref:" in on, "the manual run and its input must stay"
    header = "\n".join(ln for ln in (WF / "stress-harness.yml").read_text().splitlines() if ln.startswith("#"))
    assert "ADVISORY, NOT A REQUIRED CHECK" in header and "XPASS" in header and "deadlock" in header and "do not add `stress` to branch protection" in header


def test_stress_publishes_the_check_named_stress():
    job = job_body("stress-harness.yml", "stress")
    assert not re.search(r"^    name:", job, re.M)
    assert "matrix" not in job


def test_no_other_workflow_publishes_a_check_that_could_be_mistaken_for_a_required_one():
    """publish-pypi.yml also has a job id `build`, but it is manual only and has no matrix, so it publishes `build`, never `build (3.x)`."""
    assert "pull_request" not in on_block("publish-pypi.yml") and "workflow_dispatch:" in on_block("publish-pypi.yml")
    assert "matrix" not in job_body("publish-pypi.yml", "build")
    for f in sorted(WF.glob("*.yml")):
        if f.name != "stress-harness.yml":
            assert not re.search(r"^  stress:\n", "\n".join(code_lines(f.read_text())), re.M), f"{f.name} also publishes `stress`"


# ---- no dangling docs citations ----------------------------------------------------------------------------------------------
CITED = re.compile(r"docs/([A-Za-z0-9_.-]+\.md)\b")


def _cited_files():
    for d in ("scripts", ".github", "app", "lib"):
        for p in sorted((ROOT / d).rglob("*")):
            if not p.is_file() or "node_modules" in p.parts or p.suffix in {".png", ".jpg", ".ico", ".woff2", ".pdf", ".gz", ".zip"}:
                continue
            # lib/capability-registry.ts says in words that docs/07_DELIVERY_RUNBOOK.md was deleted; tests/site/capability-registry.test.ts pins that
            if p == ROOT / "lib" / "capability-registry.ts":
                continue
            try:
                yield p, p.read_text()
            except UnicodeDecodeError:
                continue


def test_every_docs_file_cited_in_scripts_workflows_and_the_site_exists():
    missing = [f"{p.relative_to(ROOT)} cites docs/{m}" for p, text in _cited_files() for m in CITED.findall(text) if not (ROOT / "docs" / m).is_file()]
    assert not missing, "cited but not in the repository (do not claim a document that is gone):\n" + "\n".join(missing)


def test_the_citation_check_actually_finds_citations():
    hits = [m for _, text in _cited_files() for m in CITED.findall(text)]
    assert hits, "the pattern matched nothing anywhere: the test above would pass vacuously"


def test_the_deploy_summary_does_not_cite_the_deleted_launch_checklist():
    assert "10_PAYG_LAUNCH_CHECKLIST" not in (ROOT / "scripts" / "deploy-engine.sh").read_text()


# ---- the facts that must stay next to the deploy summary -----------------------------------------------------------------------
def test_the_deploy_script_records_the_persisted_format_and_first_boot_facts():
    s = (ROOT / "scripts" / "deploy-engine.sh").read_text()
    assert "PERSISTED-FORMAT AND FIRST-BOOT FACTS" in s
    for needle in ("GRIDFORGE_USAGE_FILE", "GRIDFORGE_LEDGER_FILE", "GRIDFORGE_REVOKED_FILE", "GRIDFORGE_COST_FILE", "GRIDFORGE_CALIBRATION_RECORDS",
                   "GRIDFORGE_TRUSTED_PROXY_HOPS", "GRIDFORGE_TRUSTED_IP_HEADER", "GRIDFORGE_ENFORCE_SECRET_STRENGTH", "FLY_APP_NAME"):
        assert needle in s, needle
    assert s.index("PERSISTED-FORMAT AND FIRST-BOOT FACTS") < s.index("summary() {")
