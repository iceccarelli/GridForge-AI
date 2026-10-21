"""0031_leads_rls.sql against a real PostgreSQL.

0001_leads.sql created public.leads but never enabled row level security (only supabase/schema.sql did), so a project built from
the migrations alone left the table to Supabase's default grants and the browser-side anon key could read every lead. This
builds the chain of migrations BEFORE 0031 on a throwaway database, gives anon and authenticated what Supabase gives new
tables by default, shows the hole, applies 0031, and shows it closed - by RLS alone and by the revoked privileges alone - while
the service role (which bypasses RLS) still works and a second application changes nothing.

Needs a reachable PostgreSQL (`psql` plus PG* variables, or GRIDFORGE_TEST_PG_URL). Skipped, loudly, where there is none: a skip
is a gap in what was checked, not a pass. GRIDFORGE_REQUIRE_DB=1 turns the skip into a failure.
"""
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "supabase" / "migrations"
MIGRATION = MIGRATIONS / "0031_leads_rls.sql"
BASE = os.environ.get("GRIDFORGE_TEST_PG_URL", "")
REQUIRED = os.environ.get("GRIDFORGE_REQUIRE_DB") == "1"
_NO_DB = shutil.which("psql") is None or not (BASE or os.environ.get("PGHOST"))
needs_db = pytest.mark.skipif(_NO_DB and not REQUIRED, reason="no PostgreSQL available (set GRIDFORGE_TEST_PG_URL or PGHOST)")


def _cmd(db):
    return ["psql", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-X"] + ([f"{BASE}/{db}"] if BASE else ["-d", db])


def psql(db, sql=None, file=None, check=True):
    cmd = _cmd(db) + (["-c", sql] if sql else ["-f", str(file)])
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode:
        raise AssertionError(r.stderr)
    return r


def refused(db, sql, needle="permission denied"):
    r = psql(db, sql, check=False)
    assert r.returncode != 0, f"expected refusal: {sql}"
    assert needle in r.stderr, r.stderr


def one(db, sql):
    return psql(db, sql).stdout.strip()


LEAD = "insert into public.leads (name, company, email, location) values ('A', 'B', 'a@b.example', 'Dublin')"
RLS_ON = "select relrowsecurity from pg_class where oid = 'public.leads'::regclass"


@pytest.fixture(scope="module")
def db():
    """Every migration before 0031, with Supabase's default grants on the table, and one lead in it."""
    if REQUIRED:
        assert not _NO_DB, "GRIDFORGE_REQUIRE_DB=1 but psql or PGHOST/GRIDFORGE_TEST_PG_URL is missing"
    name = f"gf_{uuid.uuid4().hex[:10]}"
    psql("postgres", f"create database {name}")
    psql(name, "create extension if not exists pgcrypto")
    psql(name, "create schema if not exists storage;"
               "create table if not exists storage.buckets (id text primary key, name text, public boolean)")
    for role, attrs in (("anon", "nologin"), ("authenticated", "nologin"), ("service_role", "nologin bypassrls")):
        psql("postgres", f"do $$ begin if not exists (select 1 from pg_roles where rolname = '{role}') "
                         f"then create role {role} {attrs}; end if; end $$")
    for f in sorted(MIGRATIONS.glob("*.sql")):
        if f.name < MIGRATION.name:
            psql(name, file=f)
    psql(name, "grant usage on schema public to anon, authenticated, service_role;"
               "grant all on public.leads to anon, authenticated, service_role")
    psql(name, LEAD)
    yield name
    psql("postgres", f"drop database {name} with (force)")


def test_the_migration_is_the_next_unreserved_number_and_is_the_only_one_with_it():
    assert MIGRATION.exists()
    assert [p.name for p in MIGRATIONS.glob("0031_*.sql")] == [MIGRATION.name]
    sql = MIGRATION.read_text().lower()
    assert "enable row level security" in sql and "revoke all on table public.leads" in sql
    assert "create policy" not in sql and "disable row level security" not in sql


@needs_db
def test_before_the_migration_the_migrations_alone_leave_leads_open_to_the_anon_key(db):
    assert one(db, RLS_ON) == "f"
    assert psql(db, "set role anon; select count(*) from public.leads").stdout.strip().splitlines()[-1] == "1"


@needs_db
def test_after_the_migration_anon_and_authenticated_can_neither_read_nor_write(db):
    psql(db, file=MIGRATION)
    assert one(db, RLS_ON) == "t"
    for role in ("anon", "authenticated"):
        refused(db, f"set role {role}; select count(*) from public.leads")
        refused(db, f"set role {role}; {LEAD}")
        refused(db, f"set role {role}; update public.leads set status = 'won'")
        refused(db, f"set role {role}; delete from public.leads")
        assert one(db, f"select has_table_privilege('{role}', 'public.leads', 'select,insert,update,delete')") == "f"


@needs_db
def test_rls_alone_holds_even_if_a_privilege_is_granted_back(db):
    psql(db, file=MIGRATION)
    psql(db, "grant select, insert on public.leads to anon, authenticated")  # a later careless grant, or schema.sql's world
    for role in ("anon", "authenticated"):
        assert psql(db, f"set role {role}; select count(*) from public.leads").stdout.strip().splitlines()[-1] == "0"
        refused(db, f"set role {role}; {LEAD}", needle="row-level security")
    psql(db, file=MIGRATION)  # re-applying closes it again
    refused(db, "set role anon; select count(*) from public.leads")


@needs_db
def test_the_service_role_still_reads_and_writes(db):
    psql(db, file=MIGRATION)
    before = int(one(db, "select count(*) from public.leads"))
    psql(db, f"set role service_role; {LEAD}")
    assert psql(db, "set role service_role; select count(*) from public.leads").stdout.strip().splitlines()[-1] == str(before + 1)
    psql(db, "set role service_role; update public.leads set status = 'reviewed' where email = 'a@b.example'")


@needs_db
def test_applying_it_again_changes_nothing(db):
    psql(db, file=MIGRATION)
    snapshot = one(db, f"select ({RLS_ON}), (select count(*) from public.leads), "
                       "has_table_privilege('anon', 'public.leads', 'select'), has_table_privilege('authenticated', 'public.leads', 'select')")
    psql(db, file=MIGRATION)
    psql(db, file=MIGRATION)
    assert one(db, f"select ({RLS_ON}), (select count(*) from public.leads), "
                   "has_table_privilege('anon', 'public.leads', 'select'), has_table_privilege('authenticated', 'public.leads', 'select')") == snapshot


@needs_db
def test_it_applies_on_a_database_that_has_no_supabase_roles(db):
    """Plain PostgreSQL (CI, a laptop) has no anon/authenticated: the revoke is guarded by pg_roles and must not fail."""
    bare = f"gf_{uuid.uuid4().hex[:10]}"
    psql("postgres", f"create database {bare}")
    try:
        psql(bare, "create extension if not exists pgcrypto")
        psql(bare, file=MIGRATIONS / "0001_leads.sql")
        # roles are cluster-wide, so this only proves the guard when anon/authenticated truly are absent; the SQL is the same either way
        psql(bare, file=MIGRATION)
        assert one(bare, RLS_ON) == "t"
    finally:
        psql("postgres", f"drop database {bare} with (force)")
