"""scripts/verify-backup-restore.py: a backup only counts once it has been restored somewhere safe."""
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "verify-backup-restore.py"
REQUIRED = os.environ.get("GRIDFORGE_REQUIRE_DB") == "1"
NO_DB = not os.environ.get("PGHOST") and not os.environ.get("GRIDFORGE_TEST_PG_URL")
pytestmark = pytest.mark.skipif(NO_DB and not REQUIRED, reason="no scratch PostgreSQL available")


def run(tmp_path, tables, host=None):
    f = tmp_path / "export.json"
    f.write_text(json.dumps({"tables": tables}))
    env = dict(os.environ)
    if host:
        env["PGHOST"] = host
    return subprocess.run([sys.executable, str(SCRIPT), str(f)], capture_output=True, text=True, env=env)


def test_a_consistent_export_restores_and_verifies(tmp_path):
    q = "0e9053f6-1c27-4bc0-b629-a0b3ebc1359d"
    r = run(tmp_path, {
        "qualifications": [{"id": q, "inputs": {}, "token": "q" * 32}],
        "deliverables": [{"id": "1b9053f6-1c27-4bc0-b629-a0b3ebc1359d", "token": "t" * 32, "kind": "density_screen", "status": "awaiting_intake", "qualification_id": q}],
        "leads": [],
    })
    assert r.returncode == 0, r.stdout + r.stderr
    assert "RESTORE VERIFIED" in r.stdout and "digest match" in r.stdout


def test_an_export_that_violates_the_schema_is_reported_failed_not_verified(tmp_path):
    r = run(tmp_path, {"deliverables": [{"id": "1b9053f6-1c27-4bc0-b629-a0b3ebc1359d", "token": "t" * 32, "kind": "density_screen",
                                          "status": "awaiting_intake", "qualification_id": "00000000-0000-4000-8000-000000000000"}]})
    assert r.returncode != 0 and "RESTORE VERIFIED" not in r.stdout


def test_it_refuses_a_hosted_supabase_host(tmp_path):
    r = run(tmp_path, {"leads": []}, host="db.abcdefghijklmnopqrst.supabase.co")
    assert r.returncode != 0 and "refusing" in (r.stdout + r.stderr)


def test_it_never_prints_row_contents_even_when_the_restore_fails(tmp_path):
    secret = "SECRET-NAME-DO-NOT-PRINT"
    r = run(tmp_path, {"leads": [{"id": "2b9053f6-1c27-4bc0-b629-a0b3ebc1359d", "name": secret, "email": "x@y.test", "company": "C", "location": "L"}], "deliverables": [{"id": "3b9053f6-1c27-4bc0-b629-a0b3ebc1359d", "kind": secret}]})
    assert r.returncode != 0                                        # the deliverable row is missing its token: a real failure
    assert secret not in r.stdout + r.stderr and "x@y.test" not in r.stdout + r.stderr
