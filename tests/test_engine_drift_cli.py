"""scripts/check-engine-drift.py output and options: grouping, --json, --write-snapshot, --summary-file, and the tool-name check.

Offline: either an injected `fetch` or a stub HTTP server on 127.0.0.1. Nothing here touches the real engine.
"""
import http.server
import importlib.util
import json
import re
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from gridforge.api.metering import UNIT_COST
from gridforge.api.server import ROUTES, VERSION
from gridforge.api.tools import catalogue
from gridforge.provenance import code_sha256

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check-engine-drift.py"
spec = importlib.util.spec_from_file_location("check_engine_drift_cli", SCRIPT)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def current():
    return {"version": VERSION, "endpoints": sorted(ROUTES) + ["/health"], "unit_rates": dict(UNIT_COST),
            "provenance": {"code_sha256": code_sha256()}, "metering": {"durable": True, "ledger_durable": True}}


def fetcher(version, tools=None, tools_error=None):
    def fetch(url):
        if url.endswith("/v1/version"):
            if isinstance(version, Exception):
                raise version
            return version
        if url.endswith("/v1/tools"):
            if tools_error:
                raise tools_error
            return tools if tools is not None else catalogue()
        raise AssertionError(url)
    return fetch


def run_main(argv, version, capsys, **kw):
    rc = mod.main(["http://engine.test", *argv], fetch=fetcher(version, **kw))
    return rc, capsys.readouterr().out


# ---- grouping ------------------------------------------------------------------------------------------------------
def stale():
    d = current()
    d["endpoints"] = [e for e in d["endpoints"] if e not in ("/v1/compare", "/v1/revoke")]
    d["unit_rates"] = {k: v for k, v in d["unit_rates"].items() if k != "/v1/compare"}
    d["unit_rates"]["/v1/study"] = 99
    d["version"] = "0.0.1"
    del d["provenance"]
    d["metering"] = {"durable": True}
    return d


def test_every_difference_lands_in_its_group():
    g = mod.drift_grouped(stale())
    assert any("/v1/compare" in p for p in g["routes"]) and any("/v1/revoke" in p for p in g["routes"])
    assert any("/v1/study" in p for p in g["unit_rates"])
    assert g["version"] and "0.0.1" in g["version"][0]
    assert g["provenance"] and "no code digest" in g["provenance"][0]
    assert g["ledger"] and "predates the usage ledger" in g["ledger"][0]


def test_the_flat_list_is_exactly_the_grouped_differences():
    g = mod.drift_grouped(stale())
    assert sorted(mod.drift(stale())) == sorted(p for v in g.values() for p in v)


def test_text_output_groups_and_names_the_operator_step(capsys):
    rc, out = run_main([], stale(), capsys)
    assert rc == 1
    for heading in ("Missing routes (", "Unit rates (", "Version (", "Provenance (code digest) (", "Usage ledger ("):
        assert heading in out, out
    assert "deploy-engine" in out and "FLY_API_TOKEN" in out and "bash scripts/deploy-engine.sh" in out


def test_a_clean_engine_prints_the_success_line_and_exits_zero(capsys):
    rc, out = run_main([], current(), capsys)
    assert rc == 0 and "no drift. Compared: routes, unit rates, version, usage ledger, tool names and code digest" in out
    assert "DRIFT" not in out and f"repo {code_sha256()[:12]}, deployed {code_sha256()[:12]} (same)" in out


# ---- --json --------------------------------------------------------------------------------------------------------
def test_json_output_is_machine_readable_and_complete(capsys):
    rc, out = run_main(["--json"], stale(), capsys)
    doc = json.loads(out)
    assert rc == 1 and doc["ok"] is False
    assert set(doc["differences"]) == {"routes", "unit_rates", "version", "provenance", "ledger"}
    assert doc["count"] == sum(len(v) for v in doc["differences"].values())
    assert "deploy-engine" in doc["operator_step"] and doc["base"] == "http://engine.test"


def test_json_output_for_a_clean_engine(capsys):
    rc, out = run_main(["--json"], current(), capsys)
    doc = json.loads(out)
    assert rc == 0 and doc["ok"] is True and doc["count"] == 0 and doc["differences"] == {} and doc["operator_step"] is None


