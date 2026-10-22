"""0040_integrity_hardening.sql against a real PostgreSQL that looks like PRODUCTION.

The site's tests use an in-memory PostgREST, which cannot run a privilege, a trigger or a constraint. And the plain database
scripts/realdb-up.sh builds does not have what makes the production catalog dangerous: Supabase's DEFAULT ACLs, which hand
anon / authenticated / service_role ALL privileges on every table created afterwards. This fixture reproduces that first
(alter default privileges ... grant all ... to the three roles), then applies EVERY migration in order, and attacks the result
the way the independent review of the production catalog did: as service_role, and as the API roles.

Needs a reachable PostgreSQL (`psql` plus the standard PG* variables, or GRIDFORGE_TEST_PG_URL). Skipped, loudly, where there
is none; GRIDFORGE_REQUIRE_DB=1 turns the skip into a failure.
"""
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


def as_service(db, sql, check=True):
    return psql(db, f"set role service_role; {sql}", check=check)


def one(db, sql):
    return psql(db, sql).stdout.strip()


@pytest.fixture(scope="module")
def db():
    name = f"gf_{uuid.uuid4().hex[:10]}"
    psql("postgres", f"create database {name}")
    psql("postgres", """do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
        if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if;
      end $$""")
    psql(name, "create extension if not exists pgcrypto; create schema if not exists storage; "
               "create table if not exists storage.buckets (id text primary key, name text, public boolean)")
    # PRODUCTION: Supabase's default ACLs, in force BEFORE any of our tables exist.
    psql(name, "grant usage on schema public to anon, authenticated, service_role; "
               "alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role; "
               "alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role; "
               "alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role")
    for f in sorted(MIGRATIONS.glob("*.sql")):
        psql(name, file=f)
    yield name
    psql("postgres", f"drop database {name} with (force)")


# ------------------------------------------------------------------------------------------------------------ F6

PRIVS = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]


def public_relations(db):
    return psql(db, "select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r','v','m','p') order by 1").stdout.split()


def test_the_api_roles_hold_no_privilege_on_any_public_table_or_view(db):
    rels = public_relations(db)
    assert len(rels) > 30, "the schema did not build"
    bad = []
    for role in ("anon", "authenticated"):
        for p in PRIVS:
            rows = psql(db, f"select c.relname from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','v','m','p') "
                            f"and has_table_privilege('{role}', c.oid, '{p}') order by 1").stdout.split()
            bad += [f"{role} {p} on {t}" for t in rows]
    assert bad == [], bad


def test_the_api_roles_hold_no_privilege_on_a_sequence_or_a_gf_function(db):
    seq = psql(db, "select c.relname from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='S' "
                   "and (has_sequence_privilege('anon', c.oid, 'usage') or has_sequence_privilege('authenticated', c.oid, 'usage') "
                   "or has_sequence_privilege('anon', c.oid, 'select') or has_sequence_privilege('authenticated', c.oid, 'select'))").stdout.split()
    assert seq == []
    fns = psql(db, "select p.oid::regprocedure::text from pg_proc p where p.pronamespace='public'::regnamespace and p.proname like 'gf\\_%' "
                   "and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))").stdout.split("\n")
    assert [f for f in fns if f] == []


def test_a_table_created_AFTER_the_migration_is_not_handed_to_the_api_roles_either(db):
    psql(db, "create table public.gf_later_table (id int)")
    assert one(db, "select has_table_privilege('anon','public.gf_later_table','select') or has_table_privilege('authenticated','public.gf_later_table','insert')") == "f"
    assert one(db, "select has_table_privilege('service_role','public.gf_later_table','insert')") == "t"
    assert one(db, "select has_table_privilege('service_role','public.gf_later_table','truncate')") == "f"


