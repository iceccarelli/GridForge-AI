"""0042_checkout_funnel.sql against a real PostgreSQL.

Three events (checkout_attempted, checkout_session_created, checkout_failed) and a closed list of failure reasons. Unlike every other funnel
event, the database fences these three itself: props may hold only `kind` (a closed product list) and, on a failure, `reason` (a closed
list). This applies the real chain 0001..0041, then 0042 TWICE, and attacks the table through the real insert path -- as the owner and as
the service role -- the way a careless or hostile writer would: a disallowed event, a disallowed reason, an unknown property key, and values
that look like an email, a token, a Stripe id or a URL.

The lists the database accepts are compared with the lists lib/funnel.ts and lib/products.ts declare, so a product or a reason added on one
side only fails here.

Needs a reachable PostgreSQL (`psql` plus PG* variables, or GRIDFORGE_TEST_PG_URL). Skipped, loudly, where there is none: a skip is a gap in
what was checked, not a pass. GRIDFORGE_REQUIRE_DB=1 turns the skip into a failure.
"""
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
THIS = MIGRATIONS / "0042_checkout_funnel.sql"
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


def refused(db, sql, needle="violates check constraint"):
    r = psql(db, sql, check=False)
    assert r.returncode != 0, f"expected a refusal: {sql}"
    assert needle in r.stderr, r.stderr


def uid():
    return uuid.uuid4().hex[:10]


def insert(db, name, props, role=None):
    """One row through the real insert path. `props` is a Python value (dumped to JSON) or a raw SQL literal string given as ('raw', sql)."""
    lit = props[1] if isinstance(props, tuple) else "'" + json.dumps(props).replace("'", "''") + "'::jsonb"
    pre = f"set role {role}; " if role else ""
    return f"{pre}insert into public.funnel_events (name, props) values ('{name}', {lit})"


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
    # the chain BELOW this migration, exactly as production has it
    chain = sorted(f for f in MIGRATIONS.glob("*.sql") if f.name < THIS.name)
    assert chain and chain[-1].name.startswith("0041_"), [f.name for f in chain[-3:]]
    for f in chain:
        psql(name, file=f)
    yield name
    psql("postgres", f"drop database {name} with (force)")


def _list_from_ts(path, pattern):
    text = (ROOT / path).read_text()
    m = re.search(pattern, text, re.S)
    assert m, pattern
    return re.findall(r'"([a-z0-9_]+)"', m.group(1))


REASONS = _list_from_ts("lib/funnel.ts", r"CHECKOUT_FAILURE_REASONS = \[(.*?)\] as const")
EVENTS = ["checkout_attempted", "checkout_session_created", "checkout_failed"]
_CATALOGUE = (ROOT / "lib/products.ts").read_text().split("export const PRODUCTS", 1)[1].split("export const PRODUCT_BY_KIND", 1)[0]
KINDS = sorted(set(re.findall(r'^\s{4}kind: "([a-z0-9_]+)",', _CATALOGUE, re.M)) | {"engagement_deposit"})  # the catalogue + the legacy deposit
OLD_EVENTS = ["free_account_created", "key_minted", "payg_enabled", "first_charge", "payment_failed", "alert_sent",
              "qualify_started", "qualify_completed", "project_created", "project_saved_result", "first_engine_use", "allowance_exhausted",
              "engagement_commissioned", "subscription_started", "subscription_cancelled", "refund_issued", "dispute_opened"]


def test_the_lists_under_test_are_the_real_ones():
    # a parse that found nothing would make every acceptance loop below pass vacuously
    assert len(REASONS) == 8 and "stripe_session_failed" in REASONS and "payments_not_configured" in REASONS
    assert {"density_screen", "hall_watch", "api_triage", "api_platform", "engagement_deposit"} <= set(KINDS) and len(KINDS) == 9


# ----------------------------------------------------------------------------------------------- applying the migration

