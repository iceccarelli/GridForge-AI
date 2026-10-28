"""The deploy script, run against a fake `fly`.

SAFETY FIRST, and this is not decorative. The first version of this file put a
fake binary named `fly` on PATH and trusted the script to find it. The script
resolved `command -v flyctl` first, found the REAL flyctl installed in the
developer's Codespace, and ran `fly apps create test-engine` against their live
Fly.io account. A test that touches production is a worse bug than the one it was
written to catch.

So: the fake is installed under BOTH names, FLY_BIN names it explicitly, and
_assert_fake() refuses to run at all unless the binary the script will use is the
one this test wrote.

This file exists because the same bug shipped twice. deploy-engine.sh generated a
fresh GRIDFORGE_API_KEYS on every run, so every deploy invalidated the key the
website was using. Patch 0014 "fixed" it by grepping `fly secrets list` — the grep
did not match flyctl's actual output, the detection silently returned false, and
the next deploy rotated the key again.

A shell script with no test is how a bug survives the patch that claims to fix it.
So: a fake `fly` on PATH that records every argv it is called with, and assertions
about what the script did and did not do. The invariant is one line — a deploy must
never write a secret that already exists — and it is now enforced rather than
intended.
"""
import json
import os
import re
import shutil
import stat
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "deploy-engine.sh"

# Every flyctl invocation is appended to $FLY_LOG as one JSON array per line, so a
# test can assert on exactly what was asked of the platform.
FAKE_FLY = r"""#!/usr/bin/env bash
python3 - "$FLY_LOG" "$@" <<'PY'
import json, sys
open(sys.argv[1], "a").write(json.dumps(sys.argv[2:]) + "\n")
PY
case "$1 $2" in
  "auth whoami")
    if [ "${FAKE_WHOAMI_RC:-0}" != "0" ]; then echo "Error: no access token available" >&2; exit "$FAKE_WHOAMI_RC"; fi
    echo "tester@example.com" ;;
  "status --app")  exit "${FAKE_STATUS_RC:-0}" ;;
  "secrets list")  cat "${FAKE_SECRETS_OUT:-/dev/null}"; exit "${FAKE_SECRETS_RC:-0}" ;;
  "volumes list")
    if [ "${FAKE_VOLUMES_RC:-0}" != "0" ]; then echo "Error: could not list volumes" >&2; exit "$FAKE_VOLUMES_RC"; fi
    if [ -n "${FAKE_VOLUMES_RAW:-}" ]; then printf '%s' "$FAKE_VOLUMES_RAW"; exit 0; fi
    case "$*" in
      *--json*) python3 - <<'PYV'
import json, os
names = [n for n in os.environ.get("FAKE_VOLUMES", "").split(",") if n]
rows = [{"id": f"vol_{i}", "Name": n, "name": n, "size_gb": 1} for i, n in enumerate(names)]
# a large listing: the old `volumes list | grep -q NAME` died on SIGPIPE here and decided the volume did not exist
rows += [{"id": f"vol_pad{i}", "Name": f"pad_{i}", "padding": "x" * 200} for i in range(int(os.environ.get("FAKE_VOLUMES_PAD", "0")))]
print(json.dumps(rows))
PYV
      ;;
      *) echo "${FAKE_VOLUMES:-}" ;;
    esac ;;
  "machines list")
    cat "${FAKE_MACHINES_OUT:-/dev/null}" ;;
  *) : ;;
esac
exit 0
"""

JSON_LIST = json.dumps(
    [{"Name": "GRIDFORGE_API_KEYS", "Digest": "abc", "CreatedAt": "2026-01-01"},
     {"Name": "GRIDFORGE_KEY_SECRET", "Digest": "def", "CreatedAt": "2026-01-01"}]
)

# flyctl has shipped this with a header row and varying indentation. The second
# form is what defeated the previous implementation's `grep "^NAME"`.
TEXT_LIST_INDENTED = (
    "NAME                  DIGEST          CREATED AT\n"
    "  GRIDFORGE_API_KEYS    abc123          1h30m ago\n"
    "  GRIDFORGE_KEY_SECRET  def456          1h30m ago\n"
)


