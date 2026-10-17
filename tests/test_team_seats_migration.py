"""0027_team_seats.sql against a real PostgreSQL.

The site's tests mirror these functions in memory; that mirror cannot run a trigger, a partial unique index, a role grant or two
connections at once. This applies the real chain of migrations to a throwaway database and attacks the seat model the way a
careless or hostile service-role caller would: it races the last seat from several connections, tries to reopen a spent
invitation, delete the history, or call the functions as the API roles. It also pins the seat counts in SQL to the catalogue in
lib/products.ts, so the two cannot drift.

Needs a reachable PostgreSQL (`psql` plus PG* variables, or GRIDFORGE_TEST_PG_URL). Skipped, loudly, where there is none: a skip
is a gap in what was checked, not a pass. GRIDFORGE_REQUIRE_DB=1 turns the skip into a failure.
"""
import hashlib
import json
import os
import re
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
    """Run each statement on its OWN connection at the same moment; return (returncode, stdout, stderr) for each."""
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


@pytest.fixture(scope="module", autouse=True)
def _database_is_reachable():
    if not REQUIRED:
        return
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


def h(s):
    return hashlib.sha256(s.encode()).hexdigest()


def new_owner(db, plan, status="active"):
    email = f"owner-{uuid.uuid4().hex[:8]}@t.example"
    psql(db, f"insert into subscriptions (email, plan, status) values ('{email}', '{plan}', '{status}')")
    return email


def invite(db, owner, who, ttl="7 days"):
    secret = uuid.uuid4().hex
    out = psql(db, f"select public.gf_invite_member('{owner}', '{who}', '{uuid.uuid4()}', '{h(secret)}', now() + interval '{ttl}')").stdout
    return json.loads(out), secret


def accept_sql(secret, who):
    return f"select public.gf_accept_invitation('{h(secret)}', '{who}')"


def accept(db, secret, who):
    return json.loads(psql(db, accept_sql(secret, who)).stdout)


# --------------------------------------------------------------------------- the catalogue and the database agree

def _catalogue_seats():
    src = (ROOT / "lib" / "products.ts").read_text()
    block = src[src.index("export const INTELLIGENCE_PLANS"):]
    found = {}
    for plan, seats in re.findall(r'^\s{2}(developer|team|enterprise): \{.*?\bseats: (\d+|null),', block, re.S | re.M):
        found[plan] = None if seats == "null" else int(seats)
    return found


def test_the_seat_counts_in_sql_are_the_catalogues(db):
    catalogue = _catalogue_seats()
    assert catalogue == {"developer": 1, "team": 5, "enterprise": None}, catalogue
    for plan, seats in catalogue.items():
        got = psql(db, f"select coalesce(public.gf_plan_seats('{plan}')::text, 'unlimited')").stdout.strip()
        assert got == ("unlimited" if seats is None else str(seats)), (plan, got)
    # An unrecognised plan fails closed: the owner alone.
    assert psql(db, "select public.gf_plan_seats('platinum')").stdout.strip() == "1"
    assert psql(db, "select public.gf_plan_seats(null)").stdout.strip() == "1"


def test_applying_the_migration_again_changes_nothing(db):
    o = new_owner(db, "team")
    r, s = invite(db, o, "again@g.example")
    assert r["ok"]
    psql(db, file=MIGRATIONS / "0027_team_seats.sql")
    assert psql(db, f"select count(*) from subscription_invitations where owner_email = '{o}'").stdout.strip() == "1"
    assert accept(db, s, "again@g.example")["ok"]


# --------------------------------------------------------------------------- the seat arithmetic, in the database

def test_developer_has_no_seat_to_give_and_team_has_four_beyond_the_owner(db):
    d = new_owner(db, "developer")
    r, _ = invite(db, d, "x@g.example")
    assert r == {"ok": False, "reason": "no_seats", "seats": 1, "used": 1, "reserved": 0}

    t = new_owner(db, "team")
    results = [invite(db, t, f"g{i}@g.example")[0] for i in range(6)]
    assert [x["ok"] for x in results] == [True] * 4 + [False] * 2
    assert all(x["reason"] == "no_seats" for x in results[4:])


def test_enterprise_has_no_cap(db):
    e = new_owner(db, "enterprise")
    for i in range(30):
        assert invite(db, e, f"u{i}@g.example")[0]["ok"]