# ---- --write-snapshot ----------------------------------------------------------------------------------------------
def test_snapshot_is_a_plain_object_with_the_documented_keys(tmp_path, capsys):
    path = tmp_path / "nested" / "engine-deployed.json"
    rc, _ = run_main(["--write-snapshot", str(path)], current(), capsys)
    assert rc == 0
    snap = json.loads(path.read_text())
    assert set(snap) == {"fetched_at", "base", "version", "endpoints", "unit_rates", "code_sha256"}
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", snap["fetched_at"])
    assert snap["base"] == "http://engine.test" and snap["version"] == VERSION
    assert snap["endpoints"] == sorted(snap["endpoints"]) and all(isinstance(e, str) for e in snap["endpoints"])
    assert snap["unit_rates"] == dict(UNIT_COST) and snap["code_sha256"] == code_sha256()
    assert not list(path.parent.glob("*.tmp")), "the atomic write must not leave a temp file"


def test_snapshot_records_what_is_deployed_even_when_it_has_drifted(tmp_path, capsys):
    path = tmp_path / "s.json"
    rc, _ = run_main(["--write-snapshot", str(path)], stale(), capsys)
    snap = json.loads(path.read_text())
    assert rc == 1, "writing a snapshot must never turn drift into success"
    assert "/v1/compare" not in snap["endpoints"] and snap["code_sha256"] is None and snap["version"] == "0.0.1"


def test_no_snapshot_is_written_when_the_engine_cannot_be_read(tmp_path, capsys):
    path = tmp_path / "s.json"
    rc, out = run_main(["--write-snapshot", str(path)], OSError("connection refused"), capsys)
    assert rc == 2 and not path.exists() and "Nothing was verified" in out


def test_an_unreadable_engine_is_never_reported_as_no_drift(capsys):
    rc, out = run_main(["--json"], ValueError("boom"), capsys)
    doc = json.loads(out)
    assert rc == 2 and doc["ok"] is False and "could not read" in doc["error"]


# ---- --summary-file ------------------------------------------------------------------------------------------------
def test_summary_file_lists_the_differences_and_the_one_operator_action(tmp_path, capsys):
    path = tmp_path / "summary.md"
    path.write_text("earlier step\n")
    rc, _ = run_main(["--summary-file", str(path)], stale(), capsys)
    text = path.read_text()
    assert rc == 1 and text.startswith("earlier step\n"), "must append, never overwrite"
    assert "Missing routes" in text and "/v1/compare" in text and "The one operator action" in text
    assert "deploy-engine" in text and "FLY_API_TOKEN" in text


def test_summary_file_for_a_clean_engine(tmp_path, capsys):
    path = tmp_path / "summary.md"
    run_main(["--summary-file", str(path)], current(), capsys)
    assert "Engine drift: none" in path.read_text()


# ---- /v1/tools names -----------------------------------------------------------------------------------------------
def test_matching_tool_names_are_not_drift():
    assert mod.drift(current(), catalogue()) == []


def test_a_renamed_tool_on_a_served_route_is_drift():
    cat = json.loads(json.dumps(catalogue()))
    for t in cat["tools"]:
        if t["endpoint"] == "/v1/screen":
            t["name"] = "gridforge_screen_old"
    out = mod.drift_grouped(current(), cat)["tools"]
    assert len(out) == 1 and "/v1/screen" in out[0] and "gridforge_screen_old" in out[0]


def test_a_served_route_missing_from_v1_tools_is_drift():
    cat = json.loads(json.dumps(catalogue()))
    cat["tools"] = [t for t in cat["tools"] if t["endpoint"] != "/v1/study"]
    out = mod.drift_grouped(current(), cat)["tools"]
    assert any("/v1/study" in p and "does not list it" in p for p in out)


def test_a_tool_the_repository_does_not_declare_is_drift():
    cat = json.loads(json.dumps(catalogue()))
    cat["tools"].append({"name": "gridforge_mystery", "endpoint": "/v1/screen-extra"})
    d = current()
    d["endpoints"] = d["endpoints"] + ["/v1/screen-extra"]
    out = mod.drift_grouped(d, cat)["tools"]
    assert any("gridforge_mystery" in p for p in out)


