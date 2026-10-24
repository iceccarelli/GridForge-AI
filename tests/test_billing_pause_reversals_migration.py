"""0043_billing_pause_and_settlement_reversals.sql against a real PostgreSQL.

The site's tests use an in-memory PostgREST, which cannot run a constraint, a trigger, a foreign key or a privilege. This applies the real
chain of migrations to a throwaway database and checks what 0043 promises: the scheduled-pause columns exist on the three tables and default
to NULL, billing_audit now accepts a dispute as its subject (and still refuses anything else, and is still append-only), the settlement
reversal table is once-per-key, linked to a real settlement by id AND account AND month, shaped per kind, append-only even for the table
owner, closed to the API roles, readable and appendable (nothing more) by the service role, and a re-apply changes nothing.

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
MIGRATION = MIGRATIONS / "0043_billing_pause_and_settlement_reversals.sql"
BASE = os.environ.get("GRIDFORGE_TEST_PG_URL", "")
REQUIRED = os.environ.get("GRIDFORGE_REQUIRE_DB") == "1"
_NO_DB = shutil.which("psql") is None or not (BASE or os.environ.get("PGHOST"))

pytestmark = pytest.mark.skipif(_NO_DB and not REQUIRED, reason="no PostgreSQL available (set GRIDFORGE_TEST_PG_URL or PGHOST)")


def _cmd(db):
    return ["psql", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-X"] + ([f"{BASE}/{db}"] if BASE else ["-d", db])


def psql(db, sql=None, file=None, check=True):
    cmd = _cmd(db) + (["-c", sql] if sql else ["-f", str(file)])
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode:
        raise AssertionError(r.stderr)
    return r


def q(db, sql):
    return psql(db, sql).stdout.strip()


def refused(db, sql, needle):
    r = psql(db, sql, check=False)
    assert r.returncode != 0, f"expected a refusal containing {needle!r}: {sql}"
    assert needle in r.stderr, r.stderr


def uid():
    return uuid.uuid4().hex[:10]


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
    for role, extra in (("anon", ""), ("authenticated", ""), ("service_role", " bypassrls")):
        psql("postgres", f"do $$ begin if not exists (select 1 from pg_roles where rolname = '{role}') "
                         f"then create role {role} nologin{extra}; end if; end $$")
    psql("postgres", "alter role service_role bypassrls")
    # PRODUCTION: Supabase's default ACLs hand the API roles every privilege on every table created afterwards.
    psql(name, "grant usage on schema public to anon, authenticated, service_role; "
               "alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role")
    for f in sorted(MIGRATIONS.glob("*.sql")):
        psql(name, file=f)
    yield name
    psql("postgres", f"drop database {name} with (force)")


def settlement(db, account=None, month="2026-09"):
    account = account or f"acct-{uid()}"
    psql(db, f"insert into usage_settlements (account, month, units, amount_cents, status) values ('{account}', '{month}', 100, 10000, 'paid')")
    sid = q(db, f"select id from usage_settlements where account = '{account}' and month = '{month}'")
    return sid, account, month


def reversal(db, sid, account, month, kind="refund", state="full", obj="ch_x", amount=10000, key=None, extra=""):
    key = key or f"k-{uid()}"
    objsql = "null" if obj is None else f"'{obj}'"
    psql(db, f"insert into payg_settlement_reversals (dedupe_key, settlement_id, account, month, kind, stripe_object_id, amount_cents, state{extra}) "
             f"values ('{key}', '{sid}', '{account}', '{month}', '{kind}', {objsql}, {amount}, '{state}')")
    return key


def test_it_is_in_the_chain_and_the_chain_applies(db):
    assert MIGRATION.name in sorted(p.name for p in MIGRATIONS.glob("*.sql"))
    assert q(db, "select to_regclass('public.payg_settlement_reversals') is not null") == "t"


def test_reapplying_changes_nothing_and_leaves_row_level_security_as_it_was(db):
    def rls(t):
        return q(db, f"select relrowsecurity from pg_class where relname = '{t}' and relnamespace = 'public'::regnamespace")

    def policies(t):
        return q(db, f"select count(*) from pg_policies where tablename = '{t}'")

    sid, a, m = settlement(db)
    k = reversal(db, sid, a, m)
    psql(db, f"insert into billing_audit (dedupe_key, subject_table, subject_id, action) values ('d-{uid()}', 'stripe_disputes', 'dp_1', 'dispute_not_found')")
    before = {t: (rls(t), policies(t)) for t in ("api_accounts", "watches", "subscriptions", "billing_audit", "usage_settlements", "payg_settlement_reversals")}
    psql(db, file=MIGRATION)
    psql(db, file=MIGRATION)
    assert {t: (rls(t), policies(t)) for t in before} == before
    assert q(db, f"select count(*) from payg_settlement_reversals where dedupe_key = '{k}'") == "1"  # data survives a re-apply
    assert rls("payg_settlement_reversals") == "t"
    assert policies("payg_settlement_reversals") == "0"
    assert q(db, "select count(*) from billing_audit where subject_table = 'stripe_disputes'") != "0"


def test_the_pause_columns_exist_with_their_types_and_default_to_null(db):
    def col(table, name):
        return q(db, f"select data_type from information_schema.columns where table_schema = 'public' and table_name = '{table}' and column_name = '{name}'")

    for t in ("api_accounts", "watches", "subscriptions"):
        assert col(t, "billing_pause_from") == "timestamp with time zone", t
        assert col(t, "billing_pause_resumes_at") == "timestamp with time zone", t
        assert col(t, "billing_pause_event_ts") == "bigint", t
        assert q(db, f"select count(*) from pg_indexes where tablename = '{t}' and indexname = '{t}_pause_due_idx'") == "1", t
    a = f"acct-{uid()}"
    psql(db, f"insert into api_accounts (token, account, plan) values ('tok-{uid()}{uid()}', '{a}', 'api_scale')")
    assert q(db, f"select billing_pause_from is null and billing_pause_resumes_at is null and billing_pause_event_ts is null from api_accounts where account = '{a}'") == "t"


def test_the_daily_job_query_for_due_pauses_is_served_by_the_partial_index_and_ignores_rows_with_no_pause(db):
    due = f"acct-{uid()}"
    later = f"acct-{uid()}"
    none = f"acct-{uid()}"
    for a, when in ((due, "now() - interval '1 hour'"), (later, "now() + interval '1 day'"), (none, "null")):
        psql(db, f"insert into api_accounts (token, account, plan, billing_pause_from) values ('tok-{uid()}{uid()}', '{a}', 'api_scale', {when})")
    rows = q(db, "select string_agg(account, ',' order by account) from api_accounts where billing_pause_from <= now() and status <> 'cancelled' "
                 f"and account in ('{due}', '{later}', '{none}')")
    assert rows == due
    # the same timestamp column round-trips the way the site writes it (ISO with milliseconds and Z)
    assert q(db, f"update api_accounts set billing_pause_from = '2026-11-03T14:05:46.000Z' where account = '{due}' returning billing_pause_from at time zone 'utc'") == "2026-11-03 14:05:46"


def test_billing_audit_accepts_a_dispute_as_subject_and_nothing_else_new(db):
    k = f"d-{uid()}"
    psql(db, f"insert into billing_audit (dedupe_key, subject_table, subject_id, action, detail) values ('{k}', 'stripe_disputes', 'dp_1', 'dispute_not_found', '{{}}')")
    for t in ("api_accounts", "watches", "subscriptions"):
        psql(db, f"insert into billing_audit (dedupe_key, subject_table, subject_id, action) values ('k-{uid()}', '{t}', 'x', 'hold_applied')")
    for bad in ("leads", "usage_settlements", "engagement_deposits", ""):
        refused(db, f"insert into billing_audit (dedupe_key, subject_table, subject_id, action) values ('k-{uid()}', '{bad}', 'x', 'a')", "billing_audit_subject_table_check")


def test_billing_audit_stays_append_only_once_per_key_and_closed_after_the_constraint_swap(db):
    k = f"d-{uid()}"
    psql(db, f"insert into billing_audit (dedupe_key, subject_table, subject_id, action) values ('{k}', 'stripe_disputes', 'dp_2', 'dispute_not_found')")
    refused(db, f"insert into billing_audit (dedupe_key, subject_table, subject_id, action) values ('{k}', 'stripe_disputes', 'dp_2', 'dispute_not_found')", "duplicate key")
    refused(db, f"update billing_audit set action = 'forged' where dedupe_key = '{k}'", "append-only")
    refused(db, f"delete from billing_audit where dedupe_key = '{k}'", "append-only")
    refused(db, "truncate billing_audit", "append-only")
    for priv in ("update", "delete", "truncate"):
        assert q(db, f"select has_table_privilege('service_role', 'public.billing_audit', '{priv}')") == "f", priv
    assert q(db, "select has_table_privilege('service_role', 'public.billing_audit', 'insert')") == "t"


def test_a_reversal_is_once_per_key_and_names_a_real_settlement_by_id_account_and_month(db):
    sid, a, m = settlement(db)
    k = reversal(db, sid, a, m)
    refused(db, f"insert into payg_settlement_reversals (dedupe_key, settlement_id, account, month, kind, stripe_object_id, amount_cents, state) "
                f"values ('{k}', '{sid}', '{a}', '{m}', 'refund', 'ch_x', 10000, 'full')", "duplicate key")
    psql(db, f"insert into payg_settlement_reversals (dedupe_key, settlement_id, account, month, kind, stripe_object_id, amount_cents, state) "
             f"values ('{k}', '{sid}', '{a}', '{m}', 'refund', 'ch_x', 10000, 'full') on conflict (dedupe_key) do nothing")
    assert q(db, f"select count(*) from payg_settlement_reversals where dedupe_key = '{k}'") == "1"
    # not a settlement that exists
    refused(db, f"insert into payg_settlement_reversals (settlement_id, account, month, kind, stripe_object_id, amount_cents, state) "
                f"values ('{uuid.uuid4()}', '{a}', '{m}', 'refund', 'ch_x', 1, 'partial')", "violates foreign key")
    # the id of one settlement with the account and month of another
    sid2, a2, m2 = settlement(db)
    refused(db, f"insert into payg_settlement_reversals (settlement_id, account, month, kind, stripe_object_id, amount_cents, state) "
                f"values ('{sid}', '{a2}', '{m2}', 'refund', 'ch_x', 1, 'partial')", "violates foreign key")
    # a referenced settlement cannot be deleted out from under its reversals
    refused(db, f"delete from usage_settlements where id = '{sid}'", "violates foreign key")


def test_a_reversal_is_shaped_per_kind(db):
    sid, a, m = settlement(db)
    reversal(db, sid, a, m, kind="refund", state="partial", amount=2500)
    reversal(db, sid, a, m, kind="dispute", state="needs_response", obj="dp_1")
    # a refund is partial or full and names its charge
    refused(db, f"insert into payg_settlement_reversals (dedupe_key, settlement_id, account, month, kind, stripe_object_id, amount_cents, state) values ('k-{uid()}', '{sid}', '{a}', '{m}', 'refund', 'ch_x', 1, 'someday')", "check constraint")
    refused(db, f"insert into payg_settlement_reversals (dedupe_key, settlement_id, account, month, kind, amount_cents, state) values ('k-{uid()}', '{sid}', '{a}', '{m}', 'refund', 1, 'partial')", "check constraint")
    # a dispute names its dispute; a release names the hold's own charge or dispute
    refused(db, f"insert into payg_settlement_reversals (dedupe_key, settlement_id, account, month, kind, amount_cents, state) values ('k-{uid()}', '{sid}', '{a}', '{m}', 'dispute', 1, 'lost')", "check constraint")
    refused(db, f"insert into payg_settlement_reversals (settlement_id, account, month, kind, amount_cents, state) values ('{sid}', '{a}', '{m}', 'release', 0, 'operator_release')", "check constraint")
    # the operator's release needs no key (one is made), is accepted with a note, and two releases are two rows
    for n in (1, 2):
        psql(db, f"insert into payg_settlement_reversals (settlement_id, account, month, kind, stripe_object_id, amount_cents, state, note) "
                 f"values ('{sid}', '{a}', '{m}', 'release', 'ch_x', 0, 'operator_release', 'goodwill {n}')")
    assert q(db, f"select count(*) from payg_settlement_reversals where settlement_id = '{sid}' and kind = 'release'") == "2"
    # no unknown kind, no negative or fractional amounts, no malformed month, no blank key, no array detail, a bounded note
    refused(db, f"insert into payg_settlement_reversals (dedupe_key, settlement_id, account, month, kind, stripe_object_id, amount_cents, state) values ('k-{uid()}', '{sid}', '{a}', '{m}', 'credit', 'x', 1, 'full')", "check constraint")
    refused(db, f"insert into payg_settlement_reversals (dedupe_key, settlement_id, account, month, kind, stripe_object_id, amount_cents, state) values ('k-{uid()}', '{sid}', '{a}', '{m}', 'refund', 'ch_x', -1, 'full')", "check constraint")
    refused(db, f"insert into payg_settlement_reversals (dedupe_key, settlement_id, account, month, kind, stripe_object_id, amount_cents, state) values ('   ', '{sid}', '{a}', '{m}', 'refund', 'ch_x', 1, 'full')", "check constraint")
    refused(db, f"insert into payg_settlement_reversals (dedupe_key, settlement_id, account, month, kind, stripe_object_id, amount_cents, state, detail) values ('k-{uid()}', '{sid}', '{a}', '{m}', 'refund', 'ch_x', 1, 'full', '[]')", "check constraint")
    refused(db, f"insert into payg_settlement_reversals (dedupe_key, settlement_id, account, month, kind, stripe_object_id, amount_cents, state, note) values ('k-{uid()}', '{sid}', '{a}', '{m}', 'refund', 'ch_x', 1, 'full', '{'x' * 501}')", "check constraint")


def test_reversals_are_append_only_even_for_the_owner_and_cannot_be_truncated(db):
    sid, a, m = settlement(db)
    k = reversal(db, sid, a, m)
    refused(db, f"update payg_settlement_reversals set amount_cents = 0 where dedupe_key = '{k}'", "append-only")
    refused(db, f"delete from payg_settlement_reversals where dedupe_key = '{k}'", "append-only")
    refused(db, "truncate payg_settlement_reversals", "append-only")
    assert q(db, f"select amount_cents from payg_settlement_reversals where dedupe_key = '{k}'") == "10000"
    # the settlement row it is about is not edited by recording it: its status is the invoice's own history
    assert q(db, f"select status from usage_settlements where id = '{sid}'") == "paid"


def test_privileges_the_api_roles_hold_nothing_and_the_service_role_can_read_and_append_only(db):
    for role in ("anon", "authenticated"):
        for priv in ("select", "insert", "update", "delete", "truncate"):
            assert q(db, f"select has_table_privilege('{role}', 'public.payg_settlement_reversals', '{priv}')") == "f", (role, priv)
    assert q(db, "select has_table_privilege('service_role', 'public.payg_settlement_reversals', 'select')") == "t"
    assert q(db, "select has_table_privilege('service_role', 'public.payg_settlement_reversals', 'insert')") == "t"
    for priv in ("update", "delete", "truncate"):
        assert q(db, f"select has_table_privilege('service_role', 'public.payg_settlement_reversals', '{priv}')") == "f", priv
    sid, a, m = settlement(db)
    psql(db, f"set role service_role; insert into payg_settlement_reversals (dedupe_key, settlement_id, account, month, kind, stripe_object_id, amount_cents, state) "
             f"values ('k-{uid()}', '{sid}', '{a}', '{m}', 'refund', 'ch_x', 1, 'partial')")
    refused(db, "set role anon; select 1 from payg_settlement_reversals", "permission denied")


def test_the_customers_view_query_is_served_for_an_account_newest_first(db):
    assert q(db, "select count(*) from pg_indexes where tablename = 'payg_settlement_reversals' and indexname in ('payg_settlement_reversals_account_idx', 'payg_settlement_reversals_settlement_idx')") == "2"
    sid, a, m = settlement(db)
    reversal(db, sid, a, m, kind="refund", state="partial", amount=2500, key=f"r1-{uid()}")
    reversal(db, sid, a, m, kind="refund", state="full", amount=10000, key=f"r2-{uid()}")
    reversal(db, sid, a, m, kind="dispute", state="won", obj="dp_1", key=f"d1-{uid()}")
    assert q(db, f"select count(*) from payg_settlement_reversals where account = '{a}' and kind in ('refund', 'dispute')") == "3"
    # what the usage page shows: the largest cumulative refund, per charge
    assert q(db, f"select max(amount_cents) from payg_settlement_reversals where account = '{a}' and kind = 'refund' and stripe_object_id = 'ch_x'") == "10000"
    assert q(db, f"select state from payg_settlement_reversals where account = '{a}' and kind = 'dispute' order by created_at desc limit 1") == "won"
