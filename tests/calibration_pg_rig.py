"""Shared rig for the calibration-integrity migration tests (0046 forecast freeze, 0047 consent and origin, 0048 evidence verification).

Replays the migration chain onto a throwaway database on a REAL PostgreSQL and offers builders for the objects the ledger gate
reads: a project, a forecast (case revision), a file (evidence), an observation, its review, a permission. Every number, name and
digest is a SYNTHETIC fixture.

Needs a reachable PostgreSQL (`psql` plus PG* variables, or GRIDFORGE_TEST_PG_URL). Skipped, loudly, where there is none: a skip is a
gap in what was checked, not a pass. GRIDFORGE_REQUIRE_DB=1 turns the skip into a failure.

GRIDFORGE_MIGRATIONS_UPTO=NNNN stops the replay after migration NNNN. It exists only to show a test FAILING on the base the change
started from (set it to 0045); the tests are written for the full chain.

The service role must be able to bypass RLS, as it is on Supabase and in scripts/realdb-up.sh: the rig creates it that way when absent.
"""
import hashlib
import json
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "supabase" / "migrations"
BASE = os.environ.get("GRIDFORGE_TEST_PG_URL", "")
REQUIRED = os.environ.get("GRIDFORGE_REQUIRE_DB") == "1"
UPTO = os.environ.get("GRIDFORGE_MIGRATIONS_UPTO", "9999")
NO_DB = shutil.which("psql") is None or not (BASE or os.environ.get("PGHOST"))

skip_without_db = pytest.mark.skipif(NO_DB and not REQUIRED, reason="no PostgreSQL available (set GRIDFORGE_TEST_PG_URL or PGHOST)")

DIGEST = "c" * 64
GOOD = '{"event_type": "%s", "actor": "someone", "payload": {}}'
HEX = lambda ch: ch * 64  # noqa: E731


