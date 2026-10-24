"""0041_billing_holds.sql against a real PostgreSQL.

The site's tests use an in-memory PostgREST, which cannot run a constraint, a trigger or a privilege. This applies the real chain of
migrations to a throwaway database and checks what 0041 promises: the hold and grace columns exist and are constrained, the audit table
is once-only and append-only (even for the table owner), the API roles hold nothing on it, the service role can read and append but not
rewrite, a re-apply changes nothing, and the new Intelligence status needs no schema change.

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
    for role, extra in (("anon", ""), ("authenticated", ""), ("service_role", " bypassrls")):  # Supabase's service_role bypasses RLS
        psql("postgres", f"do $$ begin if not exists (select 1 from pg_roles where rolname = '{role}') "
                         f"then create role {role} nologin{extra}; end if; end $$")
    psql("postgres", "alter role service_role bypassrls")  # a role another test file created without it, in a shared cluster
    # PRODUCTION: Supabase's default ACLs hand the API roles every privilege on every table created afterwards.
    psql(name, "grant usage on schema public to anon, authenticated, service_role; "
               "alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role")
    for f in sorted(MIGRATIONS.glob("*.sql")):
        psql(name, file=f)
    yield name
    psql("postgres", f"drop database {name} with (force)")


def account(db, **kw):
    a = f"acct-{uid()}"
    cols = {"token": f"tok-{uid()}{uid()}", "account": a, "plan": "api_scale", **kw}
    psql(db, f"insert into api_accounts ({', '.join(cols)}) values ({', '.join('null' if v is None else repr(v) for v in cols.values())})")
    return a


def audit(db, key=None, table="api_accounts", subject=None, action="hold_applied", detail="{}"):
    key = key or f"k-{uid()}"
    psql(db, f"insert into billing_audit (dedupe_key, subject_table, subject_id, action, detail) "
             f"values ('{key}', '{table}', '{subject or uid()}', '{action}', '{detail}')")
    return key


def test_it_is_in_the_chain_and_the_chain_applies(db):
    names = sorted(p.name for p in MIGRATIONS.glob("*.sql"))
    assert "0041_billing_holds.sql" in names, names[-3:]


def test_reapplying_changes_nothing_and_leaves_row_level_security_as_it_was(db):
    def rls(t):
        return q(db, f"select relrowsecurity from pg_class where relname = '{t}' and relnamespace = 'public'::regnamespace")

    def policies(t):
        return q(db, f"select count(*) from pg_policies where tablename = '{t}'")

    a = account(db)
    psql(db, f"update api_accounts set billing_hold = 'refunded', billing_hold_ref = 'ch_x', past_due_since = '2026-10-01Z' where account = '{a}'")
    key = audit(db)
    before = {t: (rls(t), policies(t)) for t in ("api_accounts", "watches", "subscriptions", "billing_audit")}
    psql(db, file=MIGRATIONS / "0041_billing_holds.sql")
    psql(db, file=MIGRATIONS / "0041_billing_holds.sql")
    assert {t: (rls(t), policies(t)) for t in before} == before
    assert q(db, f"select billing_hold from api_accounts where account = '{a}'") == "refunded"  # data survives a re-apply
    assert q(db, f"select count(*) from billing_audit where dedupe_key = '{key}'") == "1"
    assert rls("billing_audit") == "t"
    assert policies("billing_audit") == "0"


def test_the_columns_exist_with_their_types_and_default_to_null(db):
    def col(table, name):
        return q(db, f"select data_type from information_schema.columns where table_schema = 'public' and table_name = '{table}' and column_name = '{name}'")

    assert col("api_accounts", "past_due_since") == "timestamp with time zone"
    for t in ("api_accounts", "watches", "subscriptions"):
        for c in ("billing_hold", "billing_hold_ref", "billing_hold_invoice", "billing_hold_prev_status"):
            assert col(t, c) == "text", (t, c)
        assert col(t, "billing_hold_at") == "timestamp with time zone", t
    a = account(db)
    assert q(db, f"select past_due_since is null and billing_hold is null from api_accounts where account = '{a}'") == "t"


def test_a_hold_is_one_of_three_kinds_or_none_on_every_table(db):
    a = account(db)
    w = f"w-{uid()}{uid()}"
    psql(db, f"insert into watches (token) values ('{w}')")
    s = f"cs_{uid()}"
    psql(db, f"insert into subscriptions (email, plan, stripe_session_id) values ('{s}@x.example', 'team', '{s}')")
    for kind in ("refunded", "disputed", "paused"):
        psql(db, f"update api_accounts set billing_hold = '{kind}' where account = '{a}'")
        psql(db, f"update watches set billing_hold = '{kind}' where token = '{w}'")
        psql(db, f"update subscriptions set billing_hold = '{kind}' where stripe_session_id = '{s}'")
    psql(db, f"update api_accounts set billing_hold = null where account = '{a}'")
    for stmt in (f"update api_accounts set billing_hold = 'cancelled' where account = '{a}'",
                 f"update watches set billing_hold = 'x' where token = '{w}'",
                 f"update subscriptions set billing_hold = '' where stripe_session_id = '{s}'"):
        refused(db, stmt, "billing_hold_check")


def test_intelligence_can_be_suspended_without_a_schema_change_and_the_one_active_rule_still_holds(db):
    e = f"{uid()}@hall.example"
    for n in (1, 2):
        psql(db, f"insert into subscriptions (email, plan, status, stripe_session_id) values ('{e}', 'team', 'suspended', 'cs_{uid()}')")
    psql(db, f"insert into subscriptions (email, plan, status, stripe_session_id) values ('{e}', 'team', 'active', 'cs_{uid()}')")
    refused(db, f"insert into subscriptions (email, plan, status, stripe_session_id) values ('{e}', 'team', 'active', 'cs_{uid()}')", "subscriptions_one_active_per_email")


def test_audit_is_once_per_key_and_refuses_blank_or_malformed_rows(db):
    k = audit(db)
    refused(db, f"insert into billing_audit (dedupe_key, subject_table, subject_id, action) values ('{k}', 'api_accounts', 'x', 'hold_applied')", "duplicate key")
    psql(db, f"insert into billing_audit (dedupe_key, subject_table, subject_id, action) values ('{k}', 'api_accounts', 'x', 'hold_applied') on conflict (dedupe_key) do nothing")
    assert q(db, f"select count(*) from billing_audit where dedupe_key = '{k}'") == "1"
    refused(db, "insert into billing_audit (dedupe_key, subject_table, subject_id, action) values ('   ', 'api_accounts', 'x', 'a')", "check constraint")
    refused(db, f"insert into billing_audit (dedupe_key, subject_table, subject_id, action) values ('k-{uid()}', 'leads', 'x', 'a')", "check constraint")
    refused(db, f"insert into billing_audit (dedupe_key, subject_table, subject_id, action) values ('k-{uid()}', 'watches', ' ', 'a')", "check constraint")
    refused(db, f"insert into billing_audit (dedupe_key, subject_table, subject_id, action) values ('k-{uid()}', 'watches', 'x', '')", "check constraint")
    refused(db, f"insert into billing_audit (dedupe_key, subject_table, subject_id, action, detail) values ('k-{uid()}', 'watches', 'x', 'a', '[]')", "check constraint")


def test_audit_is_append_only_even_for_the_owner_and_cannot_be_truncated(db):
    k = audit(db)
    refused(db, f"update billing_audit set action = 'forged' where dedupe_key = '{k}'", "append-only")
    refused(db, f"delete from billing_audit where dedupe_key = '{k}'", "append-only")
    refused(db, "truncate billing_audit", "append-only")
    assert q(db, f"select action from billing_audit where dedupe_key = '{k}'") == "hold_applied"


def test_privileges_the_api_roles_hold_nothing_and_the_service_role_can_read_and_append_only(db):
    for role in ("anon", "authenticated"):
        for priv in ("select", "insert", "update", "delete", "truncate"):
            assert q(db, f"select has_table_privilege('{role}', 'public.billing_audit', '{priv}')") == "f", (role, priv)
    assert q(db, "select has_table_privilege('service_role', 'public.billing_audit', 'select')") == "t"
    assert q(db, "select has_table_privilege('service_role', 'public.billing_audit', 'insert')") == "t"
    for priv in ("update", "delete", "truncate"):
        assert q(db, f"select has_table_privilege('service_role', 'public.billing_audit', '{priv}')") == "f", priv
    # and as the service role, appending works through the privilege layer
    psql(db, f"set role service_role; insert into billing_audit (dedupe_key, subject_table, subject_id, action) values ('k-{uid()}', 'api_accounts', 'x', 'hold_applied')")
    refused(db, "set role anon; select 1 from billing_audit", "permission denied")


def test_the_grace_pass_query_is_served_by_an_index_and_selects_what_the_site_selects(db):
    assert q(db, "select count(*) from pg_indexes where tablename = 'api_accounts' and indexname = 'api_accounts_past_due_idx'") == "1"
    a = account(db, status="past_due", stripe_subscription_id=f"sub_{uid()}")
    held = account(db, status="past_due", stripe_subscription_id=f"sub_{uid()}")
    psql(db, f"update api_accounts set billing_hold = 'paused' where account = '{held}'")
    payg = account(db, status="past_due")  # no subscription: not a subscription plan
    rows = q(db, "select string_agg(account, ',' order by account) from api_accounts where status = 'past_due' and billing_hold is null "
                 f"and stripe_subscription_id is not null and account in ('{a}', '{held}', '{payg}')")
    assert rows == a
