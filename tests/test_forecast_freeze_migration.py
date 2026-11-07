"""0046_freeze_the_forecast.sql against a REAL PostgreSQL.

A forecast (a power_deployment_cases revision) is the thing an observation is judged against. Until 0046 it was immutable only by
convention: nothing stopped a service-role caller rewriting a revision's request, result or provenance after the outcome was known, or
back-dating one, and nothing compared the revision's creation time with the date of the outcome. This attacks the three doors a careless or
hostile service-role caller has: the row (UPDATE / DELETE / TRUNCATE), the clock (an inserted created_at) and the observation (a forecast
made AFTER the measurement). Every value is a SYNTHETIC fixture.

See tests/calibration_pg_rig.py for how the database is built and for GRIDFORGE_MIGRATIONS_UPTO (set to 0045 to watch these fail on the base).
"""
import json
import uuid

import pytest

from calibration_pg_rig import (
    DIGEST, GOOD, as_anon, as_service_role, bypassing_triggers, count, database_fixture, new_case, new_project,
    psql, scalar, skip_without_db, submit, submitted,
)

pytestmark = skip_without_db
db = database_fixture()

CASE_COLS = ["id", "case_token", "revision", "request", "result", "changed_fields", "engine_provenance", "created_at", "case_digest"]


def one_case(db, **kw):
    token = new_case(db, **kw)
    return token


# ---------------------------------------------------------------------------------------------- A. the row cannot be rewritten

@pytest.mark.parametrize("assignment", [
    "request = '{\"target_MW\": 1}'::jsonb",
    "result = '{\"architectures\": []}'::jsonb",
    "engine_provenance = '{\"digest\": \"" + "e" * 64 + "\"}'::jsonb",
    "created_at = now() - interval '400 days'",
    "case_token = 'another'",
    "revision = 7",
    "changed_fields = '{x}'",
    "case_digest = '" + "f" * 64 + "'",
    "id = gen_random_uuid()",
])
def test_a_forecast_cannot_be_rewritten(db, assignment):
    t = one_case(db)
    before = scalar(db, f"select to_jsonb(c)::text from power_deployment_cases c where case_token = '{t}'")
    for runner in (psql, as_service_role):
        r = runner(db, f"update power_deployment_cases set {assignment} where case_token = '{t}'", check=False)
        assert r.returncode != 0, (runner.__name__, assignment)
        assert "immutable" in r.stderr, r.stderr
    assert scalar(db, f"select to_jsonb(c)::text from power_deployment_cases c where case_token = '{t}'") == before


def test_only_contact_metadata_may_change_on_a_revision(db):
    """The one legitimate edit a person could ask for: the contact fields (erasure of an e-mail, a corrected company name)."""
    t = one_case(db)
    psql(db, f"update power_deployment_cases set email = 'a@example.test', company = 'Acme', project_name = 'Hall B' where case_token = '{t}'")
    assert scalar(db, f"select email || '|' || company || '|' || project_name from power_deployment_cases where case_token = '{t}'") == "a@example.test|Acme|Hall B"
    psql(db, f"update power_deployment_cases set email = null where case_token = '{t}'")
    # ...and that update must not smuggle a forecast column through with it
    r = psql(db, f"update power_deployment_cases set email = 'x@example.test', result = '[1]'::jsonb where case_token = '{t}'", check=False)
    assert r.returncode != 0 and "immutable" in r.stderr


def test_a_revision_cannot_be_deleted(db):
    t = one_case(db)
    for runner in (psql, as_service_role):
        r = runner(db, f"delete from power_deployment_cases where case_token = '{t}'", check=False)
        assert r.returncode != 0 and "immutable" in r.stderr, runner.__name__
    assert count(db, "power_deployment_cases", f"case_token = '{t}'") == 1


def test_the_table_cannot_be_truncated(db):
    one_case(db)
    for sql in ("truncate public.power_deployment_cases", "truncate public.power_deployment_cases cascade"):
        r = psql(db, sql, check=False)
        assert r.returncode != 0 and "append-only" in r.stderr, sql
    assert count(db, "power_deployment_cases") >= 1


# ---------------------------------------------------------------------------------------------- B. the digest

def test_the_database_sets_a_digest_of_the_request_and_result_at_insert(db):
    t = one_case(db, request='{"target_MW": 35}', result='{"architectures": [{"label": "A", "available_MW": 30}]}')
    d = scalar(db, f"select case_digest from power_deployment_cases where case_token = '{t}'")
    assert len(d) == 64 and all(ch in "0123456789abcdef" for ch in d)
    assert d == scalar(db, "select encode(sha256(convert_to(jsonb_build_object('request', request, 'result', result)::text, 'UTF8')), 'hex')"
                           f" from power_deployment_cases where case_token = '{t}'")


