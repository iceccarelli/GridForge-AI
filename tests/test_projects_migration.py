"""0015_projects.sql against a real PostgreSQL.

The site's tests use an in-memory PostgREST, which cannot run a trigger — so "events
are append-only" and "a package's selection is set once" would only ever be asserted
against the fake's own rules. This applies the real migration to a throwaway database
and attacks it with UPDATE and DELETE, the way a careless service-role caller would.

Needs a reachable PostgreSQL (`psql` plus the standard PG* variables, or
GRIDFORGE_TEST_PG_URL pointing at a server you can create a database on). Skipped,
loudly, where there is none: a skip here is a gap in what was checked, not a pass.
"""
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

MIGRATIONS = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
BASE = os.environ.get("GRIDFORGE_TEST_PG_URL", "")

#: In CI the database is mandatory: GRIDFORGE_REQUIRE_DB=1 turns "no database" from a skip into a FAILURE,
#: so a missing or misconfigured service can never turn an untested invariant into a green run.
REQUIRED = os.environ.get("GRIDFORGE_REQUIRE_DB") == "1"
_NO_DB = shutil.which("psql") is None or not (BASE or os.environ.get("PGHOST"))

pytestmark = pytest.mark.skipif(
    _NO_DB and not REQUIRED,
    reason="no PostgreSQL available (set GRIDFORGE_TEST_PG_URL or PGHOST)")


@pytest.fixture(scope="module", autouse=True)
def _database_is_reachable():
    """Fails (never skips) when the database is required and cannot be reached."""
    if not REQUIRED:
        return
    assert not _NO_DB, "GRIDFORGE_REQUIRE_DB=1 but psql or PGHOST/GRIDFORGE_TEST_PG_URL is missing"
    r = subprocess.run(["psql", "-At", "-X", "-c", "select 1"] + ([BASE + "/postgres"] if BASE else ["-d", "postgres"]),
                       capture_output=True, text=True)
    assert r.returncode == 0 and r.stdout.strip() == "1", f"required PostgreSQL is unreachable: {r.stderr}"


