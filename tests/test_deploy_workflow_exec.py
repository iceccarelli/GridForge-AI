"""The deploy workflow's rollback-anchor and one-machine steps, EXECUTED.

A text check that a step "mentions" or "does not mention" a command proves nothing about what it does (a green step can be meaningless, and
a denylist misses the next mutation). So these tests pull the `run:` blocks out of .github/workflows/deploy-engine.yml and run them with bash
exactly as the runner would (`bash -e`), against

  * a stub `flyctl` first on PATH that appends every argument list to calls.log and prints fixture files (no network, no account), and
  * a stub engine on 127.0.0.1 that the real scripts/check-engine-drift.py reads (GRIDFORGE_API_URL points at it),

then assert exit codes, the files written, what the summary says, and that calls.log holds exactly the read calls and nothing else. No
YAML parser is used (CI installs pytest only): the step layout is fixed, and the extractor fails loudly if it ever changes.
"""
import json
import os
import re
import shutil
import socket
import stat
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

from gridforge.api.metering import UNIT_COST
from gridforge.api.server import ROUTES, VERSION
from gridforge.api.tools import catalogue
from gridforge.provenance import code_sha256

ROOT = Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / ".github" / "workflows" / "deploy-engine.yml"
PINNED = "73e35ca725d045c6c8328e97bcc761c919c9869ed0eedb05a25544ddd224626c"
APP = "test-engine"
READS = [f"releases --app {APP} --json", f"machines list --app {APP} --json"]

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="bash is required")


# ---- extracting a step's run block ----------------------------------------------------------------------------------------
def run_block(step_name: str) -> str:
    lines = WORKFLOW.read_text().splitlines()
    starts = [i for i, ln in enumerate(lines) if re.match(r"^      - name: ", ln)]
    mine = [i for i in starts if lines[i].startswith(f"      - name: {step_name}")]
    assert len(mine) == 1, f"want exactly one step named {step_name!r}, found {len(mine)}"
    i = mine[0]
    end = next((s for s in starts if s > i), len(lines))
    body = lines[i:end]
    at = next((k for k, ln in enumerate(body) if ln == "        run: |"), None)
    assert at is not None, f"{step_name}: no `run: |` block"
    out = []
    for ln in body[at + 1:]:
        if ln.strip() and not ln.startswith(" " * 10):
            break
        out.append(ln[10:] if ln.strip() else "")
    text = "\n".join(out) + "\n"
    assert "${{" not in text, "a run block must not interpolate expressions (they go through env:)"
    return text


READ_STEP = "Read Fly state for the rollback anchors (read-only)"
ANCHOR_STEP = "Record rollback anchors (read-only)"
FINAL_STEP = "Exactly one machine must exist after the deploy"


# ---- the stubs ------------------------------------------------------------------------------------------------------------
FLYCTL = r"""#!/usr/bin/env bash
echo "$*" >> "$CALLS_LOG"
case "$1 $2" in
  "releases --app")     cat "$FAKE_RELEASES" 2>/dev/null; exit "${FAKE_FLY_RC:-0}" ;;
  "machines list")      cat "$FAKE_MACHINES" 2>/dev/null; exit "${FAKE_FLY_RC:-0}" ;;
esac
exit 0
"""


def current_reply(**over):
    d = {"version": VERSION, "endpoints": sorted(ROUTES) + ["/health"], "unit_rates": dict(UNIT_COST),
         "provenance": {"code_sha256": code_sha256()}, "metering": {"durable": True, "ledger_durable": True}}
    d.update(over)
    return d


class Engine:
    """A 127.0.0.1 stub of /v1/version and /v1/tools. `reply` is raw bytes, or None for a port nothing listens on."""

    def __init__(self, reply):
        self.reply = reply
        self.srv = None
        if reply is None:
            s = socket.socket()
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
            s.close()
            return
        outer = self

        class H(BaseHTTPRequestHandler):
            def do_GET(self):
                body = outer.reply if self.path == "/v1/version" else json.dumps(catalogue()).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.port = self.srv.server_address[1]
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"

    def close(self):
        if self.srv:
            self.srv.shutdown()