def test_routes_the_engine_does_not_serve_are_reported_once_as_routes_not_as_tools():
    d = current()
    d["endpoints"] = [e for e in d["endpoints"] if e != "/v1/compare"]
    cat = json.loads(json.dumps(catalogue()))
    cat["tools"] = [t for t in cat["tools"] if t["endpoint"] != "/v1/compare"]  # an old engine does not list the tool either
    g = mod.drift_grouped(d, cat)
    assert g["tools"] == [] and any("/v1/compare" in p for p in g["routes"])


def test_a_malformed_tools_document_is_drift_not_a_crash():
    assert mod.drift_grouped(current(), {"nope": 1})["tools"]


def test_an_unreadable_v1_tools_is_reported_as_a_tools_difference(capsys):
    rc, out = run_main(["--json"], current(), capsys, tools_error=OSError("503"))
    doc = json.loads(out)
    assert rc == 1 and any("could not read" in p for p in doc["differences"]["tools"])


def test_tools_json_in_the_repository_matches_the_engines_own_catalogue():
    """The committed file the website reads and the engine's /v1/tools must agree, or this check would fail on a current engine."""
    assert mod.repo_tool_names() == {t["endpoint"]: t["name"] for t in catalogue()["tools"]}


# ---- end to end, over HTTP ----------------------------------------------------------------------------------------------
def serve(version, tools):
    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            body = {"/v1/version": version, "/v1/tools": tools}.get(self.path)
            self.send_response(200 if body is not None else 404)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps(body if body is not None else {"error": "not found"}).encode())

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


def cli(*args):
    return subprocess.run([sys.executable, str(SCRIPT), *args], capture_output=True, text=True, cwd=ROOT)


def test_cli_over_http_clean_and_drifted(tmp_path):
    srv, url = serve(current(), catalogue())
    try:
        ok = cli(url, "--write-snapshot", str(tmp_path / "s.json"))
    finally:
        srv.shutdown()
    assert ok.returncode == 0, ok.stdout + ok.stderr
    assert json.loads((tmp_path / "s.json").read_text())["base"] == url
    srv, url = serve(stale(), catalogue())
    try:
        bad = cli(url, "--json")
    finally:
        srv.shutdown()
    assert bad.returncode == 1 and json.loads(bad.stdout)["ok"] is False


def test_cli_exits_two_when_nothing_listens():
    r = cli("http://127.0.0.1:9", "--json")
    assert r.returncode == 2 and json.loads(r.stdout)["ok"] is False


def test_cli_rejects_unknown_options():
    r = cli("--nope")
    assert r.returncode == 2 and "unknown option" in r.stderr




# ---- the workflows themselves (text checks: CI installs pytest only, so no YAML parser is assumed) -------------------
WF = ROOT / ".github" / "workflows"


def wf_text(name):
    text = (WF / name).read_text()
    assert "\t" not in text, "tabs are not valid YAML indentation"
    return text


def code_lines(text):
    return [ln for ln in text.splitlines() if not ln.lstrip().startswith("#")]


def test_deploy_workflow_is_manual_only_confirmed_serialised_and_gated():
    text = wf_text("deploy-engine.yml")
    code = "\n".join(code_lines(text))
    triggers = re.search(r"^on:\n((?:[ ]+.*\n|\n)+?)(?=^\S)", code + "\n", re.M).group(1)
    assert "workflow_dispatch:" in triggers
    for forbidden in ("push:", "pull_request", "schedule:", "workflow_run", "repository_dispatch"):
        assert forbidden not in triggers, f"a deploy must never be triggered by {forbidden}"
    assert re.search(r"confirm:\n(?:\s+.*\n)*?\s+required: true", code), "the confirm input is required"
    assert re.search(r"concurrency:\n\s+group: deploy-engine\n\s+cancel-in-progress: false", code)
    assert "environment: production-engine" in code
    assert "continue-on-error" not in code, "a failed deploy or remaining drift must fail the job"
    assert "--bootstrap" not in code and "scale" not in code and "--ha=true" not in code
    assert "workflow_dispatch" in code and "name: deploy-engine" in code


