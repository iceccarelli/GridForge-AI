"""Shared helpers for the site-and-hall registry migration tests (0049 organisations/sites/halls, 0050 hall inputs, 0051 timeline).

Real PostgreSQL, real migrations, in order: the registry's rules are database rules (role checks inside the functions, append-only
triggers, CHECK constraints), so a fake would only restate them. Needs a reachable PostgreSQL (`psql` plus the PG* variables, or
GRIDFORGE_TEST_PG_URL). Skipped, loudly, where there is none: a skip is a gap in what was checked, not a pass.
GRIDFORGE_REQUIRE_DB=1 turns the skip into a failure.
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
NO_DB = shutil.which("psql") is None or not (BASE or os.environ.get("PGHOST"))

needs_db = pytest.mark.skipif(NO_DB and not REQUIRED, reason="no PostgreSQL available (set GRIDFORGE_TEST_PG_URL or PGHOST)")


def _cmd(db):
    return ["psql", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-X"] + ([f"{BASE}/{db}"] if BASE else ["-d", db])


def psql(db, sql=None, file=None, check=True):
    cmd = _cmd(db) + (["-c", sql] if sql else ["-f", str(file)])
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode:
        raise AssertionError(r.stderr)
    return r


def refused(db, sql, needle):
    """The statement must fail, and the failure must say `needle` (a constraint, a trigger message, a privilege error)."""
    r = psql(db, sql, check=False)
    assert r.returncode != 0, f"expected a refusal containing {needle!r}, but it was accepted: {sql}"
    assert needle in r.stderr, r.stderr


def refused_either(db, sql, *needles):
    """The statement must fail and say ANY of the needles (e.g. the trigger's message, or the privilege error that stops it even earlier)."""
    r = psql(db, sql, check=False)
    assert r.returncode != 0, f"expected a refusal, but it was accepted: {sql}"
    assert any(n in r.stderr for n in needles), r.stderr


def scalar(db, sql):
    return psql(db, sql).stdout.strip()


def q(s):
    """A SQL string literal (None -> null)."""
    return "null" if s is None else "'" + str(s).replace("'", "''") + "'"


def call(db, fn, **args):
    """Call a gf_* function the way PostgREST does (named arguments) as the service role; return its jsonb answer parsed."""
    parts = []
    for k, v in args.items():
        if isinstance(v, (dict, list)):
            parts.append(f"{k} => {q(json.dumps(v))}::jsonb")
        elif isinstance(v, bool):
            parts.append(f"{k} => {'true' if v else 'false'}")
        elif k == "p_value" and v is not None:
            parts.append(f"{k} => {q(json.dumps(v))}::jsonb")
        elif isinstance(v, (int, float)):
            parts.append(f"{k} => {v}")
        else:
            parts.append(f"{k} => {q(v)}")
    out = psql(db, f"set role service_role; select public.{fn}({', '.join(parts)})").stdout.strip().splitlines()
    return json.loads(out[-1]) if out and out[-1] not in ("", "null") else None


def ok(db, fn, **args):
    r = call(db, fn, **args)
    assert r and r.get("ok") is True, f"{fn}{args} -> {r}"
    return r


def reason(db, fn, **args):
    r = call(db, fn, **args)
    assert r and r.get("ok") is False, f"{fn}{args} should have been refused -> {r}"
    return r["reason"]


def make_database(through=None):
    """A scratch database with the Supabase roles and every repository migration applied in order (up to `through`, a 4-digit string)."""
    name = f"gf_{uuid.uuid4().hex[:10]}"
    psql("postgres", f"create database {name}")
    psql(name, "create extension if not exists pgcrypto")
    psql(name, "create schema if not exists storage;"
               "create table if not exists storage.buckets (id text primary key, name text, public boolean)")
    for role in ("anon", "authenticated", "service_role"):
        psql("postgres", f"do $$ begin if not exists (select 1 from pg_roles where rolname = '{role}') "
                         f"then create role {role} nologin; end if; end $$")
    # As on Supabase and in scripts/realdb-up.sh: the service role bypasses RLS (the tables have RLS on and no policies), and the
    # platform's default privileges hand every new public table and function to the API roles until the migrations take them back
    # (0020 and 0040 do, and each migration revokes its own objects as well). Set BEFORE the migrations so the chain starts from there.
    psql("postgres", "alter role service_role bypassrls")
    psql(name, "grant usage on schema public to anon, authenticated, service_role;"
               "alter default privileges in schema public grant all on tables to anon, authenticated, service_role;"
               "alter default privileges in schema public grant all on functions to anon, authenticated, service_role")
    for f in sorted(MIGRATIONS.glob("*.sql")):
        if through is None or f.name[:4] <= through:
            psql(name, file=f)
    return name


def drop_database(name):
    psql("postgres", f"drop database {name} with (force)")


def new_org(db, actor, name=None):
    return ok(db, "gf_create_org", p_actor=actor, p_name=name or f"Org {uuid.uuid4().hex[:6]}")["org_id"]


def add_member(db, org, owner, email, role):
    return ok(db, "gf_org_add_member", p_actor=owner, p_org=org, p_email=email, p_role=role)


def new_site(db, actor, org, name=None, origin="synthetic", country="DE"):
    return ok(db, "gf_create_site", p_actor=actor, p_org=org, p_name=name or f"Site {uuid.uuid4().hex[:6]}",
              p_country=country, p_data_origin=origin)["site_id"]


def new_hall(db, actor, site, label=None):
    return ok(db, "gf_create_hall", p_actor=actor, p_site=site, p_label=label or f"Hall {uuid.uuid4().hex[:6]}")["hall_id"]
