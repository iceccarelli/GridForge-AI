#!/usr/bin/env python3
"""A backup-and-restore DRILL against a LOCAL scratch PostgreSQL. It can never reach production.

    PGHOST=/tmp PGPORT=5433 PGUSER=postgres python3 scripts/local-backup-drill.py

Why this exists: scripts/export-prod-data.py talks only to the hosted Supabase Management API with a personal access token and a
hard-coded production project ref, so it cannot run without production credentials, and scripts/apply-migration.py is the same
(production only, behind gates). Neither may be pointed at a local database. This drill exercises the same RESTORE path without them:

  1. build a fresh source database from every supabase/migrations/*.sql and seed SYNTHETIC rows only;
  2. write an export in the exact file format export-prod-data.py produces (tables, counts, migrations), mode 0600, in a temp dir;
  3. restore it with scripts/verify-backup-restore.py (builds a second scratch database, loads every row, compares counts and digests);
  4. take a pg_dump -Fc of the source, pg_restore it into a third scratch database, and compare per-table row counts and content hashes;
  5. drop every database it created. Prints counts and hashes, never row contents.

Refusal: it exits 2 without touching anything if PGHOST is not a unix socket / localhost, or if ANY environment variable looks like
production (a Supabase host, the production project ref, a Management API token, a service-role key).
Exit 0 only if both restores match the source exactly.
"""
from __future__ import annotations