MACHINE = {"id": "m1", "region": "ams", "state": "started", "private_ip": "fdaa:0:1::2",
           "config": {"image": "registry.fly.io/test-engine:deployment-01", "env": {"GRIDFORGE_SECRET_THING": "hunter2"},
                      "mounts": [{"volume": "vol_abc", "path": "/data"}]},
           "image_ref": {"registry": "registry.fly.io", "repository": "test-engine", "tag": "deployment-01", "digest": "sha256:feed"},
           "events": [{"source": "user", "request": {"exit_event": {"requested_by": "someone@example.com"}}}]}
RELEASES = [{"Version": 7, "ImageRef": "registry.fly.io/test-engine:deployment-01", "Status": "complete", "User": {"Email": "someone@example.com"}}]


def machines(n):
    return json.dumps([{**MACHINE, "id": f"m{i}"} for i in range(n)])


class Flow:
    def __init__(self, tmp_path, *, engine, releases=json.dumps(RELEASES), machines_out=machines(1), allow=False, extra_env=None,
                 scripts_dir=None, anchor_text=None):
        self.dir = tmp_path / "ws"
        self.dir.mkdir()
        bin_dir = tmp_path / "bin"
        bin_dir.mkdir()
        fly = bin_dir / "flyctl"
        fly.write_text(FLYCTL)
        fly.chmod(fly.stat().st_mode | stat.S_IEXEC)
        (tmp_path / "releases.in").write_text(releases)
        (tmp_path / "machines.in").write_text(machines_out)
        if scripts_dir is None:
            (self.dir / "scripts").symlink_to(ROOT / "scripts")
        else:
            shutil.copytree(scripts_dir, self.dir / "scripts")
        self.engine = engine
        self.summary = tmp_path / "summary.md"
        self.calls = tmp_path / "calls.log"
        self.env = {
            "PATH": f"{bin_dir}:{os.environ['PATH']}", "HOME": str(tmp_path), "FLY_APP": APP,
            "CALLS_LOG": str(self.calls), "FAKE_RELEASES": str(tmp_path / "releases.in"), "FAKE_MACHINES": str(tmp_path / "machines.in"),
            "GRIDFORGE_API_URL": engine.url, "ALLOW_NO_BASELINE": "true" if allow else "false",
            "GITHUB_STEP_SUMMARY": str(self.summary), "GITHUB_RUN_ID": "42", "GITHUB_RUN_ATTEMPT": "2",
            "NO_PROXY": "127.0.0.1", "no_proxy": "127.0.0.1", "PYTHONDONTWRITEBYTECODE": "1", **(extra_env or {}),
        }
        assert shutil.which("flyctl", path=self.env["PATH"]) == str(fly), "PATH would not resolve flyctl to the stub"
        self.anchor_text = anchor_text

    def bash(self, script_text, token=False):
        env = dict(self.env)
        if token:
            env["FLY_API_TOKEN"] = "fo1_NotARealToken"
        return subprocess.run(["bash", "-e", "-c", script_text], cwd=self.dir, env=env, capture_output=True, text=True)

    def anchors(self):
        """The two steps, in workflow order. (read result, anchor result)."""
        reads = self.bash(run_block(READ_STEP), token=True)
        anchor = self.bash(self.anchor_text or run_block(ANCHOR_STEP))
        return reads, anchor

    def final(self):
        return self.bash(run_block(FINAL_STEP), token=True)

    def logged(self):
        return self.calls.read_text().splitlines() if self.calls.exists() else []

    def json_file(self, name):
        return json.loads((self.dir / name).read_text())

    def summary_text(self):
        return self.summary.read_text() if self.summary.exists() else ""


@pytest.fixture
def engines():
    made = []

    def make(reply):
        e = Engine(reply if reply is None or isinstance(reply, bytes) else json.dumps(reply).encode())
        made.append(e)
        return e
    yield make
    for e in made:
        e.close()


