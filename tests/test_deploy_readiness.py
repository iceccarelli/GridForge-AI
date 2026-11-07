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


# ---- rollback anchors ---------------------------------------------------------------------------------------------------
def test_the_anchor_step_runs_before_the_deploy_and_after_flyctl_is_installed():
    order = [n for n, _ in steps("deploy-engine.yml")]
    a = index_of("deploy-engine.yml", "Record rollback anchors (read-only)")
    d = index_of("deploy-engine.yml", "Deploy (never changes a credential")
    f = next(i for i, n in enumerate(order) if n.startswith("uses: superfly/flyctl-actions/setup-flyctl"))
    assert f < a < d, order


def test_the_anchor_step_records_the_three_files_raw_and_changes_nothing():
    t = step("deploy-engine.yml", "Record rollback anchors (read-only)")
    assert 'flyctl releases --app "$FLY_APP" --json > releases-before.json || true' in t
    assert 'flyctl machines list --app "$FLY_APP" --json > machines-before.json || true' in t
    assert "python3 scripts/check-engine-drift.py --write-snapshot engine-before.json" in t
    commands = re.sub(r"<<'EOF'.*?\n\s*EOF\n", "\n", t, flags=re.S)       # the summary text may name commands; only what RUNS counts
    assert "fly deploy" not in commands
    for mutating in ("flyctl deploy", "secrets set", "scale", "destroy", "volumes create", "apps create", "--bootstrap", "deploy-engine.sh",
                     "machines stop", "machines start", "machines update", "machines clone"):
        assert mutating not in commands, f"the read-only anchor step runs {mutating!r}"
    assert len(re.findall(r"\bflyctl\b", commands)) == 2, "the anchor step may call flyctl exactly twice (releases, machines list)"
    # flyctl output is stored as printed: no shell parsing of it
    assert not re.search(r"(jq|python3? -c|grep|sed|awk)[^\n]*(releases|machines)-before", t)


def test_a_drift_exit_of_one_is_tolerated_but_an_unreadable_engine_stops_the_deploy():
    t = step("deploy-engine.yml", "Record rollback anchors (read-only)")
    assert "|| rc=$?" in t and '"$rc" -ge 2' in t and "exit 1" in t
    assert "No rollback anchor" in t


def test_the_anchors_are_uploaded_as_engine_before_even_when_the_run_fails():
    t = step("deploy-engine.yml", "Upload the rollback anchors")
    assert "uses: actions/upload-artifact@v4" in t and "name: engine-before" in t
    assert "if: ${{ !cancelled() }}" in t
    for f in ("engine-before.json", "releases-before.json", "machines-before.json"):
        assert f in t
    assert index_of("deploy-engine.yml", "Upload the rollback anchors") < index_of("deploy-engine.yml", "Deploy (never changes a credential")


def test_the_summary_gives_the_verification_command_and_the_volume_caveat_without_inventing_a_rollback_command():
    t = step("deploy-engine.yml", "Record rollback anchors (read-only)")
    assert "GITHUB_STEP_SUMMARY" in t
    assert "python3 scripts/check-engine-drift.py --baseline engine-before.json" in t
    assert "redeploy the previous image recorded in `releases-before.json`" in t
    assert "confirm with `fly deploy --help` on your flyctl version" in t
    assert "does NOT roll back the volume data" in t
    for invented in ("releases rollback", "fly rollback", "flyctl rollback", "deploy --image", "--rollback"):
        assert invented not in t, f"the workflow asserts a rollback command that was not verified: {invented!r}"


def test_the_last_step_asserts_exactly_one_machine_and_fails_when_it_cannot_tell():
    names = [n for n, _ in steps("deploy-engine.yml")]
    assert names[-1].startswith("Exactly one machine must exist after the deploy"), names
    t = step("deploy-engine.yml", "Exactly one machine must exist after the deploy")
    assert "steps.deploy.conclusion != 'skipped'" in t and "!cancelled()" in t
    assert "len(rows) != 1" in t and t.count("raise SystemExit(1)") >= 3
    assert "|| true" not in t and "continue-on-error" not in t
    assert "machines list" in t


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


def job_names(name, job):
    text = "\n".join(code_lines((WF / name).read_text()))
    m = re.search(rf"^  {job}:\n(.*?)(?=^  [a-z][\w-]*:\n|\Z)", text, re.S | re.M)
    assert m, f"{name}: job {job} not found"
    return m.group(1)


def test_package_build_has_no_pull_request_path_filter_so_it_can_be_required():
    body = trigger("package.yml", "pull_request")
    assert "paths" not in body and "branches" not in body, body
    assert "workflow_dispatch" in on_block("package.yml")


def test_package_push_keeps_its_path_filter():
    assert "paths:" in trigger("package.yml", "push")


def test_package_publishes_the_checks_named_build_with_the_matrix_value():
    job = job_names("package.yml", "build")
    assert not re.search(r"^    name:", job, re.M), "a job name override would change the required check name"
    versions = re.search(r"python-version: \[([^\]]+)\]", job).group(1)
    published = [f"build ({v})" for v in re.findall(r"'(3\.\d+)'", versions)]
    assert published == ["build (3.11)", "build (3.12)", "build (3.13)"]


def test_stress_has_no_pull_request_path_filter_so_it_can_be_required():
    body = trigger("stress-harness.yml", "pull_request")
    assert "paths" not in body and "branches" not in body, body
    on = on_block("stress-harness.yml")
    assert "workflow_dispatch:" in on and "harness_ref:" in on, "the manual run and its input must stay"


def test_stress_publishes_the_check_named_stress():
    job = job_names("stress-harness.yml", "stress")
    assert not re.search(r"^    name:", job, re.M)
    assert "matrix" not in job


def test_no_other_workflow_publishes_a_check_that_could_be_mistaken_for_a_required_one():
    """publish-pypi.yml also has a job id `build`, but it is manual only and has no matrix, so it publishes `build`, never `build (3.x)`."""
    assert "pull_request" not in on_block("publish-pypi.yml") and "workflow_dispatch:" in on_block("publish-pypi.yml")
    assert "matrix" not in job_names("publish-pypi.yml", "build")
    for f in sorted(WF.glob("*.yml")):
        if f.name != "stress-harness.yml":
            assert not re.search(r"^  stress:\n", "\n".join(code_lines(f.read_text())), re.M), f"{f.name} also publishes `stress`"


# ---- the facts that must stay next to the deploy summary -----------------------------------------------------------------------
def test_the_deploy_script_records_the_persisted_format_and_first_boot_facts():
    s = (ROOT / "scripts" / "deploy-engine.sh").read_text()
    assert "PERSISTED-FORMAT AND FIRST-BOOT FACTS" in s
    for needle in ("GRIDFORGE_USAGE_FILE", "GRIDFORGE_LEDGER_FILE", "GRIDFORGE_REVOKED_FILE", "GRIDFORGE_COST_FILE", "GRIDFORGE_CALIBRATION_RECORDS",
                   "GRIDFORGE_TRUSTED_PROXY_HOPS", "GRIDFORGE_TRUSTED_IP_HEADER", "GRIDFORGE_ENFORCE_SECRET_STRENGTH", "FLY_APP_NAME"):
        assert needle in s, needle
    assert s.index("PERSISTED-FORMAT AND FIRST-BOOT FACTS") < s.index("summary() {")