def run(tmp_path, *, secrets_out: str | None, secrets_rc: int = 0,
        args=(), env_extra=None, json_ok=True, script=None, cwd=None):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(exist_ok=True)
    fly = bin_dir / "fly"
    flyctl = bin_dir / "flyctl"
    # When json_ok is False the fake returns the same text for --json too, which is
    # exactly what an older flyctl does: it ignores the flag and prints a table.
    body = FAKE_FLY
    if not json_ok:
        body = body.replace('"secrets list")  cat "${FAKE_SECRETS_OUT:-/dev/null}"',
                            '"secrets list")  cat "${FAKE_SECRETS_TXT:-/dev/null}"')
    for target in (fly, flyctl):
        target.write_text(body)
        target.chmod(target.stat().st_mode | stat.S_IEXEC)

    log = tmp_path / "fly.log"
    out_file = tmp_path / "secrets.out"
    out_file.write_text(secrets_out or "")

    env = {
        **os.environ,
        "PATH": f"{bin_dir}:{os.environ['PATH']}",
        "FLY_BIN": str(fly),
        "FLY_LOG": str(log),
        "FAKE_SECRETS_OUT": str(out_file) if secrets_out is not None else "/dev/null",
        "FAKE_SECRETS_TXT": str(out_file),
        "FAKE_SECRETS_RC": str(secrets_rc),
        "FAKE_VOLUMES": "gridforge_data",
        "GRIDFORGE_ENGINE_URL": "http://127.0.0.1:9",   # nothing listens here: tests that deploy for real override it
        "GRIDFORGE_SKIP_DEPLOY": "1",
        "FLY_APP": "test-engine",
        # These tests are about what the script does on Fly, not about which branch the repository is on; the source guard has its
        # own class (TestSourceIsMain) that runs the script inside a throwaway git repository with this override switched off.
        "GRIDFORGE_DEPLOY_ANY_REF": "1",
        **(env_extra or {}),
    }
    _assert_fake(env, fly)
    proc = subprocess.run(["bash", str(script or SCRIPT), *args], cwd=cwd or ROOT, env=env,
                          capture_output=True, text=True)
    assert "personal organization" not in proc.stderr, (
        "the script reached a real Fly account:\n" + proc.stderr)
    calls = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
    return proc, calls


def _assert_fake(env: dict, fake: Path) -> None:
    """Refuse to run unless the binary the script will use is ours.

    Belt and braces on top of FLY_BIN: if a future edit drops that override, this
    stops the suite rather than letting it create apps in somebody's account.
    """
    chosen = env.get("FLY_BIN", "")
    assert chosen == str(fake), f"FLY_BIN is {chosen!r}, not the fake at {fake}"
    resolved = shutil.which("fly", path=env["PATH"])
    assert resolved and Path(resolved).parent == fake.parent, (
        f"PATH would resolve `fly` to {resolved}, which is not the fake")


