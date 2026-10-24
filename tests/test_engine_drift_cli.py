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
    assert rc == 0 and "serves every route and unit rate" in out and "DRIFT" not in out


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
