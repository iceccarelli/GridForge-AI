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


def run(tmp_path, tables, host=None, migrations=None):
    f = tmp_path / "export.json"
    f.write_text(json.dumps({"tables": tables, **({"migrations": migrations} if migrations else {})}))
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


def test_a_table_the_migrations_seed_restores_without_colliding_with_its_seed_row(tmp_path):
    """payg_cursor holds one row (id 1) that migration 0028 inserts. A production export of it carries the live value, and the
    restore must load that value rather than die on the seed: the first time this ran against the real project it did."""
    r = run(tmp_path, {"payg_cursor": [{"id": 1, "last_seq": 4242, "updated_at": "2026-10-21T16:00:00+00:00"}]})
    assert r.returncode == 0, r.stdout + r.stderr
    assert "payg_cursor: 1 exported, 1 restored, digest match -> OK" in r.stdout and "RESTORE VERIFIED" in r.stdout


def test_an_append_only_table_that_guards_truncate_does_not_stop_the_restore(tmp_path):
    """project_comparisons refuses TRUNCATE by trigger. The scratch database empties its tables before loading; that must not
    trip the guard (it did, the second time this ran against the real project)."""
    r = run(tmp_path, {"project_comparisons": []})
    assert r.returncode == 0, r.stdout + r.stderr
    assert "RESTORE VERIFIED" in r.stdout


def test_an_export_restores_into_the_schema_it_was_taken_from_and_the_pending_migrations_are_rehearsed_on_top(tmp_path):
    """Production had one released deliverable with no reviewer name (it predates the rule). Migration 0040 forbids that for NEW rows.
    A backup of that production is still a good backup: it must restore into the schema production HAD, and the pending migration
    must then apply on top of the restored data without disturbing it. Loading it into the newest schema (the old behaviour) refused
    it, which is how the real project's backup was wrongly declared unrestorable."""
    q = "0e9053f6-1c27-4bc0-b629-a0b3ebc1359d"
    r = run(tmp_path, {
        "qualifications": [{"id": q, "inputs": {}, "token": "q" * 32}],
        "deliverables": [{"id": "1b9053f6-1c27-4bc0-b629-a0b3ebc1359d", "token": "t" * 32, "kind": "density_screen",
                          "status": "released", "released_at": "2026-09-01T00:00:00+00:00", "qualification_id": q}],
    }, migrations=["gf_0021_customer_notifications", "gf_0039_billing_event_clock"])
    assert r.returncode == 0, r.stdout + r.stderr
    assert "pending 0040 applies cleanly on the restored data" in r.stdout
    assert "deliverables: rows unchanged by the pending migrations -> OK" in r.stdout
    assert "RESTORE VERIFIED" in r.stdout


def test_without_a_migration_list_the_whole_repository_schema_is_used_as_before(tmp_path):
    r = run(tmp_path, {"leads": []})
    assert r.returncode == 0 and "pending" not in r.stdout.split("schema built from", 1)[1].splitlines()[0]