def test_an_anon_request_reads_nothing_and_the_service_role_still_works(db):
    refused(db, "set role anon; select count(*) from public.deliverables", "permission denied")
    refused(db, "set role authenticated; select count(*) from public.watches", "permission denied")
    refused(db, "set role anon; insert into public.leads (name, email) values ('X', 'x@y.z')", "permission denied")
    as_service(db, "select count(*) from public.deliverables; select count(*) from public.watches")
    # what the application does with the service role: read, insert, update and (where it deletes) delete
    as_service(db, "insert into public.scenarios (email) values ('s@x.example'); update public.scenarios set name = 'n' where email = 's@x.example'; "
                   "delete from public.scenarios where email = 's@x.example'")
    as_service(db, "insert into public.founding_reservations (expires_at) values (now() + interval '1 hour'); delete from public.founding_reservations")
    as_service(db, "insert into public.operator_notices (dedupe_key) values ('k'); delete from public.operator_notices where dedupe_key = 'k'")


# ------------------------------------------------------------------------------------------------------------ F3

GUARDED = [
    "usage_events", "usage_settlements", "engagement_credits", "engagement_deposits", "engagement_credit_sources",
    "customer_notifications", "deliverables", "watches", "api_accounts", "subscriptions",
    "cost_evidence", "cost_evidence_retirements", "cost_evidence_reviews", "cost_evidence_runs",
    "procurement_packages", "procurement_responses", "procurement_comparisons", "project_events",
    "project_comparisons", "project_observations", "project_observation_reviews", "supplier_actuals", "supplier_actual_reviews", "project_shares",
]


def test_service_role_cannot_truncate_any_public_table(db):
    rows = psql(db, "select c.relname from pg_class c where c.relnamespace='public'::regnamespace and c.relkind in ('r','p') "
                    "and has_table_privilege('service_role', c.oid, 'truncate')").stdout.split()
    assert rows == []


@pytest.mark.parametrize("table", GUARDED)
def test_truncate_of_a_ledger_fails_for_service_role_AND_for_the_owner(db, table):
    refused(db, f"set role service_role; truncate public.{table}", "permission denied")
    refused(db, f"truncate public.{table} cascade", "append-only")   # the owner is stopped by the guard, not by a privilege


def test_the_exact_attack_of_the_review(db):
    refused(db, "set role service_role; truncate public.usage_events", "permission denied")


def test_a_scratch_restore_still_empties_tables_under_the_replica_role(db):
    """scripts/verify-backup-restore.py: the guard must not stop an export being restored into a SCRATCH database."""
    psql(db, "set session_replication_role = replica; truncate table public.usage_events restart identity cascade")


def test_deletes_the_application_makes_still_work_for_the_service_role(db):
    # checked against the application: founding_reservations (webhook, checkout), scenarios (a customer's own),
    # operator_notices (a claim released on failure); rate_limit_windows is cleaned by gf_rate_limit_hit (invoker).
    for t in ("founding_reservations", "scenarios", "operator_notices", "rate_limit_windows"):
        assert one(db, f"select has_table_privilege('service_role', 'public.{t}', 'delete')") == "t", t
    as_service(db, "select public.gf_rate_limit_hit('b', repeat('a', 64), 5, 60)")


# ------------------------------------------------------------------------------------------------------------ F2


def deposit(db, email="a@hall.example", status="contacted", kind="envelope_study_deposit", amount=900000):
    dep = str(uuid.uuid4())
    cols, vals = "id, stripe_session_id, kind, amount_cents, email, status", f"'{dep}', 'cs_{uuid.uuid4().hex}', '{kind}', {amount}, '{email}', '{status}'"
    if status != "paid":
        cols += ", owner, contacted_at"
        vals += ", 'Ada', now()"
    psql(db, f"insert into engagement_deposits ({cols}) values ({vals})")
    return dep


def source(db, email="a@hall.example", kind="density_screen", amount=450000, paid=True, status="released"):
    d = str(uuid.uuid4())
    # a draft/awaiting row for the non-released statuses; the release guard needs a reviewer only on the way INTO released
    review = ', intake' if False else ''
    sess = f"'cs_{uuid.uuid4().hex}'" if paid else "null"
    amt = "null" if amount is None else str(amount)
    psql(db, "insert into deliverables (id, token, kind, status, email, amount_cents, stripe_session_id, intake) values "
             f"('{d}', '{uuid.uuid4().hex}', '{kind}', '{status}', '{email}', {amt}, {sess}, "
             "'{\"_gridforge\":{\"review\":{\"by\":\"A. Rivera\"}}}'::jsonb)")
    return d


