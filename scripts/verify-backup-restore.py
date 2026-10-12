#!/usr/bin/env python3
"""Prove a GridForge data export can actually be restored -- into a SCRATCH database, never production.

A JSON file that parses is not a backup. This builds a throwaway PostgreSQL database from the repository's own
migrations (the schema production is supposed to have), loads every exported row into it, and checks that each
table's row count AND a content digest match the export. It then drops the database.

    PGHOST=/tmp PGPORT=5544 PGUSER=postgres python3 scripts/verify-backup-restore.py path/to/export.json

Needs a local/scratch PostgreSQL superuser connection (psql on PATH). It refuses to run against a host that looks
like a Supabase production database. It prints counts and OK/FAIL per table -- never row contents.

Exit 0 only if every exported table restored with identical counts and digests.
"""
import hashlib
import json
import os
import subprocess
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = sorted((ROOT / "supabase" / "migrations").glob("[0-9][0-9][0-9][0-9]_*.sql"))


def psql(db, sql=None, file=None, stdin=None):
    cmd = ["psql", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-X", "-d", db]
    cmd += ["-c", sql] if sql is not None else ["-f", str(file)]
    r = subprocess.run(cmd, input=stdin, capture_output=True, text=True)
    if r.returncode:
        # Only the error line: PostgreSQL's DETAIL/CONTEXT lines quote the offending row, i.e. customer data.
        first = next((l for l in r.stderr.splitlines() if "ERROR" in l), "unknown error")
        raise SystemExit(f"psql failed: {first.strip()[:200]}")
    return r.stdout.strip()


def digest(rows):
    canon = sorted(json.dumps(r, sort_keys=True, default=str, separators=(",", ":")) for r in rows)
    return hashlib.sha256("\n".join(canon).encode()).hexdigest()[:16]


def main():
    if len(sys.argv) != 2:
        raise SystemExit(__doc__)
    host = os.environ.get("PGHOST", "")
    if "supabase" in host or "pooler" in host:
        raise SystemExit("refusing: PGHOST looks like a hosted Supabase database. Use a scratch PostgreSQL.")
    export = json.loads(Path(sys.argv[1]).read_text())
    tables = export["tables"]
    name = f"gf_restore_{uuid.uuid4().hex[:8]}"
    psql("postgres", f"create database {name}")
    ok = True
    try:
        # What Supabase provides out of the box and the migrations rely on.
        psql(name, "create extension if not exists pgcrypto")
        psql(name, "do $$ declare r text; begin foreach r in array array['anon','authenticated','service_role'] loop "
                   "if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if; end loop; end $$")
        for m in MIGRATIONS:
            psql(name, file=m)
        print(f"schema built from {len(MIGRATIONS)} repository migrations")
        # Parents before children: foreign keys are real constraints here, so order the load by them.
        edges = psql(name, "select conrelid::regclass::text, confrelid::regclass::text from pg_constraint where contype='f' and connamespace='public'::regnamespace")
        deps = {t: set() for t in tables}
        for line in filter(None, edges.splitlines()):
            child, parent = (x.replace("public.", "").strip('"') for x in line.split("|"))
            if child in deps and parent in deps and child != parent:
                deps[child].add(parent)
        order = []
        while deps:
            ready = sorted(t for t, d in deps.items() if not (d - set(order)))
            if not ready:
                raise SystemExit("foreign-key cycle among exported tables")
            for t in ready:
                order.append(t)
                del deps[t]
        for table in order:
            rows = tables[table]
            if not rows:
                got = int(psql(name, f'select count(*) from public."{table}"'))
                print(f"{table}: 0 rows exported, {got} restored -> {'OK' if got == 0 else 'FAIL'}")
                ok &= got == 0
                continue
            payload = json.dumps(rows, default=str)
            psql(name, f'insert into public."{table}" select * from jsonb_populate_recordset(null::public."{table}", $gf${payload}$gf$::jsonb)')
            got = json.loads(psql(name, f'select coalesce(jsonb_agg(to_jsonb(t)), \'[]\'::jsonb) from public."{table}" t'))
            same = len(got) == len(rows) and digest(got) == digest(
                json.loads(psql(name, f'select coalesce(jsonb_agg(to_jsonb(t)), \'[]\'::jsonb) from (select * from jsonb_populate_recordset(null::public."{table}", $gf${payload}$gf$::jsonb)) t')))
            print(f"{table}: {len(rows)} exported, {len(got)} restored, digest {'match' if same else 'MISMATCH'} -> {'OK' if same else 'FAIL'}")
            ok &= same
    finally:
        psql("postgres", f"drop database {name}")
    print("RESTORE VERIFIED" if ok else "RESTORE FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