def _cmd(db):
    return ["psql", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-X"] + ([f"{BASE}/{db}"] if BASE else ["-d", db])


def psql(db, sql=None, file=None, check=True, sqlstate=False):
    """`sqlstate=True` makes an error print its five-character SQLSTATE (the stable GFnnn code) instead of its message."""
    cmd = _cmd(db) + (["-v", "VERBOSITY=sqlstate"] if sqlstate else []) + (["-c", sql] if sql else ["-f", str(file)])
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode:
        raise AssertionError(r.stderr)
    return r


def scalar(db, sql):
    return psql(db, sql).stdout.strip()


def count(db, table, where="true"):
    return int(scalar(db, f"select count(*) from {table} where {where}"))


def as_service_role(db, sql, check=False):
    """Run `sql` as the service role (the role the application uses), in one session."""
    return psql(db, "set role service_role; " + sql, check=check)


def as_anon(db, sql, check=False):
    return psql(db, "set role anon; " + sql, check=check)


def bypassing_triggers(db, sql, check=True):
    """Run `sql` with row triggers off (session_replication_role = replica, superuser only): how the tests stand in for an out-of-band
    write that the guards would refuse, and how they build a fixture whose timestamp the database would otherwise assign."""
    return psql(db, "set session_replication_role = replica; " + sql, check=check)


def make_database():
    name = f"gf_{uuid.uuid4().hex[:10]}"
    psql("postgres", f"create database {name}")
    psql(name, "create extension if not exists pgcrypto")
    psql(name, "create schema if not exists storage;"
               "create table if not exists storage.buckets (id text primary key, name text, public boolean)")
    for role, extra in (("anon", ""), ("authenticated", ""), ("service_role", " bypassrls")):
        psql("postgres", f"do $$ begin if not exists (select 1 from pg_roles where rolname = '{role}') "
                         f"then create role {role} nologin{extra}; end if; end $$")
    for f in sorted(MIGRATIONS.glob("*.sql")):
        if f.name[:4] <= UPTO:
            psql(name, file=f)
    # What scripts/realdb-up.sh does after the migrations, minus TRUNCATE (0040 withholds it and the guards stop the owner anyway).
    psql(name, "grant usage on schema public to anon, service_role;"
               "grant select, insert, update, delete on all tables in schema public to service_role;"
               "grant usage on all sequences in schema public to service_role")
    return name


def drop_database(name):
    psql("postgres", f"drop database {name} with (force)")


def database_fixture(scope="module"):
    @pytest.fixture(scope=scope)
    def db():
        if REQUIRED:
            assert not NO_DB, "GRIDFORGE_REQUIRE_DB=1 but psql or PGHOST/GRIDFORGE_TEST_PG_URL is missing"
        name = make_database()
        yield name
        drop_database(name)
    return db


# ---------------------------------------------------------------------------------------------- builders

def new_project(db, site="Dublin DC1"):
    tok = uuid.uuid4().hex
    site_sql = "null" if site is None else f"'{site}'"
    out = scalar(db, f"select gf_create_project(jsonb_build_object('project_token', '{tok}', 'project_name', 'Hall A',"
                     f" 'site_label', {site_sql}), '{GOOD % 'project_created'}'::jsonb)")
    return json.loads(out)["id"]


def new_case(db, token=None, created_at=None, request="{}", result="{}", revision=1):
    """A forecast: one case revision through the real function. `created_at` (an ISO instant) back-dates it the only way possible
    after 0046, with the row guards off: the production path always stamps the revision with the database's own clock."""
    token = token or uuid.uuid4().hex
    prov = f"jsonb_build_object('digest', '{DIGEST}', 'report_date', '2026-03-01', 'engine_version', 'x')"
    psql(db, "select gf_append_case_revision(jsonb_build_object('case_token', '" + token + "', 'revision', " + str(revision)
             + ", 'request', '" + request + "'::jsonb, 'result', '" + result + "'::jsonb, 'changed_fields', '[]'::jsonb,"
             " 'engine_provenance', " + prov + "), '" + GOOD % "btm_case_revised" + "'::jsonb)")
    if created_at:
        bypassing_triggers(db, f"update power_deployment_cases set created_at = '{created_at}' "
                               f"where case_token = '{token}' and revision = {revision}")
    return token


def review_evidence(db, evidence_id, decision="verified", sha=None, reviewer="F. Keane", reason="checked", check=True):
    """The only way a file becomes verified (0048): the reviewer confirms the digest of the stored object. `sha` defaults to the
    stored digest, i.e. a confirmation that matches."""
    if scalar(db, "select to_regproc('public.gf_review_evidence') is null") == "t":
        # Before 0048 there is no review path: a file is made verified (or rejected) by a raw update, as the older tests always did.
        return psql(db, f"update project_evidence set review_status = '{decision}' where id = '{evidence_id}'", check=check)
    stored = scalar(db, f"select sha256 from project_evidence where id = '{evidence_id}'")
    p = {"evidence_id": evidence_id, "decision": decision, "reviewer": reviewer, "reason": reason,
         "sha256_confirmed": stored if sha is None else sha}
    if decision == "rejected" and sha is None:
        p.pop("sha256_confirmed")
    return psql(db, f"select gf_review_evidence('{json.dumps(p)}'::jsonb, '{GOOD % 'evidence_reviewed'}'::jsonb)", check=check)


def new_evidence(db, project, verified=True, sha="a"):
    psql(db, f"select gf_add_evidence(jsonb_build_object('project_id', '{project}', 'filename', 'f.csv', 'media_type',"
             f" 'text/csv', 'sha256', repeat('{sha}', 64), 'byte_size', 10, 'storage_ref', 'b/x'),"
             f" '{GOOD % 'evidence_attached'}'::jsonb)")
    eid = scalar(db, f"select id from project_evidence where project_id = '{project}' order by uploaded_at desc, id desc limit 1")
    if verified:
        review_evidence(db, eid)
    return eid


def obs_args(project, evidence_id, case_token, **over):
    ref = f"power_deployment_case:{case_token}:r1:ARCH"
    d = {"project_id": project, "prediction_ref": ref, "case_token": case_token, "case_revision": 1,
         "architecture": "ARCH", "calibration_key": "btm.firm_MW", "unit": "MW", "predicted_value": 30,
         "predicted_source": "result.architectures[\"ARCH\"].available_MW", "observed_value": 28.5,
         "observed_on": "2026-06-30", "method": "revenue-grade metering", "submitted_by": "A. Rivera",
         "evidence_id": evidence_id, "installed_attested": True, "installed_basis": "commissioning certificate",
         "measurement_kind": "metered", "data_origin": "production",
         "submitted_by_ref": hashlib.sha256(project.encode()).hexdigest()}
    d.update(over)
    return json.dumps({k: v for k, v in d.items() if v is not None})


def submit(db, project=None, evidence_verified=True, site="Dublin DC1", on="2026-06-30", case_created_at="2026-03-02T09:00:00Z", **over):
    """An observation through the real function, against a forecast made BEFORE the outcome unless told otherwise."""
    project = project or new_project(db, site)
    case = over.pop("case_token", None) or new_case(db, created_at=case_created_at)
    ev = over.pop("evidence_id", None) or new_evidence(db, project, verified=evidence_verified)
    r = psql(db, f"select gf_submit_observation('{obs_args(project, ev, case, observed_on=on, **over)}'::jsonb,"
                 f" '{GOOD % 'observation_submitted'}'::jsonb)", check=False)
    return project, ev, r


def submitted(db, **kw):
    project, ev, r = submit(db, **kw)
    assert r.returncode == 0, r.stderr
    return project, ev, json.loads(r.stdout)


def review(db, oid, decision="verified", cls="E5", reviewer="J. Ortiz"):
    p = json.dumps({"observation_id": oid, "decision": decision, "evidence_class": cls, "reviewer": reviewer, "reason": "checked"})
    return psql(db, f"select gf_review_observation('{p}'::jsonb, '{GOOD % 'observation_reviewed'}'::jsonb)", check=False)


def record_permission(db, project, kind="granted", email="owner@example.test", doc=None, note="signed", check=True):
    p = {"scope_type": "project", "scope_id": project, "kind": kind, "granted_by_email": email,
         "document_sha256": doc or HEX("d"), "note": note}
    return psql(db, f"select gf_record_calibration_permission('{json.dumps(p)}'::jsonb, '{GOOD % 'calibration_permission_recorded'}'::jsonb)",
                check=check)


def export_rows(db, where="true"):
    return json.loads(scalar(db, f"select coalesce(json_agg(t), '[]'::json) from calibration_ledger_rows t where {where}"))
