"""Shared rig for the calibration-integrity migration tests (0046 forecast freeze, 0047 consent and origin, 0048 evidence verification).

Replays the migration chain onto a throwaway database on a REAL PostgreSQL and offers builders for the objects the ledger gate
reads: a project, a forecast (case revision), a file (evidence), an observation, its review, a permission. Every number, name and
digest is a SYNTHETIC fixture.

Needs a reachable PostgreSQL (`psql` plus PG* variables, or GRIDFORGE_TEST_PG_URL). Skipped, loudly, where there is none: a skip is a
gap in what was checked, not a pass. GRIDFORGE_REQUIRE_DB=1 turns the skip into a failure.

GRIDFORGE_MIGRATIONS_DIR=<dir> replays the migrations from another directory (used to run a new test against an EARLIER version of 0046-0048
and watch it fail); the tests that open a migration file by number read it from there too.

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
MIGRATIONS = Path(os.environ["GRIDFORGE_MIGRATIONS_DIR"]) if os.environ.get("GRIDFORGE_MIGRATIONS_DIR") else ROOT / "supabase" / "migrations"
BASE = os.environ.get("GRIDFORGE_TEST_PG_URL", "")
REQUIRED = os.environ.get("GRIDFORGE_REQUIRE_DB") == "1"
UPTO = os.environ.get("GRIDFORGE_MIGRATIONS_UPTO", "9999")
NO_DB = shutil.which("psql") is None or not (BASE or os.environ.get("PGHOST"))

skip_without_db = pytest.mark.skipif(NO_DB and not REQUIRED, reason="no PostgreSQL available (set GRIDFORGE_TEST_PG_URL or PGHOST)")

DIGEST = "c" * 64
GOOD = '{"event_type": "%s", "actor": "someone", "payload": {}}'
HEX = lambda ch: ch * 64  # noqa: E731
# A document digest that is not an obvious placeholder (0047 refuses 64 identical characters).
DOC = lambda tag: hashlib.sha256(f"document-{tag}".encode()).hexdigest()  # noqa: E731
FORECAST_RESULT = '{"architectures": [{"label": "ARCH", "available_MW": 30}, {"label": "OTHER", "available_MW": 12.5}]}'


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


def make_database(regrant=True, supabase_default_acls=False):
    """A database with the whole chain applied. `supabase_default_acls` first sets what a Supabase project has before any user migration:
    default privileges that hand ALL on every new public table to anon, authenticated and service_role (see 0040), so that a REVOKE in a
    migration actually has something to take away."""
    name = f"gf_{uuid.uuid4().hex[:10]}"
    psql("postgres", f"create database {name}")
    psql(name, "create extension if not exists pgcrypto")
    psql(name, "create schema if not exists storage;"
               "create table if not exists storage.buckets (id text primary key, name text, public boolean)")
    for role, extra in (("anon", ""), ("authenticated", ""), ("service_role", " bypassrls")):
        psql("postgres", f"do $$ begin if not exists (select 1 from pg_roles where rolname = '{role}') "
                         f"then create role {role} nologin{extra}; end if; end $$")
    if supabase_default_acls:
        psql(name, "alter default privileges in schema public grant all on tables to anon, authenticated, service_role;"
                   "alter default privileges in schema public grant all on sequences to anon, authenticated, service_role")
    for f in sorted(MIGRATIONS.glob("*.sql")):
        if f.name[:4] <= UPTO:
            psql(name, file=f)
    if not regrant:
        return name
    # What scripts/realdb-up.sh does after the migrations, minus TRUNCATE (0040 withholds it and the guards stop the owner anyway).
    # It hands INSERT on every table back to service_role, so the tests of the guards run with the privilege PRESENT: the triggers, not
    # the revoke in the migration, are what they exercise (the revoke itself is checked on a database built without this step).
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


def new_case(db, token=None, created_at=None, request="{}", result=FORECAST_RESULT, revision=1):
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


def _call_json(db, fn_call):
    """`select <fn_call>` as the database owner (some of these databases are built without the service role's table grants, to test the privileges themselves, and
    the registry functions run with the invoker's rights); the jsonb answer of a registry function (the last line of output)."""
    return json.loads(psql(db, f"select {fn_call}").stdout.strip().splitlines()[-1])


def satisfy_publication_gates(db, project, reached_on="2020-01-01"):
    """What 0056 asks BEFORE a production observation of `project` is recorded, done the way an organisation would do it and idempotent: the project is in a
    hall of an organisation (a new one, with a production site, unless the project is already attached to one), that organisation's standing consent is a
    grant, and the project has attested a completion milestone backed by a verified file. A no-op on a database built before 0056, where nothing is asked.
    Every observation this rig submits as production goes through here (submit(..., gates=False) skips it, which is how a test shows a gate refusing)."""
    if scalar(db, "select to_regclass('public.calibration_consents') is null") == "t":
        return
    if scalar(db, f"select count(*) from projects where id = '{project}'") != "1":
        return                                                  # a project that does not exist is the test's point, and the function's to refuse
    q = lambda s: "'" + str(s).replace("'", "''") + "'"        # noqa: E731
    org = scalar(db, f"select s.org_id from projects p join sites s on s.id = p.site_id where p.id = '{project}'")
    if org:
        owner = scalar(db, f"select email from organisation_members where org_id = '{org}' and role = 'owner' and removed_at is null order by added_at limit 1")
    else:
        owner = f"owner-{uuid.uuid4().hex[:10]}@rig.example"
        org = _call_json(db, f"public.gf_create_org(p_actor => {q(owner)}, p_name => {q('Rig organisation ' + uuid.uuid4().hex[:8])})")["org_id"]
        site = _call_json(db, f"public.gf_create_site(p_actor => {q(owner)}, p_org => '{org}', p_name => 'Rig site', p_country => 'DE', "
                                    f"p_data_origin => 'production')")["site_id"]
        hall = _call_json(db, f"public.gf_create_hall(p_actor => {q(owner)}, p_site => '{site}', p_label => 'Rig hall')")["hall_id"]
        token = scalar(db, f"select project_token from projects where id = '{project}'")
        out = _call_json(db, f"public.gf_attach_project_to_hall(p_actor => {q(owner)}, p_hall => '{hall}', p_project_token => {q(token)})")
        assert out.get("ok"), out
    if scalar(db, f"select coalesce((select kind from calibration_consents where organisation_id = '{org}' order by seq desc limit 1), 'none')") != "granted":
        p = {"organisation_id": org, "publish_scope": "aggregate_residual_statistics", "min_aggregate_observations": 10, "min_aggregate_organisations": 3,
             "consent_text_version": "rig-1", "consent_text_sha256": DOC("rig consent text"), "document_sha256": DOC("rig signed " + org), "recorded_by": owner}
        psql(db, f"select public.gf_record_calibration_consent({q(json.dumps(p))}::jsonb)")
    if scalar(db, f"select count(*) from project_completion_milestones where project_id = '{project}' and milestone = 'energised'") == "0":
        proof = new_evidence(db, project, verified=True, sha="b")
        p = {"project_id": project, "milestone": "energised", "reached_on": reached_on, "evidence_id": proof, "basis": "rig: energisation certificate",
             "attested_by": owner}
        psql(db, f"select public.gf_attest_completion_milestone({q(json.dumps(p))}::jsonb, '{GOOD % 'completion_milestone_attested'}'::jsonb)")


def stamp_organisation(db, oid):
    """For a row recorded with the insert gates OFF (bypassing_triggers), on purpose, to test the VIEW alone: set the organisation and the consent that the insert
    trigger would have derived, so that the view's 0056 conditions are met and only the condition under test can keep the row out. A no-op before 0056."""
    if scalar(db, "select to_regclass('public.calibration_consents') is null") == "t":
        return
    org = "(select s.org_id from projects p join sites s on s.id = p.site_id where p.id = project_id)"
    bypassing_triggers(db, f"update project_observations set organisation_id = {org}, "
                           f"consent_id = (select c.id from calibration_consents c where c.organisation_id = {org} order by c.seq desc limit 1) where id = '{oid}'")


def submit(db, project=None, evidence_verified=True, site="Dublin DC1", on="2026-06-30", case_created_at="2026-03-02T09:00:00Z", gates=True, **over):
    """An observation through the real function, against a forecast made BEFORE the outcome unless told otherwise. A production observation first gets what
    0056 requires of one (`satisfy_publication_gates`) unless `gates=False`."""
    project = project or new_project(db, site)
    if gates and over.get("data_origin", "production") == "production":
        satisfy_publication_gates(db, project)
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
         "document_sha256": doc or DOC("default"), "note": note}
    return psql(db, f"select gf_record_calibration_permission('{json.dumps(p)}'::jsonb, '{GOOD % 'calibration_permission_recorded'}'::jsonb)",
                check=check)


def export_rows(db, where="true"):
    return json.loads(scalar(db, f"select coalesce(json_agg(t), '[]'::json) from calibration_ledger_rows t where {where}"))