def test_an_inactive_owner_can_neither_invite_nor_be_joined(db):
    for status in ("cancelled", "superseded"):
        o = new_owner(db, "team", status)
        assert invite(db, o, "x@g.example")[0] == {"ok": False, "reason": "no_subscription"}
    o = new_owner(db, "team")
    r, secret = invite(db, o, "late@g.example")
    psql(db, f"update subscriptions set status = 'cancelled' where email = '{o}'")
    assert accept(db, secret, "late@g.example") == {"ok": False, "reason": "inactive"}
    assert psql(db, f"select count(*) from subscription_members where owner_email = '{o}'").stdout.strip() == "0"
    assert psql(db, "select public.gf_member_entitlement('late@g.example')").stdout.strip() == ""


def test_a_past_due_owner_still_entitles_members_as_the_existing_rule_says(db):
    o = new_owner(db, "team", "past_due")
    r, secret = invite(db, o, "pd@g.example")
    assert r["ok"] and accept(db, secret, "pd@g.example")["ok"]
    got = json.loads(psql(db, "select public.gf_member_entitlement('pd@g.example')").stdout)
    assert got["owner_email"] == o and got["subscription"]["status"] == "past_due"


# --------------------------------------------------------------------------- racing connections

def test_racing_acceptances_for_the_last_seats_never_exceed_the_plan(db):
    o = new_owner(db, "enterprise")
    secrets = []
    for i in range(10):
        r, s = invite(db, o, f"race{i}@g.example")
        assert r["ok"]
        secrets.append((s, f"race{i}@g.example"))
    psql(db, f"update subscriptions set plan = 'team' where email = '{o}'")        # five seats, owner included
    out = parallel(db, [accept_sql(s, e) for s, e in secrets])
    answers = [json.loads(so) for rc, so, se in out if rc == 0]
    assert len(answers) == 10, [se for rc, so, se in out if rc]
    assert sum(1 for a in answers if a["ok"]) == 4
    assert all(a["reason"] == "no_seats" for a in answers if not a["ok"])
    assert psql(db, f"select count(*) from subscription_members where owner_email = '{o}' and removed_at is null").stdout.strip() == "4"


def test_racing_invitations_never_hold_more_than_the_plan(db):
    o = new_owner(db, "team")
    stmts = [f"select public.gf_invite_member('{o}', 'p{i}@g.example', '{uuid.uuid4()}', '{h(uuid.uuid4().hex)}', now() + interval '1 day')" for i in range(12)]
    answers = [json.loads(so) for rc, so, se in parallel(db, stmts) if rc == 0]
    assert len(answers) == 12
    assert sum(1 for a in answers if a["ok"]) == 4


def test_one_invitation_raced_by_one_person_seats_them_once(db):
    o = new_owner(db, "team")
    r, secret = invite(db, o, "twice@g.example")
    answers = [json.loads(so) for rc, so, se in parallel(db, [accept_sql(secret, "twice@g.example")] * 6) if rc == 0]
    assert sum(1 for a in answers if a["ok"]) == 1
    assert sorted(a["reason"] for a in answers if not a["ok"]) == ["used"] * 5
    assert psql(db, f"select count(*) from subscription_members where owner_email = '{o}'").stdout.strip() == "1"


