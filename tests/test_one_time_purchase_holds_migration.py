"""0045_one_time_purchase_holds.sql against a real PostgreSQL: a refunded or disputed one-time purchase is held, and what a hold must stop.

Each test is a way the record could lie: a hold on nothing, a hold with no Stripe object behind it, a value no code writes, a refunded
purchase credited against the next engagement, an audit row about a table the trail does not know, a re-run that changes something.

The whole chain is applied in order, as production has it, because the credit guard being amended is 0040's and needs everything before it.
Run as the role the default ACLs are set for (postgres). Needs a reachable PostgreSQL (`psql` plus PG* variables, or GRIDFORGE_TEST_PG_URL);
GRIDFORGE_REQUIRE_DB=1 turns the skip into a failure.
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
pytestmark = pytest.mark.skipif(_NO_DB and not REQUIRED, reason="no PostgreSQL available (set GRIDFORGE_TEST_PG_URL or PGHOST)")


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
    psql(name, """do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
      end $$""")
    psql(name, "create extension if not exists pgcrypto; create schema if not exists storage; "
               "create table if not exists storage.buckets (id text primary key, name text, public boolean)")
    psql(name, "grant usage on schema public to anon, authenticated, service_role; "
               "alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role; "
               "alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role; "
               "alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role")
    for f in sorted(MIGRATIONS.glob("*.sql")):
        psql(name, file=f)
    yield name
    psql("postgres", f"drop database {name} with (force)")


def purchase(db, email="buyer@hall.example", kind="density_screen", status="draft"):
    d = str(uuid.uuid4())
    psql(db, "insert into deliverables (id, token, kind, status, email, amount_cents, stripe_session_id) "
             f"values ('{d}', '{uuid.uuid4().hex}', '{kind}', '{status}', '{email}', 450000, 'cs_{uuid.uuid4().hex}')")
    return d


def deposit(db, email="buyer@hall.example", kind="envelope_study_deposit"):
    dep = str(uuid.uuid4())
    psql(db, "insert into engagement_deposits (id, stripe_session_id, kind, amount_cents, email, status, owner, contacted_at) "
             f"values ('{dep}', 'cs_{uuid.uuid4().hex}', '{kind}', 900000, '{email}', 'contacted', 'Ada', now())")
    return dep


def credit(db, dep, src):
    return psql(db, "insert into engagement_credits (source_deliverable_id, deposit_id, amount_cents, applied_by) "
                    f"values ('{src}', '{dep}', 450000, 'Ada')", check=False)


def hold(db, d, kind, ref):
    psql(db, f"update deliverables set billing_hold = '{kind}', billing_hold_ref = '{ref}', billing_hold_at = now() where id = '{d}'")


def test_a_purchase_can_be_held_as_refunded_or_disputed_and_released_again(db):
    d = purchase(db)
    assert psql(db, f"select billing_hold is null from deliverables where id='{d}'").stdout.strip() == "t"
    hold(db, d, "disputed", "dp_1")
    assert psql(db, f"select billing_hold, billing_hold_ref from deliverables where id='{d}'").stdout.strip() == "disputed|dp_1"
    psql(db, f"update deliverables set billing_hold = null, billing_hold_ref = null, billing_hold_at = null where id = '{d}'")
    hold(db, d, "refunded", "ch_1")
    assert psql(db, f"select billing_hold from deliverables where id='{d}'").stdout.strip() == "refunded"


@pytest.mark.parametrize("value", ["paused", "REFUNDED", "chargeback", ""])
def test_only_refunded_and_disputed_are_holds(db, value):
    d = purchase(db)
    refused(db, f"update deliverables set billing_hold = '{value}', billing_hold_ref = 'x', billing_hold_at = now() where id = '{d}'", "deliverables_billing_hold_check")


def test_a_hold_names_the_stripe_object_and_a_hold_free_row_names_none(db):
    d = purchase(db)
    refused(db, f"update deliverables set billing_hold = 'refunded' where id = '{d}'", "deliverables_billing_hold_ref_check")
    refused(db, f"update deliverables set billing_hold = 'refunded', billing_hold_ref = 'ch_1' where id = '{d}'", "deliverables_billing_hold_ref_check")
    refused(db, f"update deliverables set billing_hold_ref = 'ch_1' where id = '{d}'", "deliverables_billing_hold_ref_check")


def test_a_purchase_on_hold_cannot_be_credited_against_the_next_engagement(db):
    src, dep = purchase(db), deposit(db)
    hold(db, src, "refunded", "ch_2")
    r = credit(db, dep, src)
    assert r.returncode != 0 and "whose payment was refunded" in r.stderr
    assert psql(db, f"select count(*) from engagement_credits where deposit_id='{dep}'").stdout.strip() == "0"


def test_the_same_purchase_is_creditable_once_the_hold_is_lifted_and_not_before(db):
    src, dep = purchase(db), deposit(db)
    hold(db, src, "disputed", "dp_2")
    assert credit(db, dep, src).returncode != 0
    psql(db, f"update deliverables set billing_hold = null, billing_hold_ref = null, billing_hold_at = null where id = '{src}'")
    r = credit(db, dep, src)
    assert r.returncode == 0, r.stderr


def test_an_unheld_purchase_is_credited_as_before(db):
    r = credit(db, deposit(db), purchase(db))
    assert r.returncode == 0, r.stderr


def test_the_audit_trail_accepts_these_two_subjects_and_still_refuses_others(db):
    for table in ("deliverables", "engagement_deposits"):
        psql(db, "insert into billing_audit (dedupe_key, subject_table, subject_id, action) "
                 f"values ('k_{uuid.uuid4().hex}', '{table}', '{uuid.uuid4()}', 'hold_applied')")
    refused(db, f"insert into billing_audit (dedupe_key, subject_table, subject_id, action) values ('k_{uuid.uuid4().hex}', 'leads', 'x', 'hold_applied')",
            "billing_audit_subject_table_check")


def test_the_credit_guard_keeps_the_grants_0040_set(db):
    """create or replace must not hand the function back to the API roles."""
    for role in ("anon", "authenticated"):
        assert psql(db, f"select has_function_privilege('{role}', 'public.gf_credit_insert_guard()', 'execute')").stdout.strip() == "f"


def test_reapplying_the_migration_changes_nothing(db):
    d = purchase(db)
    hold(db, d, "refunded", "ch_3")
    psql(db, file=MIGRATIONS / "0045_one_time_purchase_holds.sql")
    assert psql(db, f"select billing_hold, billing_hold_ref from deliverables where id='{d}'").stdout.strip() == "refunded|ch_3"
