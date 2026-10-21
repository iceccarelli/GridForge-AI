"""0030_delivery_handoff.sql against a real PostgreSQL.

The site's tests use an in-memory PostgREST, which cannot run a trigger, so "a credit is applied once", "the fee and the
delivery date are set at scoping and never rewritten" and "scoping and its credits commit together" would only ever be
asserted against the fake's own rules. This applies the real migrations to a throwaway database and attacks them the way a
careless service-role caller would.

Needs a reachable PostgreSQL (`psql` plus the standard PG* variables, or GRIDFORGE_TEST_PG_URL). Skipped, loudly, where there
is none: a skip here is a gap in what was checked, not a pass. GRIDFORGE_REQUIRE_DB=1 turns the skip into a failure.
"""
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

MIGRATIONS = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
BASE = os.environ.get("GRIDFORGE_TEST_PG_URL", "")
REQUIRED = os.environ.get("GRIDFORGE_REQUIRE_DB") == "1"
_NO_DB = shutil.which("psql") is None or not (BASE or os.environ.get("PGHOST"))

pytestmark = pytest.mark.skipif(_NO_DB and not REQUIRED, reason="no PostgreSQL available (set GRIDFORGE_TEST_PG_URL or PGHOST)")


@pytest.fixture(scope="module", autouse=True)
def _database_is_reachable():
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
    for f in ("0003_deliverables.sql", "0005_watches.sql", "0019_engagement_deposits.sql", "0030_delivery_handoff.sql"):
        psql(name, file=MIGRATIONS / f)
    yield name
    psql("postgres", f"drop database {name}")


def new_deposit(db, status="contacted", email="buyer@hall.example", kind="envelope_study_deposit"):
    dep = str(uuid.uuid4())
    session = f"cs_{uuid.uuid4().hex}"
    cols = "id, stripe_session_id, kind, amount_cents, email, status"
    vals = f"'{dep}', '{session}', '{kind}', 900000, '{email}', '{status}'"
    if status != "paid":
        cols += ", owner, contacted_at"
        vals += ", 'Ada', now()"
    psql(db, f"insert into engagement_deposits ({cols}) values ({vals})")
    return dep


def new_screen(db, email="buyer@hall.example", amount=450000, paid=True):
    d = str(uuid.uuid4())
    session = f"'cs_{uuid.uuid4().hex}'" if paid else "null"
    psql(db, "insert into deliverables (id, token, kind, status, email, amount_cents, stripe_session_id) "
             f"values ('{d}', '{uuid.uuid4().hex}', 'density_screen', 'released', '{email}', {amount}, {session})")
    return d


def scope(db, dep, credits, fee=2200000, due="2027-01-15"):
    import json
    p = json.dumps({"id": dep, "scope_note": "One hall, grid and thermal", "agreed_fee_cents": fee,
                    "delivery_due_on": due, "applied_by": "Ada", "credits": credits}).replace("'", "''")
    return psql(db, f"select public.gf_scope_deposit('{p}'::jsonb)", check=False)


def test_scoping_records_fee_credit_and_date_together(db):
    dep = new_deposit(db)
    src = new_screen(db)
    r = scope(db, dep, [{"source_deliverable_id": src, "amount_cents": 450000}])
    assert r.returncode == 0, r.stderr
    row = psql(db, f"select status, agreed_fee_cents, credit_applied_cents, delivery_due_on from engagement_deposits where id='{dep}'").stdout.strip()
    assert row == "scoped|2200000|450000|2027-01-15"
    assert psql(db, f"select count(*) from engagement_credits where deposit_id='{dep}'").stdout.strip() == "1"


def test_a_screen_is_credited_once_even_against_a_second_deposit(db):
    src = new_screen(db)
    first = new_deposit(db)
    assert scope(db, first, [{"source_deliverable_id": src, "amount_cents": 450000}]).returncode == 0
    second = new_deposit(db)
    r = scope(db, second, [{"source_deliverable_id": src, "amount_cents": 450000}])
    assert r.returncode != 0 and "engagement_credits_source_deliverable_id_key" in r.stderr
    # and the refused attempt left the second deposit exactly as it was: contacted, no fee, no credit rows
    assert psql(db, f"select status, credit_applied_cents from engagement_deposits where id='{second}'").stdout.strip() == "contacted|0"
    assert psql(db, f"select count(*) from engagement_credits where deposit_id='{second}'").stdout.strip() == "0"


def test_a_failing_credit_rolls_back_the_scoping_step_and_the_credits_before_it(db):
    dep = new_deposit(db)
    good = new_screen(db)
    unpaid = new_screen(db, paid=False)
    r = scope(db, dep, [{"source_deliverable_id": good, "amount_cents": 450000}, {"source_deliverable_id": unpaid, "amount_cents": 450000}])
    assert r.returncode != 0 and "paid engagement" in r.stderr
    assert psql(db, f"select status from engagement_deposits where id='{dep}'").stdout.strip() == "contacted"
    assert psql(db, f"select count(*) from engagement_credits where source_deliverable_id='{good}'").stdout.strip() == "0"