def credit(db, dep, src, amount=450000):
    return psql(db, f"insert into engagement_credits (source_deliverable_id, deposit_id, amount_cents, applied_by) values ('{src}', '{dep}', {amount}, 'Ada')", check=False)


def scope_direct(db, dep, fee, credit_sql, due="2099-01-31"):
    return psql(db, f"update engagement_deposits set status='scoped', scope_note='x', scoped_at=now(), agreed_fee_cents={fee}, "
                    f"credit_applied_cents={credit_sql}, delivery_due_on='{due}' where id='{dep}'", check=False)


def test_a_direct_scoping_with_a_NULL_credit_and_a_fee_below_the_deposit_is_refused(db):
    d = deposit(db)
    r = scope_direct(db, d, 100000, "null")                       # the review's reproduction: fee < deposit, credit NULL
    assert r.returncode != 0 and "cannot exceed the agreed fee" in r.stderr
    assert one(db, f"select status from engagement_deposits where id='{d}'") == "contacted"


def test_a_direct_scoping_whose_credit_is_not_in_the_ledger_is_refused(db):
    d = deposit(db)
    r = scope_direct(db, d, 2500000, "777")                       # credit_applied=777 with 0 ledger rows
    assert r.returncode != 0 and "must equal what the credit ledger holds" in r.stderr
    assert one(db, f"select status from engagement_deposits where id='{d}'") == "contacted"


def test_a_direct_scoping_with_a_NULL_credit_is_scoped_as_zero_when_the_ledger_is_empty(db):
    d = deposit(db)
    assert scope_direct(db, d, 2500000, "null").returncode == 0
    assert one(db, f"select credit_applied_cents from engagement_deposits where id='{d}'") == "0"


def test_a_credit_for_a_different_buyer_is_refused_by_the_table(db):
    d = deposit(db, "buyer-b@hall.example")
    s = source(db, "buyer-a@hall.example")                         # the review's reproduction: buyer A's source on buyer B's deposit
    r = credit(db, d, s)
    assert r.returncode != 0 and "only to the buyer who paid it" in r.stderr


def test_the_buyer_match_is_on_the_normalised_address(db):
    d = deposit(db, "  Mixed.Case@Hall.Example ")
    s = source(db, "mixed.case@hall.example")
    assert credit(db, d, s).returncode == 0


def test_a_credit_larger_than_the_source_was_paid_is_refused(db):
    d = deposit(db, "big@hall.example")
    s = source(db, "big@hall.example", amount=450000)
    r = credit(db, d, s, 99_999_999)
    assert r.returncode != 0 and "cannot exceed what the engagement was paid" in r.stderr


def test_a_source_that_recorded_no_amount_is_worth_the_catalogue_price_and_no_more(db):
    d = deposit(db, "noamt@hall.example")
    s = source(db, "noamt@hall.example", amount=None)
    assert credit(db, d, s, 450001).returncode != 0
    assert credit(db, d, s, 450000).returncode == 0


def test_only_a_product_that_credits_this_deposit_may_credit_it(db):
    d = deposit(db, "spec@hall.example")
    spec = source(db, "spec@hall.example", kind="procurement_spec", amount=1_800_000)     # the review: a EUR 18,000 spec was credited
    r = credit(db, d, spec, 1_800_000)
    assert r.returncode != 0 and "does not credit a envelope_study_deposit" in r.stderr
    watch = source(db, "spec@hall.example", kind="hall_watch", amount=600000)
    assert credit(db, d, watch, 600000).returncode != 0
    # and through the RPC the application uses
    p = '{"id":"%s","scope_note":"x","agreed_fee_cents":2500000,"delivery_due_on":"2099-01-31","applied_by":"Ada","credits":[{"source_deliverable_id":"%s","amount_cents":1800000}]}' % (d, spec)
    r = psql(db, f"select public.gf_scope_deposit('{p}'::jsonb)", check=False)
    assert r.returncode != 0 and "does not credit" in r.stderr
    assert one(db, f"select status from engagement_deposits where id='{d}'") == "contacted"