def test_the_digest_follows_the_content_not_the_identity_or_the_key_order(db):
    a = one_case(db, request='{"a": 1, "b": 2}', result='{"x": [1, 2]}')
    b = one_case(db, request='{"b": 2, "a": 1}', result='{"x": [1, 2]}')       # same content, other key order, other case
    c = one_case(db, request='{"a": 1, "b": 3}', result='{"x": [1, 2]}')       # one value different
    da, db_, dc = (scalar(db, f"select case_digest from power_deployment_cases where case_token = '{t}'") for t in (a, b, c))
    assert da == db_ and da != dc


def test_a_caller_cannot_choose_the_digest(db):
    t = uuid.uuid4().hex
    psql(db, "insert into power_deployment_cases (case_token, revision, request, result, case_digest)"
             f" values ('{t}', 1, '{{}}', '{{}}', '{'0' * 64}')")
    assert scalar(db, f"select case_digest from power_deployment_cases where case_token = '{t}'") != "0" * 64


def test_the_digest_column_refuses_a_malformed_value_at_the_table_level(db):
    t = uuid.uuid4().hex
    r = psql(db, "set session_replication_role = replica; insert into power_deployment_cases (case_token, revision, request, result, case_digest)"
                 f" values ('{t}', 1, '{{}}', '{{}}', 'not-hex')", check=False)
    assert r.returncode != 0 and "case_digest" in r.stderr


def test_a_revision_written_by_the_real_function_still_emits_its_events_and_keeps_provenance(db):
    project = new_project(db)
    t = one_case(db)
    psql(db, f"insert into project_links (project_id, object_type, object_id) values ('{project}', 'power_deployment_case', '{t}')")
    out = json.loads(scalar(db, "select gf_append_case_revision(jsonb_build_object('case_token', '" + t + "', 'revision', 2, 'request', '{}'::jsonb,"
                                " 'result', '{}'::jsonb, 'changed_fields', '[\"x\"]'::jsonb), '" + GOOD % "btm_case_revised" + "'::jsonb)"))
    assert out["events"] == 1 and out["row"]["case_digest"] and out["row"]["revision"] == 2
    assert scalar(db, f"select engine_provenance->>'digest' from power_deployment_cases where case_token = '{t}' and revision = 1") == DIGEST


# ---------------------------------------------------------------------------------------------- C. the clock is the database's

@pytest.mark.parametrize("when", ["now() - interval '3 days'", "now() + interval '3 days'", "'2020-01-01T00:00:00Z'::timestamptz"])
def test_a_revision_cannot_be_inserted_with_a_back_dated_or_future_timestamp(db, when):
    t = uuid.uuid4().hex
    r = psql(db, f"insert into power_deployment_cases (case_token, revision, request, result, created_at) values ('{t}', 1, '{{}}', '{{}}', {when})", check=False)
    assert r.returncode != 0 and "assigned by the database" in r.stderr, r.stderr
    assert count(db, "power_deployment_cases", f"case_token = '{t}'") == 0


def test_a_revision_inserted_without_a_timestamp_gets_the_databases_own(db):
    t = uuid.uuid4().hex
    psql(db, f"insert into power_deployment_cases (case_token, revision, request, result) values ('{t}', 1, '{{}}', '{{}}')")
    assert scalar(db, f"select abs(extract(epoch from now() - created_at)) < 60 from power_deployment_cases where case_token = '{t}'") == "t"


def test_an_explicit_timestamp_equal_to_now_is_accepted(db):
    t = uuid.uuid4().hex
    psql(db, f"insert into power_deployment_cases (case_token, revision, request, result, created_at) values ('{t}', 1, '{{}}', '{{}}', now())")
    assert count(db, "power_deployment_cases", f"case_token = '{t}'") == 1


# ---------------------------------------------------------------------------------------------- D. forecast must predate the outcome

def test_an_observation_against_a_forecast_made_after_the_outcome_is_refused(db):
    # the forecast is made now; the outcome is dated yesterday
    t = new_case(db)
    _, _, r = submit(db, case_token=t, evidence_verified=False, on="2026-11-06")
    assert r.returncode != 0
    assert "forecast must predate the outcome" in r.stderr, r.stderr
    assert count(db, "project_observations", f"case_token = '{t}'") == 0


