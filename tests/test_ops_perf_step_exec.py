"""The `site` job's bundle-budget step, EXECUTED.

tests/test_ops_ci_workflow.py pins what the step's text says. A pin cannot see what bash does with it, so (like
tests/test_deploy_workflow_exec.py) this pulls the step's `run:` block out of .github/workflows/gridforge.yml and runs it under bash
against fakes: a fake `npm`, a fake Playwright installer, a fake `next` (a tiny HTTP server that dies with EADDRINUSE like the real one
when its port is taken) and a fake `npx` that records the vitest invocation. `curl`, `bash`, `sleep` and `kill` are the real ones.

What it proves: the step passes only when the server comes up AND is its own process; a busy port, a server that never answers, a failing
install and a failing vitest each fail the step; and the server is never left running.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import stat
import subprocess
import sys
import textwrap
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = ROOT / ".github" / "workflows" / "gridforge.yml"
STEP_NAME = "No route may ship more first-load JavaScript than scripts/perf-budget.json allows"

pytestmark = pytest.mark.skipif(shutil.which("curl") is None or shutil.which("bash") is None, reason="curl and bash are required")


def _step_run_block() -> tuple[str, dict[str, str]]:
    text = WORKFLOW.read_text()
    m = re.search(rf"^      - name: {re.escape(STEP_NAME)}.*?(?=^      - name: )", text, re.S | re.M)
    assert m, "the budget step is missing"
    step = m.group(0)
    run = re.search(r"^        run: \|\n((?:          .*\n|\n)+)", step, re.M)
    assert run, "no `run: |` block"
    script = textwrap.dedent(run.group(1))
    env = dict(re.findall(r"^          ([A-Z_]+): '([^']*)'$", step.split("run: |")[0], re.M))
    return script, env


FAKE_NPM = r"""#!/usr/bin/env bash
# fake npm: `npm install --prefix DIR ... playwright@X`; fails the first FAKE_NPM_FAILS times, always if FAKE_NPM_FAILS=999
echo "npm $*" >> "$FAKE_LOG"
n=$(cat "$FAKE_STATE/npm_count" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "$FAKE_STATE/npm_count"
[ "$n" -le "${FAKE_NPM_FAILS:-0}" ] && { echo "npm ERR! network" >&2; exit 1; }
prefix=""; while [ $# -gt 0 ]; do [ "$1" = "--prefix" ] && prefix="$2"; shift; done
mkdir -p "$prefix/node_modules/.bin"
cat > "$prefix/node_modules/.bin/playwright" <<'EOS'
#!/usr/bin/env bash
echo "playwright $*" >> "$FAKE_LOG"
n=$(cat "$FAKE_STATE/pw_count" 2>/dev/null || echo 0); n=$((n + 1)); echo $n > "$FAKE_STATE/pw_count"
[ "$n" -le "${FAKE_PW_FAILS:-0}" ] && { echo "download failed" >&2; exit 1; }
exit 0
EOS
chmod +x "$prefix/node_modules/.bin/playwright"
"""

FAKE_NPX = r"""#!/usr/bin/env bash
echo "npx $* | PERF_BASE_URL=${PERF_BASE_URL:-} NODE_PATH=${NODE_PATH:-}" >> "$FAKE_LOG"
exit "${FAKE_VITEST_RC:-0}"
"""

# the fake `next start -p PORT`: binds like the real server (no SO_REUSEADDR), so a taken port is EADDRINUSE and a non-zero exit.
FAKE_NEXT = r"""#!/usr/bin/env python3
import os, socket, sys, time
from http.server import BaseHTTPRequestHandler, HTTPServer
port = int(sys.argv[sys.argv.index("-p") + 1])
if os.environ.get("FAKE_NEXT_MODE") == "hang":      # alive, never listens
    time.sleep(120)
class H(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200); self.end_headers(); self.wfile.write(b"ok")
    def log_message(self, *a): pass
class S(HTTPServer):
    allow_reuse_address = False
try:
    srv = S(("127.0.0.1", port), H)
except OSError as e:
    print("Error: listen EADDRINUSE: address already in use :::%d" % port, file=sys.stderr)
    sys.exit(1)
open(os.environ["FAKE_STATE"] + "/next.pid", "w").write(str(os.getpid()))
srv.serve_forever()
"""


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _answers(port: int) -> bool:
    r = subprocess.run(["curl", "-s", "-o", "/dev/null", "--max-time", "2", f"http://127.0.0.1:{port}/"], capture_output=True)
    return r.returncode == 0


class Rig:
    def __init__(self, tmp: Path):
        self.tmp = tmp
        self.bin = tmp / "bin"
        self.bin.mkdir()
        self.state = tmp / "state"
        self.state.mkdir()
        self.log = tmp / "calls.log"
        self.work = tmp / "work"
        (self.work / "node_modules" / ".bin").mkdir(parents=True)
        for path, body in ((self.bin / "npm", FAKE_NPM), (self.bin / "npx", FAKE_NPX), (self.work / "node_modules" / ".bin" / "next", FAKE_NEXT)):
            path.write_text(body)
            path.chmod(path.stat().st_mode | stat.S_IEXEC)
        self.script, self.env_defaults = _step_run_block()
        self.port = _free_port()

    def run(self, **extra: str) -> subprocess.CompletedProcess:
        env = {k: v for k, v in os.environ.items() if not k.startswith(("PERF_", "FAKE_")) and k not in {"CI", "GITHUB_ACTIONS"}}
        env.update(self.env_defaults)
        env.update({
            "PATH": f"{self.bin}:{os.environ['PATH']}", "RUNNER_TEMP": str(self.tmp), "PERF_PORT": str(self.port),
            "PERF_RETRY_BACKOFF": "0", "PERF_WAIT_SECONDS": "6",
            "FAKE_LOG": str(self.log), "FAKE_STATE": str(self.state), "PYTHONUNBUFFERED": "1",
        })
        env.update(extra)
        return subprocess.run(["bash", "-e", "-c", self.script], cwd=self.work, env=env, capture_output=True, text=True, timeout=120)

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines() if self.log.exists() else []

    def vitest_calls(self) -> list[str]:
        return [c for c in self.calls() if c.startswith("npx vitest")]


@pytest.fixture()
def rig(tmp_path):
    r = Rig(tmp_path)
    yield r
    pid = r.state / "next.pid"
    if pid.exists():
        try:
            os.kill(int(pid.read_text()), 9)
        except OSError:
            pass


def _no_server_left(r: Rig) -> None:
    assert not _answers(r.port), "the production server was left running after the step"


def test_the_step_passes_when_the_server_is_its_own_and_vitest_passes(rig):
    p = rig.run()
    assert p.returncode == 0, p.stdout + p.stderr
    [call] = rig.vitest_calls()
    assert f"npx vitest run tests/site/perf-budget.test.ts | PERF_BASE_URL=http://127.0.0.1:{rig.port} NODE_PATH={rig.tmp}/perf-playwright/node_modules" == call
    assert any(c.startswith("npm install --prefix") and "playwright@1.63.0" in c for c in rig.calls())
    assert any(c == "playwright install --with-deps chromium" for c in rig.calls())
    _no_server_left(rig)


def test_a_failing_budget_fails_the_step_and_still_stops_the_server(rig):
    p = rig.run(FAKE_VITEST_RC="1")
    assert p.returncode == 1
    assert len(rig.vitest_calls()) == 1
    _no_server_left(rig)


def test_a_port_that_already_answers_is_refused_and_nothing_is_measured(rig):
    foreign = subprocess.Popen([sys.executable, "-m", "http.server", str(rig.port), "--bind", "127.0.0.1"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            if _answers(rig.port):
                break
            subprocess.run(["sleep", "0.1"])
        assert _answers(rig.port)
        p = rig.run()
        assert p.returncode != 0
        assert "already answers HTTP before the production server was started" in p.stderr + p.stdout
        assert rig.vitest_calls() == [], "vitest measured a server that is not this build"
        assert foreign.poll() is None, "the step must not kill a process it did not start"
    finally:
        foreign.kill()
        foreign.wait()


def test_a_taken_port_that_never_answers_http_is_caught_by_the_process_dying(rig):
    """The pre-check sees no HTTP answer, our server dies with EADDRINUSE: the step must fail on that, not wait or measure."""
    blocker = socket.socket()
    blocker.bind(("127.0.0.1", rig.port))
    blocker.listen(1)  # accepts connections, never replies
    try:
        p = rig.run()
        assert p.returncode != 0
        assert "exited before it served port" in p.stderr + p.stdout
        assert "EADDRINUSE" in p.stdout + p.stderr, "the server's own log must be shown"
        assert rig.vitest_calls() == []
    finally:
        blocker.close()


def test_a_server_that_wins_the_race_is_not_mistaken_for_ours(rig):
    """A foreign server appears after the pre-check and our server dies on it: the 200 must not be trusted."""
    foreign = subprocess.Popen(
        [sys.executable, "-c", "import time,sys;time.sleep(float(sys.argv[2]));import http.server;"
         "http.server.HTTPServer(('127.0.0.1',int(sys.argv[1])),http.server.SimpleHTTPRequestHandler).serve_forever()", str(rig.port), "0.0"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(50):
            if _answers(rig.port):
                break
            subprocess.run(["sleep", "0.1"])
        # make the pre-check blind to it: ask the step to probe a different port than the one `next start` will use
        script = rig.script.replace('if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${PERF_PORT}/"', 'if false && curl -s -o /dev/null')
        rig.script = script
        p = rig.run()
        assert p.returncode != 0, p.stdout + p.stderr
        assert rig.vitest_calls() == [], "vitest measured the foreign server"
    finally:
        foreign.kill()
        foreign.wait()


def test_a_server_that_never_answers_fails_with_an_accurate_message(rig):
    p = rig.run(FAKE_NEXT_MODE="hang", PERF_WAIT_SECONDS="3")
    assert p.returncode != 0
    out = p.stdout + p.stderr
    assert "did not answer HTTP 200" in out and "within 3 s" in out
    assert rig.vitest_calls() == []
    _no_server_left(rig)


def test_transient_install_failures_are_retried_and_persistent_ones_fail_after_three_attempts(rig):
    ok = rig.run(FAKE_NPM_FAILS="2")
    assert ok.returncode == 0, ok.stdout + ok.stderr
    assert sum(c.startswith("npm install") for c in rig.calls()) == 3
    assert len(rig.vitest_calls()) == 1


def test_a_persistent_npm_failure_fails_the_step_without_measuring(tmp_path):
    r = Rig(tmp_path)
    p = r.run(FAKE_NPM_FAILS="999")
    assert p.returncode != 0
    assert sum(c.startswith("npm install") for c in r.calls()) == 3
    assert r.vitest_calls() == []
    assert not (r.state / "next.pid").exists(), "the server must not start after a failed install"


def test_a_persistent_browser_download_failure_fails_the_step_without_measuring(tmp_path):
    r = Rig(tmp_path)
    p = r.run(FAKE_PW_FAILS="999")
    assert p.returncode != 0
    assert sum(c.startswith("playwright install") for c in r.calls()) == 3
    assert r.vitest_calls() == []


def test_a_transient_browser_download_failure_is_retried(tmp_path):
    r = Rig(tmp_path)
    p = r.run(FAKE_PW_FAILS="1")
    assert p.returncode == 0, p.stdout + p.stderr
    assert sum(c.startswith("playwright install") for c in r.calls()) == 2