def test_an_unpaid_source_and_a_source_credited_once_already_are_refused(db):
    d = deposit(db, "once@hall.example")
    unpaid = source(db, "once@hall.example", paid=False)
    assert credit(db, d, unpaid).returncode != 0
    ok = source(db, "once@hall.example")
    assert credit(db, d, ok).returncode == 0
    d2 = deposit(db, "once@hall.example")
    r = credit(db, d2, ok)
    assert r.returncode != 0 and "engagement_credits_source_deliverable_id_key" in r.stderr


def test_a_credit_is_applied_only_while_the_deposit_is_being_scoped(db):
    for status in ("paid", "scoped", "delivered"):
        d = deposit(db, "late@hall.example", status="paid") if status == "paid" else deposit(db, "late@hall.example")
        if status in ("scoped", "delivered"):
            assert scope_direct(db, d, 2500000, "0").returncode == 0
            if status == "delivered":
                psql(db, f"update engagement_deposits set status='delivered', delivery_ref='r', delivered_at=now() where id='{d}'")
        s = source(db, "late@hall.example")
        r = credit(db, d, s)
        assert r.returncode != 0 and "only while a deposit is being scoped" in r.stderr, status


def test_deposit_plus_credits_cannot_exceed_the_fee_when_the_deposit_is_scoped(db):
    d = deposit(db, "sum@hall.example")
    for _ in range(4):
        assert credit(db, d, source(db, "sum@hall.example")).returncode == 0       # 4 x 4,500 = 18,000 in the ledger
    r = scope_direct(db, d, 2200000, "1800000")                                    # 9,000 + 18,000 = 27,000 > 22,000
    assert r.returncode != 0 and "cannot exceed the agreed fee" in r.stderr
    assert scope_direct(db, d, 2700000, "1800000").returncode == 0                 # exactly the fee: allowed
    assert one(db, f"select credit_applied_cents from engagement_deposits where id='{d}'") == "1800000"


def test_the_application_path_still_works_end_to_end(db):
    d = deposit(db, "happy@hall.example")
    s = source(db, "happy@hall.example")
    p = '{"id":"%s","scope_note":"x","agreed_fee_cents":2500000,"delivery_due_on":"2099-01-31","applied_by":"Ada","credits":[{"source_deliverable_id":"%s","amount_cents":450000}]}' % (d, s)
    as_service(db, f"select public.gf_scope_deposit('{p}'::jsonb)")
    assert one(db, f"select status || ':' || credit_applied_cents from engagement_deposits where id='{d}'") == "scoped:450000"


def products_ts_credit_rules():
    """(deposit kind, source kind, catalogue cents) as lib/products.ts declares them: a product with creditsAgainst credits that deposit."""
    text = (ROOT / "lib" / "products.ts").read_text()
    blocks = re.findall(r"\n  (\w+): \{\n    id: \"(\w+)\",\n    kind: \"(\w+)\",(.*?)\n  \},", text, flags=re.S)
    price = {}
    rules = set()
    for _key, pid, kind, body in blocks:
        m = re.search(r"amountCents: ([\d_]+)", body)
        c = re.search(r"creditsAgainst: \"(\w+)\"", body)
        price[pid] = int(m.group(1).replace("_", "")) if m else None
        if c:
            rules.add((c.group(1), kind, price[pid]))
    assert rules, "no creditsAgainst parsed from lib/products.ts: the parser is stale"
    return rules


def test_the_credit_rules_in_the_database_are_the_catalogues(db):
    rows = {tuple(r.split("|")) for r in psql(db, "select deposit_kind, source_kind, catalogue_cents from engagement_credit_sources").stdout.split()}
    assert rows == {(a, b, str(c)) for a, b, c in products_ts_credit_rules()}


def test_the_credit_rules_cannot_be_edited_through_the_api_roles_path(db):
    refused(db, "set role service_role; update public.engagement_credit_sources set catalogue_cents = 1", "append-only")
    refused(db, "set role service_role; delete from public.engagement_credit_sources", "append-only")


# ------------------------------------------------------------------------------------------------------------ F4


def test_deliverables_status_is_a_closed_set_and_the_constraint_is_validated(db):
    refused(db, "insert into deliverables (token, kind, status) values ('t1', 'density_screen', 'complete')", "deliverables_status_valid")
    assert one(db, "select convalidated from pg_constraint where conname='deliverables_status_valid'") == "t"