def test_it_applies_on_top_of_the_chain_and_applying_it_twice_changes_nothing(db):
    # rows that exist BEFORE 0042: untouched by it (same physical row version), whatever they hold
    psql(db, "insert into funnel_events (name, props) values ('key_minted', '{\"account_ref\": \"0123456789ab\"}'), ('qualify_started', '{}')")
    before_rows = q(db, "select count(*) from funnel_events")
    before_xmin = q(db, "select string_agg(id::text || ':' || xmin::text, ',' order by id) from funnel_events")
    psql(db, file=THIS)
    psql(db, file=THIS)
    assert q(db, "select count(*) from funnel_events") == before_rows
    assert q(db, "select string_agg(id::text || ':' || xmin::text, ',' order by id) from funnel_events") == before_xmin  # no data rewrite
    # exactly one of each constraint after two applications
    assert q(db, "select count(*) from pg_constraint where conrelid = 'public.funnel_events'::regclass and conname = 'funnel_events_name_check'") == "1"
    assert q(db, "select count(*) from pg_constraint where conrelid = 'public.funnel_events'::regclass and conname = 'funnel_events_checkout_props_check'") == "1"
    assert q(db, "select convalidated from pg_constraint where conname = 'funnel_events_checkout_props_check'") == "t"
    assert q(db, "select count(*) from pg_proc where proname = 'gf_checkout_funnel_summary'") == "1"


def test_it_is_additive_row_level_security_and_privileges_are_as_before(db):
    assert q(db, "select relrowsecurity from pg_class where relname = 'funnel_events' and relnamespace = 'public'::regnamespace") == "t"
    assert q(db, "select count(*) from pg_policies where tablename = 'funnel_events'") == "0"  # no policies: service role only
    for role in ("anon", "authenticated"):
        for priv in ("select", "insert", "update", "delete"):
            assert q(db, f"select has_table_privilege('{role}', 'public.funnel_events', '{priv}')") == "f", (role, priv)
    for priv in ("select", "insert"):
        assert q(db, f"select has_table_privilege('service_role', 'public.funnel_events', '{priv}')") == "t", priv
    # the new read function is service-role only, like every gf_ function
    fn = "public.gf_checkout_funnel_summary(timestamptz)"
    for role in ("anon", "authenticated", "public"):
        assert q(db, f"select has_function_privilege('{role}', '{fn}', 'execute')") == "f", role
    assert q(db, f"select has_function_privilege('service_role', '{fn}', 'execute')") == "t"
    # and the earlier documented behaviour is intact: other events are still not fenced by the database
    psql(db, "insert into funnel_events (name, props) values ('key_minted', '{\"anything\": \"goes@here.example\"}')")
    table = q(db, "select obj_description('public.funnel_events'::regclass, 'pg_class')")
    assert "name is one of a fixed list" in table and "NOT fenced in the database" in table and "lib/funnel.ts" in table
    assert "NOT a payment" in table and "funnel_events_checkout_props_check" in table


# ----------------------------------------------------------------------------------------------- what is accepted

def test_every_earlier_event_name_is_still_accepted(db):
    for n in OLD_EVENTS:
        psql(db, f"insert into funnel_events (name, props) values ('{n}', '{{}}')")


def test_every_valid_event_kind_and_reason_is_accepted_through_the_real_insert_path(db):
    n0 = int(q(db, "select count(*) from funnel_events"))
    n = 0
    for kind in KINDS:
        psql(db, insert(db, "checkout_attempted", {"kind": kind}))
        psql(db, insert(db, "checkout_session_created", {"kind": kind}))
        n += 2
        for reason in REASONS:
            psql(db, insert(db, "checkout_failed", {"kind": kind, "reason": reason}))
            n += 1
    assert int(q(db, "select count(*) from funnel_events")) == n0 + n == n0 + len(KINDS) * (2 + len(REASONS))


def test_a_non_owner_writer_can_write_them_too(db):
    # The site writes as the service role (BYPASSRLS on Supabase, plain INSERT/SELECT grants from 0028). A scratch cluster's service_role has
    # no BYPASSRLS and the role is shared with other runs, so an equivalent private role is used. The point: the check is INLINE, so no
    # function ACL stands between a non-owner writer and the constraint.
    w = f"gf_ck_{uid()}"
    psql("postgres", f"create role {w} nologin bypassrls")
    try:
        psql(db, f"grant insert, select on public.funnel_events to {w}")
        psql(db, insert(db, "checkout_attempted", {"kind": "density_screen"}, role=w))
        psql(db, insert(db, "checkout_failed", {"kind": "hall_watch", "reason": "store_unavailable"}, role=w))
        refused(db, insert(db, "checkout_failed", {"kind": "hall_watch", "reason": "nope"}, role=w))
        refused(db, insert(db, "checkout_attempted", {"kind": "density_screen", "email": "a@b.example"}, role=w))
    finally:
        psql(db, f"revoke all on public.funnel_events from {w}")
        psql("postgres", f"drop role {w}")


