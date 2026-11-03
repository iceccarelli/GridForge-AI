"""scripts/check-env.mjs: a production environment is validated by NAME ONLY, and a value never reaches the output.

Every value here is fake. The script is run as a real subprocess (Node ships on the CI runners; the file skips where it does not).
"""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "check-env.mjs"
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")

GOOD = {
    "ADMIN_PASSWORD": "fake-admin-password-for-tests",
    "ADMIN_SESSION_SECRET": "fake-session-secret-0123456789abcdefghij",
    "CRON_SECRET": "fake-cron-secret-0123456789",
    "STRIPE_WEBHOOK_SECRET": "whsec_fakefakefakefakefakefake",
    "STRIPE_SECRET_KEY": "sk_live_fakefakefakefakefake",
    "SUPABASE_URL": "https://fakeproject.example.com",
    "SUPABASE_SERVICE_ROLE_KEY": "fake-service-role-key-0123456789abcdefghijklmnop",
    "GRIDFORGE_API_URL": "https://engine.example.com",
    "NEXT_PUBLIC_SITE_URL": "https://site.example.com",
    "GRIDFORGE_KEY_SECRET": "fake-key-secret-0123456789abcdefghijklmnop",
    "FUNNEL_REF_KEY": "fake-funnel-ref-key-123",
}


def run(env: dict[str, str], *args: str, tmp: Path | None = None):
    """Run the script against an env FILE (so the test host's own environment can never leak in)."""
    assert tmp is not None
    f = tmp / "prod.env"
    f.write_text("\n".join(f"{k}={v}" for k, v in env.items()) + "\n")
    return subprocess.run(["node", str(SCRIPT), *args, str(f)], capture_output=True, text=True, timeout=30)


def test_a_complete_strong_environment_passes(tmp_path):
    r = run(GOOD, tmp=tmp_path)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "ok:" in r.stdout


@pytest.mark.parametrize("name", sorted(set(GOOD) - {"ADMIN_PASSWORD"}))
def test_each_missing_required_variable_fails_by_name(tmp_path, name):
    env = {k: v for k, v in GOOD.items() if k != name}
    r = run(env, tmp=tmp_path)
    assert r.returncode == 1
    assert f"FAIL  {name}: missing" in r.stdout


def test_a_session_secret_equal_to_the_password_or_too_short_fails(tmp_path):
    same = dict(GOOD, ADMIN_SESSION_SECRET=GOOD["ADMIN_PASSWORD"] + "x" * 20)
    assert run(same, tmp=tmp_path).returncode == 0  # long and distinct: fine
    same["ADMIN_PASSWORD"] = same["ADMIN_SESSION_SECRET"]
    r = run(same, tmp=tmp_path)
    assert r.returncode == 1 and "identical to ADMIN_PASSWORD" in r.stdout
    short = run(dict(GOOD, ADMIN_SESSION_SECRET="short"), tmp=tmp_path)
    assert short.returncode == 1 and "ADMIN_SESSION_SECRET: shorter than 32" in short.stdout


@pytest.mark.parametrize(
    "name,value,reason",
    [
        ("STRIPE_WEBHOOK_SECRET", "not-a-webhook-secret-at-all", "whsec_"),
        ("GRIDFORGE_API_URL", "http://127.0.0.1:8080", "public https"),
        ("NEXT_PUBLIC_SITE_URL", "https://site.example.com/", "trailing slash"),
        ("SUPABASE_URL", "http://localhost:54321", "public https"),
        ("CRON_SECRET", "short", "shorter than 16"),
        ("SUPABASE_SERVICE_ROLE_KEY", "changeme", "placeholder"),
    ],
)
def test_weak_values_fail_with_a_reason(tmp_path, name, value, reason):
    r = run(dict(GOOD, **{name: value}), tmp=tmp_path)
    assert r.returncode == 1
    assert f"FAIL  {name}:" in r.stdout and reason in r.stdout


def test_a_value_never_appears_in_any_output(tmp_path):
    secret = "ZZ-super-distinctive-fake-value-ZZ"
    env = dict(GOOD, CRON_SECRET=secret[:5], STRIPE_WEBHOOK_SECRET=secret, ADMIN_SESSION_SECRET=secret, ADMIN_PASSWORD=secret)
    for args in ((), ("--json",)):
        r = run(env, *args, tmp=tmp_path)
        assert r.returncode == 1
        assert secret not in r.stdout + r.stderr and secret[:5] not in r.stdout + r.stderr


def test_json_output_names_problems_only(tmp_path):
    r = run({k: v for k, v in GOOD.items() if k != "CRON_SECRET"}, "--json", tmp=tmp_path)
    doc = json.loads(r.stdout)
    assert doc["ok"] is False and doc["problems"] == [{"name": "CRON_SECRET", "reason": "missing"}]


def test_process_environment_is_read_when_no_file_is_given(tmp_path):
    env = dict(GOOD, PATH=subprocess.os.environ.get("PATH", ""))
    r = subprocess.run(["node", str(SCRIPT)], capture_output=True, text=True, env=env, timeout=30)
    assert r.returncode == 0, r.stdout
    r = subprocess.run(["node", str(SCRIPT)], capture_output=True, text=True, env={"PATH": env["PATH"]}, timeout=30)
    assert r.returncode == 1 and "FAIL  ADMIN_SESSION_SECRET: missing" in r.stdout


def test_dotenv_syntax_is_understood(tmp_path):
    f = tmp_path / "p.env"
    lines = ["# comment", ""] + [f'export {k}="{v}"' if i % 2 else f"{k}='{v}' # trailing" for i, (k, v) in enumerate(GOOD.items())]
    f.write_text("\n".join(lines))
    assert subprocess.run(["node", str(SCRIPT), str(f)], capture_output=True, text=True, timeout=30).returncode == 0


def test_an_unreadable_file_is_a_usage_error(tmp_path):
    r = subprocess.run(["node", str(SCRIPT), str(tmp_path / "nope.env")], capture_output=True, text=True, timeout=30)
    assert r.returncode == 2