def secret_sets(calls):
    return [c for c in calls if c[:2] == ["secrets", "set"]]


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is required")
class TestNeverRotates:
    """The one invariant. Everything else in this file is detail."""

    def test_existing_secrets_are_never_rewritten_json(self, tmp_path):
        proc, calls = run(tmp_path, secrets_out=JSON_LIST)
        assert proc.returncode == 0, proc.stderr
        assert secret_sets(calls) == [], (
            "a deploy wrote a secret that already existed:\n" + proc.stdout)
        assert "already set, untouched" in proc.stdout

    def test_existing_secrets_are_never_rewritten_from_an_indented_table(self, tmp_path):
        """The exact shape that defeated the previous implementation."""
        proc, calls = run(tmp_path, secrets_out=TEXT_LIST_INDENTED, json_ok=False)
        assert proc.returncode == 0, proc.stderr
        assert secret_sets(calls) == [], (
            "the text fallback failed to see an existing secret:\n" + proc.stdout)

    def test_existing_secrets_are_not_rewritten_even_with_bootstrap(self, tmp_path):
        """--bootstrap means 'mint what is missing', never 'replace what is there'."""
        proc, calls = run(tmp_path, secrets_out=JSON_LIST, args=("--bootstrap",))
        assert proc.returncode == 0, proc.stderr
        assert secret_sets(calls) == []

    def test_a_missing_secret_is_not_minted_without_bootstrap(self, tmp_path):
        """The default cannot create a credential, so it cannot surprise anyone."""
        proc, calls = run(tmp_path, secrets_out="[]")
        assert proc.returncode == 0, proc.stderr
        assert secret_sets(calls) == []
        assert "--bootstrap" in proc.stdout
        assert "GRIDFORGE_API_KEYS is NOT set" in proc.stdout

    def test_uncertain_detection_refuses_to_write(self, tmp_path):
        """If the secret list cannot be read at all, the script must not guess.
        Guessing is what rotated a live key twice."""
        proc, calls = run(tmp_path, secrets_out=None, secrets_rc=1,
                          args=("--bootstrap",))
        assert proc.returncode == 0, proc.stderr
        assert secret_sets(calls) == []
        assert "Uncertainty must never resolve to overwriting a credential" in proc.stdout


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is required")
class TestSafety:
    """The regression that matters most: this file once created a real Fly app."""

    def test_a_real_flyctl_earlier_on_path_is_not_used(self, tmp_path):
        decoy = tmp_path / "decoy"
        decoy.mkdir()
        real = decoy / "flyctl"
        real.write_text("#!/usr/bin/env bash\necho 'REAL FLYCTL CALLED' >&2\nexit 0\n")
        real.chmod(real.stat().st_mode | stat.S_IEXEC)
        proc, calls = run(tmp_path, secrets_out=JSON_LIST,
                          env_extra={"PATH": f"{decoy}:{tmp_path / 'bin'}:{os.environ['PATH']}"})
        assert "REAL FLYCTL CALLED" not in proc.stderr, (
            "the script used a flyctl this test did not write")
        assert calls, "the fake recorded nothing — it was never called"

    def test_the_script_refuses_when_no_binary_exists(self, tmp_path):
        # PATH keeps the system dirs so bash itself is still findable; only the
        # fly binaries are absent, which is the condition under test.
        empty = tmp_path / "empty"
        empty.mkdir()
        # The deploy-source guard (exit 4) judges the repository this test happens to run in: any checkout whose engine files differ from
        # origin/main, which includes every PR that changes the engine, would refuse before reaching the check under test. TestSourceIsMain
        # covers the guard in throwaway repositories; here it is switched off so this test depends on nothing but the missing binary.
        env = {**os.environ, "FLY_BIN": str(tmp_path / "does-not-exist"),
               "GRIDFORGE_SKIP_DEPLOY": "1", "GRIDFORGE_DEPLOY_ANY_REF": "1",
               "PATH": f"{empty}:/usr/bin:/bin"}
        proc = subprocess.run(["bash", str(SCRIPT)], cwd=ROOT, env=env,
                              capture_output=True, text=True)
        assert proc.returncode == 2
        assert "flyctl not found" in proc.stderr


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is required")
class TestBootstrap:
    def test_bootstrap_mints_only_what_is_missing(self, tmp_path):
        partial = json.dumps([{"Name": "GRIDFORGE_API_KEYS"}])
        proc, calls = run(tmp_path, secrets_out=partial, args=("--bootstrap",))
        assert proc.returncode == 0, proc.stderr
        sets = secret_sets(calls)
        assert len(sets) == 1, sets
        assigned = [a for a in sets[0] if "=" in a]
        assert len(assigned) == 1
        name, value = assigned[0].split("=", 1)
        assert name == "GRIDFORGE_KEY_SECRET"
        assert len(value) >= 32, "a signing secret must not be short"
        assert "--stage" in sets[0], "secrets must be staged, not applied mid-deploy"

    def test_a_minted_secret_is_printed_once(self, tmp_path):
        proc, _ = run(tmp_path, secrets_out="[]", args=("--bootstrap",))
        assert "NEW, set this now" in proc.stdout
        assert "Both sides must hold the SAME value" in proc.stdout

    def test_nothing_minted_says_unchanged_rather_than_printing_a_key(self, tmp_path):
        proc, _ = run(tmp_path, secrets_out=JSON_LIST)
        assert "<unchanged>" in proc.stdout
        assert "NEW, set this now" not in proc.stdout


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is required")
class TestApp:
    def test_an_existing_app_is_not_recreated(self, tmp_path):
        proc, calls = run(tmp_path, secrets_out=JSON_LIST)
        assert not [c for c in calls if c[:2] == ["apps", "create"]]
        assert "already exists" in proc.stdout

    def test_a_missing_app_is_created(self, tmp_path):
        proc, calls = run(tmp_path, secrets_out="[]", env_extra={"FAKE_STATUS_RC": "1"})
        assert [c for c in calls if c[:2] == ["apps", "create"]], proc.stdout

    def test_the_script_tells_you_how_to_rotate_deliberately(self, tmp_path):
        proc, _ = run(tmp_path, secrets_out=JSON_LIST)
        assert "To rotate deliberately (this script never will)" in proc.stdout


