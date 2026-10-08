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

pytestmark = pytest.mark.skipif(
    shutil.which("psql") is None or not (BASE or os.environ.get("PGHOST")),
    reason="no PostgreSQL available (set GRIDFORGE_TEST_PG_URL or PGHOST)")


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
              "0016_project_purchases.sql"):
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
              "0016_project_purchases.sql"):
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