def test_the_refusal_carries_the_stable_code(db):
    t = new_case(db)
    project = new_project(db)
    from calibration_pg_rig import new_evidence, obs_args
    ev = new_evidence(db, project, verified=False)
    r = psql(db, f"select gf_submit_observation('{obs_args(project, ev, t, observed_on='2020-01-01')}'::jsonb,"
                 f" '{GOOD % 'observation_submitted'}'::jsonb)", check=False, sqlstate=True)
    assert r.returncode != 0 and "GF004" in r.stderr, r.stderr


def test_an_observation_against_a_forecast_made_before_the_outcome_is_accepted(db):
    _, _, o = submitted(db, evidence_verified=False, on="2026-06-30", case_created_at="2026-06-29T23:59:59Z")
    assert o["observed_on"] == "2026-06-30"


@pytest.mark.parametrize("created_at", ["2026-06-30T00:00:00Z", "2026-06-30T08:00:00Z", "2026-07-01T00:00:00Z"])
def test_a_forecast_made_on_the_day_of_the_outcome_does_not_predate_it(db, created_at):
    t = new_case(db, created_at=created_at)
    _, _, r = submit(db, case_token=t, evidence_verified=False, on="2026-06-30")
    assert r.returncode != 0 and "forecast must predate the outcome" in r.stderr, created_at


def test_an_observation_that_names_no_stored_forecast_revision_is_refused(db):
    _, _, r = submit(db, case_token=uuid.uuid4().hex, evidence_verified=False)
    assert r.returncode != 0 and "forecast must predate the outcome" in r.stderr and "no stored revision" in r.stderr, r.stderr


def test_a_forecast_with_no_recorded_creation_time_cannot_be_shown_to_predate(db):
    t = new_case(db)
    bypassing_triggers(db, f"update power_deployment_cases set created_at = null where case_token = '{t}'")
    _, _, r = submit(db, case_token=t, evidence_verified=False)
    assert r.returncode != 0 and "forecast must predate the outcome" in r.stderr


def test_the_rule_binds_a_direct_insert_too_not_only_the_function(db):
    t = new_case(db)
    project, ev, ok = submit(db, evidence_verified=False)
    assert ok.returncode == 0
    r = psql(db, "insert into project_observations (project_id, prediction_ref, case_token, case_revision, architecture, calibration_key, unit,"
                 " predicted_value, predicted_source, observed_value, observed_on, method, evidence_id, installed_attested, installed_basis, submitted_by)"
                 f" values ('{project}', 'power_deployment_case:{t}:r1:ARCH', '{t}', 1, 'ARCH', 'btm.firm_MW', 'MW', 30, 's', 28, '2026-06-30', 'm', '{ev}',"
                 " true, 'b', 'x')", check=False)
    assert r.returncode != 0 and "forecast must predate the outcome" in r.stderr


def test_observations_written_before_the_rule_are_not_rewritten_by_it(db):
    """The trigger fires on INSERT only: it never touches a stored observation (those stay append-only, 0017)."""
    _, _, o = submitted(db, evidence_verified=False)
    r = psql(db, f"update project_observations set method = 'x' where id = '{o['id']}'", check=False)
    assert r.returncode != 0 and "append-only" in r.stderr
    assert count(db, "project_observations", f"id = '{o['id']}'") == 1


# ---------------------------------------------------------------------------------------------- E. housekeeping

def test_the_migration_is_idempotent_and_leaves_the_roles_as_they_were(db):
    from calibration_pg_rig import MIGRATIONS
    f = next(MIGRATIONS.glob("0046_*.sql"))
    psql(db, file=f)
    psql(db, file=f)
    assert as_anon(db, "select count(*) from power_deployment_cases").returncode != 0           # anon still reads nothing
    assert as_service_role(db, "select count(*) from power_deployment_cases").returncode == 0
    assert scalar(db, "select relrowsecurity from pg_class where oid = 'public.power_deployment_cases'::regclass") == "t"
    assert scalar(db, "select count(*) from pg_policies where tablename = 'power_deployment_cases'") == "0"


def test_the_migration_carries_no_destructive_statement_and_says_it_is_not_applied():
    import glob
    import importlib.util
    from calibration_pg_rig import ROOT
    f = glob.glob(str(ROOT / "supabase" / "migrations" / "0046_*.sql"))[0]
    sql = open(f).read()
    assert "WRITTEN, NOT APPLIED" in sql
    spec = importlib.util.spec_from_file_location("am", ROOT / "scripts" / "apply-migration.py")
    am = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(am)
    assert am.destructive_statements(sql) == []