def test_deploy_workflow_step_order_and_credential_preflight():
    code = "\n".join(code_lines(wf_text("deploy-engine.yml")))
    at = {k: code.index(k) for k in ("CONFIRM", "actions/checkout", "pytest", "setup-flyctl", "bash scripts/deploy-engine.sh",
                                     "scripts/check-engine-drift.py")}
    assert at["CONFIRM"] < at["actions/checkout"] < at["pytest"] < at["setup-flyctl"] < at["bash scripts/deploy-engine.sh"] \
        < at["scripts/check-engine-drift.py"], at
    preflight = code[:at["actions/checkout"]]
    assert '"DEPLOY"' in preflight and "exit 1" in preflight
    assert "Add repository secret FLY_API_TOKEN (fly tokens create deploy -a gridforge-engine)" in preflight
    assert "FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}" in preflight
    assert not re.search(r"echo[^\n]*\$\{?FLY_API_TOKEN", code), "the token must never be printed"


def test_flyctl_is_installed_by_the_official_action_and_its_version_is_recorded():
    # Not pinned on purpose: neither the action tag nor a flyctl version could be verified when this was written, and a pin that does
    # not exist fails the first real deploy. The version used is printed so the operator can pin it after a successful run.
    code = "\n".join(code_lines(wf_text("deploy-engine.yml")))
    assert "uses: superfly/flyctl-actions/setup-flyctl@" in code
    assert code.index("setup-flyctl") < code.index("flyctl version") < code.index("scripts/deploy-engine.sh")


def test_the_token_is_only_ever_assigned_to_an_env_var():
    for name in ("deploy-engine.yml", "engine-drift.yml"):
        for line in code_lines(wf_text(name)):
            if "secrets.FLY_API_TOKEN" in line:
                assert line.strip().startswith("FLY_API_TOKEN:"), f"{name}: interpolating a secret into a command leaks it: {line}"


def test_drift_workflow_fails_on_drift_summarises_and_opens_nothing():
    code = "\n".join(code_lines(wf_text("engine-drift.yml")))
    assert "continue-on-error" not in code
    assert re.search(r"permissions:\n\s+contents: read\n", code), "read-only: it must not be able to open issues or comments"
    assert 'check-engine-drift.py --summary-file "$GITHUB_STEP_SUMMARY"' in code
    assert "gh issue" not in code and "issues:" not in code and "gh pr" not in code
    for trigger in ("push:", "schedule:", "workflow_dispatch:"):
        assert trigger in code



# ---- local and CI must agree: same script, same digest, same endpoint, and a mismatch is never a pass -------------------------------------
STALE_DIGEST = "137777ef547ad9bf84d290a0d1002cb578b6add529c40c717077c5fcb7135918"   # the pre-#100 engine tree, as the CI run saw it


def clean_tree():
    return ("clean", [])


def test_a_deployed_engine_with_an_older_code_digest_is_never_reported_as_no_drift(capsys):
    """The routes, unit rates, version, ledger and tool names all match; only the code digest differs. Health and a 200 are not provenance."""
    old = current()
    old["provenance"] = {"code_sha256": STALE_DIGEST}
    rc = mod.main(["http://engine.test"], fetch=fetcher(old), tree=clean_tree)
    out = capsys.readouterr().out
    assert rc == 1 and "no drift" not in out and "DRIFT" in out
    assert f"deployed {STALE_DIGEST[:12]}" in out and f"repo {code_sha256()[:12]}" in out and "(DIFFERENT)" in out
    assert "different tree than this repository" in out


def test_the_json_result_carries_both_digests_so_two_runs_can_be_compared(capsys):
    old = current()
    old["provenance"] = {"code_sha256": STALE_DIGEST}
    rc = mod.main(["--json", "http://engine.test"], fetch=fetcher(old), tree=clean_tree)
    doc = json.loads(capsys.readouterr().out)
    assert rc == 1 and doc["ok"] is False
    assert doc["repo_code_sha256"] == code_sha256() and doc["deployed_code_sha256"] == STALE_DIGEST and doc["tree"] == "clean"


