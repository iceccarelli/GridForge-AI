"""0047_calibration_consent_and_origin.sql against a REAL PostgreSQL.

Before 0047 nothing recorded whether a project's owner had agreed to its measurements feeding a shared calibration ledger, and nothing
said whether an observation came from a real deployment or from a demo, a test or a generator: the export view took every verified row and
`gridforge calibrate import` imports whatever the view returns, with published=True. This attacks the new gates the way a careless or
hostile service-role caller would: it tries to edit or erase a permission, to revoke what was never granted, to forge an origin, and it
checks that the ledger view admits only production rows of a project whose LATEST permission is a grant. Every value is SYNTHETIC.

See tests/calibration_pg_rig.py for how the database is built and for GRIDFORGE_MIGRATIONS_UPTO (set to 0046 to watch these fail on the base).
"""
import json
import uuid

import pytest

from calibration_pg_rig import (
    DOC, GOOD, as_anon, as_service_role, count, database_fixture, export_rows, new_project, psql, record_permission, review, scalar,
    skip_without_db, submit, submitted,
)

pytestmark = skip_without_db
db = database_fixture()

COLUMNS = ["id", "key", "observed_value", "predicted_value", "unit", "site_ref", "measurement_kind", "evidence_sha256",
           "engine_provenance_digest", "report_date", "observed_on", "method", "evidence_class", "reviewed_by", "reviewed_at"]


def eligible_observation(db, **kw):
    """A reviewed, verified, production observation (permission NOT yet recorded)."""
    project, _, o = submitted(db, **kw)
    assert review(db, o["id"]).returncode == 0
    return project, o


# ---------------------------------------------------------------------------------------------- A. the permission log

def test_a_permission_is_recorded_with_who_what_and_when(db):
    project = new_project(db)
    out = json.loads(record_permission(db, project, email="  Owner@Example.TEST ", doc=DOC("1"), note=" signed 2026-10-01 ").stdout)
    assert out["scope_type"] == "project" and out["scope_id"] == project and out["kind"] == "granted"
    assert out["granted_by_email"] == "owner@example.test" and out["document_sha256"] == DOC("1") and out["note"] == "signed 2026-10-01"
    assert out["granted_at"] and out["seq"] >= 1
    ev = scalar(db, f"select count(*) from project_events where project_id = '{project}' and event_type = 'calibration_permission_recorded'")
    assert ev == "1"


def test_the_history_event_carries_the_document_digest_but_not_the_email_address(db):
    project = new_project(db)
    record_permission(db, project, email="private@example.test", doc=DOC("2"))
    payload = scalar(db, f"select payload::text from project_events where project_id = '{project}' and event_type = 'calibration_permission_recorded'")
    assert DOC("2") in payload and "private@example.test" not in payload


@pytest.mark.parametrize("over,needle", [
    ({"document_sha256": "xyz"}, "document_sha256"), ({"document_sha256": "a" * 63}, "document_sha256"),
    ({"document_sha256": "A" * 64}, "document_sha256"), ({"document_sha256": None}, "document_sha256"),
    ({"document_sha256": "0" * 64}, "document_sha256"), ({"document_sha256": "a" * 64}, "document_sha256"),   # a placeholder, not a digest
    ({"granted_by_email": ""}, "granted_by_email"), ({"granted_by_email": "not-an-address"}, "granted_by_email"),
    ({"granted_by_email": None}, "granted_by_email"), ({"granted_by_email": "a b@example.test"}, "granted_by_email"),
    ({"kind": "maybe"}, "kind"), ({"scope_type": "organisation"}, "scope_type"), ({"note": "x" * 1001}, "note"),
])
def test_an_incomplete_or_malformed_permission_is_refused(db, over, needle):
    project = new_project(db)
    p = {"scope_type": "project", "scope_id": project, "kind": "granted", "granted_by_email": "o@example.test", "document_sha256": DOC("default")}
    p.update(over)
    p = {k: v for k, v in p.items() if v is not None}
    r = psql(db, f"select gf_record_calibration_permission('{json.dumps(p)}'::jsonb, '{GOOD % 'calibration_permission_recorded'}'::jsonb)", check=False)
    assert r.returncode != 0 and needle in r.stderr, r.stderr
    assert count(db, "calibration_permissions", f"scope_id = '{project}'") == 0


def test_a_permission_for_a_project_that_does_not_exist_is_refused(db):
    r = record_permission(db, str(uuid.uuid4()), check=False)
    assert r.returncode != 0 and "no such project" in r.stderr


