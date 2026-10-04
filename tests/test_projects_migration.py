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
    for f in ("0003_deliverables.sql", "0014_power_deployment_cases.sql", "0015_projects.sql"):
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