def test_a_seat_cannot_be_granted_against_a_subscription_that_is_being_replaced(db):
    """The webhook's supersede UPDATE and an acceptance take the same row lock, so they serialise instead of interleaving."""
    o = new_owner(db, "team")
    r, secret = invite(db, o, "swap@g.example")
    a = subprocess.Popen(_cmd(db) + ["-c", f"begin; select public.gf_accept_invitation('{h(secret)}', 'swap@g.example'); select pg_sleep(2); commit"],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    import time
    # Wait until that transaction is really inside its sleep (so it holds the lock), rather than guessing how long psql takes to start.
    for _ in range(100):
        if psql(db, "select count(*) from pg_stat_activity where state = 'active' and query like '%pg_sleep(2)%' and pid <> pg_backend_pid()").stdout.strip() == "1":
            break
        time.sleep(0.05)
    else:
        raise AssertionError("the acceptance transaction never started")
    start = time.time()
    psql(db, f"update subscriptions set status = 'superseded' where email = '{o}'")       # waits for the acceptance to commit
    waited = time.time() - start
    a.communicate()
    assert waited > 0.5, "the supersede did not wait for the seat-granting transaction"
    assert psql(db, f"select count(*) from subscription_members where owner_email = '{o}'").stdout.strip() == "1"


# --------------------------------------------------------------------------- what cannot be undone

def test_a_spent_invitation_never_reopens_and_nothing_is_deleted(db):
    o = new_owner(db, "team")
    r, secret = invite(db, o, "once@g.example")
    assert accept(db, secret, "once@g.example")["ok"]
    refused(db, f"update subscription_invitations set status = 'pending', accepted_at = null where owner_email = '{o}'", "cannot be reopened")
    refused(db, f"update subscription_invitations set status = 'revoked', revoked_at = now() where owner_email = '{o}'", "cannot be reopened")
    refused(db, f"delete from subscription_invitations where owner_email = '{o}'", "never deleted")
    refused(db, f"delete from subscription_members where owner_email = '{o}'", "never deleted")


def test_identity_columns_are_immutable(db):
    o = new_owner(db, "team")
    r, secret = invite(db, o, "fixed@g.example")
    for col, val in (("email", "'other@g.example'"), ("owner_email", "'someone@t.example'"), ("token_hash", f"'{h('x')}'"),
                     ("expires_at", "now() + interval '20 days'")):
        refused(db, f"update subscription_invitations set {col} = {val} where owner_email = '{o}'", "identity cannot change")
    assert accept(db, secret, "fixed@g.example")["ok"]
    refused(db, f"update subscription_members set email = 'other@g.example' where owner_email = '{o}'", "identity cannot change")
    psql(db, f"update subscription_members set removed_at = now() where owner_email = '{o}'")
    refused(db, f"update subscription_members set removed_at = null where owner_email = '{o}'", "cannot be restored")


def test_the_table_constraints_refuse_what_the_functions_would_not_write(db):
    o = new_owner(db, "team")
    ok = f"'{uuid.uuid4()}', '{o}', 'a@g.example', '{h('a')}', now() + interval '1 day'"
    cols = "(id, owner_email, email, token_hash, expires_at)"
    for bad, needle in ((f"'{uuid.uuid4()}', '{o}', 'A@g.example', '{h('b')}', now() + interval '1 day'", "check"),     # not normalised
                        (f"'{uuid.uuid4()}', '{o}', '{o}', '{h('c')}', now() + interval '1 day'", "check"),             # owner invites themselves
                        (f"'{uuid.uuid4()}', '{o}', 'b@g.example', 'not-a-hash', now() + interval '1 day'", "check"),   # unhashed secret
                        (f"'{uuid.uuid4()}', '{o}', 'b@g.example', '{h('d')}', now() - interval '1 day'", "check")):    # already expired
        refused(db, f"insert into subscription_invitations {cols} values ({bad})", needle)
    psql(db, f"insert into subscription_invitations {cols} values ({ok})")
    refused(db, f"insert into subscription_invitations {cols} values ('{uuid.uuid4()}', '{o}', 'a@g.example', '{h('z')}', now() + interval '1 day')",
            "subscription_invitations_one_pending")
    refused(db, f"insert into subscription_invitations {cols} values ('{uuid.uuid4()}', '{o}', 'c@g.example', '{h('a')}', now() + interval '1 day')",
            "token_hash_key")


def test_a_lapsed_offer_is_retired_and_the_token_for_it_stays_dead(db):
    o = new_owner(db, "team")
    r, secret = invite(db, o, "slow@g.example", ttl="1500 milliseconds")
    assert r["ok"]
    psql(db, "select pg_sleep(1.7)")
    assert accept(db, secret, "slow@g.example") == {"ok": False, "reason": "expired"}
    assert psql(db, f"select status from subscription_invitations where owner_email = '{o}'").stdout.strip() == "expired"
    assert invite(db, o, "slow@g.example")[0]["ok"]
    assert accept(db, secret, "slow@g.example") == {"ok": False, "reason": "expired"}


def test_another_address_gets_the_answer_an_unknown_secret_gets(db):
    o = new_owner(db, "team")
    r, secret = invite(db, o, "right@g.example")
    wrong = accept(db, secret, "wrong@g.example")
    unknown = accept(db, uuid.uuid4().hex, "wrong@g.example")
    assert wrong == unknown == {"ok": False, "reason": "invalid"}
    assert psql(db, f"select status from subscription_invitations where owner_email = '{o}'").stdout.strip() == "pending"


# --------------------------------------------------------------------------- service role only

def test_the_api_roles_can_reach_none_of_it(db):
    for t in ("subscription_invitations", "subscription_members"):
        assert psql(db, f"select relrowsecurity from pg_class where relname = '{t}'").stdout.strip() == "t"
        assert psql(db, f"select count(*) from pg_policies where tablename = '{t}'").stdout.strip() == "0"
        for role in ("anon", "authenticated"):
            for priv in ("select", "insert", "update", "delete"):
                assert psql(db, f"select has_table_privilege('{role}', 'public.{t}', '{priv}')").stdout.strip() == "f", (role, t, priv)
        assert psql(db, f"select has_table_privilege('service_role', 'public.{t}', 'select')").stdout.strip() == "t"
    fns = psql(db, "select p.oid::regprocedure::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace "
                   "where n.nspname = 'public' and p.proname in ('gf_plan_seats','gf_lock_owner_subscription','gf_invite_member',"
                   "'gf_invitation_preview','gf_accept_invitation','gf_decline_invitation','gf_revoke_invitation','gf_remove_member',"
                   "'gf_team_overview','gf_member_entitlement','gf_invitation_guard','gf_member_guard')").stdout.split("\n")
    fns = [f for f in fns if f]
    assert len(fns) == 12, fns
    for f in fns:
        for role in ("anon", "authenticated"):
            assert psql(db, f"select has_function_privilege('{role}', '{f}', 'execute')").stdout.strip() == "f", (role, f)
        assert psql(db, f"select has_function_privilege('service_role', '{f}', 'execute')").stdout.strip() == "t", f


def test_the_invitation_email_is_a_kind_the_durable_outbox_accepts(db):
    o = new_owner(db, "team")
    r, _ = invite(db, o, "mail@g.example")
    psql(db, f"insert into customer_notifications (dedupe_key, kind, subject_table, subject_id) "
             f"values ('team_invitation:{r['invitation_id']}:again', 'team_invitation', 'subscription_invitations', '{r['invitation_id']}')")
    refused(db, f"insert into customer_notifications (dedupe_key, kind, subject_table, subject_id) "
                f"values ('x', 'team_invitation', 'nonsense', '{uuid.uuid4()}')", "subject_table_check")
    # and the earlier kinds are untouched
    psql(db, f"insert into customer_notifications (dedupe_key, kind, subject_table, subject_id) "
             f"values ('subscription_welcome:{uuid.uuid4()}', 'subscription_welcome', 'subscriptions', '{uuid.uuid4()}')")


def test_an_invitation_and_the_obligation_to_email_it_exist_together(db):
    o = new_owner(db, "team")
    r, _ = invite(db, o, "pair@g.example")
    n = psql(db, f"select kind || '/' || status || '/' || subject_table from customer_notifications where subject_id = '{r['invitation_id']}'").stdout.strip()
    assert n == "team_invitation/pending/subscription_invitations"
    # a refused invitation leaves no obligation behind
    d = new_owner(db, "developer")
    refused_r, _ = invite(db, d, "nope@g.example")
    assert not refused_r["ok"]
    assert psql(db, "select count(*) from customer_notifications where kind = 'team_invitation' and "
                    f"subject_id not in (select id from subscription_invitations)").stdout.strip() == "0"


def test_seat_order_is_the_order_seats_were_granted(db):
    o = new_owner(db, "enterprise")
    first = ["a1@g.example", "a2@g.example", "a3@g.example"]
    for w in first:
        r, s = invite(db, o, w)
        assert accept(db, s, w)["ok"]
    order = psql(db, f"select string_agg(email, ',' order by added_at, id) from subscription_members where owner_email = '{o}'").stdout.strip()
    assert order == ",".join(first)
    psql(db, f"update subscriptions set plan = 'team' where email = '{o}'")
    for w in first:   # five seats incl. owner: all three still fit
        assert psql(db, f"select public.gf_member_entitlement('{w}') is not null").stdout.strip() == "t"
    psql(db, f"update subscriptions set plan = 'developer' where email = '{o}'")
    for w in first:
        assert psql(db, f"select public.gf_member_entitlement('{w}') is not null").stdout.strip() == "f"