def test_the_log_is_append_only(db):
    project = new_project(db)
    record_permission(db, project)
    for sql in ("update calibration_permissions set kind = 'revoked'", "update calibration_permissions set granted_by_email = 'x@y.zz'",
                "delete from calibration_permissions"):
        for runner in (psql, as_service_role):
            r = runner(db, sql, check=False)
            assert r.returncode != 0 and "append-only" in r.stderr, (runner.__name__, sql)
    for sql in ("truncate public.calibration_permissions", "truncate public.calibration_permissions cascade"):
        r = psql(db, sql, check=False)
        assert r.returncode != 0 and "append-only" in r.stderr, sql
    assert count(db, "calibration_permissions", f"scope_id = '{project}'") == 1


def test_a_revocation_is_a_new_row_and_needs_something_to_revoke(db):
    project = new_project(db)
    nothing = record_permission(db, project, kind="revoked", check=False)
    assert nothing.returncode != 0 and "nothing to revoke" in nothing.stderr
    record_permission(db, project)
    assert record_permission(db, project, kind="revoked", doc=DOC("3")).returncode == 0
    again = record_permission(db, project, kind="revoked", check=False)
    assert again.returncode != 0 and "nothing to revoke" in again.stderr                        # already revoked
    assert record_permission(db, project, kind="granted", doc=DOC("4")).returncode == 0         # a new grant after a revocation is a new row
    assert scalar(db, f"select string_agg(kind, ',' order by seq) from calibration_permissions where scope_id = '{project}'") == "granted,revoked,granted"


def test_the_order_is_a_sequence_not_a_clock(db):
    """Two rows written in one transaction share now(); the latest is the highest seq, not the latest timestamp."""
    project = new_project(db)
    psql(db, "begin;"
             f"select gf_record_calibration_permission('{json.dumps({'scope_type': 'project', 'scope_id': project, 'kind': 'granted', 'granted_by_email': 'a@b.cc', 'document_sha256': DOC('a')})}'::jsonb, '{GOOD % 'calibration_permission_recorded'}'::jsonb);"
             f"select gf_record_calibration_permission('{json.dumps({'scope_type': 'project', 'scope_id': project, 'kind': 'revoked', 'granted_by_email': 'a@b.cc', 'document_sha256': DOC('b')})}'::jsonb, '{GOOD % 'calibration_permission_recorded'}'::jsonb);"
             "commit")
    assert scalar(db, f"select kind from calibration_permissions where scope_id = '{project}' order by seq desc limit 1") == "revoked"
    assert scalar(db, f"select count(distinct granted_at) from calibration_permissions where scope_id = '{project}'") == "1"


def test_only_the_service_role_can_use_the_function_and_the_table(db):
    project = new_project(db)
    p = json.dumps({"scope_type": "project", "scope_id": project, "kind": "granted", "granted_by_email": "o@example.test", "document_sha256": DOC("default")})
    call = f"select gf_record_calibration_permission('{p}'::jsonb, '{GOOD % 'calibration_permission_recorded'}'::jsonb)"
    for role in ("anon", "authenticated"):
        r = psql(db, f"set role {role}; {call}", check=False)
        assert r.returncode != 0 and "permission denied" in r.stderr, role
        assert psql(db, f"set role {role}; select count(*) from calibration_permissions", check=False).returncode != 0, role
    assert as_service_role(db, call).returncode == 0
    assert scalar(db, "select relrowsecurity from pg_class where oid = 'public.calibration_permissions'::regclass") == "t"
    assert scalar(db, "select count(*) from pg_policies where tablename = 'calibration_permissions'") == "0"


# ---------------------------------------------------------------------------------------------- B. data origin

def test_existing_observations_are_unclassified_and_the_column_cannot_say_anything_else(db):
    assert scalar(db, "select column_default from information_schema.columns where table_name = 'project_observations' and column_name = 'data_origin'") \
        == "'unclassified'::text"
    assert scalar(db, "select is_nullable from information_schema.columns where table_name = 'project_observations' and column_name = 'data_origin'") == "NO"


@pytest.mark.parametrize("origin", ["production", "test", "synthetic", "unclassified"])
def test_the_four_origins_are_accepted(db, origin):
    _, _, o = submitted(db, evidence_verified=False, data_origin=origin)
    assert o["data_origin"] == origin