def test_nothing_becomes_released_without_a_named_reviewer(db):
    refused(db, "insert into deliverables (token, kind, status, email) values ('t2', 'density_screen', 'released', 'x@y.z')", "without a named reviewer")
    psql(db, "insert into deliverables (token, kind, status, email) values ('t3', 'density_screen', 'draft', 'x@y.z')")
    refused(db, "update deliverables set status='released' where token='t3'", "without a named reviewer")
    refused(db, """update deliverables set status='released', intake='{"_gridforge":{"review":{"by":"   "}}}'::jsonb where token='t3'""", "without a named reviewer")
    psql(db, """update deliverables set status='released', intake='{"_gridforge":{"review":{"by":"A. Rivera"}}}'::jsonb where token='t3'""")
    # a re-write of a released row (a bid comparison) does not need the reviewer re-checked, and pulling it back is allowed
    psql(db, "update deliverables set title='x' where token='t3'")
    psql(db, "update deliverables set status='draft' where token='t3'")


def test_a_proposal_the_operator_writes_already_issued_is_exempt(db):
    psql(db, "insert into deliverables (token, kind, status, email) values ('t4', 'proposal', 'released', 'x@y.z')")


def test_a_row_released_before_reviewers_were_recorded_keeps_working(db):
    """Production rows released earlier have no reviewer. The guard fires on the way INTO released only."""
    psql(db, "set session_replication_role = replica; insert into deliverables (token, kind, status, email) values ('t5', 'density_screen', 'released', 'x@y.z')")
    psql(db, "update deliverables set working_files = '{\"bid_comparison.json\":\"{}\"}'::jsonb where token='t5'")


def test_the_version_trigger_makes_a_stale_release_lose(db):
    psql(db, "insert into deliverables (token, kind, status, email) values ('t6', 'density_screen', 'draft', 'x@y.z')")
    v = int(one(db, "select row_version from deliverables where token='t6'"))
    psql(db, "update deliverables set document_html='<p>changed after the hash</p>' where token='t6'")   # a writer changes it after it was hashed
    r = psql(db, f"""update deliverables set status='released', intake='{{"_gridforge":{{"review":{{"by":"A"}}}}}}'::jsonb
                     where token='t6' and status='draft' and row_version={v} returning token""")
    assert r.stdout.strip() == ""                                                                    # 'lost': nothing written
    assert one(db, "select status from deliverables where token='t6'") == "draft"


# ------------------------------------------------------------------------------------------------------------ F5


def project(db, name="P"):
    pid = str(uuid.uuid4())
    psql(db, f"insert into projects (id, project_token, project_name) values ('{pid}', '{uuid.uuid4().hex}', '{name}')")
    return pid


def package(db, pid):
    pk = str(uuid.uuid4())
    psql(db, f"insert into procurement_packages (id, package_token, project_id, case_token, case_revision, architecture, spec_summary, response_template, document_md, document_html) "
             f"values ('{pk}', '{uuid.uuid4().hex}', '{pid}', 'c', 1, 'A', '{{}}', '{{}}', 'm', 'h')")
    return pk


def response(db, pk, pid, supplier="S"):
    r = psql(db, f"insert into procurement_responses (package_id, project_id, supplier, response) values ('{pk}', '{pid}', '{supplier}{uuid.uuid4().hex[:4]}', '{{}}') returning id", check=False)
    return r


def comparison(db, pk, pid):
    return psql(db, f"insert into procurement_comparisons (package_id, project_id, case_token, case_revision, architecture, response_ids, result) values ('{pk}', '{pid}', 'c', 1, 'A', '[]', '{{}}') returning id", check=False)


def test_a_response_or_comparison_must_name_its_packages_own_project(db):
    p1, p2 = project(db, "one"), project(db, "two")
    pk = package(db, p1)
    assert response(db, pk, p1).returncode == 0
    r = response(db, pk, p2)                                       # a response to p1's package filed under p2
    assert r.returncode != 0 and "procurement_responses_package_project_fkey" in r.stderr
    r = comparison(db, pk, p2)
    assert r.returncode != 0 and "procurement_comparisons_package_project_fkey" in r.stderr
    assert comparison(db, pk, p1).returncode == 0
    assert one(db, "select convalidated from pg_constraint where conname='procurement_responses_package_project_fkey'") == "t"