def test_every_reason_the_site_can_write_is_in_the_database_and_nothing_else_is(db):
    # the database's own list, read back from the constraint, equals lib/funnel.ts
    d = q(db, "select pg_get_constraintdef(oid) from pg_constraint where conname = 'funnel_events_checkout_props_check'")
    in_db = set(re.findall(r"'([a-z_]+)'::text", d))
    assert set(REASONS) <= in_db and set(KINDS) <= in_db and set(EVENTS) <= in_db
    assert in_db - set(REASONS) - set(KINDS) - set(EVENTS) - {"kind", "reason", "object", "string"} == set()


# ----------------------------------------------------------------------------------------------- what is refused

def test_a_disallowed_event_name_is_refused(db):
    for bad in ("checkout_paid", "checkout_completed", "checkout_returned", "checkout_started", "payment_succeeded", "checkout", "Checkout_Attempted"):
        refused(db, insert(db, bad, {"kind": "density_screen"}))


def test_a_disallowed_reason_is_refused(db):
    for bad in ("made_up", "Stripe_Session_Failed", "stripe_session_failed ", "stripe session failed", "", "card_declined", "ops@acme.example",
                "cs_test_a1b2c3d4e5f6", "stripe_session_failed; drop table funnel_events"):
        refused(db, insert(db, "checkout_failed", {"kind": "density_screen", "reason": bad}))
    # a failure needs a reason, and a reason is a string
    refused(db, insert(db, "checkout_failed", {"kind": "density_screen"}))
    refused(db, insert(db, "checkout_failed", {"kind": "density_screen", "reason": None}))
    refused(db, insert(db, "checkout_failed", {"kind": "density_screen", "reason": 7}))
    refused(db, insert(db, "checkout_failed", {"kind": "density_screen", "reason": ["stripe_session_failed"]}))
    # and only a failure may have one
    refused(db, insert(db, "checkout_attempted", {"kind": "density_screen", "reason": "stripe_session_failed"}))
    refused(db, insert(db, "checkout_session_created", {"kind": "density_screen", "reason": "stripe_session_failed"}))


def test_a_disallowed_kind_is_refused(db):
    for bad in ("not_a_product", "Density_Screen", "density screen", "density_screen ", "", "intelligence_subscription", "ops@acme.example"):
        for name in EVENTS:
            props = {"kind": bad, **({"reason": "stripe_session_failed"} if name == "checkout_failed" else {})}
            refused(db, insert(db, name, props))
    for name in EVENTS:
        extra = {"reason": "stripe_session_failed"} if name == "checkout_failed" else {}
        refused(db, insert(db, name, extra))  # no kind
        refused(db, insert(db, name, {"kind": None, **extra}))
        refused(db, insert(db, name, {"kind": 7, **extra}))
        refused(db, insert(db, name, {"kind": ["density_screen"], **extra}))


def test_an_unknown_property_key_is_refused(db):
    for key in ("email", "company", "token", "plan", "scope", "account_ref", "units", "session_id", "url", "site", "message", "Kind", "kind "):
        for name in EVENTS:
            props = {"kind": "density_screen", key: "x", **({"reason": "stripe_session_failed"} if name == "checkout_failed" else {})}
            refused(db, insert(db, name, props))
    # even a harmless-looking, allow-listed-elsewhere key
    refused(db, insert(db, "checkout_attempted", {"kind": "density_screen", "account_ref": "0123456789ab"}))
    refused(db, insert(db, "checkout_attempted", {"kind": "density_screen", "evidence_class": "E3"}))


def test_a_value_that_leaks_something_is_refused_in_every_property(db):
    leaks = {
        "email": "director@northhall.example",
        "token": "gfk1.eyJhIjoiYWNtZSJ9.c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWc",
        "qualification token": "q_n6xB2kq0wVn9mQp3hT7yL4aZ8sJ1cD5eF",
        "stripe session id": "cs_test_a1B2c3D4e5F6g7H8i9J0",
        "stripe id, lower case": "cs_live_a1b2c3d4e5f6g7h8",
        "stripe customer": "cus_Qa1b2c3d4e5f6",
        "payment intent": "pi_3Oabcdef1234567890",
        "url": "https://checkout.stripe.test/c/pay/cs_test_a1B2c3",
        "company": "North Hall Ltd",
        "card": "4242 4242 4242 4242",
        "uuid": "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
        "hex digest": "a" * 64,
        "exception text": "Error: stripe down sk_live_abc",
        "sql": "'; drop table funnel_events;--",
        "newline": "density_screen\nx",
    }
    for label, v in leaks.items():
        for name in EVENTS:
            reason = {"reason": "stripe_session_failed"} if name == "checkout_failed" else {}
            refused(db, insert(db, name, {"kind": v, **reason}))
        refused(db, insert(db, "checkout_failed", {"kind": "density_screen", "reason": v}))


