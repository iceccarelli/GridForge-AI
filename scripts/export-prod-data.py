#!/usr/bin/env python3
"""Read-only export of every `public` table of the production Supabase project to a private JSON file.

    export SUPABASE_ACCESS_TOKEN=...     (enter it with `read -rsp`; never put it on a command line or in chat)
    python3 scripts/export-prod-data.py [project_ref]

Uses the Management API's READ-ONLY query endpoint: it cannot modify anything. Writes ~/gf-backups/gridforge-prod-<UTC>.json
with mode 0600 (outside the repository) and prints the path and per-table row counts -- never row contents. Each table is
counted separately and the export fails if the rows returned differ from the count. Feed the file to
scripts/verify-backup-restore.py: an export only counts as a backup once that has restored it.
"""
import datetime
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request

DEFAULT_REF = "qdfghkfcyndxrhtbnzag"   # the project timetopower.ai's NEXT_PUBLIC_SUPABASE_URL points at (verified 2026-10)


def main():
    token = os.environ.get("SUPABASE_ACCESS_TOKEN")
    if not token:
        raise SystemExit("SUPABASE_ACCESS_TOKEN is not set (use: read -rsp 'Supabase token: ' SUPABASE_ACCESS_TOKEN; export SUPABASE_ACCESS_TOKEN)")
    ref = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_REF
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "gridforge-export/1"}

    def call(path, body=None):
        req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{ref}/{path}",
                                     json.dumps(body).encode() if body is not None else None, headers)
        try:
            return json.load(urllib.request.urlopen(req, timeout=120))
        except urllib.error.HTTPError as e:
            raise SystemExit(f"Supabase API refused ({e.code}); check the token and the project ref")

    def q(sql):
        return call("database/query/read-only", {"query": sql})

    if call("")["status"] != "ACTIVE_HEALTHY":
        raise SystemExit("project is not ACTIVE_HEALTHY; nothing exported")
    names = [r["table_name"] for r in q("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE' order by 1")]
    out = {"taken_at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "project": ref, "tables": {}, "counts": {}}
    out["migrations"] = [r["name"] for r in q("select name from supabase_migrations.schema_migrations order by version")]
    for t in names:
        rows = q(f'select * from public."{t}"')
        n = q(f'select count(*) c from public."{t}"')[0]["c"]
        if len(rows) != n:
            raise SystemExit(f"{t}: exported {len(rows)} rows but the table has {n}; refusing a partial export")
        out["tables"][t] = rows
        out["counts"][t] = n
    d = os.path.expanduser("~/gf-backups")
    os.makedirs(d, mode=0o700, exist_ok=True)
    path = os.path.join(d, "gridforge-prod-" + datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + ".json")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as fh:
        json.dump(out, fh, default=str)
    print(f"exported {len(names)} tables, last migration: {out['migrations'][-1] if out['migrations'] else 'none'}")
    for t, n in out["counts"].items():
        print(f"  {t}: {n} rows")
    print(f"file: {path}  sha256:{hashlib.sha256(open(path, 'rb').read()).hexdigest()[:16]}")


if __name__ == "__main__":
    main()