def test_a_selection_must_name_a_response_and_a_comparison_of_the_same_package(db):
    p1 = project(db)
    a, b = package(db, p1), package(db, p1)
    ra = response(db, a, p1).stdout.split()[0]
    rb = response(db, b, p1).stdout.split()[0]
    ca = comparison(db, a, p1).stdout.split()[0]
    refused(db, f"update procurement_packages set selected_supplier='S', selected_response_id='{rb}', selected_at=now(), selected_by='x' where id='{a}'", "not a response to this package")
    cb = comparison(db, b, p1).stdout.split()[0]
    refused(db, f"update procurement_packages set selected_supplier='S', selected_response_id='{ra}', selected_comparison_id='{cb}', selected_at=now(), selected_by='x' where id='{a}'", "not a comparison of this package")
    psql(db, f"update procurement_packages set selected_supplier='S', selected_response_id='{ra}', selected_comparison_id='{ca}', selected_at=now(), selected_by='x' where id='{a}'")


def test_a_case_that_does_not_exist_cannot_be_attached(db):
    p = project(db)
    ev = '{"event_type":"btm_case_attached","actor":"x","payload":{}}'
    r = psql(db, f"select public.gf_attach_case('{p}', 'no-such-case', '{ev}'::jsonb)", check=False)
    assert r.returncode != 0 and "that case does not exist" in r.stderr
    psql(db, "insert into power_deployment_cases (case_token, revision, request, result) values ('real-case', 1, '{}', '{}')")
    assert one(db, f"select public.gf_attach_case('{p}', 'real-case', '{ev}'::jsonb)") .startswith("{\"created\": true")
    assert one(db, f"select public.gf_attach_case('{p}', 'real-case', '{ev}'::jsonb)") == '{"created": false}'


# ------------------------------------------------------------------------------------------------------------ F1


def _purchase(db, pid, payload, deliverable=None):
    ev = '{"event_type":"paid_product_attached","actor":"stripe_webhook","payload":%s}' % payload
    obj = f"'{deliverable}'" if deliverable else "null"
    typ = "'deliverable'" if deliverable else "null"
    return psql(db, f"select public.gf_attach_purchase('{pid}', {typ}, {obj}, '{ev}'::jsonb)", check=False)


def test_a_purchase_is_attached_once_per_session_reference_and_the_session_id_is_never_stored(db):
    p = project(db)
    ref = "a" * 64
    payload = '{"kind":"density_screen","session_ref":"%s"}' % ref
    assert _purchase(db, p, payload).stdout.strip() == '{"created": true}'
    assert _purchase(db, p, payload).stdout.strip() == '{"created": false}'      # the webhook is redelivered
    assert one(db, f"select count(*) from project_events where project_id='{p}' and event_type='paid_product_attached'") == "1"
    assert one(db, f"select count(*) from project_events where project_id='{p}' and payload::text like '%cs_%'") == "0"


def test_a_session_attached_before_this_migration_under_its_raw_id_is_still_recognised_by_its_hash(db):
    p = project(db)
    sid = "cs_live_legacy_0001"
    psql(db, "insert into project_events (project_id, event_type, actor, payload) values "
             f"('{p}', 'paid_product_attached', 'stripe_webhook', jsonb_build_object('kind', 'density_screen', 'stripe_session_id', '{sid}'))")
    ref = one(db, f"select encode(sha256(convert_to('{sid}', 'UTF8')), 'hex')")
    r = _purchase(db, p, '{"kind":"density_screen","session_ref":"%s"}' % ref)
    assert r.stdout.strip() == '{"created": false}', r.stderr
    assert one(db, f"select count(*) from project_events where project_id='{p}' and event_type='paid_product_attached'") == "1"


# ------------------------------------------------------------------------------------------------------------ the migration itself


def test_the_migration_is_idempotent_and_a_second_run_changes_nothing(db):
    before = psql(db, "select count(*) from pg_constraint").stdout.strip()
    psql(db, file=MIGRATIONS / "0040_integrity_hardening.sql")
    assert psql(db, "select count(*) from pg_constraint").stdout.strip() == before
    assert one(db, "select count(*) from engagement_credit_sources") == "1"