def assert_exactly_the_two_reads(flow):
    assert flow.logged() == READS, f"flyctl was called with something other than the two read calls: {flow.logged()}"


# ---- the happy path -------------------------------------------------------------------------------------------------------
def test_a_good_baseline_passes_writes_both_files_and_makes_only_the_two_read_calls(tmp_path, engines):
    f = Flow(tmp_path, engine=engines(current_reply(version="0.8.0")))      # differs from the repository: expected, that is why we deploy
    reads, anchor = f.anchors()
    assert reads.returncode == 0 and anchor.returncode == 0, reads.stderr + anchor.stdout + anchor.stderr
    assert_exactly_the_two_reads(f)
    snap = f.json_file("engine-before.json")
    assert snap["version"] == "0.8.0" and snap["endpoints"] and snap["code_sha256"] == code_sha256() and "unreadable" not in snap
    assert (f.dir / "releases-before.json").read_text() == json.dumps(RELEASES) + "", "the raw flyctl output must be stored as printed"
    assert (f.dir / "machines-before.json").read_text() == machines(1)
    summary = f.summary_text()
    assert "python3 scripts/check-engine-drift.py --baseline engine-before.json" in summary
    assert "does NOT roll back the volume data" in summary
    assert "engine-before-42-2" in summary, "the artifact name carries the run id and attempt"
    assert f"live digest == {PINNED} (the digest of 79a83d5): no" in summary
    assert "engine-before.json` alone cannot restore anything" in summary
    assert summary.index("start from the image reference") < summary.index("--baseline"), "the image reference comes first"
    assert "confirm with `fly deploy --help` on your flyctl version" in summary
    for invented in ("rollback", "releases rollback"):
        assert "flyctl " + invented not in summary and "fly " + invented not in summary
    assert "allow_no_baseline" not in summary, "nothing about the override when it was not set"


def test_the_summary_says_yes_when_the_live_digest_is_the_pinned_one(tmp_path, engines):
    f = Flow(tmp_path, engine=engines(current_reply(provenance={"code_sha256": PINNED})))
    _, anchor = f.anchors()
    assert anchor.returncode == 0
    assert f"live digest == {PINNED} (the digest of 79a83d5): yes" in f.summary_text()


def test_anchors_json_is_a_whitelist_and_leaks_nothing_from_the_raw_output(tmp_path, engines):
    f = Flow(tmp_path, engine=engines(current_reply()))
    _, anchor = f.anchors()
    assert anchor.returncode == 0
    a = f.json_file("anchors.json")
    assert a["machine_count"] == 1 and len(a["machines"]) == 1 and a["releases"] == [
        {"version": 7, "image_ref": "registry.fly.io/test-engine:deployment-01"}]
    m = a["machines"][0]
    assert m == {"id": "m0", "region": "ams", "state": "started", "image": "registry.fly.io/test-engine:deployment-01",
                 "image_ref": {"registry": "registry.fly.io", "repository": "test-engine", "tag": "deployment-01", "digest": "sha256:feed"},
                 "mounts": 1, "volume_ids": ["vol_abc"]}
    blob = (f.dir / "anchors.json").read_text()
    for private in ("hunter2", "GRIDFORGE_SECRET_THING", "someone@example.com", "fdaa:0:1::2", "fo1_NotARealToken", "Email", "private_ip"):
        assert private not in blob, f"anchors.json carries {private!r}"


def test_the_token_is_present_for_the_reads_and_absent_from_the_anchor_step(tmp_path, engines):
    read, anchor = run_block(READ_STEP), run_block(ANCHOR_STEP)
    assert "FLY_API_TOKEN" not in anchor and not re.search(r"^\s*(flyctl|fly)\s", anchor, re.M), "the anchor step must not call flyctl"
    text = WORKFLOW.read_text()
    reads_step = text[text.index(f"- name: {READ_STEP}"):text.index(f"- name: {ANCHOR_STEP}")]
    anchor_step = text[text.index(f"- name: {ANCHOR_STEP}"):text.index("- name: Upload the rollback anchors")]
    assert "FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}" in reads_step and "FLY_API_TOKEN" not in anchor_step
    assert read.count("flyctl ") == 2


