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
  "auth whoami")   echo "tester@example.com" ;;
  "status --app")  exit "${FAKE_STATUS_RC:-0}" ;;
  "secrets list")  cat "${FAKE_SECRETS_OUT:-/dev/null}"; exit "${FAKE_SECRETS_RC:-0}" ;;
  "volumes list")  echo "${FAKE_VOLUMES:-}" ;;
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
        args=(), env_extra=None, json_ok=True):
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
        "GRIDFORGE_SKIP_DEPLOY": "1",
        "FLY_APP": "test-engine",
        **(env_extra or {}),
    }
    _assert_fake(env, fly)
    proc = subprocess.run(["bash", str(SCRIPT), *args], cwd=ROOT, env=env,
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
        env = {**os.environ, "FLY_BIN": str(tmp_path / "does-not-exist"),
               "GRIDFORGE_SKIP_DEPLOY": "1",
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
