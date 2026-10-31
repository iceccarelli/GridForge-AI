"""0044_intake_evidence.sql against a real PostgreSQL: what a buyer attaches and confirms for ONE engagement, and what the database refuses.

Each test is a way the record could be made to lie: a confirmation citing another engagement's file, a number under the wrong unit, a
non-finite or zero value, a rewrite of history, a change after the engagement has left intake, anon reading the buyer's material.

Needs a reachable PostgreSQL (`psql` plus PG* variables, or GRIDFORGE_TEST_PG_URL). Skipped, loudly, where there is none: a skip is a
gap in what was checked, not a pass. GRIDFORGE_REQUIRE_DB=1 turns the skip into a failure.
"""
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
_NO_DB = shutil.which("psql") is None or not (BASE or os.environ.get("PGHOST") or os.environ.get("PGUSER"))
needs_db = pytest.mark.skipif(_NO_DB and not REQUIRED, reason="no PostgreSQL available (set GRIDFORGE_TEST_PG_URL or PGHOST)")
pytestmark = needs_db


def psql(db, sql=None, file=None, check=True):
    cmd = ["psql", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-X"] + ([f"{BASE}/{db}"] if BASE else ["-d", db])
    cmd += ["-c", sql] if sql else ["-f", str(file)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode:
        raise AssertionError(r.stderr)
    return r


def refused(db, sql, needle):
    r = psql(db, sql, check=False)
    assert r.returncode != 0, f"expected a refusal containing {needle!r}, but it was accepted: {sql}"
    assert needle in r.stderr, r.stderr


@pytest.fixture(scope="module")
def db():
    name = f"gf_{uuid.uuid4().hex[:10]}"
    psql("postgres", f"create database {name}")
    psql(name, "create extension if not exists pgcrypto")
    psql(name, "create table public.qualifications (id uuid primary key default gen_random_uuid())")
    for f in ("0003_deliverables.sql", "0014_power_deployment_cases.sql", "0015_projects.sql", "0044_intake_evidence.sql"):
        psql(name, file=MIGRATIONS / f)
    yield name
    psql("postgres", f"drop database {name}")


def engagement(db, status="awaiting_intake"):
    d = str(uuid.uuid4())
    psql(db, f"insert into deliverables (id, token, kind, status, email) values ('{d}', '{uuid.uuid4().hex}', 'density_screen', '{status}', 'buyer@hall.example')")
    return d


def file(db, d, name="agreement.pdf", sha=None):
    f = str(uuid.uuid4())
    sha = sha or uuid.uuid4().hex + uuid.uuid4().hex
    psql(db, "insert into intake_evidence_files (id, deliverable_id, filename, media_type, sha256, byte_size, storage_ref) "
             f"values ('{f}', '{d}', '{name}', 'application/pdf', '{sha}', 1000, 'project-evidence/{d}/{sha}-{name}')")
    return f


def confirm_sql(d, f, field="firmCapacityMVA", unit="MVA", value="40", locator="'clause 4.2'"):
    return ("insert into intake_value_events (deliverable_id, action, field, value, unit, file_id, locator, confirmed_by) "
            f"values ('{d}', 'confirm', '{field}', {value}, '{unit}', '{f}', {locator}, 'buyer@hall.example')")


def test_a_confirmation_records_value_unit_file_and_locator(db):
    d = engagement(db)
    f = file(db, d)
    psql(db, confirm_sql(d, f))
    assert psql(db, f"select field, value, unit, locator from intake_value_events where deliverable_id='{d}'").stdout.strip() == "firmCapacityMVA|40|MVA|clause 4.2"


def test_the_same_bytes_are_one_file_per_engagement_but_may_serve_another(db):
    sha = uuid.uuid4().hex + uuid.uuid4().hex
    a, b = engagement(db), engagement(db)
    file(db, a, sha=sha)
    refused(db, f"insert into intake_evidence_files (deliverable_id, filename, media_type, sha256, byte_size, storage_ref) values ('{a}', 'again.pdf', 'application/pdf', '{sha}', 1, 'x')", "intake_evidence_files_deliverable_id_sha256_key")
    file(db, b, sha=sha)


def test_a_confirmation_cannot_cite_another_engagements_file(db):
    a, b = engagement(db), engagement(db)
    other = file(db, b)
    refused(db, confirm_sql(a, other), "violates foreign key constraint")


def test_the_unit_is_fixed_by_the_field(db):
    d = engagement(db)
    f = file(db, d)
    refused(db, confirm_sql(d, f, "firmCapacityMVA", "MW"), "intake_value_events_shape")
    refused(db, confirm_sql(d, f, "floorLoadingKPa", "MVA"), "intake_value_events_shape")
    psql(db, confirm_sql(d, f, "floorLoadingKPa", "kPa", "12"))
    psql(db, confirm_sql(d, f, "plantCapacityKW", "kW", "4500"))


@pytest.mark.parametrize("value", ["0", "-5", "'NaN'", "'Infinity'", "'-Infinity'", "null"])
def test_a_value_must_be_finite_and_positive(db, value):
    d = engagement(db)
    f = file(db, d)
    refused(db, confirm_sql(d, f, value=value), "intake_value_events_shape")


@pytest.mark.parametrize("locator", ["null", "''", f"'{'x' * 201}'"])
def test_a_confirmation_says_where_in_the_file(db, locator):
    d = engagement(db)
    f = file(db, d)
    refused(db, confirm_sql(d, f, locator=locator), "intake_value_events_shape")


def test_only_the_three_fields_can_be_confirmed(db):
    d = engagement(db)
    f = file(db, d)
    refused(db, confirm_sql(d, f, field="contractedMW", unit="MW"), "intake_value_events_field_check")


def test_a_withdrawal_carries_no_value_and_leaves_the_confirmation_in_history(db):
    d = engagement(db)
    f = file(db, d)
    psql(db, confirm_sql(d, f))
    refused(db, f"insert into intake_value_events (deliverable_id, action, field, value) values ('{d}', 'withdraw', 'firmCapacityMVA', 40)", "intake_value_events_shape")
    psql(db, f"insert into intake_value_events (deliverable_id, action, field) values ('{d}', 'withdraw', 'firmCapacityMVA')")
    assert psql(db, f"select action from intake_value_events where deliverable_id='{d}' order by seq").stdout.split() == ["confirm", "withdraw"]


def test_history_cannot_be_rewritten_or_erased(db):
    d = engagement(db)
    f = file(db, d)
    psql(db, confirm_sql(d, f))
    for sql in (f"update intake_value_events set value = 99 where deliverable_id='{d}'",
                f"delete from intake_value_events where deliverable_id='{d}'",
                f"update intake_evidence_files set filename = 'x' where id='{f}'",
                f"delete from intake_evidence_files where id='{f}'"):
        refused(db, sql, "is append-only")


@pytest.mark.parametrize("status", ["generating", "draft", "released"])
def test_nothing_can_be_added_once_the_engagement_has_left_intake(db, status):
    d = engagement(db)
    f = file(db, d)
    psql(db, f"update deliverables set status = '{status}' where id = '{d}'")
    refused(db, confirm_sql(d, f), "can no longer change")
    refused(db, f"insert into intake_evidence_files (deliverable_id, filename, media_type, sha256, byte_size, storage_ref) values ('{d}', 'late.pdf', 'application/pdf', '{uuid.uuid4().hex * 2}', 1, 'x')", "can no longer change")


def test_a_failed_generation_reopens_intake_so_evidence_may_still_change(db):
    d = engagement(db, status="engine_unavailable")
    f = file(db, d)
    psql(db, confirm_sql(d, f))


def test_the_tables_hold_no_policy_and_anon_and_authenticated_cannot_read_them(db):
    assert psql(db, "select count(*) from pg_policies where tablename in ('intake_evidence_files','intake_value_events')").stdout.strip() == "0"
    assert psql(db, "select bool_and(relrowsecurity) from pg_class where relname in ('intake_evidence_files','intake_value_events')").stdout.strip() == "t"
    for role in ("anon", "authenticated"):
        psql(db, f"do $$ begin if not exists (select 1 from pg_roles where rolname='{role}') then create role {role} nologin; end if; end $$")
    psql(db, "revoke all on table public.intake_evidence_files, public.intake_value_events from anon, authenticated")
    for role in ("anon", "authenticated"):
        for t in ("intake_evidence_files", "intake_value_events"):
            assert psql(db, f"select has_table_privilege('{role}', 'public.{t}', 'select')").stdout.strip() == "f"


def test_reapplying_the_migration_changes_nothing(db):
    d = engagement(db)
    f = file(db, d)
    psql(db, confirm_sql(d, f))
    psql(db, file=MIGRATIONS / "0044_intake_evidence.sql")
    assert psql(db, f"select count(*) from intake_value_events where deliverable_id='{d}'").stdout.strip() == "1"
