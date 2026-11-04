"""The backup drill must be unable to touch production, and (where a local PostgreSQL is reachable) must actually round-trip.

The production-facing scripts (export-prod-data.py, apply-migration.py) talk to the hosted Management API with a token; they are not
run here. What is checked is that they refuse without a token and that the drill's guard names (never prints values) anything that
looks like production.
"""
from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent


def _drill():
    spec = importlib.util.spec_from_file_location("gf_local_drill", ROOT / "scripts" / "local-backup-drill.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def test_the_guard_accepts_a_local_socket_and_localhost():
    d = _drill()
    assert d.looks_like_production({"PGHOST": "/tmp", "PATH": "/usr/bin"}) == []
    assert d.looks_like_production({"PGHOST": "localhost"}) == []
    assert d.looks_like_production({}) == []


@pytest.mark.parametrize(
    "env,names",
    [
        ({"SUPABASE_ACCESS_TOKEN": "sbp_fake"}, ["SUPABASE_ACCESS_TOKEN"]),
        ({"SUPABASE_SERVICE_ROLE_KEY": "fake"}, ["SUPABASE_SERVICE_ROLE_KEY"]),
        ({"PGHOST": "db.fakeref.supabase.co"}, ["PGHOST"]),
        ({"PGHOST": "aws-0-eu.pooler.supabase.com"}, ["PGHOST"]),
        ({"PGHOST": "10.1.2.3"}, ["PGHOST"]),
        ({"DATABASE_URL": "postgres://u:p@db.x.supabase.co/postgres", "PGHOST": "/tmp"}, ["DATABASE_URL"]),
        ({"WHATEVER": "https://qdfghkfcyndxrhtbnzag.supabase.co"}, ["WHATEVER"]),
    ],
)
def test_the_guard_names_anything_that_looks_like_production(env, names):
    assert _drill().looks_like_production(env) == names


def test_the_drill_refuses_with_exit_2_and_prints_no_value():
    env = {**os.environ, "SUPABASE_ACCESS_TOKEN": "sbp_distinctive_fake_token_value"}
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "local-backup-drill.py")], capture_output=True, text=True, env=env, timeout=60)
    assert r.returncode == 2
    assert "SUPABASE_ACCESS_TOKEN" in r.stderr and "distinctive_fake" not in r.stdout + r.stderr


@pytest.mark.parametrize("script,args", [("export-prod-data.py", []), ("apply-migration.py", ["0001"])])
def test_the_production_scripts_refuse_without_a_token(script, args):
    env = {k: v for k, v in os.environ.items() if k != "SUPABASE_ACCESS_TOKEN"}
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / script), *args], capture_output=True, text=True, env=env, timeout=60)
    assert r.returncode != 0 and "SUPABASE_ACCESS_TOKEN is not set" in r.stdout + r.stderr


def _local_pg() -> bool:
    if not shutil.which("psql") or not shutil.which("pg_dump") or not os.environ.get("PGHOST"):
        return False
    r = subprocess.run(["psql", "-X", "-Atc", "select 1", "-d", "postgres"], capture_output=True, text=True, timeout=20)
    return r.returncode == 0


@pytest.mark.skipif(not _local_pg() or bool(os.environ.get("SUPABASE_ACCESS_TOKEN")), reason="needs a reachable local PostgreSQL superuser (PG* variables) and no production token in the environment")
def test_the_drill_round_trips_on_a_local_postgres():
    r = subprocess.run([sys.executable, str(ROOT / "scripts" / "local-backup-drill.py")], capture_output=True, text=True, timeout=600)
    assert r.returncode == 0, r.stdout[-1500:] + r.stderr[-500:]
    assert "RESTORE VERIFIED" in r.stdout and "DRILL PASSED" in r.stdout and "DIFFERENT" not in r.stdout


@pytest.mark.parametrize("name", ["PGHOSTADDR", "PGSERVICE", "PGSERVICEFILE", "DATABASE_URL"])
def test_variables_that_redirect_libpq_away_from_the_local_socket_are_refused_even_with_a_local_pghost(name):
    """The security review's finding: PGHOSTADDR overrides PGHOST, so a local-looking PGHOST did not make the drill local. Names only are reported."""
    from importlib import util
    spec = util.spec_from_file_location("gf_local_backup_drill", Path(__file__).resolve().parent.parent / "scripts" / "local-backup-drill.py")
    mod = util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert mod.looks_like_production({"PGHOST": "/tmp", name: "203.0.113.5"}) == [name]