# ---- the engine cannot be read, or answers with nothing useful ----------------------------------------------------------------
DEGENERATE = {
    "empty object": {},
    "no endpoints": current_reply(endpoints=[]),
    "empty version": current_reply(version=""),
    "null version": current_reply(version=None),
    "no digest": current_reply(provenance={}),
    "null digest": current_reply(provenance={"code_sha256": None}),
}


@pytest.mark.parametrize("label", sorted(DEGENERATE))
def test_a_degenerate_engine_reply_stops_the_run_before_the_deploy(tmp_path, engines, label):
    f = Flow(tmp_path, engine=engines(DEGENERATE[label]))
    _, anchor = f.anchors()
    assert anchor.returncode == 1, anchor.stdout + anchor.stderr
    assert "::error title=No usable rollback baseline::" in anchor.stdout and "Nothing was deployed" in anchor.stdout
    assert "Stopped before the deploy" in f.summary_text()
    assert_exactly_the_two_reads(f)


@pytest.mark.parametrize("label", sorted(DEGENERATE))
def test_a_degenerate_engine_reply_with_the_override_records_unreadable_and_warns(tmp_path, engines, label):
    f = Flow(tmp_path, engine=engines(DEGENERATE[label]), allow=True)
    _, anchor = f.anchors()
    assert anchor.returncode == 0, anchor.stdout + anchor.stderr
    assert "::warning title=Deploying WITHOUT a rollback baseline::" in anchor.stdout
    snap = f.json_file("engine-before.json")
    assert snap["unreadable"] is True and snap["reason"] and "version" not in snap
    summary = f.summary_text()
    assert "`allow_no_baseline` was set" in summary and "WITHOUT a verified baseline" in summary
    assert "does not skip the" in summary and "`confirm == DEPLOY` gate" in summary and "one-machine check after the deploy" in summary
    assert f"live digest == {PINNED} (the digest of 79a83d5): no (no usable baseline" in summary
    assert_exactly_the_two_reads(f)


def test_an_unreachable_engine_fails_and_passes_only_with_the_override(tmp_path, engines):
    f = Flow(tmp_path, engine=engines(None))
    _, anchor = f.anchors()
    assert anchor.returncode == 1 and "could not be read" in anchor.stdout
    assert not (f.dir / "engine-before.json").exists()
    (tmp_path / "second").mkdir()
    g = Flow(tmp_path / "second", engine=engines(None), allow=True)
    _, anchor = g.anchors()
    assert anchor.returncode == 0 and g.json_file("engine-before.json")["unreadable"] is True
    assert "::warning" in anchor.stdout


def test_a_baseline_marked_unreadable_is_refused_by_the_baseline_check(tmp_path, engines):
    f = Flow(tmp_path, engine=engines(None), allow=True)
    f.anchors()
    r = subprocess.run(["python3", "-B", str(ROOT / "scripts" / "check-engine-drift.py"), f.engine.url, "--baseline", "engine-before.json"],
                       cwd=f.dir, capture_output=True, text=True, env={**f.env})
    assert r.returncode == 2 and "there is no baseline to compare with" in r.stdout


# ---- guards in the step itself, reachable only with a drift script the real engine would not produce ----------------------------
def fake_drift(tmp_path, body):
    d = tmp_path / "fakescripts"
    d.mkdir()
    (d / "check-engine-drift.py").write_text(body)
    return d


def test_exit_two_from_the_drift_check_is_fatal_even_when_a_snapshot_file_is_lying_around(tmp_path, engines):
    fake = fake_drift(tmp_path, "import sys\nopen('engine-before.json','w').write('{\"version\":\"x\",\"endpoints\":[\"/a\"],\"code_sha256\":\"abc\"}')\nsys.exit(2)\n")
    f = Flow(tmp_path, engine=engines(current_reply()), scripts_dir=fake)
    _, anchor = f.anchors()
    assert anchor.returncode == 1 and "the drift check exited 2" in anchor.stdout, anchor.stdout + anchor.stderr