def volume_creates(calls):
    return [c for c in calls if c[:2] == ["volumes", "create"]]


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is required")
class TestVolumeNeverDuplicated:
    """Fly volume names are not unique: a second `gridforge_data` is a second, empty usage ledger."""

    def test_an_existing_volume_is_not_recreated(self, tmp_path):
        proc, calls = run(tmp_path, secrets_out=JSON_LIST)
        assert volume_creates(calls) == [], proc.stdout
        assert "exists" in proc.stdout

    def test_an_existing_volume_in_a_huge_listing_is_still_seen(self, tmp_path):
        proc, calls = run(tmp_path, secrets_out=JSON_LIST, env_extra={"FAKE_VOLUMES_PAD": "4000"})
        assert volume_creates(calls) == [], "a large listing made the script decide the volume was absent"

    def test_a_failed_listing_never_creates_a_volume(self, tmp_path):
        proc, calls = run(tmp_path, secrets_out=JSON_LIST, env_extra={"FAKE_VOLUMES_RC": "1"})
        assert proc.returncode == 0, proc.stderr
        assert volume_creates(calls) == [], "an unreadable volume list resolved to creating a second volume"
        assert "Could not read the volume list" in proc.stdout

    def test_only_the_exact_name_counts_so_a_look_alike_does_not_hide_a_missing_volume(self, tmp_path):
        proc, calls = run(tmp_path, secrets_out=JSON_LIST, env_extra={"FAKE_VOLUMES": "gridforge_data_old"})
        assert len(volume_creates(calls)) == 1, proc.stdout

    def test_a_listing_that_is_not_a_list_is_unknown_not_empty(self, tmp_path):
        # an error object on stdout with exit 0 must not be read as 'no volumes'
        proc, calls = run(tmp_path, secrets_out=JSON_LIST, env_extra={"FAKE_VOLUMES_RAW": json.dumps({"error": "unauthorized"})})
        assert volume_creates(calls) == [], proc.stdout
        assert "Could not read the volume list" in proc.stdout

    def test_garbage_is_unknown_not_empty(self, tmp_path):
        proc, calls = run(tmp_path, secrets_out=JSON_LIST, env_extra={"FAKE_VOLUMES_RAW": "<html>502</html>"})
        assert volume_creates(calls) == [], proc.stdout


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is required")
class TestSecretDetectionRefusesToGuess:
    def test_an_error_object_is_not_an_empty_secret_list(self, tmp_path):
        """flyctl answering {"error": ...} with exit 0 once read as 'no secrets', and --bootstrap then overwrote the signing secret."""
        proc, calls = run(tmp_path, secrets_out=json.dumps({"error": "rate limited"}), args=("--bootstrap",))
        assert secret_sets(calls) == [], proc.stdout
        assert "Uncertainty must never resolve to overwriting a credential" in proc.stdout

    def test_a_text_banner_is_not_a_secret_table(self, tmp_path):
        proc, calls = run(tmp_path, secrets_out="Error: failed to fetch secrets\n", json_ok=False, args=("--bootstrap",))
        assert secret_sets(calls) == [], proc.stdout
        assert "Uncertainty must never resolve to overwriting a credential" in proc.stdout

    def test_a_dict_holding_a_list_is_still_accepted(self, tmp_path):
        proc, calls = run(tmp_path, secrets_out=json.dumps({"secrets": json.loads(JSON_LIST)}), args=("--bootstrap",))
        assert secret_sets(calls) == []
        assert "already set, untouched" in proc.stdout


# ---------------------------------------------------------------------------------------------------------------------
# The post-deploy proof, against a REAL local engine (the fake `fly` deploys nothing; the script then asks the engine it is
# pointed at what it serves, and fails unless it is what the repository says).
# ---------------------------------------------------------------------------------------------------------------------
import socket
import sys
import time
import urllib.request