def test_a_credit_belongs_to_the_buyer_who_paid_it_and_cannot_exceed_the_payment(db):
    dep = new_deposit(db)
    other = new_screen(db, email="someone.else@rival.example")
    r = scope(db, dep, [{"source_deliverable_id": other, "amount_cents": 450000}])
    assert r.returncode != 0 and "only to the buyer who paid" in r.stderr
    mine = new_screen(db, amount=450000)
    r = scope(db, dep, [{"source_deliverable_id": mine, "amount_cents": 450001}])
    assert r.returncode != 0 and "cannot exceed what the engagement was paid" in r.stderr
    # the email match is case-insensitive
    upper = new_screen(db, email="BUYER@HALL.EXAMPLE")
    assert scope(db, dep, [{"source_deliverable_id": upper, "amount_cents": 450000}]).returncode == 0


def test_the_deposit_and_credits_can_never_exceed_the_agreed_fee(db):
    dep = new_deposit(db)
    src = new_screen(db)
    r = scope(db, dep, [{"source_deliverable_id": src, "amount_cents": 450000}], fee=1000000)
    assert r.returncode != 0 and "cannot exceed the agreed fee" in r.stderr
    assert psql(db, f"select status from engagement_deposits where id='{dep}'").stdout.strip() == "contacted"


def test_only_a_contacted_deposit_can_be_scoped(db):
    dep = new_deposit(db, status="paid")
    r = scope(db, dep, [])
    assert r.returncode != 0 and "only a contacted deposit can be scoped" in r.stderr


def test_scoping_without_a_fee_or_a_date_is_refused_by_the_table_itself(db):
    dep = new_deposit(db)
    refused(db, f"update engagement_deposits set status='scoped', scope_note='x', scoped_at=now() where id='{dep}'",
            "records the agreed fee and the delivery date")


def test_the_fee_credit_and_date_are_never_rewritten(db):
    paid = new_deposit(db, status="paid")
    # a fee cannot be smuggled in on any step other than scoping
    refused(db, f"update engagement_deposits set status='contacted', owner='Ada', contacted_at=now(), agreed_fee_cents=5 where id='{paid}'", "never rewritten")
    dep = new_deposit(db)
    assert scope(db, dep, []).returncode == 0
    # once scoped, the row cannot be edited without moving forward, and moving forward cannot edit them
    refused(db, f"update engagement_deposits set delivery_due_on='2027-06-01' where id='{dep}'", "one step at a time")
    refused(db, f"update engagement_deposits set status='delivered', delivery_ref='r', delivered_at=now(), delivery_due_on='2027-06-01' where id='{dep}'", "never rewritten")
    refused(db, f"update engagement_deposits set status='delivered', delivery_ref='r', delivered_at=now(), agreed_fee_cents=1 where id='{dep}'", "never rewritten")
    refused(db, f"update engagement_deposits set status='delivered', delivery_ref='r', delivered_at=now(), credit_applied_cents=1 where id='{dep}'", "never rewritten")
    # delivering is still allowed, and does not touch them
    psql(db, f"update engagement_deposits set status='delivered', delivery_ref='report v1', delivered_at=now() where id='{dep}'")


def test_the_credit_ledger_is_append_only(db):
    dep = new_deposit(db)
    src = new_screen(db)
    assert scope(db, dep, [{"source_deliverable_id": src, "amount_cents": 450000}]).returncode == 0
    refused(db, f"update engagement_credits set amount_cents=1 where deposit_id='{dep}'", "append-only")
    refused(db, f"delete from engagement_credits where deposit_id='{dep}'", "append-only")


def test_payment_facts_and_step_order_are_still_guarded(db):
    dep = new_deposit(db, status="paid")
    refused(db, f"update engagement_deposits set amount_cents=1 where id='{dep}'", "payment facts")
    refused(db, f"update engagement_deposits set status='scoped' where id='{dep}'", "one step at a time")
    refused(db, f"delete from engagement_deposits where id='{dep}'", "append-only")


def test_one_change_notice_per_stored_note(db):
    w = str(uuid.uuid4())
    psql(db, f"insert into watches (id, token) values ('{w}', '{uuid.uuid4().hex}')")
    n = str(uuid.uuid4())
    psql(db, f"insert into watch_notes (id, watch_id, material) values ('{n}', '{w}', true)")
    psql(db, f"insert into watch_note_notices (watch_note_id, watch_id) values ('{n}', '{w}')")
    refused(db, f"insert into watch_note_notices (watch_note_id, watch_id) values ('{n}', '{w}')", "watch_note_id_key")
    refused(db, f"update watch_note_notices set status='sent' where watch_note_id='{n}'", "watch_note_notices_check")
    psql(db, f"update watch_note_notices set status='sent', sent_at=now() where watch_note_id='{n}'")