def test_an_empty_snapshot_file_is_fatal_even_when_the_drift_check_exits_one(tmp_path, engines):
    fake = fake_drift(tmp_path, "import sys\nopen('engine-before.json','w').write('')\nsys.exit(1)\n")
    f = Flow(tmp_path, engine=engines(current_reply()), scripts_dir=fake)
    _, anchor = f.anchors()
    assert anchor.returncode == 1 and "wrote no snapshot" in anchor.stdout, anchor.stdout + anchor.stderr


def test_a_garbage_snapshot_file_is_fatal(tmp_path, engines):
    fake = fake_drift(tmp_path, "import sys\nopen('engine-before.json','w').write('<html>502</html>')\nsys.exit(1)\n")
    f = Flow(tmp_path, engine=engines(current_reply()), scripts_dir=fake)
    _, anchor = f.anchors()
    assert anchor.returncode == 1 and "not JSON" in anchor.stdout


# ---- flyctl output that is empty or unusable --------------------------------------------------------------------------------------
@pytest.mark.parametrize("which, value", [("releases", ""), ("releases", "   \n"), ("releases", "not json at all"), ("releases", "{"),
                                          ("releases", "null"), ("releases", "[]"), ("releases", '{"releases": []}'), ("releases", '"x"'),
                                          ("machines_out", ""), ("machines_out", "oops"), ("machines_out", "null"), ("machines_out", '"a string"'),
                                          ("machines_out", '{"error": "app not found"}')])
def test_empty_or_unparseable_flyctl_output_stops_the_run_unless_overridden(tmp_path, engines, which, value):
    f = Flow(tmp_path, engine=engines(current_reply()), **{which: value})
    _, anchor = f.anchors()
    assert anchor.returncode == 1 and "::error title=No usable rollback baseline::" in anchor.stdout, anchor.stdout + anchor.stderr
    (tmp_path / "again").mkdir()
    g = Flow(tmp_path / "again", engine=engines(current_reply()), allow=True, **{which: value})
    _, anchor = g.anchors()
    assert anchor.returncode == 0 and "::warning" in anchor.stdout
    assert "unreadable" not in g.json_file("engine-before.json"), "the engine baseline itself was fine and must stay usable"
    assert g.json_file("anchors.json")["schema"] == "gridforge/rollback-anchors/1"


def test_flyctl_failing_outright_leaves_empty_files_and_the_run_stops(tmp_path, engines):
    f = Flow(tmp_path, engine=engines(current_reply()), releases="", machines_out="", extra_env={"FAKE_FLY_RC": "1"})
    reads, anchor = f.anchors()
    assert reads.returncode == 0, "the reads are `|| true`: judging them is the next step's job"
    assert anchor.returncode == 1 and "releases-before.json is empty" in anchor.stdout and "machines-before.json is empty" in anchor.stdout


# ---- machine counts, before the deploy ----------------------------------------------------------------------------------------------
@pytest.mark.parametrize("n, ok_plain, ok_override", [(0, False, True), (1, True, True), (2, False, False), (3, False, False)])
def test_the_machine_count_before_the_deploy(tmp_path, engines, n, ok_plain, ok_override):
    f = Flow(tmp_path, engine=engines(current_reply()), machines_out=machines(n))
    _, anchor = f.anchors()
    assert (anchor.returncode == 0) is ok_plain, anchor.stdout + anchor.stderr
    (tmp_path / "o").mkdir()
    g = Flow(tmp_path / "o", engine=engines(current_reply()), machines_out=machines(n), allow=True)
    _, anchor = g.anchors()
    assert (anchor.returncode == 0) is ok_override, anchor.stdout + anchor.stderr
    if n >= 2:
        assert "no override covers this" in anchor.stdout