def test_an_observation_with_no_origin_is_unclassified_never_production(db):
    _, _, o = submitted(db, evidence_verified=False, data_origin=None)
    assert o["data_origin"] == "unclassified"


@pytest.mark.parametrize("origin", ["prod", "PRODUCTION", "demo", "", " production", "real"])
def test_an_unknown_origin_is_refused(db, origin):
    _, _, r = submit(db, evidence_verified=False, data_origin=origin)
    assert r.returncode != 0 and ("data_origin" in r.stderr), (origin, r.stderr)


def test_an_origin_cannot_be_changed_after_the_fact(db):
    _, _, o = submitted(db, evidence_verified=False, data_origin="test")
    r = psql(db, f"update project_observations set data_origin = 'production' where id = '{o['id']}'", check=False)
    assert r.returncode != 0 and "append-only" in r.stderr


# ---------------------------------------------------------------------------------------------- C. the ledger view

def test_the_view_keeps_every_column_in_order_and_is_still_service_role_only(db):
    cols = scalar(db, "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name = 'calibration_ledger_rows'")
    assert cols.split(",") == COLUMNS
    assert as_service_role(db, "select count(*) from calibration_ledger_rows").returncode == 0
    for role in ("anon", "authenticated"):
        assert psql(db, f"set role {role}; select count(*) from calibration_ledger_rows", check=False).returncode != 0, role


def test_without_a_permission_nothing_is_exported(db):
    project, o = eligible_observation(db)
    assert export_rows(db, f"id = '{o['id']}'") == []


def test_a_granted_permission_makes_the_project_exportable_and_the_row_keeps_its_shape(db):
    project, o = eligible_observation(db)
    record_permission(db, project)
    rows = export_rows(db, f"id = '{o['id']}'")
    assert len(rows) == 1 and list(rows[0].keys()) == COLUMNS


def test_revoking_removes_the_project_from_the_export_and_a_regrant_restores_it(db):
    project, o = eligible_observation(db)
    record_permission(db, project)
    assert len(export_rows(db, f"id = '{o['id']}'")) == 1
    record_permission(db, project, kind="revoked", doc=DOC("5"))
    assert export_rows(db, f"id = '{o['id']}'") == []
    record_permission(db, project, kind="granted", doc=DOC("6"))
    assert len(export_rows(db, f"id = '{o['id']}'")) == 1


def test_one_projects_permission_does_not_open_another(db):
    p1, o1 = eligible_observation(db)
    p2, o2 = eligible_observation(db)
    record_permission(db, p1)
    assert [r["id"] for r in export_rows(db, f"id in ('{o1['id']}', '{o2['id']}')")] == [o1["id"]]


@pytest.mark.parametrize("origin", ["test", "synthetic", "unclassified"])
def test_only_production_rows_are_exported(db, origin):
    project, o = eligible_observation(db, data_origin=origin)
    record_permission(db, project)
    assert export_rows(db, f"id = '{o['id']}'") == []


def test_an_observation_with_no_origin_given_is_never_exported(db):
    project, o = eligible_observation(db, data_origin=None)
    record_permission(db, project)
    assert export_rows(db, f"id = '{o['id']}'") == []


def test_the_view_is_the_single_gate_and_names_every_condition(db):
    """The importer (gridforge/cli.py `calibrate import`) trusts the rows the view returns, so the view's own definition is what is checked."""
    d = scalar(db, "select pg_get_viewdef('public.calibration_ledger_rows'::regclass, true)")
    for needle in ("data_origin", "'production'", "calibration_permissions", "'granted'", "review_status", "'verified'", "created_at"):
        assert needle in d, needle


def test_the_migration_says_it_is_not_applied_and_has_no_destructive_statement():
    import glob
    import importlib.util
    from calibration_pg_rig import ROOT
    sql = open(glob.glob(str(ROOT / "supabase" / "migrations" / "0047_*.sql"))[0]).read()
    assert "WRITTEN, NOT APPLIED" in sql
    spec = importlib.util.spec_from_file_location("am", ROOT / "scripts" / "apply-migration.py")
    am = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(am)
    assert am.destructive_statements(sql) == []


def test_the_migration_is_idempotent(db):
    from calibration_pg_rig import MIGRATIONS
    f = next(MIGRATIONS.glob("0047_*.sql"))
    psql(db, file=f)
    psql(db, file=f)
    project, o = eligible_observation(db)
    record_permission(db, project)
    assert len(export_rows(db, f"id = '{o['id']}'")) == 1