def test_local_and_ci_run_the_same_script_the_same_digest_and_the_same_default_endpoint():
    workflow = (ROOT / ".github" / "workflows" / "engine-drift.yml").read_text()
    assert "python3 scripts/check-engine-drift.py" in workflow
    assert "GRIDFORGE_API_URL" not in workflow, "CI must not point the check at a different engine than a local run uses by default"
    assert "--require-clean-tree" not in workflow  # CI checks out a clean tree; the flag exists for local runs
    assert mod.code_sha256 is code_sha256, "the script must use the product's own digest function, not a copy"
    assert mod.DEFAULT_BASE == "https://gridforge-engine.fly.dev"
    # the step that CI runs must not be able to skip the digest comparison
    live_lines = [ln for ln in workflow.split("jobs:")[1].splitlines() if not ln.lstrip().startswith("#")]
    assert not [ln for ln in live_lines if "continue-on-error" in ln or "|| true" in ln or "|| :" in ln]


def test_a_base_url_from_the_environment_is_named_so_a_local_run_cannot_pass_against_a_different_engine(monkeypatch, capsys):
    monkeypatch.setenv("GRIDFORGE_API_URL", "http://staging.example")
    rc = mod.main([], fetch=fetcher(current()), tree=clean_tree)
    cap = capsys.readouterr()
    assert rc == 0 and cap.out.startswith("http://staging.example: no drift")
    assert "base URL taken from GRIDFORGE_API_URL (http://staging.example); CI checks https://gridforge-engine.fly.dev" in cap.err


def test_the_default_endpoint_is_used_when_the_environment_is_unset(monkeypatch, capsys):
    monkeypatch.delenv("GRIDFORGE_API_URL", raising=False)
    seen = []

    def fetch(url):
        seen.append(url)
        return fetcher(current())(url)

    mod.main([], fetch=fetch, tree=clean_tree)
    assert seen[0] == "https://gridforge-engine.fly.dev/v1/version"
    assert "note: base URL" not in capsys.readouterr().err


def test_a_dirty_tree_is_reported_in_text_and_json_without_changing_the_verdict(capsys):
    dirty = lambda: ("dirty", ["gridforge/intake/loader.py"])  # noqa: E731
    rc = mod.main(["http://engine.test"], fetch=fetcher(current()), tree=dirty)
    out = capsys.readouterr().out
    assert rc == 0 and "working tree under gridforge/: dirty" in out and "gridforge/intake/loader.py" in out
    assert "CI hashes the committed tree" in out
    rc = mod.main(["--json", "http://engine.test"], fetch=fetcher(current()), tree=dirty)
    assert json.loads(capsys.readouterr().out)["tree"] == "dirty" and rc == 0


@pytest.mark.parametrize("state", [("dirty", ["gridforge/x.py"]), ("unknown", [])])
def test_require_clean_tree_refuses_to_verify_a_tree_that_is_not_a_commit(state, capsys):
    called = []
    rc = mod.main(["--require-clean-tree", "http://engine.test"], fetch=lambda u: called.append(u), tree=lambda: state)
    out = capsys.readouterr().out
    assert rc == 2 and "Nothing was verified" in out and not called, "it must not even contact the engine"


def test_require_clean_tree_passes_through_on_a_clean_tree(capsys):
    assert mod.main(["--require-clean-tree", "http://engine.test"], fetch=fetcher(current()), tree=clean_tree) == 0


def test_tree_state_sees_an_uncommitted_file_under_the_package(tmp_path):
    def git(*a):
        subprocess.run(["git", "-C", str(tmp_path), *a], check=True, capture_output=True,
                       env={"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
                            "PATH": __import__("os").environ["PATH"], "HOME": str(tmp_path)})
    git("init", "-q")
    (tmp_path / "gridforge").mkdir()
    (tmp_path / "gridforge" / "a.py").write_text("x = 1\n")
    git("add", ".")
    git("commit", "-q", "-m", "init")
    assert mod.tree_state(tmp_path) == ("clean", [])
    (tmp_path / "gridforge" / "a.py").write_text("x = 2\n")
    (tmp_path / "gridforge" / "new.py").write_text("y = 1\n")
    state, changed = mod.tree_state(tmp_path)
    assert state == "dirty" and sorted(changed) == ["gridforge/a.py", "gridforge/new.py"]
    assert mod.tree_state(tmp_path / "does-not-exist")[0] == "unknown"