import importlib.util
import json
import os
import re
import subprocess
import sys
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROD_MARKERS = ("supabase.co", "supabase.com", "pooler.supabase", "qdfghkfcyndxrhtbnzag", "timetopower.ai")
PROD_VARS = ("SUPABASE_ACCESS_TOKEN", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_KEY")


def looks_like_production(env: dict[str, str]) -> list[str]:
    """Names (never values) of environment variables that look like production. Pure: the unit tests call it."""
    bad = [k for k in PROD_VARS if env.get(k)]
    for k, v in env.items():
        if k in bad or not v:
            continue
        if any(m in v.lower() for m in PROD_MARKERS):
            bad.append(k)
    host = env.get("PGHOST", "")
    if host and not (host.startswith("/") or host in ("localhost", "127.0.0.1", "::1")):
        if "PGHOST" not in bad:
            bad.append("PGHOST")
    return sorted(set(bad))


def _load_verifier():
    spec = importlib.util.spec_from_file_location("gf_verify_restore", ROOT / "scripts" / "verify-backup-restore.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[union-attr]
    return mod


SEED = """
insert into projects (id, project_token, company, project_name, status) values
  ('00000000-0000-4000-8000-000000000001', 'synthetic-token-1', 'Synthetic Co A', 'Synthetic Hall A', 'active'),
  ('00000000-0000-4000-8000-000000000002', 'synthetic-token-2', 'Synthetic Co B', 'Synthetic Hall B', 'draft'),
  ('00000000-0000-4000-8000-000000000003', 'synthetic-token-3', null, 'Synthetic Hall C', 'closed');
insert into project_events (project_id, event_type, actor, payload)
  select id, 'project_created', 'drill', jsonb_build_object('n', row_number() over (order by id), 'note', 'synthetic') from projects;
insert into leads (name, company, email, location, capacity_mw, urgency, services, message) values
  ('Synthetic One', 'Synthetic Co A', 'one@example.invalid', 'Nowhere', 12.5, 'soon', '["screen"]', 'drill row 1'),
  ('Synthetic Two', 'Synthetic Co B', 'two@example.invalid', 'Nowhere', 30, 'later', '["study","watch"]', 'drill row 2 with "quotes" and ''apostrophes'''),
  ('Synthetic Three', 'Synthetic Co C', 'three@example.invalid', 'Nowhere', null, null, null, null);
insert into funnel_events (name, props, dedupe_key) values
  ('qualify_started', '{}', 'drill-1'), ('qualify_completed', '{}', 'drill-2');
"""


class Drill:
    def __init__(self) -> None:
        self.created: list[str] = []
        self.verifier = _load_verifier()

    def psql(self, db: str, sql: str) -> str:
        return self.verifier.psql(db, sql)

    def make_db(self, label: str) -> str:
        name = f"gf_drill_{label}_{uuid.uuid4().hex[:6]}"
        self.psql("postgres", f"create database {name}")
        self.created.append(name)
        return name

    def prepare_roles(self, db: str) -> None:
        self.psql(db, "create extension if not exists pgcrypto")
        self.psql(db, "do $$ declare r text; begin foreach r in array array['anon','authenticated','service_role'] loop "
                      "if not exists (select 1 from pg_roles where rolname = r) then execute format('create role %I nologin', r); end if; end loop; end $$")

    def tables(self, db: str) -> list[str]:
        out = self.psql(db, "select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1")
        return [t for t in out.splitlines() if t]

    def snapshot(self, db: str) -> dict[str, tuple[int, str]]:
        """{table: (row count, md5 over the sorted canonical JSON of every row)}. Hashes only; contents never leave the database."""
        snap = {}
        for t in self.tables(db):
            row = self.psql(db, f'select count(*) || \'|\' || coalesce(md5(string_agg(j, \'~\' order by j)), \'empty\') '
                                f'from (select to_jsonb(x)::text j from public."{t}" x) q')
            n, h = row.split("|", 1)
            snap[t] = (int(n), h)
        return snap

    def export_file(self, db: str, out_dir: Path) -> Path:
        tables, counts = {}, {}
        for t in self.tables(db):
            tables[t] = json.loads(self.psql(db, f'select coalesce(jsonb_agg(to_jsonb(x)), \'[]\'::jsonb) from public."{t}" x'))
            counts[t] = len(tables[t])
        migrations = [f"gf_{p.name[:-4]}" for p in sorted((ROOT / "supabase" / "migrations").glob("[0-9][0-9][0-9][0-9]_*.sql"))]
        doc = {"taken_at": "local-drill", "project": "LOCAL-DRILL-NOT-PRODUCTION", "tables": tables, "counts": counts, "migrations": migrations}
        path = out_dir / "gridforge-local-drill.json"
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as fh:
            json.dump(doc, fh, default=str)
        return path

    def run(self) -> int:
        ok = True
        src = self.make_db("src")
        self.prepare_roles(src)
        migrations = sorted((ROOT / "supabase" / "migrations").glob("[0-9][0-9][0-9][0-9]_*.sql"))
        for m in migrations:
            self.verifier.psql(src, file=m)
        print(f"[1] source database built from {len(migrations)} migrations")
        self.psql(src, SEED)
        before = self.snapshot(src)
        seeded = {t: v for t, v in before.items() if v[0]}
        print(f"[1] seeded synthetic rows; non-empty tables: " + ", ".join(f"{t}={n}" for t, (n, _) in sorted(seeded.items())))

        with tempfile.TemporaryDirectory(prefix="gf-drill-") as tmp:
            tmpd = Path(tmp)
            tmpd.chmod(0o700)
            export = self.export_file(src, tmpd)
            total = sum(n for n, _ in before.values())
            print(f"[2] export written (mode 0600), {len(before)} tables, {total} rows")

            r = subprocess.run([sys.executable, str(ROOT / "scripts" / "verify-backup-restore.py"), str(export)], capture_output=True, text=True)
            lines = [l for l in r.stdout.splitlines() if l.strip()]
            shown = [l for l in lines if "restored" in l and not l.endswith("0 restored -> OK") or l.startswith(("schema built", "RESTORE"))]
            print("[3] verify-backup-restore.py: exit", r.returncode)
            for l in shown:
                print("      " + l)
            if r.returncode != 0 or "RESTORE VERIFIED" not in r.stdout:
                ok = False
                print(r.stderr[-300:])

            dump = tmpd / "src.dump"
            subprocess.run(["pg_dump", "-Fc", "--no-owner", "-d", src, "-f", str(dump)], check=True)
            dst = self.make_db("dst")
            self.prepare_roles(dst)
            rr = subprocess.run(["pg_restore", "--no-owner", "--exit-on-error", "-d", dst, str(dump)], capture_output=True, text=True)
            if rr.returncode:
                ok = False
                print("[4] pg_restore FAILED:", (rr.stderr.splitlines() or ["?"])[0][:200])
            after = self.snapshot(dst)
            diffs = sorted(t for t in set(before) | set(after) if before.get(t) != after.get(t))
            print(f"[4] pg_dump -Fc ({dump.stat().st_size} bytes) -> pg_restore: {len(after)} tables restored; differing tables: {diffs or 'none'}")
            for t in sorted(seeded):
                (n, h), (n2, h2) = before[t], after.get(t, (-1, "missing"))
                print(f"      {t}: source {n} rows md5 {h[:12]} | restored {n2} rows md5 {h2[:12]} | {'EQUAL' if (n, h) == (n2, h2) else 'DIFFERENT'}")
            ok &= not diffs and rr.returncode == 0
        print("DRILL PASSED" if ok else "DRILL FAILED")
        return 0 if ok else 1

    def cleanup(self) -> None:
        for name in self.created:
            try:
                self.psql("postgres", f"drop database if exists {name} with (force)")
            except SystemExit as e:  # best effort, but say so
                print("cleanup failed for", name, e)


def main() -> int:
    bad = looks_like_production(dict(os.environ))
    if bad:
        print("refusing: these variables look like production or a non-local database: " + ", ".join(bad), file=sys.stderr)
        return 2
    d = Drill()
    try:
        return d.run()
    finally:
        d.cleanup()


if __name__ == "__main__":
    sys.exit(main())
