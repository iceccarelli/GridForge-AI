#!/usr/bin/env python3
"""Apply ONE repository migration to the production Supabase project, behind safety gates.

    read -rsp "Supabase token: " SUPABASE_ACCESS_TOKEN; export SUPABASE_ACCESS_TOKEN; echo
    python3 scripts/apply-migration.py 0021            # dry run: checks every gate, changes nothing
    python3 scripts/apply-migration.py 0021 --yes      # applies it, records it in the migration history, verifies

Gates (any failure refuses; nothing is written):
  1. the project is ACTIVE_HEALTHY;
  2. the previous migration (NNNN-1) is already in the remote history, and this one is not;
  3. a restore-test-grade export exists in ~/gf-backups, newer than 2 hours, and its per-table row counts equal
     the live counts right now (so the backup is of the data as it is, not of an earlier state);
  4. the SQL contains no destructive statement (drop table/schema/column, truncate, delete from, alter column type).
It never uses `db reset` or migration repair, and prints counts and names only.
"""
import glob
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request

REF = os.environ.get("GF_SUPABASE_REF", "qdfghkfcyndxrhtbnzag")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DESTRUCTIVE = re.compile(r"\b(drop\s+(table|schema|column|database)|truncate|delete\s+from|alter\s+table\s+\S+\s+alter\s+column\s+\S+\s+type)\b", re.I)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    apply = "--yes" in sys.argv
    if len(args) != 1 or not re.fullmatch(r"\d{4}", args[0]):
        raise SystemExit(__doc__)
    num = args[0]
    token = os.environ.get("SUPABASE_ACCESS_TOKEN") or sys.exit("SUPABASE_ACCESS_TOKEN is not set")
    files = glob.glob(os.path.join(ROOT, "supabase", "migrations", f"{num}_*.sql"))
    if len(files) != 1:
        raise SystemExit(f"expected exactly one migration file for {num}, found {len(files)}")
    path = files[0]
    name = "gf_" + os.path.basename(path)[:-4]
    sql = open(path).read()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json", "User-Agent": "gridforge-apply/1"}

    def call(p, body=None):
        req = urllib.request.Request(f"https://api.supabase.com/v1/projects/{REF}/{p}", json.dumps(body).encode() if body is not None else None, headers)
        try:
            return json.load(urllib.request.urlopen(req, timeout=180))
        except urllib.error.HTTPError as e:
            raise SystemExit(f"Supabase API refused ({e.code}) on {p.split('?')[0]}")

    q = lambda s: call("database/query/read-only", {"query": s})
    fail = []

    status = call("")["status"]
    print(f"gate 1  project {REF}: {status}")
    if status != "ACTIVE_HEALTHY":
        fail.append("project not healthy")

    hist = [r["name"] for r in q("select name from supabase_migrations.schema_migrations order by version")]
    prev = f"{int(num) - 1:04d}"
    has_prev = any(h.startswith(f"gf_{prev}_") or f"_{prev}_" in h or h.endswith(f"_{prev}") for h in hist)
    already = name in hist
    print(f"gate 2  previous migration {prev} recorded: {has_prev}; {name} already applied: {already}; history ends at {hist[-1] if hist else 'nothing'}")
    if not has_prev:
        fail.append(f"previous migration {prev} is not in the remote history")
    if already:
        fail.append(f"{name} is already applied")

    live = {t["table_name"]: q(f'select count(*) c from public."{t["table_name"]}"')[0]["c"]
            for t in q("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")}
    backups = sorted(glob.glob(os.path.expanduser("~/gf-backups/*.json")), key=os.path.getmtime)
    ok_backup = False
    if backups:
        b = backups[-1]
        age_h = (time.time() - os.path.getmtime(b)) / 3600
        counts = json.load(open(b)).get("counts", {})
        mismatch = sorted(t for t in set(live) | set(counts) if live.get(t) != counts.get(t))
        ok_backup = age_h < 2 and not mismatch
        print(f"gate 3  newest export {os.path.basename(b)}: {age_h:.1f} h old, counts {'match live' if not mismatch else 'DIFFER on ' + ', '.join(mismatch)}")
    else:
        print("gate 3  no export in ~/gf-backups")
    if not ok_backup:
        fail.append("no fresh export whose counts equal the live counts (run export-prod-data.py and verify-backup-restore.py first)")

    bad = DESTRUCTIVE.findall(sql)
    print(f"gate 4  destructive statements in {os.path.basename(path)}: {len(bad)}")
    if bad:
        fail.append("migration contains a destructive statement")

    if fail:
        raise SystemExit("REFUSED: " + "; ".join(fail))
    if not apply:
        print(f"all gates pass. DRY RUN: would apply {name} ({len(sql.splitlines())} lines). Re-run with --yes to apply.")
        return
    call("database/migrations", {"name": name, "query": sql})
    after = [r["name"] for r in q("select name from supabase_migrations.schema_migrations order by version")]
    print(f"applied {name}; history now ends: {after[-3:]}")
    if name not in after:
        raise SystemExit("applied but not recorded in the migration history -- stop and investigate")
    after_counts = {t: q(f'select count(*) c from public."{t}"')[0]["c"] for t in live}
    changed = sorted(t for t in live if after_counts[t] != live[t])
    print("existing tables' row counts unchanged" if not changed else f"WARNING: counts changed on {changed}")


if __name__ == "__main__":
    main()