def _free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class LocalEngine:
    def __init__(self, tmp_path, *, ledger=True, admin_key=None):
        self.port = _free_port()
        env = {**os.environ, "GRIDFORGE_KEY_SECRET": "deploy-test-secret", "GRIDFORGE_USAGE_FILE": str(tmp_path / "usage.json"),
               "GRIDFORGE_REVOKED_FILE": str(tmp_path / "revoked.json"), "GRIDFORGE_COST_FILE": str(tmp_path / "costs.json")}
        if ledger:
            env["GRIDFORGE_LEDGER_FILE"] = str(tmp_path / "ledger.jsonl")
        else:
            env.pop("GRIDFORGE_LEDGER_FILE", None)
        if admin_key:
            env["GRIDFORGE_ADMIN_KEY"] = admin_key
        env.pop("FLY_MACHINE_ID", None)
        self.proc = subprocess.Popen([sys.executable, "-m", "gridforge", "serve", "--port", str(self.port)], cwd=ROOT, env=env,
                                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(60):
            try:
                urllib.request.urlopen(f"http://127.0.0.1:{self.port}/health", timeout=1)
                return
            except Exception:
                time.sleep(0.25)
        self.stop()
        raise RuntimeError("the local engine did not start")

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"

    def stop(self):
        self.proc.terminate()
        try:
            self.proc.wait(timeout=10)
        except Exception:
            self.proc.kill()


def machines_file(tmp_path, machines):
    f = tmp_path / "machines.json"
    f.write_text(json.dumps(machines))
    return str(f)


ONE_MACHINE = [{"id": "m1", "config": {"mounts": [{"name": "gridforge_data", "path": "/data"}]}}]
TWO_MACHINES = ONE_MACHINE + [{"id": "m2", "config": {"mounts": [{"name": "gridforge_data", "path": "/data"}]}}]


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is required")
class TestPostDeployProof:
    def deploy(self, tmp_path, engine, machines, extra=None):
        return run(tmp_path, secrets_out=JSON_LIST, env_extra={
            "GRIDFORGE_SKIP_DEPLOY": "0", "GRIDFORGE_ENGINE_URL": engine.url,
            "FAKE_MACHINES_OUT": machines, **(extra or {})})

    def test_a_current_engine_with_one_volume_machine_passes(self, tmp_path):
        eng = LocalEngine(tmp_path, admin_key="op-key-for-test")
        try:
            proc, calls = self.deploy(tmp_path, eng, machines_file(tmp_path, ONE_MACHINE), {"GRIDFORGE_ADMIN_KEY": "op-key-for-test"})
        finally:
            eng.stop()
        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert "durable usage ledger" in proc.stdout and "machines: 1, mounting gridforge_data: 1" in proc.stdout
        assert "revocation persistable" in proc.stdout and "serves every route and unit rate" in proc.stdout
        assert "op-key-for-test" not in proc.stdout + proc.stderr, "the operator key must never be printed"

    def test_two_machines_fail_the_deploy(self, tmp_path):
        eng = LocalEngine(tmp_path)
        try:
            proc, _ = self.deploy(tmp_path, eng, machines_file(tmp_path, TWO_MACHINES))
        finally:
            eng.stop()
        assert proc.returncode == 1, proc.stdout
        assert "machines: 2" in proc.stdout and "Do not scale out" in proc.stdout

    def test_an_engine_without_a_writable_ledger_fails_the_deploy(self, tmp_path):
        eng = LocalEngine(tmp_path, ledger=False)
        try:
            proc, _ = self.deploy(tmp_path, eng, machines_file(tmp_path, ONE_MACHINE))
        finally:
            eng.stop()
        assert proc.returncode == 1, proc.stdout
        assert re.search(r"!!\s+durable usage ledger", proc.stdout)

    def test_an_unreadable_machine_list_is_reported_unverified_not_failed_not_passed(self, tmp_path):
        eng = LocalEngine(tmp_path)
        try:
            proc, _ = self.deploy(tmp_path, eng, "/dev/null")
        finally:
            eng.stop()
        assert "machine count could not be read" in proc.stdout
        assert "machines: 1" not in proc.stdout

    def test_an_engine_that_predates_the_ledger_fails_on_drift(self, tmp_path):
        """What production is today: the routes and rates the repository declares are not served."""
        import http.server
        import threading

        class Old(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                body = json.dumps({"version": "0.9.0", "auth_configured": True, "signed_keys": True, "metering": {"durable": True},
                                   "endpoints": ["/v1/screen", "/v1/study", "/v1/qualify"], "unit_rates": {"/v1/screen": 1, "/v1/study": 5}}).encode()
                self.send_response(200)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(body)

        srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Old)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            class E:  # same shape as LocalEngine for deploy()
                url = f"http://127.0.0.1:{srv.server_address[1]}"
            proc, _ = self.deploy(tmp_path, E, machines_file(tmp_path, ONE_MACHINE))
        finally:
            srv.shutdown()
        assert proc.returncode == 1, proc.stdout
        assert "DRIFT from this repository" in proc.stdout
        assert re.search(r"!!\s+pay-as-you-go published", proc.stdout) and re.search(r"!!\s+durable usage ledger", proc.stdout)


# ---------------------------------------------------------------------------------------------------------------------
# Credentials: auth failure is explicit and early; a deploy never writes a secret; the post-deploy drift check is not optional.
# ---------------------------------------------------------------------------------------------------------------------
MUTATING = (["apps", "create"], ["secrets", "set"], ["volumes", "create"], ["deploy"])


def mutations(calls):
    return [c for c in calls if any(c[:len(m)] == m for m in MUTATING)]


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is required")
class TestAuthFailsEarly:
    def test_missing_auth_fails_before_any_mutation(self, tmp_path):
        proc, calls = run(tmp_path, secrets_out="[]", env_extra={"FAKE_WHOAMI_RC": "1", "FAKE_STATUS_RC": "1", "GRIDFORGE_SKIP_DEPLOY": "0"},
                          args=("--bootstrap",))
        assert proc.returncode == 3, proc.stdout + proc.stderr
        assert calls == [["auth", "whoami"], ["status", "--app", "test-engine"]], f"anything after the auth check is a mutation or a read it had no right to make: {calls}"
        assert mutations(calls) == []
        assert "Add repository secret FLY_API_TOKEN (fly tokens create deploy -a test-engine)" in proc.stderr

    def test_an_app_scoped_deploy_token_that_cannot_answer_whoami_is_accepted_when_it_can_read_the_app(self, tmp_path):
        proc, calls = run(tmp_path, secrets_out="[]", env_extra={"FAKE_WHOAMI_RC": "1", "FAKE_STATUS_RC": "0", "GRIDFORGE_SKIP_DEPLOY": "1"}, args=("--check",))
        assert "Not authenticated" not in proc.stdout + proc.stderr, proc.stdout + proc.stderr
        assert calls[:2] == [["auth", "whoami"], ["status", "--app", "test-engine"]]
        assert mutations(calls) == []

    def test_there_is_no_interactive_login_fallback(self, tmp_path):
        proc, calls = run(tmp_path, secrets_out="[]", env_extra={"FAKE_WHOAMI_RC": "1", "FAKE_STATUS_RC": "1"})
        assert not [c for c in calls if c[:2] == ["auth", "login"]], "a script run in CI must not try to sign in"

    def test_a_rejected_token_is_named_and_never_printed(self, tmp_path):
        secret = "fo1_SuperSecretTokenValue123"
        proc, calls = run(tmp_path, secrets_out="[]", env_extra={"FAKE_WHOAMI_RC": "1", "FAKE_STATUS_RC": "1", "FLY_API_TOKEN": secret})
        assert proc.returncode == 3
        assert "Fly rejected it" in proc.stderr
        assert secret not in proc.stdout + proc.stderr
        assert mutations(calls) == []

    def test_an_empty_token_counts_as_no_token(self, tmp_path):
        proc, calls = run(tmp_path, secrets_out="[]", env_extra={"FAKE_WHOAMI_RC": "1", "FAKE_STATUS_RC": "1", "FLY_API_TOKEN": ""})
        assert proc.returncode == 3
        assert "FLY_API_TOKEN is set but empty" in proc.stdout
        assert "Add repository secret FLY_API_TOKEN" in proc.stderr

    def test_check_mode_also_needs_auth(self, tmp_path):
        proc, calls = run(tmp_path, secrets_out="[]", args=("--check",), env_extra={"FAKE_WHOAMI_RC": "1", "FAKE_STATUS_RC": "1"})
        assert proc.returncode == 3 and mutations(calls) == []

    def test_check_mode_still_stops_before_the_deploy(self, tmp_path):
        proc, calls = run(tmp_path, secrets_out=JSON_LIST, args=("--check",), env_extra={"GRIDFORGE_SKIP_DEPLOY": "0"})
        assert proc.returncode == 0, proc.stderr
        assert [c for c in calls if c[:1] == ["deploy"]] == []
        assert "--check: stopping before deploy" in proc.stdout
        assert "Post-deploy drift check" not in proc.stdout


def _stub_engine(*, mutate=None):
    """An HTTP stub that reports exactly what THIS repository says an engine serves (so there is no drift), optionally mutated."""
    import http.server
    import threading

    from gridforge.api.metering import UNIT_COST
    from gridforge.api.server import ROUTES, VERSION
    from gridforge.api.tools import catalogue
    from gridforge.provenance import code_sha256

    version = {"version": VERSION, "auth_configured": True, "signed_keys": True, "payg": {"unit_price_cents": 1},
               "endpoints": sorted(ROUTES) + ["/health"], "unit_rates": dict(UNIT_COST),
               "provenance": {"code_sha256": code_sha256()}, "metering": {"durable": True, "ledger_durable": True}}
    if mutate:
        mutate(version)

    class H(http.server.BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            body = {"/v1/version": version, "/v1/tools": catalogue()}.get(self.path, {"ok": True})
            raw = json.dumps(body).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.end_headers()
            self.wfile.write(raw)

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_address[1]}"


@pytest.mark.skipif(shutil.which("bash") is None, reason="bash is required")
class TestDeployNeverWritesSecretsAndVerifies:
    def _deploy(self, tmp_path, url, secrets_out=JSON_LIST):
        return run(tmp_path, secrets_out=secrets_out, env_extra={
            "GRIDFORGE_SKIP_DEPLOY": "0", "GRIDFORGE_ENGINE_URL": url,
            "FAKE_MACHINES_OUT": machines_file(tmp_path, ONE_MACHINE)})

    def test_a_real_deploy_never_calls_secrets_set_and_deploys_one_machine(self, tmp_path):
        srv, url = _stub_engine()
        try:
            proc, calls = self._deploy(tmp_path, url)
        finally:
            srv.shutdown()
        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert secret_sets(calls) == [], "a deploy wrote a secret that already existed"
        deploys = [c for c in calls if c[:1] == ["deploy"]]
        assert len(deploys) == 1 and "--ha=false" in deploys[0]
        assert not [c for c in calls if c[:1] == ["scale"] or c[:2] in (["machine", "clone"], ["machines", "clone"])], "never scale out"
        # auth is the first thing asked of Fly
        assert calls[0] == ["auth", "whoami"]

    def test_a_deploy_with_missing_secrets_still_does_not_mint_them(self, tmp_path):
        srv, url = _stub_engine()
        try:
            proc, calls = self._deploy(tmp_path, url, secrets_out="[]")
        finally:
            srv.shutdown()
        assert secret_sets(calls) == []

    def test_the_post_deploy_drift_check_runs_and_a_clean_engine_passes(self, tmp_path):
        srv, url = _stub_engine()
        try:
            proc, _ = self._deploy(tmp_path, url)
        finally:
            srv.shutdown()
        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert "Post-deploy drift check" in proc.stdout
        assert "serves every route and unit rate" in proc.stdout

    def test_remaining_drift_alone_fails_the_deploy(self, tmp_path):
        """Everything else about the engine is healthy; only the code digest differs. The script must still exit non-zero."""
        srv, url = _stub_engine(mutate=lambda v: v.update(provenance={"code_sha256": "0" * 64}))
        try:
            proc, _ = self._deploy(tmp_path, url)
        finally:
            srv.shutdown()
        assert proc.returncode == 1, proc.stdout
        assert "Provenance (code digest)" in proc.stdout and "different tree" in proc.stdout
        assert "Post-deploy verification FAILED" in proc.stdout
        assert not re.search(r"!!\s+(paid endpoints|self-serve keys|durable usage|pay-as-you-go)", proc.stdout)

    def test_an_engine_that_cannot_be_read_after_deploy_fails_rather_than_passes(self, tmp_path):
        proc, _ = run(tmp_path, secrets_out=JSON_LIST, env_extra={"GRIDFORGE_SKIP_DEPLOY": "0", "GRIDFORGE_HEALTH_TRIES": "1", "FAKE_MACHINES_OUT": machines_file(tmp_path, ONE_MACHINE)})
        assert proc.returncode == 1, proc.stdout
        assert "Post-deploy verification FAILED" in proc.stdout


# ---------------------------------------------------------------------------------------------------------------------------------
# The engine on Fly must be built from main.
#
# `fly deploy` ships whatever is checked out, and the post-deploy drift check compares the engine with THAT checkout. Deploying a
# stale feature branch therefore reports "no drift" while main is still not deployed (the owner's Codespace was on
# feat/ttp-quotation-backed-comparison-20261017-142725 when the first redeploy was attempted). These tests run the real script
# inside a throwaway git repository with a real bare "origin", with the override switched off.
# ---------------------------------------------------------------------------------------------------------------------------------

def _git(cwd, *args):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True,
                          env={**os.environ, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.test",
                               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.test"})


def make_repo(tmp_path):
    """A repository shaped like this one (the files the image is built from, plus files it is not), pushed to a bare origin."""
    origin = tmp_path / "origin.git"
    origin.mkdir()
    _git(origin, "init", "--bare", "-b", "main")
    work = tmp_path / "work"
    (work / "scripts").mkdir(parents=True)
    (work / "gridforge").mkdir()
    (work / "examples" / "intake").mkdir(parents=True)
    (work / "tests").mkdir()
    shutil.copy(SCRIPT, work / "scripts" / "deploy-engine.sh")
    (work / "gridforge" / "__init__.py").write_text("VERSION = '1'\n")
    (work / "examples" / "intake" / "hall.json").write_text("{}\n")
    (work / "pyproject.toml").write_text("[project]\nname = 'x'\n")
    (work / "Dockerfile").write_text("FROM python:3.13-slim\n")
    (work / "fly.toml").write_text('app = "t"\n[mounts]\n  source = "d"\n')
    (work / "README.md").write_text("hello\n")
    (work / "tests" / "t.py").write_text("x = 1\n")
    _git(work, "init", "-b", "main")
    _git(work, "add", "-A")
    _git(work, "commit", "-m", "main")
    _git(work, "remote", "add", "origin", str(origin))
    _git(work, "push", "-u", "origin", "main")
    return work


def guard_run(tmp_path, work, **kw):
    # `secrets_out` is irrelevant: the guard runs before the script touches Fly at all.
    kw.setdefault("env_extra", {})
    kw["env_extra"] = {"GRIDFORGE_DEPLOY_ANY_REF": "0", **kw["env_extra"]}
    return run(tmp_path, secrets_out=JSON_LIST, script=work / "scripts" / "deploy-engine.sh", cwd=work, **kw)


@pytest.mark.skipif(shutil.which("bash") is None or shutil.which("git") is None, reason="bash and git are required")
class TestSourceIsMain:
    def test_a_checkout_identical_to_main_proceeds(self, tmp_path):
        work = make_repo(tmp_path)
        proc, calls = guard_run(tmp_path, work)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert "Source is main" in proc.stdout
        assert calls, "after the guard the script goes on to talk to Fly"

    def test_a_feature_branch_with_an_engine_change_is_refused_before_anything_else(self, tmp_path):
        work = make_repo(tmp_path)
        _git(work, "checkout", "-b", "feat/something")
        (work / "gridforge" / "__init__.py").write_text("VERSION = '2'\n")
        _git(work, "commit", "-am", "engine change not on main")
        proc, calls = guard_run(tmp_path, work)
        assert proc.returncode == 4, proc.stdout + proc.stderr
        assert "Refusing to deploy" in proc.stdout + proc.stderr
        assert "gridforge/__init__.py" in proc.stderr
        assert "git checkout main" in proc.stderr
        assert calls == [], "the guard runs before the script asks Fly anything"

    def test_a_checkout_that_is_behind_main_is_refused(self, tmp_path):
        work = make_repo(tmp_path)
        other = tmp_path / "other"
        _git(tmp_path, "clone", str(tmp_path / "origin.git"), str(other))
        (other / "gridforge" / "__init__.py").write_text("VERSION = '3'\n")
        _git(other, "commit", "-am", "main moved on")
        _git(other, "push", "origin", "main")
        proc, calls = guard_run(tmp_path, work)     # `work` has not pulled: the guard fetches and sees main moved
        assert proc.returncode == 4, proc.stdout + proc.stderr
        assert "gridforge/__init__.py" in proc.stderr
        assert calls == []

    def test_an_uncommitted_edit_to_an_image_file_is_refused(self, tmp_path):
        work = make_repo(tmp_path)
        (work / "Dockerfile").write_text("FROM python:3.13-slim\nRUN echo local\n")
        proc, calls = guard_run(tmp_path, work)
        assert proc.returncode == 4
        assert "Dockerfile" in proc.stderr
        assert calls == []

    def test_an_untracked_file_inside_the_image_is_refused(self, tmp_path):
        work = make_repo(tmp_path)
        (work / "gridforge" / "scratch.py").write_text("print('would be copied into the image')\n")
        proc, calls = guard_run(tmp_path, work)
        assert proc.returncode == 4
        assert "scratch.py" in proc.stderr
        assert calls == []

    def test_a_branch_that_only_changes_files_outside_the_image_is_fine(self, tmp_path):
        work = make_repo(tmp_path)
        _git(work, "checkout", "-b", "docs/readme")
        (work / "README.md").write_text("changed\n")
        (work / "tests" / "t.py").write_text("x = 2\n")
        _git(work, "commit", "-am", "docs and tests only")
        proc, calls = guard_run(tmp_path, work)
        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert "Source is main" in proc.stdout

    def test_failing_to_refresh_main_is_a_refusal_not_a_shrug(self, tmp_path):
        work = make_repo(tmp_path)
        _git(work, "remote", "remove", "origin")
        proc, calls = guard_run(tmp_path, work)
        assert proc.returncode == 4
        assert "could not fetch origin/main" in proc.stdout + proc.stderr
        assert calls == []

    def test_a_missing_base_ref_is_a_refusal(self, tmp_path):
        work = make_repo(tmp_path)
        proc, calls = guard_run(tmp_path, work, env_extra={"GRIDFORGE_BASE_REF": "no-such-ref"})
        assert proc.returncode == 4
        assert "does not exist" in proc.stdout + proc.stderr
        assert calls == []

    def test_a_directory_that_is_not_a_git_checkout_is_refused(self, tmp_path):
        loose = tmp_path / "loose"
        (loose / "scripts").mkdir(parents=True)
        shutil.copy(SCRIPT, loose / "scripts" / "deploy-engine.sh")
        proc, calls = guard_run(tmp_path, loose)
        assert proc.returncode == 4
        assert "not a git checkout" in proc.stdout + proc.stderr
        assert calls == []

    def test_the_override_deploys_anyway_and_says_what_it_gives_up(self, tmp_path):
        work = make_repo(tmp_path)
        _git(work, "checkout", "-b", "feat/hotfix")
        (work / "gridforge" / "__init__.py").write_text("VERSION = '9'\n")
        _git(work, "commit", "-am", "hotfix")
        proc, calls = guard_run(tmp_path, work, env_extra={"GRIDFORGE_DEPLOY_ANY_REF": "1"})
        assert proc.returncode == 0, proc.stdout + proc.stderr
        assert "NOT necessarily main" in proc.stdout + proc.stderr
        assert "cannot tell you that main is undeployed" in proc.stderr

    def test_the_workflow_never_sets_the_override(self):
        wf = (ROOT / ".github" / "workflows" / "deploy-engine.yml").read_text()
        assert "GRIDFORGE_DEPLOY_ANY_REF" not in wf
