"""0028_payg_ledger.sql against a real PostgreSQL.

The site's tests mirror these SQL functions in TypeScript; that mirror cannot run a trigger, a unique index, a role grant or two
connections at once. This applies the real chain of migrations to a throwaway database and attacks the billing model the way a
careless or hostile service-role caller would: it replays and reorders ledger pages, races the free-allowance ceiling and the last
Founding slot from many connections, tries to edit the append-only ledger, drops revoked key ids from an account, and calls the
functions as the API roles.

Needs a reachable PostgreSQL (`psql` plus PG* variables, or GRIDFORGE_TEST_PG_URL). Skipped, loudly, where there is none: a skip is
a gap in what was checked, not a pass. GRIDFORGE_REQUIRE_DB=1 turns the skip into a failure.
"""
import json
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


def parallel(db, statements):
    procs = [subprocess.Popen(_cmd(db) + ["-c", s], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for s in statements]
    out = []
    for p in procs:
        so, se = p.communicate()
        out.append((p.returncode, so.strip(), se))
    return out


def refused(db, sql, needle):
    r = psql(db, sql, check=False)
    assert r.returncode != 0, f"expected refusal: {sql}"
    assert needle in r.stderr, r.stderr


def q(db, sql):
    return psql(db, sql).stdout.strip()


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


def uid():
    return uuid.uuid4().hex[:10]


def account(db, plan="api_payg", **kw):
    a = f"acct-{uid()}"
    cols = {"token": f"tok-{uid()}{uid()}", "account": a, "plan": plan, **kw}
    names = ", ".join(cols)
    vals = ", ".join("null" if v is None else f"'{v}'" for v in cols.values())
    psql(db, f"insert into api_accounts ({names}) values ({vals})")
    return a


_seq = [0]


def event(db, acct, units=5, kind="charge", scope="payg", ts="2026-09-10T12:00:00Z", ref="", eid=None, seq=None):
    """Insert straight into usage_events (the ledger copy) for aggregation tests."""
    _seq[0] += 1
    s = seq if seq is not None else 1_000_000 + _seq[0] + int(uuid.uuid4().int % 10**9)
    e = eid or f"ev-{uid()}"
    psql(db, f"insert into usage_events (event_id, seq, account, scope, units, kind, ref, occurred_at) "
             f"values ('{e}', {s}, '{acct}', '{scope}', {units}, '{kind}', '{ref}', '{ts}')")
    return e


# --------------------------------------------------------------------------------------------------- the migration

def test_applying_the_migration_again_changes_nothing(db):
    a = account(db)
    event(db, a)
    before = q(db, "select count(*) from usage_events")
    psql(db, file=MIGRATIONS / "0028_payg_ledger.sql")
    assert q(db, "select count(*) from usage_events") == before
    assert q(db, "select last_seq from payg_cursor where id = 1") is not None


def test_every_new_table_has_row_level_security_and_the_api_roles_have_no_privileges(db):
    tables = ["usage_events", "payg_cursor", "usage_settlements", "usage_alerts", "funnel_events", "founding_reservations"]
    for t in tables:
        assert q(db, f"select relrowsecurity from pg_class where relname = '{t}' and relnamespace = 'public'::regnamespace") == "t", t
        assert q(db, f"select count(*) from pg_policies where tablename = '{t}'") == "0", t  # no policies: service role only
        for role in ("anon", "authenticated"):
            assert q(db, f"select has_table_privilege('{role}', 'public.{t}', 'select')") == "f", (t, role)
            assert q(db, f"select has_table_privilege('{role}', 'public.{t}', 'insert')") == "f", (t, role)
        assert q(db, f"select has_table_privilege('service_role', 'public.{t}', 'select')") == "t", t
    assert q(db, "select has_table_privilege('anon', 'public.usage_effective', 'select')") == "f"


def test_the_gf_functions_of_this_migration_are_service_role_only(db):
    fns = ["gf_founding_reserve(integer,integer,integer)", "gf_usage_ingest(jsonb,bigint)", "gf_usage_net(text,timestamptz,timestamptz)",
           "gf_usage_month_totals(timestamptz,timestamptz)", "gf_payg_unsettled(text)",
           "gf_free_account_create(text,text,text,text,text,integer,integer)"]
    for f in fns:
        for role in ("anon", "authenticated"):
            assert q(db, f"select has_function_privilege('{role}', 'public.{f}', 'execute')") == "f", (f, role)
        assert q(db, f"select has_function_privilege('service_role', 'public.{f}', 'execute')") == "t", f
        assert q(db, f"select has_function_privilege('public', 'public.{f}', 'execute')") == "f", f


# ------------------------------------------------------------------------------------------------ the ledger copy

def test_the_ledger_is_append_only_and_its_checks_hold(db):
    a = account(db)
    e = event(db, a)
    refused(db, f"update usage_events set units = 1 where event_id = '{e}'", "append-only")
    refused(db, f"delete from usage_events where event_id = '{e}'", "append-only")
    refused(db, f"insert into usage_events (event_id, seq, account, units, kind, occurred_at) values ('x{uid()}', 1, '{a}', 0, 'charge', now())", "violates check")
    refused(db, f"insert into usage_events (event_id, seq, account, units, kind, occurred_at) values ('x{uid()}', 2, '{a}', 3, 'gift', now())", "violates check")
    # a charge never carries a ref
    refused(db, f"insert into usage_events (event_id, seq, account, units, kind, ref, occurred_at) values ('x{uid()}', 3, '{a}', 3, 'charge', 'other', now())", "violates check")
    # event_id and seq are each unique
    refused(db, f"insert into usage_events (event_id, seq, account, units, kind, occurred_at) values ('{e}', 999999999, '{a}', 3, 'charge', now())", "duplicate key")


def page(a, seqs, start_id="p"):
    return json.dumps([{"event_id": f"{start_id}{s}", "seq": s, "account": a, "key_id": "k", "scope": "payg", "endpoint": "/v1/study",
                        "units": 2, "kind": "charge", "project": "", "idem": "", "ref": "", "occurred_at": "2026-09-01T00:00:00Z"} for s in seqs])


def test_ingest_is_idempotent_and_moves_the_cursor_with_the_rows(db):
    a = account(db)
    base = int(q(db, "select coalesce(max(seq), 0) from usage_events")) + 10_000
    seqs = [base + 1, base + 2, base + 3]
    r1 = json.loads(q(db, f"select public.gf_usage_ingest('{page(a, seqs, 'i')}'::jsonb, {seqs[-1]})"))
    assert r1["inserted"] == 3 and r1["cursor"] == seqs[-1]
    r2 = json.loads(q(db, f"select public.gf_usage_ingest('{page(a, seqs, 'i')}'::jsonb, {seqs[-1]})"))
    assert r2["inserted"] == 0 and r2["cursor"] == seqs[-1]
    assert q(db, f"select count(*) from usage_events where account = '{a}'") == "3"
    # the cursor never goes backwards, whatever a replayed page claims
    r3 = json.loads(q(db, f"select public.gf_usage_ingest('{page(a, [], 'i')}'::jsonb, 5)"))
    assert r3["cursor"] == seqs[-1]


def test_a_failing_page_rolls_back_its_rows_and_its_cursor_together(db):
    a = account(db)
    cur = int(q(db, "select last_seq from payg_cursor where id = 1"))
    seq_taken = cur + 50_000
    psql(db, f"insert into usage_events (event_id, seq, account, units, kind, occurred_at) values ('taken{uid()}', {seq_taken}, '{a}', 1, 'charge', now())")
    new = [cur + 40_000, seq_taken]  # the second collides on seq with a different event id
    refused(db, f"select public.gf_usage_ingest('{page(a, new, 'f')}'::jsonb, {seq_taken})", "duplicate key")
    assert int(q(db, "select last_seq from payg_cursor where id = 1")) == cur  # the cursor did NOT move
    assert q(db, f"select count(*) from usage_events where event_id = 'f{new[0]}'") == "0"  # and the page's first row did not stay
    refused(db, "select public.gf_usage_ingest('{}'::jsonb, 1)", "must be a JSON array")


# ---------------------------------------------------------------------------------------------------- net usage

def test_net_usage_is_charges_minus_refunds_and_a_refund_follows_its_charge_across_midnight(db):
    a = account(db)
    c1 = event(db, a, 6, ts="2026-09-30T23:59:59.999Z")
    event(db, a, 6, kind="refund", ts="2026-10-01T00:00:00.001Z", ref=c1)
    event(db, a, 4, ts="2026-09-12T10:00:00Z")
    sep = json.loads(q(db, f"select public.gf_usage_net('{a}', '2026-09-01Z', '2026-10-01Z')"))
    octo = json.loads(q(db, f"select public.gf_usage_net('{a}', '2026-10-01Z', '2026-11-01Z')"))
    assert sep["net"] == 4 and sep["charged"] == 10 and sep["refunded"] == 6
    assert octo["net"] == 0  # not negative, and September's refund is not October's


def test_only_payg_scope_is_billable_and_only_closed_unsettled_months_are_listed(db):
    pay = account(db)
    free = account(db, plan="api_free")
    event(db, pay, 7, scope="payg", ts="2026-08-05T00:00:00Z")
    event(db, pay, 20, scope="trial", ts="2026-08-06T00:00:00Z")
    event(db, pay, 9, scope="machine", ts="2026-08-07T00:00:00Z")
    event(db, free, 25, scope="trial", ts="2026-08-08T00:00:00Z")
    event(db, pay, 3, scope="payg", ts="2026-11-02T00:00:00Z")  # the "current" month in this call
    rows = [l.split("|") for l in q(db, f"select account, month, net_units from public.gf_payg_unsettled('2026-11') where account in ('{pay}', '{free}')").splitlines()]
    assert rows == [[pay, "2026-08", "7"]]
    # a refund inherits the CHARGE's scope: refunding a trial charge does not reduce billable usage
    t = event(db, pay, 5, scope="trial", ts="2026-08-09T00:00:00Z")
    event(db, pay, 5, kind="refund", scope="payg", ts="2026-08-09T00:00:01Z", ref=t)
    rows = q(db, f"select net_units from public.gf_payg_unsettled('2026-11') where account = '{pay}'")
    assert rows == "7"
    # once settled, the month is no longer listed
    psql(db, f"insert into usage_settlements (account, month, units, amount_cents, status) values ('{pay}', '2026-08', 7, 1400, 'invoiced')")
    assert q(db, f"select count(*) from public.gf_payg_unsettled('2026-11') where account = '{pay}'") == "0"


def test_an_event_for_an_account_that_does_not_exist_is_never_listed_for_settlement(db):
    event(db, "ghost-account", 10, ts="2026-08-05T00:00:00Z")
    assert q(db, "select count(*) from public.gf_payg_unsettled('2026-11') where account = 'ghost-account'") == "0"


def test_month_totals_group_by_account(db):
    a, b = account(db), account(db)
    event(db, a, 5, ts="2027-03-02T00:00:00Z")
    event(db, a, 5, ts="2027-03-03T00:00:00Z")
    event(db, b, 8, scope="trial", ts="2027-03-04T00:00:00Z")
    got = {l.split("|")[0]: l.split("|")[1:] for l in q(db, "select * from public.gf_usage_month_totals('2027-03-01Z', '2027-04-01Z')").splitlines()}
    assert got[a] == ["10", "10"] and got[b] == ["8", "0"]


# --------------------------------------------------------------------------------------------------- settlements

def test_one_settlement_per_account_and_month_and_its_checks(db):
    a = account(db)
    psql(db, f"insert into usage_settlements (account, month, units, amount_cents) values ('{a}', '2026-08', 3, 600)")
    refused(db, f"insert into usage_settlements (account, month, units, amount_cents) values ('{a}', '2026-08', 3, 600)", "duplicate key")
    # ON CONFLICT DO NOTHING is how the site makes a second cron run a no-op
    psql(db, f"insert into usage_settlements (account, month, units, amount_cents) values ('{a}', '2026-08', 99, 1) on conflict (account, month) do nothing")
    assert q(db, f"select units from usage_settlements where account = '{a}'") == "3"
    for bad in ("2026-13", "2026-8", "Aug-2026", "2026-00"):
        refused(db, f"insert into usage_settlements (account, month, units, amount_cents) values ('{a}', '{bad}', 1, 1)", "violates check")
    refused(db, f"insert into usage_settlements (account, month, units, amount_cents, status) values ('{a}', '2026-09', 1, 1, 'refunded')", "violates check")
    refused(db, f"insert into usage_settlements (account, month, units, amount_cents) values ('{a}', '2026-10', 1, -1)", "violates check")


def test_one_alert_per_account_month_and_percent(db):
    a = account(db)
    psql(db, f"insert into usage_alerts (account, month, percent) values ('{a}', '2026-10', 80)")
    refused(db, f"insert into usage_alerts (account, month, percent) values ('{a}', '2026-10', 80)", "duplicate key")
    psql(db, f"insert into usage_alerts (account, month, percent) values ('{a}', '2026-10', 100)")


# --------------------------------------------------------------------------------------------------- free accounts

def free(db, email_norm, maxn, tok=None):
    t = tok or f"t{uid()}{uid()}"
    return json.loads(q(db, f"select public.gf_free_account_create('{email_norm}', '{email_norm}', null, '{t}', 'free-{uid()}', 25, {maxn})"))


def test_one_free_account_per_normalised_email_and_it_survives_an_upgrade(db):
    e = f"dev{uid()}@example.com"
    first = free(db, e, 10_000)
    assert first["created"] is True
    again = free(db, e, 10_000)
    assert again == {"created": False, "id": first["id"]}
    assert q(db, f"select count(*) from api_accounts where free_email_norm = '{e}'") == "1"
    # upgrading to pay-as-you-go keeps the claim: the address cannot take a second allowance
    psql(db, f"update api_accounts set plan = 'api_payg' where id = '{first['id']}'")
    assert free(db, e, 10_000) == {"created": False, "id": first["id"]}
    # and the unique index itself refuses a direct duplicate
    refused(db, f"insert into api_accounts (token, account, plan, free_email_norm) values ('{uid()}{uid()}x', 'dup-{uid()}', 'api_free', '{e}')", "duplicate key")
    # many accounts without a free claim are not constrained by it
    psql(db, f"insert into api_accounts (token, account, plan) values ('{uid()}{uid()}y', 'n1-{uid()}', 'api_scale'), ('{uid()}{uid()}z', 'n2-{uid()}', 'api_scale')")


def test_the_monthly_ceiling_holds_under_concurrent_requests(db):
    already = int(q(db, "select count(*) from api_accounts where free_email_norm is not null and created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'"))
    ceiling = already + 3
    stmts = [f"select public.gf_free_account_create('race{i}{uid()}@example.com', 'x', null, 'tk{i}{uid()}{uid()}', 'race-{i}-{uid()}', 25, {ceiling})" for i in range(12)]
    results = parallel(db, stmts)
    assert all(rc == 0 for rc, _, _ in results), [se for _, _, se in results if se]
    outcomes = [json.loads(so) for _, so, _ in results]
    assert sum(1 for o in outcomes if o["created"]) == 3
    assert sum(1 for o in outcomes if o.get("reason") == "capacity") == 9
    assert int(q(db, "select count(*) from api_accounts where free_email_norm is not null and created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'")) == ceiling
    # an address that already has an account is answered even at the ceiling
    existing = q(db, "select free_email_norm from api_accounts where free_email_norm like 'race%' limit 1")
    assert free(db, existing, ceiling)["created"] is False and "reason" not in free(db, existing, ceiling)


def test_free_account_arguments_are_range_checked(db):
    refused(db, "select public.gf_free_account_create('', 'x', null, 'tttttttttttttttt', 'a', 25, 5)", "out of range")
    refused(db, "select public.gf_free_account_create('a@b.c', 'x', null, 'tttttttttttttttt', 'a', 0, 5)", "out of range")
    refused(db, "select public.gf_free_account_create('a@b.c', 'x', null, 'tttttttttttttttt', 'a', 25, -1)", "out of range")


# ----------------------------------------------------------------------------------------- the Founding Partner slot

def test_the_last_founding_slot_goes_to_exactly_one_of_many_concurrent_checkouts(db):
    psql(db, "delete from founding_reservations")
    results = parallel(db, ["select public.gf_founding_reserve(4, 5, 35)" for _ in range(10)])
    assert all(rc == 0 for rc, _, _ in results), [se for _, _, se in results if se]
    got = [so for _, so, _ in results if so]
    assert len(got) == 1  # one uuid; the other nine are null
    assert q(db, "select count(*) from founding_reservations") == "1"


def test_founding_slots_are_paid_plus_live_reservations_and_expired_ones_free_theirs(db):
    psql(db, "delete from founding_reservations")
    got = [q(db, "select public.gf_founding_reserve(2, 5, 35)") for _ in range(5)]
    assert len([g for g in got if g]) == 3  # 5 total - 2 paid
    psql(db, "update founding_reservations set expires_at = now() - interval '1 minute' where id = (select id from founding_reservations limit 1)")
    assert q(db, "select public.gf_founding_reserve(2, 5, 35)") != ""  # the expired one was swept and its slot is free again
    assert q(db, "select count(*) from founding_reservations") == "3"
    refused(db, "select public.gf_founding_reserve(0, 5, 0)", "out of range")
    refused(db, "select public.gf_founding_reserve(-1, 5, 35)", "out of range")


# ---------------------------------------------------------------------------------- revoked ids on the account row

def arr(db, a, col):
    return q(db, f"select array_to_string({col}, ',') from api_accounts where account = '{a}'")


def test_revoked_key_ids_only_accumulate_whatever_a_writer_sends(db):
    a = account(db)
    psql(db, f"update api_accounts set revoked_key_ids = array['k1','k2'] where account = '{a}'")
    # a racing writer that read the row BEFORE k2 was recorded sends its own, shorter list: nothing is lost
    psql(db, f"update api_accounts set revoked_key_ids = array['k1','k3'] where account = '{a}'")
    assert sorted(arr(db, a, "revoked_key_ids").split(",")) == ["k1", "k2", "k3"]
    psql(db, f"update api_accounts set revoked_key_ids = array[]::text[] where account = '{a}'")
    psql(db, f"update api_accounts set revoked_key_ids = null where account = '{a}'")
    assert sorted(arr(db, a, "revoked_key_ids").split(",")) == ["k1", "k2", "k3"]


def test_revocation_is_pending_until_every_revoked_id_is_confirmed(db):
    a = account(db)
    assert q(db, f"select revocation_pending from api_accounts where account = '{a}'") == "f"
    psql(db, f"update api_accounts set revoked_key_ids = array['k1','k2'] where account = '{a}'")
    assert q(db, f"select revocation_pending from api_accounts where account = '{a}'") == "t"
    psql(db, f"update api_accounts set revoked_confirmed_ids = array['k1'] where account = '{a}'")
    assert q(db, f"select revocation_pending from api_accounts where account = '{a}'") == "t"
    psql(db, f"update api_accounts set revoked_confirmed_ids = array['k2'] where account = '{a}'")  # accumulates: k1 is kept
    assert sorted(arr(db, a, "revoked_confirmed_ids").split(",")) == ["k1", "k2"]
    assert q(db, f"select revocation_pending from api_accounts where account = '{a}'") == "f"
    psql(db, f"update api_accounts set revoked_key_ids = array['k1','k2','k3'] where account = '{a}'")
    assert q(db, f"select revocation_pending from api_accounts where account = '{a}'") == "t"
    # the sweep's query is served by the partial index
    assert q(db, f"select count(*) from api_accounts where revocation_pending and account = '{a}'") == "1"


def test_cap_must_be_positive_and_key_scope_known(db):
    a = account(db)
    refused(db, f"update api_accounts set cap_units = 0 where account = '{a}'", "violates check")
    refused(db, f"update api_accounts set key_scope = 'root' where account = '{a}'", "violates check")
    psql(db, f"update api_accounts set cap_units = 50, key_scope = 'payg' where account = '{a}'")


# --------------------------------------------------------------------------------------- the outbox and the funnel

def test_the_outbox_accepts_usage_alerts_and_still_refuses_unknown_kinds(db):
    a = account(db)
    aid = q(db, f"select id from api_accounts where account = '{a}'")
    psql(db, f"insert into customer_notifications (dedupe_key, kind, subject_table, subject_id) values ('usage_alert:{aid}:2026-10:80', 'usage_alert', 'api_accounts', '{aid}')")
    refused(db, f"insert into customer_notifications (dedupe_key, kind, subject_table, subject_id) values ('x:{aid}', 'newsletter', 'api_accounts', '{aid}')", "violates check")
    refused(db, f"insert into customer_notifications (dedupe_key, kind, subject_table, subject_id) values ('usage_alert:{aid}:2026-10:80', 'usage_alert', 'api_accounts', '{aid}')", "duplicate key")
    # earlier kinds (including the team invitation) are still accepted
    psql(db, f"insert into customer_notifications (dedupe_key, kind, subject_table, subject_id) values ('key_rotation:{aid}:2026-12-01', 'key_rotation', 'api_accounts', '{aid}')")


def test_funnel_events_have_a_closed_name_list_and_once_only_keys(db):
    psql(db, "insert into funnel_events (name, props) values ('key_minted', '{}'), ('key_minted', '{}')")  # no dedupe key: any number
    psql(db, "insert into funnel_events (name, props, dedupe_key) values ('payg_enabled', '{\"cap_eur\": 100}', 'payg_enabled:abc')")
    refused(db, "insert into funnel_events (name, props, dedupe_key) values ('payg_enabled', '{}', 'payg_enabled:abc')", "duplicate key")
    refused(db, "insert into funnel_events (name, props) values ('page_view', '{}')", "violates check")
    refused(db, "insert into funnel_events (name, props) values ('key_minted', '[1]')", "violates check")
