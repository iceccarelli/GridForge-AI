"""0038_calibration_capture.sql against a REAL PostgreSQL.

The site's tests mirror these functions in memory; that mirror cannot run a trigger, a CHECK, a view or a role grant. This
applies the whole chain of migrations to a throwaway database and attacks the observation pipeline the way a careless or
hostile service-role caller would: it tries to review its own submission, to verify an observation whose evidence is not
verified, to hand out E6, to record a quote as a measurement, to truncate the history, to smuggle a non-finite or
non-physical number, and it checks that the ledger-export view yields ONLY rows that cleared every one of those gates.
Every number, name and digest here is a SYNTHETIC fixture.

Needs a reachable PostgreSQL (`psql` plus PG* variables, or GRIDFORGE_TEST_PG_URL). Skipped, loudly, where there is none:
a skip is a gap in what was checked, not a pass. GRIDFORGE_REQUIRE_DB=1 turns the skip into a failure.
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
MIGRATION = MIGRATIONS / "0038_calibration_capture.sql"
BASE = os.environ.get("GRIDFORGE_TEST_PG_URL", "")
REQUIRED = os.environ.get("GRIDFORGE_REQUIRE_DB") == "1"
_NO_DB = shutil.which("psql") is None or not (BASE or os.environ.get("PGHOST"))

pytestmark = pytest.mark.skipif(_NO_DB and not REQUIRED, reason="no PostgreSQL available (set GRIDFORGE_TEST_PG_URL or PGHOST)")

DIGEST = "c" * 64
GOOD = '{"event_type": "%s", "actor": "someone", "payload": {}}'


def _cmd(db):
    return ["psql", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-X"] + ([f"{BASE}/{db}"] if BASE else ["-d", db])


def psql(db, sql=None, file=None, check=True):
    cmd = _cmd(db) + (["-c", sql] if sql else ["-f", str(file)])
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode:
        raise AssertionError(r.stderr)
    return r


def scalar(db, sql):
    return psql(db, sql).stdout.strip()


def count(db, table, where="true"):
    return int(scalar(db, f"select count(*) from {table} where {where}"))


@pytest.fixture(scope="module", autouse=True)
def _database_is_reachable():
    if REQUIRED:
        assert not _NO_DB, "GRIDFORGE_REQUIRE_DB=1 but psql or PGHOST/GRIDFORGE_TEST_PG_URL is missing"


@pytest.fixture(scope="module")
def db():
    name = f"gf_{uuid.uuid4().hex[:10]}"
    psql("postgres", f"create database {name}")
    psql(name, "create extension if not exists pgcrypto")
    psql(name, "create schema if not exists storage;"
               "create table if not exists storage.buckets (id text primary key, name text, public boolean)")
    for role in ("anon", "authenticated", "service_role"):
        psql("postgres", f"do $$ begin if not exists (select 1 from pg_roles where rolname = '{role}') "
                         f"then create role {role} nologin; end if; end $$")
    for f in sorted(MIGRATIONS.glob("*.sql")):
        psql(name, file=f)
    yield name
    psql("postgres", f"drop database {name} with (force)")


# ---------------------------------------------------------------------------------------------- fixtures

def new_project(db, site="Dublin DC1"):
    tok = uuid.uuid4().hex
    site_sql = "null" if site is None else f"'{site}'"
    out = scalar(db, f"select gf_create_project(jsonb_build_object('project_token', '{tok}', 'project_name', 'Hall A',"
                     f" 'site_label', {site_sql}), '{GOOD % 'project_created'}'::jsonb)")
    return json.loads(out)["id"]


def new_case(db, token=None, provenance=True, revision=1):
    token = token or uuid.uuid4().hex
    prov = (f"jsonb_build_object('digest', '{DIGEST}', 'report_date', '2026-03-01', 'engine_version', 'x')"
            if provenance else "null")
    psql(db, "select gf_append_case_revision(jsonb_build_object('case_token', '" + token + "', 'revision', " + str(revision)
             + ", 'request', '{}'::jsonb, 'result', '{}'::jsonb, 'changed_fields', '[]'::jsonb, 'engine_provenance', "
             + prov + "), '" + GOOD % "btm_case_revised" + "'::jsonb)")
    return token


def new_evidence(db, project, verified=True, sha="a"):
    psql(db, f"select gf_add_evidence(jsonb_build_object('project_id', '{project}', 'filename', 'f.csv', 'media_type',"
             f" 'text/csv', 'sha256', repeat('{sha}', 64), 'byte_size', 10, 'storage_ref', 'b/x'),"
             f" '{GOOD % 'evidence_attached'}'::jsonb)")
    eid = scalar(db, f"select id from project_evidence where project_id = '{project}' order by uploaded_at desc limit 1")
    if verified:
        psql(db, f"update project_evidence set review_status = 'verified' where id = '{eid}'")
    return eid


def obs_args(project, evidence_id, case_token, **over):
    ref = f"power_deployment_case:{case_token}:r1:ARCH"
    d = {"project_id": project, "prediction_ref": ref, "case_token": case_token, "case_revision": 1,
         "architecture": "ARCH", "calibration_key": "btm.firm_MW", "unit": "MW", "predicted_value": 30,
         "predicted_source": "result.architectures[\"ARCH\"].available_MW", "observed_value": 28.5,
         "observed_on": "2026-06-30", "method": "revenue-grade metering", "submitted_by": "A. Rivera",
         "evidence_id": evidence_id, "installed_attested": True, "installed_basis": "commissioning certificate",
         "measurement_kind": "metered", "submitted_by_ref": hashlib.sha256(project.encode()).hexdigest()}
    d.update(over)
    return json.dumps({k: v for k, v in d.items() if v is not None})


def submit(db, project=None, evidence_verified=True, provenance=True, site="Dublin DC1", on="2026-06-30", **over):
    project = project or new_project(db, site)
    case = over.pop("case_token", None) or new_case(db, provenance=provenance)
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


def export_rows(db, where="true"):
    return json.loads(scalar(db, f"select coalesce(json_agg(t), '[]'::json) from calibration_ledger_rows t where {where}"))


# ---------------------------------------------------------------------------------------------- A. truncate guards

@pytest.mark.parametrize("table", ["project_observations", "project_observation_reviews", "supplier_actuals",
                                   "supplier_actual_reviews"])
def test_the_record_and_review_tables_cannot_be_truncated(db, table):
    submitted(db)
    r = psql(db, f"truncate public.{table} cascade", check=False)
    assert r.returncode != 0 and "append-only" in r.stderr
    r = psql(db, f"truncate public.{table}", check=False)
    assert r.returncode != 0
    assert count(db, "project_observations") >= 1


# ---------------------------------------------------------------------------------------------- B. separation and verified evidence

def test_a_review_by_the_submitter_is_refused_however_it_is_spelled(db):
    _, _, o = submitted(db)
    for who in ("A. Rivera", "  a. rivera ", "A. RIVERA", o["submitted_by_ref"]):
        r = review(db, o["id"], reviewer=who)
        assert r.returncode != 0 and "GF001" not in r.stdout and "cannot be reviewed by the person who submitted" in r.stderr, who
    assert count(db, "project_observation_reviews", f"observation_id = '{o['id']}'") == 0
    assert review(db, o["id"], reviewer="J. Ortiz").returncode == 0


def test_a_rejection_by_the_submitter_is_refused_too(db):
    _, _, o = submitted(db)
    r = review(db, o["id"], decision="rejected", cls=None, reviewer="A. Rivera")
    assert r.returncode != 0 and "cannot be reviewed by the person who submitted" in r.stderr


def test_verification_is_refused_while_the_evidence_artifact_is_unverified(db):
    project, ev, o = submitted(db, evidence_verified=False)
    r = review(db, o["id"])
    assert r.returncode != 0 and "evidence artifact is not verified" in r.stderr
    assert count(db, "project_observation_reviews", f"observation_id = '{o['id']}'") == 0
    # a rejection never needs the evidence to be verified: refusing is always possible
    assert review(db, o["id"], decision="rejected", cls=None).returncode == 0
    # and a rejected artifact does not verify anything either
    _, ev2, o2 = submitted(db, evidence_verified=False)
    psql(db, f"update project_evidence set review_status = 'rejected' where id = '{ev2}'")
    assert "not verified" in review(db, o2["id"]).stderr


def test_the_review_snapshots_the_evidence_digest_it_vouched_for(db):
    _, _, o = submitted(db)
    r = review(db, o["id"])
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)["evidence_sha256"] == "a" * 64


# ---------------------------------------------------------------------------------------------- C. class and kind

@pytest.mark.parametrize("cls", ["E6", "E7", "E4", "E3", "E0", "E9", None])
def test_a_reviewer_may_assign_only_e5(db, cls):
    _, _, o = submitted(db)
    r = review(db, o["id"], cls=cls)
    assert r.returncode != 0, cls
    assert count(db, "project_observation_reviews", f"observation_id = '{o['id']}'") == 0


def test_e5_is_accepted_and_the_table_itself_refuses_a_higher_class(db):
    _, _, o = submitted(db)
    assert review(db, o["id"], cls="E5").returncode == 0
    _, _, o2 = submitted(db)
    r = psql(db, "insert into project_observation_reviews (observation_id, project_id, decision, evidence_class, reviewer)"
                 f" select id, project_id, 'verified', 'E7', 'x' from project_observations where id = '{o2['id']}'", check=False)
    assert r.returncode != 0 and "e5_only" in r.stderr


@pytest.mark.parametrize("kind", ["quoted", "declared", "simulated", "metered ", ""])
def test_a_quote_an_assumption_or_a_simulation_is_not_a_measurement_kind(db, kind):
    _, _, r = submit(db, measurement_kind=kind)
    assert r.returncode != 0 and "measurement_kind" in r.stderr, kind


@pytest.mark.parametrize("kind", ["metered", "bms_trend", "commissioning_record"])
def test_the_three_measurement_kinds_are_accepted(db, kind):
    _, _, o = submitted(db, measurement_kind=kind)
    assert o["measurement_kind"] == kind


def test_the_table_refuses_a_bad_kind_even_when_the_function_is_skipped(db):
    project, ev, o = submitted(db)
    r = psql(db, "insert into project_observations (project_id, prediction_ref, case_token, case_revision, architecture,"
                 " calibration_key, unit, predicted_value, predicted_source, observed_value, observed_on, method, evidence_id,"
                 " installed_attested, installed_basis, submitted_by, measurement_kind) select project_id, prediction_ref, case_token,"
                 " case_revision, architecture, calibration_key, unit, predicted_value, predicted_source, observed_value,"
                 f" '2025-01-01', method, evidence_id, true, 'b', 'x', 'quoted' from project_observations where id = '{o['id']}'",
            check=False)
    assert r.returncode != 0 and "measurement_kind" in r.stderr


@pytest.mark.parametrize("over,needle", [
    ({"unit": "kW"}, "unit_mw"), ({"unit": "mw"}, "unit_mw"),
    ({"observed_value": 0}, "value_sane"), ({"observed_value": -1}, "observed_value_check"),
    ({"observed_value": 10001}, "value_sane"), ({"observed_value": "NaN"}, "value_sane"),
    ({"observed_value": "Infinity"}, "value_sane"), ({"predicted_value": "NaN"}, "value_sane"),
    ({"observed_value": 1e15}, "value_sane"),
])
def test_a_wrong_unit_or_a_non_physical_number_is_refused(db, over, needle):
    _, _, r = submit(db, **over)
    assert r.returncode != 0 and needle in r.stderr, (over, r.stderr)


def test_a_physical_value_at_the_edges_is_accepted(db):
    for v in (0.001, 28.5, 10000):
        assert submit(db, observed_value=v)[2].returncode == 0


# ---------------------------------------------------------------------------------------------- D. site_ref and provenance

def site_only_ref(name):
    from gridforge.calibration.schema import site_only_ref as f
    return f(name)


def test_the_site_ref_is_derived_by_the_database_with_the_engines_algorithm(db):
    for name in ("Dublin DC1", "  dublin dc1 ", "Fráncfort-Ost 2", "X"):
        _, _, o = submitted(db, site=name)
        assert o["site_ref"] == site_only_ref(name), name
    # one site is one reference across projects, whatever the case of the label
    _, _, a = submitted(db, site="Same Site")
    _, _, b = submitted(db, site="SAME SITE")
    assert a["site_ref"] == b["site_ref"]


def test_a_caller_cannot_choose_the_site_ref(db):
    _, _, o = submitted(db, site="Real Site", site_ref="site_000000000000")
    assert o["site_ref"] == site_only_ref("Real Site")


def test_a_project_with_no_site_label_has_no_site_ref_and_is_never_exported(db):
    for blank in (None, "   "):
        project = new_project(db, blank)
        _, _, o = submitted(db, project=project)
        assert o["site_ref"] is None
        assert review(db, o["id"]).returncode == 0
        assert export_rows(db, f"id = '{o['id']}'") == []


def test_provenance_is_read_from_the_case_revision_not_from_the_caller(db):
    _, _, o = submitted(db, engine_provenance_digest="f" * 64, report_date="2001-01-01")
    assert o["engine_provenance_digest"] == DIGEST and o["report_date"] == "2026-03-01"


def test_a_revision_with_no_stored_provenance_leaves_it_null_and_ineligible(db):
    _, _, o = submitted(db, provenance=False)
    assert o["engine_provenance_digest"] is None and o["report_date"] is None
    assert review(db, o["id"]).returncode == 0
    assert export_rows(db, f"id = '{o['id']}'") == []


def test_the_case_revision_function_stores_the_provenance_it_is_given(db):
    t = new_case(db)
    assert scalar(db, f"select engine_provenance->>'digest' from power_deployment_cases where case_token = '{t}'") == DIGEST
    t2 = new_case(db, provenance=False)
    assert scalar(db, f"select coalesce(engine_provenance::text, 'null') from power_deployment_cases where case_token = '{t2}'") == "null"


# ---------------------------------------------------------------------------------------------- E. the export view

COLUMNS = ["id", "key", "observed_value", "predicted_value", "unit", "site_ref", "measurement_kind", "evidence_sha256",
           "engine_provenance_digest", "report_date", "observed_on", "method", "evidence_class", "reviewed_by", "reviewed_at"]


def test_a_fully_cleared_observation_is_exported_and_nothing_else_is(db):
    _, _, good = submitted(db)
    assert review(db, good["id"]).returncode == 0
    rows = export_rows(db, f"id = '{good['id']}'")
    assert len(rows) == 1 and list(rows[0].keys()) == COLUMNS
    row = rows[0]
    assert row["key"] == "btm.firm_MW" and row["unit"] == "MW" and row["evidence_class"] == "E5"
    assert row["evidence_sha256"] == "a" * 64 and row["engine_provenance_digest"] == DIGEST
    assert row["reviewed_by"] == "J. Ortiz" and row["site_ref"] == site_only_ref("Dublin DC1")
    assert row["measurement_kind"] == "metered"

    # each one of these stays out, for its own reason
    _, _, unreviewed = submitted(db)
    _, _, rejected = submitted(db)
    review(db, rejected["id"], decision="rejected", cls=None)
    _, ev, flipped = submitted(db)
    review(db, flipped["id"])
    psql(db, f"update project_evidence set review_status = 'rejected' where id = '{ev}'")       # evidence withdrawn afterwards
    _, ev2, swapped = submitted(db)
    review(db, swapped["id"])
    psql(db, f"update project_evidence set sha256 = repeat('e', 64) where id = '{ev2}'")        # evidence replaced afterwards
    _, _, legacy_kind = submitted(db, measurement_kind=None)
    review(db, legacy_kind["id"])
    out = {r["id"] for r in export_rows(db)}
    assert good["id"] in out
    for other in (unreviewed, rejected, flipped, swapped, legacy_kind):
        assert other["id"] not in out, other["id"]


def test_the_export_is_empty_on_a_database_with_no_reviewed_observation_and_so_is_a_submitted_one(db):
    name = f"gf_{uuid.uuid4().hex[:10]}"
    psql("postgres", f"create database {name}")
    try:
        psql(name, "create extension if not exists pgcrypto")
        psql(name, "create schema if not exists storage;"
                   "create table if not exists storage.buckets (id text primary key, name text, public boolean)")
        for f in sorted(MIGRATIONS.glob("*.sql")):
            psql(name, file=f)
        assert export_rows(name) == []
        _, _, o = submitted(name)                       # submitted, never reviewed
        assert o["id"] and export_rows(name) == []
    finally:
        psql("postgres", f"drop database {name} with (force)")


def test_a_pre_0038_review_with_no_evidence_snapshot_is_not_exportable(db):
    _, _, o = submitted(db)
    psql(db, "insert into project_observation_reviews (observation_id, project_id, decision, evidence_class, reviewer)"
             f" select id, project_id, 'verified', 'E5', 'Old Reviewer' from project_observations where id = '{o['id']}'")
    assert export_rows(db, f"id = '{o['id']}'") == []


def test_the_view_is_for_the_service_role_alone(db):
    for role in ("anon", "authenticated"):
        assert scalar(db, f"select has_table_privilege('{role}', 'public.calibration_ledger_rows', 'select')") == "f", role
        assert scalar(db, f"select has_function_privilege('{role}', 'public.gf_review_observation(jsonb, jsonb)', 'execute')") == "f"
        assert scalar(db, f"select has_function_privilege('{role}', 'public.gf_submit_observation(jsonb, jsonb)', 'execute')") == "f"
        assert scalar(db, f"select has_function_privilege('{role}', 'public.gf_review_supplier_actual(jsonb, jsonb)', 'execute')") == "f"
    assert scalar(db, "select has_table_privilege('service_role', 'public.calibration_ledger_rows', 'select')") == "t"
    assert scalar(db, "select has_function_privilege('service_role', 'public.gf_review_observation(jsonb, jsonb)', 'execute')") == "t"
    assert scalar(db, "select relrowsecurity from pg_class where relname = 'project_observations'") == "t"
    assert scalar(db, "select relrowsecurity from pg_class where relname = 'project_observation_reviews'") == "t"


def test_the_sql_mw_rule_names_exactly_the_engines_mw_keys(db):
    from gridforge.calibration.keys import UNIT_OF
    assert {k for k, u in UNIT_OF.items() if u == "MW"} == {"btm.firm_MW"}
    assert "calibration_key <> 'btm.firm_MW' or unit = 'MW'" in MIGRATION.read_text()


def test_the_exported_rows_pass_the_ledgers_own_import_policy_end_to_end(db, tmp_path):
    """SQL view -> JSON -> `import_export` -> hash-chained ledger: the two halves agree on every column name."""
    from gridforge.calibration.ledger import EXPORT_SCHEMA, import_export, read_chain
    ids = []
    for site in ("Site One", "Site Two", "Site Three"):
        _, _, o = submitted(db, site=site)
        assert review(db, o["id"]).returncode == 0
        ids.append(o["id"])
    rows = [r for r in export_rows(db) if r["id"] in ids]
    assert len(rows) == 3
    ledger = tmp_path / "led.json"
    out = import_export({"schema": EXPORT_SCHEMA, "rows": rows}, ledger)
    assert out["imported"] == 3
    obs, head = read_chain(ledger)
    assert {o.source_ref.split(":")[0] for o in obs} == set(ids) and head
    assert all(o.model_digest == DIGEST and o.reviewed_by == "J. Ortiz" for o in obs)


# ---------------------------------------------------------------------------------------------- supplier actuals

def supplier_actual(db, evidence_verified=True):
    project = new_project(db)
    psql(db, f"select gf_create_package(jsonb_build_object('package_token', '{uuid.uuid4().hex[:12]}', 'project_id', '{project}',"
             " 'case_token', 'c', 'case_revision', 1, 'architecture', 'A', 'spec_summary', '{}'::jsonb,"
             " 'response_template', '{}'::jsonb, 'document_md', 'm', 'document_html', 'h'),"
             f" '{GOOD % 'rfq_generated'}'::jsonb)")
    pkg = scalar(db, f"select id from procurement_packages where project_id = '{project}'")
    psql(db, f"select gf_add_response(jsonb_build_object('package_id', '{pkg}', 'project_id', '{project}',"
             " 'supplier', 'Voltek', 'response', jsonb_build_object('values', jsonb_build_object('capex_eur', 4000000,"
             " 'lead_time_weeks', 20, 'install_weeks', 6))), '" + GOOD % "supplier_response_received" + "'::jsonb)")
    resp = scalar(db, f"select id from procurement_responses where package_id = '{pkg}'")
    psql(db, f"select gf_select_supplier('{pkg}', jsonb_build_object('selected_supplier', 'Voltek',"
             f" 'selected_response_id', '{resp}', 'selected_at', now()::text, 'selected_by', 'buyer'),"
             f" '{GOOD % 'supplier_selected'}'::jsonb)")
    ev = new_evidence(db, project, verified=evidence_verified)
    p = json.dumps({"project_id": project, "package_id": pkg, "po_date": "2026-01-05", "on_site_date": "2026-06-01",
                    "evidence_id": ev, "method": "delivery note", "submitted_by": "A. Rivera",
                    "submitted_by_ref": hashlib.sha256(project.encode()).hexdigest()})
    r = psql(db, f"select gf_submit_supplier_actual('{p}'::jsonb, '{GOOD % 'supplier_actual_submitted'}'::jsonb)", check=False)
    return r


def review_actual(db, aid, decision="verified", fields=("po_date", "on_site_date"), reviewer="J. Ortiz"):
    p = json.dumps({"actual_id": aid, "decision": decision, "verified_fields": list(fields) if decision == "verified" else [],
                    "reviewer": reviewer, "reason": "checked"})
    return psql(db, f"select gf_review_supplier_actual('{p}'::jsonb, '{GOOD % 'supplier_actual_reviewed'}'::jsonb)", check=False)


def test_supplier_actual_reviews_follow_the_same_two_rules(db):
    sub = supplier_actual(db, evidence_verified=False)
    assert sub.returncode == 0, sub.stderr
    a = json.loads(sub.stdout)
    assert a["submitted_by_ref"]
    assert "cannot be reviewed by the person who submitted" in review_actual(db, a["id"], reviewer="a. rivera").stderr
    assert "evidence artifact is not verified" in review_actual(db, a["id"]).stderr
    assert count(db, "supplier_actual_reviews") == 0
    assert review_actual(db, a["id"], decision="rejected", reviewer="J. Ortiz").returncode == 0


def test_a_verified_supplier_actual_review_needs_verified_evidence(db):
    sub = supplier_actual(db, evidence_verified=True)
    assert sub.returncode == 0, sub.stderr
    a = json.loads(sub.stdout)
    r = review_actual(db, a["id"])
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout)["evidence_sha256"] == "a" * 64


# ---------------------------------------------------------------------------------------------- idempotence

def test_applying_the_migration_again_changes_nothing(db):
    _, _, o = submitted(db)
    review(db, o["id"])
    before = (count(db, "project_observations"), count(db, "project_observation_reviews"), len(export_rows(db)))
    psql(db, file=MIGRATION)
    psql(db, file=MIGRATION)
    assert (count(db, "project_observations"), count(db, "project_observation_reviews"), len(export_rows(db))) == before
    r = psql(db, "truncate public.project_observations cascade", check=False)
    assert r.returncode != 0 and "append-only" in r.stderr