def psql(db, sql=None, file=None, check=True):
    cmd = ["psql", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-X"]
    cmd += [f"{BASE}/{db}"] if BASE else ["-d", db]
    cmd += ["-c", sql] if sql else ["-f", str(file)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode:
        raise AssertionError(r.stderr)
    return r


@pytest.fixture(scope="module")
def db():
    name = f"gf_{uuid.uuid4().hex[:10]}"
    psql("postgres", f"create database {name}")
    psql(name, "create table public.qualifications (id uuid primary key default gen_random_uuid())")
    for f in ("0003_deliverables.sql", "0014_power_deployment_cases.sql", "0015_projects.sql",
              "0016_project_purchases.sql", "0017_project_observations.sql",
              "0018_supplier_reality.sql", "0019_engagement_deposits.sql"):
        psql(name, file=MIGRATIONS / f)
    psql(name, "insert into projects (project_token, project_name) values ('t', 'Hall A');"
               "insert into project_events (project_id, event_type, actor) "
               "select id, 'project_created', 'x' from projects")
    yield name
    psql("postgres", f"drop database {name}")


def refused(db, sql, needle):
    r = psql(db, sql, check=False)
    assert r.returncode != 0, f"expected refusal: {sql}"
    assert needle in r.stderr, r.stderr


def test_events_cannot_be_updated_or_deleted_even_by_the_service_role(db):
    refused(db, "update project_events set actor = 'y'", "append-only")
    refused(db, "delete from project_events", "append-only")
    assert psql(db, "select count(*) from project_events").stdout.strip() == "1"


def test_responses_and_comparisons_are_append_only_too(db):
    psql(db, "insert into procurement_packages (package_token, project_id, case_token, case_revision,"
             " architecture, spec_summary, response_template, document_md, document_html)"
             " select 'p', id, 'c', 1, 'A', '{}', '{}', 'm', 'h' from projects;"
             "insert into procurement_responses (package_id, project_id, supplier, response)"
             " select id, project_id, 'S', '{}' from procurement_packages;"
             "insert into procurement_comparisons (package_id, project_id, case_token, case_revision,"
             " architecture, response_ids, result)"
             " select id, project_id, 'c', 1, 'A', '[]', '{}' from procurement_packages")
    refused(db, "update procurement_responses set supplier = 'T'", "append-only")
    refused(db, "delete from procurement_comparisons", "append-only")
    refused(db, "insert into procurement_responses (package_id, project_id, supplier, response)"
                " select package_id, project_id, 'S', '{}' from procurement_responses",
            "duplicate key")                  # one response per supplier, case-insensitively
    refused(db, "insert into procurement_responses (package_id, project_id, supplier, response)"
                " select package_id, project_id, 's', '{}' from procurement_responses",
            "duplicate key")


def test_a_package_can_only_ever_gain_one_selection(db):
    refused(db, "update procurement_packages set architecture = 'B'", "only the supplier selection")
    psql(db, "update procurement_packages set selected_supplier = 'S', selected_by = 'me',"
             " selected_at = now()")
    refused(db, "update procurement_packages set selected_supplier = 'T'", "already selected")
    refused(db, "delete from procurement_packages", "cannot be deleted")


def test_a_link_is_unique_and_a_calibration_link_needs_its_prediction(db):
    psql(db, "insert into project_links (project_id, object_type, object_id)"
             " select id, 'power_deployment_case', 'c1' from projects")
    refused(db, "insert into project_links (project_id, object_type, object_id)"
                " select id, 'power_deployment_case', 'c1' from projects", "duplicate key")
    refused(db, "insert into project_links (project_id, object_type, object_id)"
                " select id, 'calibration_observation', 'o1' from projects", "violates check")
    assert psql(db, "select count(*) from project_links where object_type ="
                    " 'calibration_observation'").stdout.strip() == "0"


def test_evidence_is_constrained_to_the_three_types_and_starts_unverified(db):
    base = ("insert into project_evidence (project_id, filename, media_type, sha256, byte_size,"
            " storage_ref) select id, 'f', '{t}', repeat('a', 64), {n}, 'b/x' from projects")
    refused(db, base.format(t="image/png", n=10), "media_type")
    refused(db, base.format(t="application/pdf", n=5242881), "byte_size")
    psql(db, base.format(t="application/pdf", n=10))
    out = psql(db, "select review_status || '/' || coalesce(evidence_class, 'none')"
                   " from project_evidence").stdout
    assert "unverified/none" in out


# --- atomic business writes (the gf_* functions) -----------------------------------------

def scalar(db, sql):
    return psql(db, sql).stdout.strip()


def count(db, table, where="true"):
    return int(scalar(db, f"select count(*) from {table} where {where}"))


GOOD = '{"event_type": "%s", "actor": "someone", "payload": {}}'
NO_ACTOR = '{"event_type": "supplier_response_received", "payload": {}}'
BAD_TYPE = '{"event_type": "made_up", "actor": "x", "payload": {}}'


@pytest.fixture()
def fresh():
    """A database of its own per test, so a rolled-back write cannot hide behind another test's rows."""
    name = f"gf_{uuid.uuid4().hex[:10]}"
    psql("postgres", f"create database {name}")
    psql(name, "create table public.qualifications (id uuid primary key default gen_random_uuid())")
    for f in ("0003_deliverables.sql", "0014_power_deployment_cases.sql", "0015_projects.sql",
              "0016_project_purchases.sql", "0017_project_observations.sql",
              "0018_supplier_reality.sql", "0019_engagement_deposits.sql"):
        psql(name, file=MIGRATIONS / f)
    yield name
    psql("postgres", f"drop database {name}")


def new_project(db, token="tok"):
    out = scalar(db, f"select gf_create_project('{{\"project_token\": \"{token}\", "
                     f"\"project_name\": \"Hall A\"}}'::jsonb, '{GOOD % 'project_created'}'::jsonb)")
    return __import__("json").loads(out)["id"]


def test_creating_a_project_writes_the_project_and_its_event_together(fresh):
    new_project(fresh)
    assert count(fresh, "projects") == 1
    assert scalar(fresh, "select event_type from project_events") == "project_created"


def test_a_project_is_not_created_when_its_event_is_refused(fresh):
    for bad in (BAD_TYPE, NO_ACTOR):
        r = psql(fresh, "select gf_create_project('{\"project_token\": \"t\", \"project_name\": \"x\"}'"
                        f"::jsonb, '{bad}'::jsonb)", check=False)
        assert r.returncode != 0
    assert count(fresh, "projects") == 0 and count(fresh, "project_events") == 0


def test_attaching_a_case_is_idempotent_and_exclusive(fresh):
    a = new_project(fresh, "a")
    b = new_project(fresh, "b")
    call = lambda p: scalar(fresh, f"select gf_attach_case('{p}', 'case1', '{GOOD % 'btm_case_attached'}'::jsonb)")
    assert '"created": true' in call(a)
    assert '"created": false' in call(a)                  # same project again: nothing written
    assert count(fresh, "project_links") == 1
    assert count(fresh, "project_events", "event_type = 'btm_case_attached'") == 1
    r = psql(fresh, f"select gf_attach_case('{b}', 'case1', '{GOOD % 'btm_case_attached'}'::jsonb)", check=False)
    assert r.returncode != 0 and "one_project_per_object" in r.stderr   # another project: refused by the database
    assert count(fresh, "project_links") == 1
    # a refused event rolls the link back with it
    r = psql(fresh, f"select gf_attach_case('{b}', 'case2', '{BAD_TYPE}'::jsonb)", check=False)
    assert r.returncode != 0 and count(fresh, "project_links") == 1


def _package(db, project):
    psql(db, f"select gf_create_package(jsonb_build_object('package_token', 'pk', 'project_id', '{project}',"
             " 'case_token', 'c', 'case_revision', 1, 'architecture', 'A', 'spec_summary', '{}'::jsonb,"
             " 'response_template', '{}'::jsonb, 'document_md', 'm', 'document_html', 'h'),"
             f" '{GOOD % 'rfq_generated'}'::jsonb)")
    return scalar(db, "select id from procurement_packages")


def test_the_package_its_link_and_its_event_are_one_write(fresh):
    p = new_project(fresh)
    _package(fresh, p)
    assert count(fresh, "project_links", "object_type = 'procurement_package'") == 1
    assert count(fresh, "project_events", "event_type = 'rfq_generated'") == 1
    r = psql(fresh, "select gf_create_package(jsonb_build_object('package_token', 'pk2', 'project_id',"
                    f" '{p}', 'case_token', 'c', 'case_revision', 1, 'architecture', 'A', 'spec_summary',"
                    " '{}'::jsonb, 'response_template', '{}'::jsonb, 'document_md', 'm', 'document_html', 'h'),"
                    f" '{BAD_TYPE}'::jsonb)", check=False)
    assert r.returncode != 0
    assert count(fresh, "procurement_packages") == 1 and count(fresh, "project_links") == 1


def test_a_response_and_a_comparison_are_never_stored_without_their_event(fresh):
    p = new_project(fresh)
    pkg = _package(fresh, p)
    resp = lambda ev: (f"select gf_add_response(jsonb_build_object('package_id', '{pkg}', 'project_id', '{p}',"
                       f" 'supplier', 'S', 'response', '{{}}'::jsonb), '{ev}'::jsonb)")
    assert psql(fresh, resp(NO_ACTOR), check=False).returncode != 0
    assert count(fresh, "procurement_responses") == 0       # no ghost row to block the retry
    psql(fresh, resp(GOOD % "supplier_response_received"))
    assert count(fresh, "procurement_responses") == 1
    assert "response_id" in scalar(fresh, "select payload::text from project_events where event_type = 'supplier_response_received'")

    cmp = lambda ev: (f"select gf_add_comparison(jsonb_build_object('package_id', '{pkg}', 'project_id', '{p}',"
                      " 'case_token', 'c', 'case_revision', 1, 'architecture', 'A', 'response_ids', '[]'::jsonb,"
                      f" 'result', '{{}}'::jsonb), '{ev}'::jsonb)")
    assert psql(fresh, cmp(BAD_TYPE), check=False).returncode != 0
    assert count(fresh, "procurement_comparisons") == 0
    psql(fresh, cmp(GOOD % "comparison_completed"))
    assert count(fresh, "procurement_comparisons") == 1


def test_selection_happens_once_and_only_with_its_event(fresh):
    p = new_project(fresh)
    pkg = _package(fresh, p)
    sel = lambda ev, who="S": (f"select gf_select_supplier('{pkg}', jsonb_build_object('selected_supplier', '{who}',"
                               " 'selected_at', now()::text, 'selected_by', 'me'), "
                               f"'{ev}'::jsonb)")
    assert psql(fresh, sel(NO_ACTOR), check=False).returncode != 0
    assert scalar(fresh, "select coalesce(selected_supplier, 'none') from procurement_packages") == "none"
    assert scalar(fresh, sel(GOOD % "supplier_selected")).startswith("{")
    assert scalar(fresh, "select selected_supplier from procurement_packages") == "S"
    assert scalar(fresh, sel(GOOD % "supplier_selected", "T")) == ""      # SQL null: nothing written
    assert scalar(fresh, "select selected_supplier from procurement_packages") == "S"
    assert count(fresh, "project_events", "event_type = 'supplier_selected'") == 1


def test_evidence_row_and_event_are_one_write_and_start_unverified(fresh):
    p = new_project(fresh)
    ev = lambda e: ("select gf_add_evidence(jsonb_build_object('project_id', '" + p + "', 'filename', 'f.pdf',"
                    " 'media_type', 'application/pdf', 'sha256', repeat('a', 64), 'byte_size', 10,"
                    f" 'storage_ref', 'b/x'), '{e}'::jsonb)")
    assert psql(fresh, ev(BAD_TYPE), check=False).returncode != 0
    assert count(fresh, "project_evidence") == 0
    psql(fresh, ev(GOOD % "evidence_attached"))
    assert scalar(fresh, "select review_status || '/' || coalesce(evidence_class, 'null') from project_evidence") == "unverified/null"
    r = psql(fresh, ev(GOOD % "evidence_attached").replace("'application/pdf'", "'image/png'"), check=False)
    assert r.returncode != 0 and count(fresh, "project_evidence") == 1


def test_a_case_revision_and_each_owning_projects_event_are_one_write(fresh):
    a = new_project(fresh, "a")
    psql(fresh, f"select gf_attach_case('{a}', 'c1', '{GOOD % 'btm_case_attached'}'::jsonb)")
    base = ("select gf_append_case_revision(jsonb_build_object('case_token', 'c1', 'revision', %d,"
            " 'request', '{}'::jsonb, 'result', '{}'::jsonb, 'changed_fields', '[\"target_MW\"]'::jsonb), '%s'::jsonb)")
    psql(fresh, "insert into power_deployment_cases (case_token, revision, request, result)"
                " values ('c1', 1, '{}', '{}')")
    assert psql(fresh, base % (2, BAD_TYPE), check=False).returncode != 0
    assert count(fresh, "power_deployment_cases") == 1            # revision 2 was rolled back
    out = scalar(fresh, base % (2, GOOD % "btm_case_revised"))
    assert '"events": 1' in out and count(fresh, "power_deployment_cases") == 2
    assert "target_MW" in scalar(fresh, "select payload::text from project_events where event_type = 'btm_case_revised'")


def test_every_project_table_has_rls_on_and_no_policy(fresh):
    tables = "'projects','project_links','project_evidence','project_events','procurement_packages'," \
             "'procurement_responses','procurement_comparisons'"
    assert count(fresh, "pg_class", f"relname in ({tables}) and relrowsecurity") == 7
    assert count(fresh, "pg_policies", f"tablename in ({tables})") == 0


def test_only_the_service_role_may_call_the_write_functions(fresh):
    if count(fresh, "pg_roles", "rolname in ('anon', 'service_role')") != 2:
        pytest.skip("this cluster has no Supabase roles (anon, service_role) to check grants against")
    for fn in ("gf_create_project(jsonb, jsonb)", "gf_add_evidence(jsonb, jsonb)"):
        assert scalar(fresh, f"select has_function_privilege('service_role', 'public.{fn}', 'execute')") == "t"
        assert scalar(fresh, f"select has_function_privilege('anon', 'public.{fn}', 'execute')") == "f"


# --- paid products attach to their project (0016) ------------------------------------------

PAID = ('{"event_type": "paid_product_attached", "actor": "stripe_webhook", "payload": '
        '{"kind": "density_screen", "stripe_session_id": "%s"}}')


def attach_purchase(db, project, otype, oid, session):
    otype_sql = f"'{otype}'" if otype else "null"
    oid_sql = f"'{oid}'" if oid else "null"
    return psql(db, f"select gf_attach_purchase('{project}', {otype_sql}, {oid_sql}, '{PAID % session}'::jsonb)",
                check=False)


def test_a_purchase_attaches_once_however_often_stripe_redelivers(fresh):
    p = new_project(fresh)
    first = attach_purchase(fresh, p, "deliverable", "d1", "cs_1")
    assert first.returncode == 0 and '"created": true' in first.stdout
    for _ in range(3):
        again = attach_purchase(fresh, p, "deliverable", "d1", "cs_1")
        assert again.returncode == 0 and '"created": false' in again.stdout
    assert count(fresh, "project_links", "object_type = 'deliverable'") == 1
    assert count(fresh, "project_events", "event_type = 'paid_product_attached'") == 1


def test_a_deposit_with_no_object_is_recorded_once_by_its_event_alone(fresh):
    p = new_project(fresh)
    assert '"created": true' in attach_purchase(fresh, p, None, None, "cs_dep").stdout
    assert '"created": false' in attach_purchase(fresh, p, None, None, "cs_dep").stdout
    assert count(fresh, "project_links") == 0
    assert count(fresh, "project_events", "event_type = 'paid_product_attached'") == 1


def test_one_stripe_session_cannot_be_attached_twice_even_with_a_different_object(fresh):
    p = new_project(fresh)
    attach_purchase(fresh, p, "deliverable", "d1", "cs_1")
    r = attach_purchase(fresh, p, "deliverable", "d2", "cs_1")      # same session, other object
    assert r.returncode == 0 and '"created": false' in r.stdout
    assert count(fresh, "project_links", "object_type = 'deliverable'") == 1   # the link rolled back with it


def test_a_purchased_object_is_never_moved_to_another_project(fresh):
    a = new_project(fresh, "a")
    b = new_project(fresh, "b")
    attach_purchase(fresh, a, "watch", "w1", "cs_1")
    r = attach_purchase(fresh, b, "watch", "w1", "cs_2")
    assert r.returncode != 0 and "one_project_per_object" in r.stderr
    assert scalar(fresh, "select project_id = '%s' from project_links where object_id = 'w1'" % a) == "t"
    assert count(fresh, "project_events", "event_type = 'paid_product_attached'") == 1


def test_a_purchase_for_a_missing_project_or_a_bad_object_type_writes_nothing(fresh):
    r = attach_purchase(fresh, "00000000-0000-4000-8000-00000000dead", "deliverable", "d1", "cs_1")
    assert r.returncode != 0 and "foreign key" in r.stderr
    p = new_project(fresh)
    r = attach_purchase(fresh, p, "power_deployment_case", "c1", "cs_2")
    assert r.returncode != 0
    assert count(fresh, "project_links") == 0 and count(fresh, "project_events", "event_type = 'paid_product_attached'") == 0


# --- observed outcomes (0017) ----------------------------------------------------------------

ARCH = "GRID + BESS + GENERATION"
REF = f"power_deployment_case:c1:r1:{ARCH}"


def _evidence(db, project):
    psql(db, f"select gf_add_evidence(jsonb_build_object('project_id', '{project}', 'filename', 'f.csv', 'media_type',"
             f" 'text/csv', 'sha256', repeat('a', 64), 'byte_size', 10, 'storage_ref', 'b/x'),"
             f" '{GOOD % 'evidence_attached'}'::jsonb)")
    return scalar(db, f"select id from project_evidence where project_id = '{project}' order by uploaded_at desc limit 1")


def observation_args(project, evidence_id, **over):
    d = {"project_id": project, "prediction_ref": REF, "case_token": "c1", "case_revision": 1,
         "architecture": ARCH, "calibration_key": "btm.firm_MW", "unit": "MW", "predicted_value": 36.4,
         "predicted_source": 'result.architectures["x"].available_MW', "observed_value": 33,
         "observed_on": "2026-09-30", "method": "revenue meter", "submitted_by": "A. Rivera",
         "evidence_id": evidence_id, "installed_attested": True,
         "installed_basis": "commissioning certificate CC-114"}
    d.update(over)
    return __import__("json").dumps({k: v for k, v in d.items() if v is not None})


def submit_obs(db, project, event=None, evidence_id="auto", **over):
    """Submit an observation; by default against a fresh artifact attached to the same project."""
    if evidence_id == "auto":
        evidence_id = _evidence(db, project)
    ev = event or (GOOD % "observation_submitted")
    return psql(db, f"select gf_submit_observation('{observation_args(project, evidence_id, **over)}'::jsonb,"
                    f" '{ev}'::jsonb)", check=False)


def test_an_observation_computes_its_own_delta_and_is_saved_with_its_event(fresh):
    p = new_project(fresh)
    r = submit_obs(fresh, p)
    assert r.returncode == 0, r.stderr
    row = __import__("json").loads(r.stdout)
    assert round(row["delta_value"], 6) == -3.4 and round(row["delta_pct"], 3) == -9.341
    assert row["installed_attested"] is True
    assert count(fresh, "project_events", "event_type = 'observation_submitted'") == 1
    assert "delta_pct" in scalar(fresh, "select payload::text from project_events where event_type = 'observation_submitted'")


def test_an_observation_is_never_stored_without_its_event_or_with_bad_numbers(fresh):
    p = new_project(fresh)
    assert submit_obs(fresh, p, event=BAD_TYPE).returncode != 0
    assert count(fresh, "project_observations") == 0
    events = count(fresh, "project_events", "event_type <> 'evidence_attached'")
    for over, needle in (({"predicted_value": 0}, "predicted_value"),                 # a ratio needs a denominator
                         ({"observed_value": -1}, "observed_value"),
                         ({"method": "  "}, "method"),
                         ({"submitted_by": ""}, "submitted_by"),
                         ({"calibration_key": "btm.capex_eur"}, "calibration_key"),     # not a model prediction
                         ({"prediction_ref": "power_deployment_case:other:r1:x"}, "check")):
        r = submit_obs(fresh, p, **over)
        assert r.returncode != 0 and needle in r.stderr, (over, r.stderr)
    assert count(fresh, "project_observations") == 0
    # every refusal left no history: the only new events are the evidence the helper attached
    assert count(fresh, "project_events", "event_type <> 'evidence_attached'") == events


def test_an_observation_needs_its_source_artifact_and_an_installed_attestation(fresh):
    p = new_project(fresh)
    ev = _evidence(fresh, p)
    before = count(fresh, "project_events")
    refusals = (
        (dict(evidence_id=None), "needs an attached evidence artifact"),               # no source: an unrepairable dead end
        (dict(installed_attested=False), "must be attested"),                           # installation is attested, not inferred
        (dict(installed_attested=None), "must be attested"),
        (dict(installed_basis="  "), "installed_basis"),
        (dict(installed_basis=None), "installed_basis"),
    )
    for over, needle in refusals:
        r = submit_obs(fresh, p, evidence_id=over.pop("evidence_id", ev), **over)
        assert r.returncode != 0 and needle in r.stderr, (over, r.stderr)
    assert count(fresh, "project_observations") == 0 and count(fresh, "project_events") == before   # nothing, no event
    # the table itself refuses a row that skips the function
    r = psql(fresh, "insert into project_observations (project_id, prediction_ref, case_token, case_revision,"
                    " architecture, calibration_key, unit, predicted_value, predicted_source, observed_value,"
                    f" observed_on, method, submitted_by, installed_attested, installed_basis) values ('{p}', '{REF}',"
                    f" 'c1', 1, '{ARCH}', 'btm.firm_MW', 'MW', 36.4, 's', 33, '2026-09-30', 'm', 'x', true, 'b')",
            check=False)
    assert r.returncode != 0 and "evidence_id" in r.stderr
    # external procurement is fine: nothing here refers to a package or a supplier
    assert submit_obs(fresh, p, evidence_id=ev).returncode == 0


def test_the_same_prediction_is_counted_once_per_day(fresh):
    p = new_project(fresh)
    assert submit_obs(fresh, p).returncode == 0
    r = submit_obs(fresh, p, observed_value=34)
    assert r.returncode != 0 and "duplicate key" in r.stderr
    assert submit_obs(fresh, p, observed_on="2026-10-01").returncode == 0
    assert count(fresh, "project_observations") == 2


def test_evidence_must_belong_to_the_same_project(fresh):
    a, b = new_project(fresh, "a"), new_project(fresh, "b")
    ev_id = _evidence(fresh, a)
    r = submit_obs(fresh, b, evidence_id=ev_id)
    assert r.returncode != 0 and "does not belong" in r.stderr
    assert count(fresh, "project_observations") == 0
    assert submit_obs(fresh, a, evidence_id=ev_id).returncode == 0


def review_obs(db, oid, decision, cls=None, event=None, reviewer="J. Ortiz"):
    p = __import__("json").dumps({"observation_id": oid, "decision": decision, "evidence_class": cls,
                                  "reviewer": reviewer, "reason": "checked"})
    return psql(db, f"select gf_review_observation('{p}'::jsonb, '{event or GOOD % 'observation_reviewed'}'::jsonb)",
                check=False)


def test_a_review_is_one_immutable_human_decision_with_its_event(fresh):
    p = new_project(fresh)
    first = __import__("json").loads(submit_obs(fresh, p).stdout)["id"]
    second = __import__("json").loads(submit_obs(fresh, p, observed_on="2026-10-01").stdout)["id"]
    assert review_obs(fresh, first, "verified", None).returncode != 0          # a class is never defaulted
    assert review_obs(fresh, first, "rejected", "E5").returncode != 0          # a rejection carries none
    assert review_obs(fresh, first, "verified", "E9").returncode != 0
    assert review_obs(fresh, first, "verified", "E5", event=BAD_TYPE).returncode != 0
    assert count(fresh, "project_observation_reviews") == 0                    # every refusal left nothing
    assert review_obs(fresh, first, "verified", "E5").returncode == 0
    again = review_obs(fresh, first, "rejected")
    assert again.returncode != 0 and "duplicate key" in again.stderr           # a decision is never flipped
    assert count(fresh, "project_events", "event_type = 'observation_reviewed'") == 1
    assert review_obs(fresh, second, "rejected").returncode == 0
    assert review_obs(fresh, "00000000-0000-4000-8000-00000000dead", "rejected").returncode != 0


def test_observations_and_reviews_are_append_only(fresh):
    p = new_project(fresh)
    oid = __import__("json").loads(submit_obs(fresh, p).stdout)["id"]
    review_obs(fresh, oid, "verified", "E5")
    for sql in ("update project_observations set observed_value = 36.4", "delete from project_observations",
                "update project_observation_reviews set evidence_class = 'E7'", "delete from project_observation_reviews"):
        r = psql(fresh, sql, check=False)
        assert r.returncode != 0 and "append-only" in r.stderr, sql
    assert scalar(fresh, "select observed_value from project_observations") == "33"


# --- supplier reality (0018) ---------------------------------------------------------------

import json as _json

QUOTE = {"supplier": "Voltek", "values": {"capex_eur": 4000000, "lead_time_weeks": 20, "install_weeks": 6}}


def selected_package(db, project, response=QUOTE, select=True):
    pkg = _package(db, project)
    psql(db, f"select gf_add_response(jsonb_build_object('package_id', '{pkg}', 'project_id', '{project}',"
             f" 'supplier', 'Voltek', 'response', '{_json.dumps(response)}'::jsonb), '{GOOD % 'supplier_response_received'}'::jsonb)")
    rid = scalar(db, "select id from procurement_responses")
    if select:
        psql(db, f"select gf_select_supplier('{pkg}', jsonb_build_object('selected_supplier', 'Voltek',"
                 f" 'selected_response_id', '{rid}', 'selected_at', now()::text, 'selected_by', 'buyer'),"
                 f" '{GOOD % 'supplier_selected'}'::jsonb)")
    return pkg, rid


def actual_args(project, pkg, evidence_id, **over):
    d = {"project_id": project, "package_id": pkg, "po_date": "2026-01-12", "on_site_date": "2026-06-22",
         "energised_date": "2026-08-03", "actual_cost": 4300000, "actual_cost_currency": "EUR",
         "cost_scope": "same_as_quote", "evidence_id": evidence_id, "method": "PO and handover record",
         "submitted_by": "A. Rivera"}
    d.update(over)
    return _json.dumps({k: v for k, v in d.items() if v is not None})


def submit_actual(db, project, pkg, event=None, evidence_id="auto", **over):
    if evidence_id == "auto":
        evidence_id = _evidence(db, project)
    return psql(db, f"select gf_submit_supplier_actual('{actual_args(project, pkg, evidence_id, **over)}'::jsonb,"
                    f" '{event or GOOD % 'supplier_actual_submitted'}'::jsonb)", check=False)


def review_actual(db, aid, decision, fields=(), reason="checked", event=None):
    p = _json.dumps({"actual_id": aid, "decision": decision, "verified_fields": list(fields),
                     "reviewer": "J. Ortiz", "reason": reason})
    return psql(db, f"select gf_review_supplier_actual('{p}'::jsonb, '{event or GOOD % 'supplier_actual_reviewed'}'::jsonb)",
                check=False)


def test_a_delivery_record_copies_its_quote_from_the_selection_and_is_saved_with_its_event(fresh):
    p = new_project(fresh)
    pkg, rid = selected_package(fresh, p)
    # the caller's own idea of the quote is not even a parameter
    r = submit_actual(fresh, p, pkg, quoted_capex_eur=1, supplier="Someone Else")
    assert r.returncode == 0, r.stderr
    row = _json.loads(r.stdout)
    assert row["supplier"] == "Voltek" and row["selected_response_id"] == rid
    assert float(row["quoted_capex_eur"]) == 4000000 and float(row["quoted_lead_time_weeks"]) == 20
    assert count(fresh, "project_events", "event_type = 'supplier_actual_submitted'") == 1


def test_nothing_is_recorded_without_a_selection_or_without_its_event(fresh):
    p = new_project(fresh)
    pkg, _ = selected_package(fresh, p, select=False)
    assert submit_actual(fresh, p, pkg).returncode != 0                      # no selection: no quote to compare
    assert count(fresh, "supplier_actuals") == 0
    psql(fresh, f"select gf_select_supplier('{pkg}', jsonb_build_object('selected_supplier', 'Voltek',"
                f" 'selected_response_id', (select id from procurement_responses), 'selected_at', now()::text,"
                f" 'selected_by', 'b'), '{GOOD % 'supplier_selected'}'::jsonb)")
    assert submit_actual(fresh, p, pkg, event=BAD_TYPE).returncode != 0      # a bad event rolls the record back
    assert submit_actual(fresh, p, pkg, event=NO_ACTOR).returncode != 0
    assert count(fresh, "supplier_actuals") == 0 and count(fresh, "project_events", "event_type = 'supplier_actual_submitted'") == 0
    assert submit_actual(fresh, p, pkg).returncode == 0


def test_the_database_refuses_impossible_or_ambiguous_facts(fresh):
    p = new_project(fresh)
    pkg, _ = selected_package(fresh, p)
    bad = [dict(po_date="2026-07-01"),                                       # PO after delivery
           dict(energised_date="2026-06-01"),                                # energised before on-site
           dict(actual_cost_currency=None), dict(cost_scope=None),           # cost without currency / scope
           dict(cost_scope="roughly"), dict(cost_scope="differs"),           # differs needs a note
           dict(actual_cost_currency="eur"), dict(actual_cost=-1),
           dict(method=" "), dict(submitted_by=""),
           dict(po_date=None, on_site_date=None, energised_date=None, actual_cost=None,
                actual_cost_currency=None, cost_scope=None)]               # no fact at all
    for over in bad:
        assert submit_actual(fresh, p, pkg, **over).returncode != 0, over
    assert count(fresh, "supplier_actuals") == 0
    # unknown stays unknown: a single date is a valid record, with nothing invented around it
    ok = submit_actual(fresh, p, pkg, po_date=None, on_site_date=None, actual_cost=None, actual_cost_currency=None, cost_scope=None)
    assert ok.returncode == 0, ok.stderr
    row = _json.loads(ok.stdout)
    assert row["po_date"] is None and row["actual_cost"] is None and row["dispatch_date"] is None


def test_evidence_and_package_must_belong_to_the_same_project(fresh):
    a = new_project(fresh, "ta")
    b = new_project(fresh, "tb")
    pkg, _ = selected_package(fresh, a)
    foreign = _evidence(fresh, b)
    assert submit_actual(fresh, a, pkg, evidence_id=foreign).returncode != 0
    assert submit_actual(fresh, b, pkg).returncode != 0                      # package is A's
    assert count(fresh, "supplier_actuals") == 0


def test_a_correction_is_a_new_record_that_supersedes_exactly_one(fresh):
    p = new_project(fresh)
    pkg, _ = selected_package(fresh, p)
    first = _json.loads(submit_actual(fresh, p, pkg).stdout)["id"]
    dup = submit_actual(fresh, p, pkg)
    assert dup.returncode != 0 and "supplier_actuals_one_initial" in dup.stderr   # not a second first record
    fix = submit_actual(fresh, p, pkg, actual_cost=4350000, supersedes_id=first)
    assert fix.returncode == 0, fix.stderr
    second = _json.loads(fix.stdout)["id"]
    fork = submit_actual(fresh, p, pkg, actual_cost=4360000, supersedes_id=first)
    assert fork.returncode != 0 and "supplier_actuals_one_correction" in fork.stderr  # no forks
    assert submit_actual(fresh, p, pkg, supersedes_id="00000000-0000-4000-8000-00000000dead").returncode != 0
    assert count(fresh, "supplier_actuals") == 2
    assert scalar(fresh, f"select actual_cost from supplier_actuals where id = '{first}'") == "4300000"   # untouched
    assert scalar(fresh, f"select supersedes_id from supplier_actuals where id = '{second}'") == first


def test_quoted_versus_actual_is_derived_with_basis_and_never_across_scopes(fresh):
    p = new_project(fresh)
    pkg, _ = selected_package(fresh, p)
    aid = _json.loads(submit_actual(fresh, p, pkg).stdout)["id"]
    row = scalar(fresh, f"select concat_ws('|', actual_lead_time_weeks, quoted_lead_time_weeks, actual_install_weeks,"
                        f" cost_delta_eur, cost_basis) from supplier_reality where actual_id = '{aid}'")
    assert row == "23.0|20|6.0|300000|EUR, same scope as quote"
    # a different scope, an unknown scope, another currency: the delta is NULL and the basis says why
    for over, needle in (({"cost_scope": "differs", "cost_scope_note": "incl. grid works"}, "scope is differs"),
                         ({"cost_scope": "unknown"}, "scope is unknown"),
                         ({"actual_cost_currency": "USD"}, "in USD")):
        q = new_project(fresh, "t" + over.get("cost_scope", "usd"))
        # a fresh project/package each time: one first record per package
        pk2, _ = selected_package_again(fresh, q)
        a2 = _json.loads(submit_actual(fresh, q, pk2, **over).stdout)["id"]
        got = psql(fresh, f"select coalesce(cost_delta_eur::text, 'NULL') || '|' || cost_basis from supplier_reality where actual_id = '{a2}'").stdout.strip()
        assert got.startswith("NULL|") and needle in got, (over, got)


def selected_package_again(db, project):
    token = "pk" + project[:6]
    psql(db, f"select gf_create_package(jsonb_build_object('package_token', '{token}', 'project_id', '{project}',"
             " 'case_token', 'c', 'case_revision', 1, 'architecture', 'A', 'spec_summary', '{}'::jsonb,"
             " 'response_template', '{}'::jsonb, 'document_md', 'm', 'document_html', 'h'),"
             f" '{GOOD % 'rfq_generated'}'::jsonb)")
    pkg = scalar(db, f"select id from procurement_packages where package_token = '{token}'")
    psql(db, f"select gf_add_response(jsonb_build_object('package_id', '{pkg}', 'project_id', '{project}',"
             f" 'supplier', 'Voltek', 'response', '{_json.dumps(QUOTE)}'::jsonb), '{GOOD % 'supplier_response_received'}'::jsonb)")
    rid = scalar(db, f"select id from procurement_responses where package_id = '{pkg}'")
    psql(db, f"select gf_select_supplier('{pkg}', jsonb_build_object('selected_supplier', 'Voltek',"
             f" 'selected_response_id', '{rid}', 'selected_at', now()::text, 'selected_by', 'b'),"
             f" '{GOOD % 'supplier_selected'}'::jsonb)")
    return pkg, rid


def test_a_quote_with_no_install_time_leaves_that_metric_unknown(fresh):
    p = new_project(fresh)
    pkg, _ = selected_package(fresh, p, response={"supplier": "Voltek", "values": {"capex_eur": 4000000}})
    aid = _json.loads(submit_actual(fresh, p, pkg).stdout)["id"]
    out = scalar(fresh, f"select coalesce(actual_install_weeks::text, 'NULL') || '|' || install_basis || '|' || lead_time_basis"
                        f" from supplier_reality where actual_id = '{aid}'")
    assert out.startswith("6.0|") or out.startswith("NULL|")   # actual elapsed time is a fact; the QUOTE is what is missing
    assert scalar(fresh, f"select quoted_install_weeks is null from supplier_reality where actual_id = '{aid}'") == "t"
    assert "unknown: the quote gave no installation time" in out


def test_a_review_names_the_facts_it_vouches_for_and_is_immutable(fresh):
    p = new_project(fresh)
    pkg, _ = selected_package(fresh, p)
    aid = _json.loads(submit_actual(fresh, p, pkg, dispatch_date=None).stdout)["id"]
    assert review_actual(fresh, aid, "verified", []).returncode != 0                       # nothing named
    assert review_actual(fresh, aid, "verified", ["dispatch_date"]).returncode != 0         # not supplied
    assert review_actual(fresh, aid, "verified", ["bogus"]).returncode != 0
    assert review_actual(fresh, aid, "rejected", [], reason="").returncode != 0             # needs a reason
    assert review_actual(fresh, aid, "rejected", ["po_date"]).returncode != 0
    assert review_actual(fresh, aid, "verified", ["po_date"], event=BAD_TYPE).returncode != 0
    assert count(fresh, "supplier_actual_reviews") == 0
    assert review_actual(fresh, aid, "verified", ["po_date", "actual_cost"]).returncode == 0
    again = review_actual(fresh, aid, "rejected", [], reason="no")
    assert again.returncode != 0 and "duplicate key" in again.stderr
    assert count(fresh, "project_events", "event_type = 'supplier_actual_reviewed'") == 1
    assert review_actual(fresh, "00000000-0000-4000-8000-00000000dead", "rejected").returncode != 0


def test_actuals_and_reviews_are_append_only_with_rls_and_no_anon_access(fresh):
    p = new_project(fresh)
    pkg, _ = selected_package(fresh, p)
    aid = _json.loads(submit_actual(fresh, p, pkg).stdout)["id"]
    review_actual(fresh, aid, "verified", ["po_date"])
    for sql in ("update supplier_actuals set actual_cost = 1", "delete from supplier_actuals",
                "update supplier_actual_reviews set decision = 'rejected'", "delete from supplier_actual_reviews"):
        r = psql(fresh, sql, check=False)
        assert r.returncode != 0 and "append-only" in r.stderr, sql
    assert count(fresh, "pg_class", "relname in ('supplier_actuals','supplier_actual_reviews') and relrowsecurity") == 2
    assert count(fresh, "pg_policies", "tablename in ('supplier_actuals','supplier_actual_reviews')") == 0
    if count(fresh, "pg_roles", "rolname in ('anon', 'service_role')") == 2:
        assert scalar(fresh, "select has_table_privilege('anon', 'public.supplier_reality', 'select')") == "f"
        assert scalar(fresh, "select has_function_privilege('anon', 'public.gf_submit_supplier_actual(jsonb, jsonb)', 'execute')") == "f"
        assert scalar(fresh, "select has_function_privilege('service_role', 'public.gf_submit_supplier_actual(jsonb, jsonb)', 'execute')") == "t"


# --- the deposit hand-off (0019) -----------------------------------------------------------

def deposit(db, session="cs_1", kind="envelope_study_deposit", amount=900000, **over):
    cols = {"stripe_session_id": session, "kind": kind, "amount_cents": amount, "email": "b@h.example", **over}
    names = ", ".join(cols)
    vals = ", ".join("null" if v is None else (str(v) if isinstance(v, int) else f"'{v}'") for v in cols.values())
    return psql(db, f"insert into engagement_deposits ({names}) values ({vals})", check=False)


def test_a_deposit_is_recorded_once_per_stripe_session_with_real_amounts(fresh):
    assert deposit(fresh).returncode == 0
    dup = deposit(fresh)
    assert dup.returncode != 0 and "duplicate key" in dup.stderr
    assert deposit(fresh, "cs_2", amount=0).returncode != 0            # a deposit with no amount is not a payment
    assert deposit(fresh, "cs_3", kind=" ").returncode != 0
    assert deposit(fresh, "cs_4", email=None).returncode == 0           # still a payment without an email
    assert count(fresh, "engagement_deposits") == 2
    assert scalar(fresh, "select status from engagement_deposits where stripe_session_id = 'cs_1'") == "paid"


def step_sql(to, sets):
    return f"update engagement_deposits set status = '{to}', {sets} where stripe_session_id = 'cs_1'"


def test_a_deposit_moves_forward_one_proven_step_at_a_time(fresh):
    deposit(fresh)
    refused = [
        step_sql("scoped", "scope_note = 'n', scoped_at = now(), owner = 'o', contacted_at = now()"),   # skipped a step
        step_sql("delivered", "delivery_ref = 'r', delivered_at = now()"),                              # skipped two
        step_sql("contacted", "contacted_at = now()"),                                                  # no named owner
    ]
    for sql in refused:
        assert psql(fresh, sql, check=False).returncode != 0, sql
    assert scalar(fresh, "select status from engagement_deposits") == "paid"
    assert psql(fresh, step_sql("contacted", "owner = 'A. Rivera', contacted_at = now()"), check=False).returncode == 0
    assert psql(fresh, step_sql("scoped", "scoped_at = now()"), check=False).returncode != 0            # no scope note
    assert psql(fresh, step_sql("scoped", "scope_note = 'Hall A+B', scoped_at = now()"), check=False).returncode == 0
    assert psql(fresh, step_sql("delivered", "delivered_at = now()"), check=False).returncode != 0      # no delivery reference
    assert psql(fresh, step_sql("delivered", "delivery_ref = 'https://x', delivered_at = now()"), check=False).returncode == 0
    assert scalar(fresh, "select status from engagement_deposits") == "delivered"


def test_the_payment_facts_and_recorded_steps_never_change_and_nothing_is_deleted(fresh):
    deposit(fresh)
    psql(fresh, step_sql("contacted", "owner = 'A. Rivera', contacted_at = now()"))
    for sql in ("update engagement_deposits set amount_cents = 1", "update engagement_deposits set kind = 'x'",
                "update engagement_deposits set email = 'other@x.example'", "update engagement_deposits set stripe_session_id = 'cs_9'",
                "update engagement_deposits set paid_at = now() - interval '9 days'",
                "update engagement_deposits set status = 'paid'",                                       # no going back
                "update engagement_deposits set owner = 'someone else'",                                # a recorded step is not rewritten
                "delete from engagement_deposits"):
        assert psql(fresh, sql, check=False).returncode != 0, sql
    assert scalar(fresh, "select owner || '/' || amount_cents from engagement_deposits") == "A. Rivera/900000"


def test_deposits_are_not_readable_by_anon_and_rls_is_on(fresh):
    assert count(fresh, "pg_class", "relname = 'engagement_deposits' and relrowsecurity") == 1
    assert count(fresh, "pg_policies", "tablename = 'engagement_deposits'") == 0
    if count(fresh, "pg_roles", "rolname in ('anon', 'service_role')") == 2:
        assert scalar(fresh, "select has_table_privilege('anon', 'public.engagement_deposits', 'select')") == "f"
        assert scalar(fresh, "select has_table_privilege('service_role', 'public.engagement_deposits', 'update')") == "t"