def test_props_that_are_not_an_object_are_refused(db):
    for lit in ("'[]'::jsonb", "'[{\"kind\": \"density_screen\"}]'::jsonb", "'\"density_screen\"'::jsonb", "'7'::jsonb", "'null'::jsonb", "'true'::jsonb"):
        for name in EVENTS:
            r = psql(db, insert(db, name, ("raw", lit)), check=False)
            assert r.returncode != 0, (name, lit)
    refused(db, insert(db, "checkout_attempted", ("raw", "'{}'::jsonb")))  # an empty object has no kind
    r = psql(db, "insert into public.funnel_events (name, props) values ('checkout_attempted', null)", check=False)
    assert r.returncode != 0  # props is not null


def test_nothing_that_was_refused_was_stored(db):
    bad = q(db, "select count(*) from funnel_events where name like 'checkout\\_%' and not ("
                f"props->>'kind' in ({', '.join(repr(k) for k in KINDS)}) and (props - 'kind' - 'reason') = '{{}}'::jsonb "
                f"and (name = 'checkout_failed') = (props ? 'reason'))")
    assert bad == "0"
    assert q(db, "select count(*) from funnel_events where name like 'checkout\\_%'") == str(len(KINDS) * (2 + len(REASONS)) + 2)


def test_dedupe_and_defaults_still_work_for_the_new_events(db):
    psql(db, "insert into funnel_events (name, props, dedupe_key) values ('checkout_attempted', '{\"kind\": \"hall_watch\"}', 'k-" + uuid.uuid4().hex + "')")
    key = "k-" + uuid.uuid4().hex
    psql(db, f"insert into funnel_events (name, props, dedupe_key) values ('checkout_attempted', '{{\"kind\": \"hall_watch\"}}', '{key}')")
    refused(db, f"insert into funnel_events (name, props, dedupe_key) values ('checkout_attempted', '{{\"kind\": \"hall_watch\"}}', '{key}')", "duplicate key")
    assert q(db, "select count(*) from funnel_events where created_at is null or id is null") == "0"


# ----------------------------------------------------------------------------------------------- the read function

def test_the_summary_counts_the_window_by_event_kind_and_reason(db):
    psql(db, "delete from funnel_events")
    rows = [("checkout_attempted", {"kind": "density_screen"}, "now()")] * 3
    rows += [("checkout_session_created", {"kind": "density_screen"}, "now()")] * 2
    rows += [("checkout_failed", {"kind": "density_screen", "reason": "stripe_session_failed"}, "now()")]
    rows += [("checkout_failed", {"kind": "api_triage", "reason": "api_plan_not_ready"}, "now()")] * 2
    rows += [("checkout_attempted", {"kind": "hall_watch"}, "now() - interval '40 days'")]  # outside a 30 day window
    rows += [("key_minted", {"account_ref": "0123456789ab"}, "now()")]  # not a checkout event
    for name, props, at in rows:
        psql(db, f"insert into funnel_events (name, props, created_at) values ('{name}', '{json.dumps(props)}', {at})")
    s = json.loads(q(db, "select public.gf_checkout_funnel_summary(now() - interval '30 days')"))
    assert s["counts"] == {"checkout_attempted": 3, "checkout_session_created": 2, "checkout_failed": 3}
    assert s["by_kind"]["checkout_attempted"] == {"density_screen": 3}
    assert s["by_kind"]["checkout_failed"] == {"density_screen": 1, "api_triage": 2}
    assert s["failed_reasons"] == {"stripe_session_failed": 1, "api_plan_not_ready": 2}
    assert s["failed_by_kind"] == {"density_screen": {"stripe_session_failed": 1}, "api_triage": {"api_plan_not_ready": 2}}
    wide = json.loads(q(db, "select public.gf_checkout_funnel_summary(now() - interval '90 days')"))
    assert wide["counts"]["checkout_attempted"] == 4
    assert "key_minted" not in json.dumps(wide)


def test_an_empty_window_is_empty_objects_not_null(db):
    s = json.loads(q(db, "select public.gf_checkout_funnel_summary('2999-01-01Z')"))
    assert s == {"counts": {}, "by_kind": {}, "failed_reasons": {}, "failed_by_kind": {}}


def test_the_older_summary_function_still_answers(db):
    s = json.loads(q(db, "select public.gf_funnel_summary('2000-01-01Z')"))
    assert set(s) >= {"counts", "cohort", "refs", "by_kind"}
