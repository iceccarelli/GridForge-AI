#!/usr/bin/env python3
"""Apply ONE repository migration to the production Supabase project, behind safety gates.

    read -rsp "Supabase token: " SUPABASE_ACCESS_TOKEN; export SUPABASE_ACCESS_TOKEN; echo
    python3 scripts/apply-migration.py 0021            # dry run: checks every gate, changes nothing
    python3 scripts/apply-migration.py 0021 --yes      # applies it, records it in the migration history, verifies

Gates (any failure refuses; nothing is written):
  1. the project is ACTIVE_HEALTHY;
  2. the previous migration IN THE REPOSITORY (the highest number below this one; gaps such as an intentionally unused 0029 are fine)
     is already in the remote history, this one is not, and no HIGHER-numbered migration is already applied (no applying out of order);
     two files with one number are refused;
  3. a restore-test-grade export exists in ~/gf-backups, newer than 2 hours, and its per-table row counts equal
     the live counts right now (so the backup is of the data as it is, not of an earlier state);
  4. the SQL contains no destructive statement (drop table/schema/column, truncate, delete from, alter column type) outside the bodies of
     functions it creates (a function that deletes rows only runs when called; comments and string literals are ignored too).
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
MIGRATIONS_DIR = os.path.join(ROOT, "supabase", "migrations")


def repo_numbers(directory=MIGRATIONS_DIR):
    """Every migration number in the repository, with how many files carry it."""
    counts = {}
    for f in glob.glob(os.path.join(directory, "[0-9][0-9][0-9][0-9]_*.sql")):
        n = os.path.basename(f)[:4]
        counts[n] = counts.get(n, 0) + 1
    return counts


def history_numbers(hist):
    """The migration numbers a remote history names (the history's names are gf_NNNN_..., or carry _NNNN_ / end _NNNN)."""
    out = set()
    for h in hist:
        m = re.match(r"gf_(\d{4})_", h) or re.search(r"_(\d{4})(?:_|$)", h)
        if m:
            out.add(m.group(1))
    return out


def gate2(num, name, hist, numbers):
    """(ok, previous, problems). `numbers` is repo_numbers(). Gaps are fine; reordering and duplicates are not."""
    problems = []
    if numbers.get(num, 0) != 1:
        problems.append(f"expected exactly one migration file numbered {num}, found {numbers.get(num, 0)}")
    dupes = sorted(n for n, c in numbers.items() if c > 1)
    if dupes:
        problems.append("two migration files share the number(s) " + ", ".join(dupes))
    earlier = sorted(n for n in numbers if n < num)
    prev = earlier[-1] if earlier else None
    have = history_numbers(hist)
    if prev is not None and prev not in have:
        problems.append(f"the previous migration in the repository ({prev}) is not in the remote history")
    later = sorted(n for n in have if n > num)
    if later:
        problems.append("a HIGHER-numbered migration is already applied (" + ", ".join(later) + "); applying " + num + " now would be out of order")
    if name in hist:
        problems.append(f"{name} is already applied")
    return (not problems, prev, problems)


def _dollar_blocks(sql):
    """[(start, end, tag)] of every dollar-quoted body: $$ ... $$ or $tag$ ... $tag$."""
    out, i = [], 0
    while True:
        m = re.compile(r"\$([A-Za-z_]*)\$").search(sql, i)
        if not m:
            return out
        close = sql.find(m.group(0), m.end())
        if close < 0:
            return out
        out.append((m.start(), close + len(m.group(0)), m.group(0)))
        i = close + len(m.group(0))


def checkable_sql(sql):
    """The SQL that EXECUTES when the migration is applied: no comments, no string literals, and no bodies of functions it creates.

    A `create function ... as $$ delete from t $$` defines the delete without running it. A DO block's body DOES run, so it stays
    in. Anything unterminated is left in (a parse we do not understand is checked, not skipped)."""
    out, pos = [], 0
    for start, end, _tag in _dollar_blocks(sql):
        lead = sql[pos:start]
        head = lead[lead.rfind(";") + 1:]  # the statement this body belongs to, up to its opening $$
        out.append(lead)
        if re.search(r"\bcreate\b(?:\s+or\s+replace)?\s+(?:function|procedure)\b", head, re.I):
            out.append(" ")  # a function body: defined, not run
        else:
            out.append(sql[start:end])  # a DO body (or anything else): runs, so it is checked
        pos = end
    out.append(sql[pos:])
    text = "".join(out)
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"--[^\n]*", " ", text)
    text = re.sub(r"'(?:[^']|'')*'", "''", text)
    # `create trigger ... before truncate on t` DEFINES a guard against truncation; it is not a truncation.
    text = re.sub(r"\b(?:before|after|or)\s+truncate\b", " ", text, flags=re.I)
    # `revoke truncate on ...` REMOVES the privilege to truncate (0040); it is not a truncation either.
    text = re.sub(r"\brevoke\s+truncate\b", " ", text, flags=re.I)
    return text


def destructive_statements(sql):
    return [m[0] if isinstance(m, tuple) else m for m in DESTRUCTIVE.findall(checkable_sql(sql))]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    apply = "--yes" in sys.argv
    if len(args) != 1 or not re.fullmatch(r"\d{4}", args[0]):
        raise SystemExit(__doc__)
    num = args[0]
    token = os.environ.get("SUPABASE_ACCESS_TOKEN") or sys.exit("SUPABASE_ACCESS_TOKEN is not set")
    files = glob.glob(os.path.join(MIGRATIONS_DIR, f"{num}_*.sql"))
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
    ok2, prev, problems = gate2(num, name, hist, repo_numbers())
    print(f"gate 2  previous migration in the repository: {prev}; ok: {ok2}; history ends at {hist[-1] if hist else 'nothing'}")
    fail.extend(problems)

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

    bad = destructive_statements(sql)
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