def test_a_dict_wrapped_machine_list_is_counted(tmp_path, engines):
    one = json.dumps({"machines": json.loads(machines(1))})
    two = json.dumps({"machines": json.loads(machines(2))})
    f = Flow(tmp_path, engine=engines(current_reply()), machines_out=one)
    assert f.anchors()[1].returncode == 0
    (tmp_path / "t").mkdir()
    g = Flow(tmp_path / "t", engine=engines(current_reply()), machines_out=two, allow=True)
    assert g.anchors()[1].returncode == 1


# ---- the override never skips the later gates ---------------------------------------------------------------------------------------
def test_the_confirm_gate_runs_first_and_does_not_read_the_override():
    text = WORKFLOW.read_text()
    confirm = text[text.index("- name: Confirm and check credentials"):text.index("- uses: actions/checkout@v7")]
    assert 'CONFIRM" != "DEPLOY"' in confirm and "allow_no_baseline" not in confirm


def test_the_override_input_is_a_boolean_that_defaults_to_false():
    text = WORKFLOW.read_text()
    m = re.search(r"      allow_no_baseline:\n((?:        .*\n)+)", text)
    assert m, "no allow_no_baseline input"
    body = m.group(1)
    assert "type: boolean" in body and "default: false" in body and "required: false" in body
    assert "ALLOW_NO_BASELINE: ${{ inputs.allow_no_baseline }}" in text


# ---- the one-machine step after the deploy ------------------------------------------------------------------------------------------
@pytest.mark.parametrize("out, rc", [(machines(1), 0), (machines(0), 1), (machines(2), 1), (machines(5), 1),
                                     (json.dumps({"machines": json.loads(machines(1))}), 0),
                                     (json.dumps({"machines": json.loads(machines(2))}), 1),
                                     ("oops", 1), ("", 1), ("null", 1), ('{"machines": "x"}', 1), ('{"error": "x"}', 1)])
def test_exactly_one_machine_after_the_deploy(tmp_path, engines, out, rc):
    f = Flow(tmp_path, engine=engines(current_reply()), machines_out=out)
    r = f.final()
    assert r.returncode == rc, r.stdout + r.stderr
    assert f.logged() == [f"machines list --app {APP} --json"]
    if rc == 0:
        assert "OK: exactly one machine" in r.stdout
    else:
        assert "::error" in r.stdout


def test_the_final_step_cannot_be_overridden(tmp_path, engines):
    f = Flow(tmp_path, engine=engines(current_reply()), machines_out=machines(2), allow=True)
    assert f.final().returncode == 1


# ---- the assertions above must be able to FAIL: inject a mutating call into a copy of the step and see it caught ------------------
@pytest.mark.parametrize("injected", ["flyctl secrets unset GRIDFORGE_API_KEYS --app \"$FLY_APP\"", "flyctl scale count 2 --app \"$FLY_APP\"",
                                      "flyctl deploy --app \"$FLY_APP\"", "flyctl releases --app \"$FLY_APP\" --json --extra"])
def test_a_mutating_flyctl_call_added_to_the_read_step_is_caught_by_the_calls_log(tmp_path, engines, injected):
    f = Flow(tmp_path, engine=engines(current_reply()))
    mutated = run_block(READ_STEP) + injected + "\n"
    assert f.bash(mutated, token=True).returncode == 0
    f.bash(run_block(ANCHOR_STEP))
    with pytest.raises(AssertionError):
        assert_exactly_the_two_reads(f)


def test_a_mutating_flyctl_call_added_to_the_anchor_step_is_caught_by_the_calls_log(tmp_path, engines):
    f = Flow(tmp_path, engine=engines(current_reply()))
    mutated = run_block(ANCHOR_STEP).replace("rc=0\n", "rc=0\nflyctl secrets unset X --app \"$FLY_APP\"\n", 1)
    assert mutated != run_block(ANCHOR_STEP)
    f.anchors_text = None
    reads = f.bash(run_block(READ_STEP), token=True)
    f.bash(mutated)
    assert reads.returncode == 0
    with pytest.raises(AssertionError):
        assert_exactly_the_two_reads(f)
