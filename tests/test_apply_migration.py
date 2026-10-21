"""scripts/apply-migration.py: the sanctioned migration applier's gates, against the REAL migrations directory.

Two defects, both reproduced before this file existed:
  * gate 2 demanded that migration N-1 be in the remote history, so 0030 could never be applied because 0029 is intentionally unused;
  * gate 4's destructive-statement regex matched `delete from` inside a function body (0028), so a migration that merely DEFINES a
    function that deletes (and a guard that fires BEFORE TRUNCATE, 0025) was refused as if it ran it.
The gates must allow gaps and ignore definitions, and must still refuse what is actually dangerous: reordering, duplicates, and a
destructive statement that runs.
"""
import glob
import importlib.util
import os
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
MIGRATIONS = ROOT / "supabase" / "migrations"


def _load():
    spec = importlib.util.spec_from_file_location("apply_migration", ROOT / "scripts" / "apply-migration.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


am = _load()
REAL = am.repo_numbers(str(MIGRATIONS))


def history_through(last, skip=()):
    """What the remote history would hold after applying every repository migration up to and including `last`."""
    names = []
    for f in sorted(glob.glob(str(MIGRATIONS / "*.sql"))):
        base = os.path.basename(f)
        if base[:4] <= last and base[:4] not in skip:
            names.append("gf_" + base[:-4])
    return names


def name_of(num):
    return "gf_" + os.path.basename(glob.glob(str(MIGRATIONS / f"{num}_*.sql"))[0])[:-4]


# ----------------------------------------------------------------------------------------------------------- gate 2

def test_the_repository_really_has_the_gap_this_is_about():
    assert "0029" not in REAL and "0028" in REAL and "0030" in REAL


def test_0030_passes_gate_2_when_0028_is_applied_despite_the_unused_0029():
    ok, prev, problems = am.gate2("0030", name_of("0030"), history_through("0028"), REAL)
    assert (ok, prev, problems) == (True, "0028", [])


def test_the_gap_does_not_loosen_the_other_checks():
    # the real predecessor missing: refused, naming it
    ok, prev, problems = am.gate2("0030", name_of("0030"), history_through("0028", skip=("0028",)), REAL)
    assert not ok and prev == "0028" and any("0028" in p and "not in the remote history" in p for p in problems)
    # already applied
    ok, _, problems = am.gate2("0030", name_of("0030"), history_through("0030"), REAL)
    assert not ok and any("already applied" in p for p in problems)
    # out of order: a higher-numbered migration is already applied
    ok, _, problems = am.gate2("0030", name_of("0030"), history_through("0028") + [name_of("0031")], REAL)
    assert not ok and any("out of order" in p and "0031" in p for p in problems)
    # a number the repository does not have
    ok, _, problems = am.gate2("0029", "gf_0029_x", history_through("0028"), REAL)
    assert not ok and any("exactly one migration file numbered 0029" in p for p in problems)


def test_duplicate_numbers_are_refused_even_for_a_different_migration():
    dup = dict(REAL)
    dup["0031"] = 2
    ok, _, problems = am.gate2("0030", name_of("0030"), history_through("0028"), dup)
    assert not ok and any("share the number" in p and "0031" in p for p in problems)
    ok, _, problems = am.gate2("0031", "gf_0031_leads_rls", history_through("0030"), dup)
    assert not ok and any("exactly one migration file numbered 0031" in p for p in problems)


def test_every_real_migration_applies_in_sequence_through_the_gates():
    """Walk the whole directory in order: each migration passes gate 2 given everything before it, gaps included."""
    nums = sorted(REAL)
    for i, n in enumerate(nums):
        ok, prev, problems = am.gate2(n, name_of(n), history_through(nums[i - 1]) if i else [], REAL)
        assert ok, (n, problems)


def test_the_history_matcher_reads_the_names_the_remote_actually_uses():
    assert am.history_numbers(["gf_0028_payg_ledger", "20260101000000_0030_x", "something_0031", "no_number"]) == {"0028", "0030", "0031"}


# ----------------------------------------------------------------------------------------------------------- gate 4

@pytest.mark.parametrize("num", ["0028", "0030"])
def test_the_real_migrations_that_define_functions_pass_the_destructive_gate(num):
    sql = Path(glob.glob(str(MIGRATIONS / f"{num}_*.sql"))[0]).read_text()
    assert "delete from" in sql.lower() or num == "0030"  # 0028 really does contain one, inside a function body
    assert am.destructive_statements(sql) == []


def test_no_migration_in_the_repository_is_refused_by_the_destructive_gate():
    for f in sorted(glob.glob(str(MIGRATIONS / "*.sql"))):
        assert am.destructive_statements(Path(f).read_text()) == [], os.path.basename(f)  # incl. 0025: `before truncate on` is a guard, not a truncate


@pytest.mark.parametrize("sql", [
    "delete from users;",
    "DELETE   FROM public.users where true;",
    "truncate table users;",
    "truncate users;",
    "drop table users;",
    "drop schema public cascade;",
    "alter table t drop column c;",
    "alter table t alter column c type text;",
    "create table t (a int);\ndelete from t;",
    # a DO block RUNS when applied, so what it deletes counts
    "do $$ begin delete from users; end $$;",
    "do $body$ begin execute 'x'; delete from users; end $body$;",
    # a function body is skipped, but a destructive statement AFTER it is still seen
    "create function f() returns void language sql as $$ select 1 $$;\ndelete from users;",
    # an unterminated dollar quote is not skipped
    "create function f() returns void as $$ delete from users;",
])
def test_a_destructive_statement_that_actually_runs_is_still_refused(sql):
    assert am.destructive_statements(sql), sql


@pytest.mark.parametrize("sql", [
    "create or replace function f() returns void language plpgsql as $$ begin delete from users; truncate t; drop table x; end $$;",
    "create function g() returns trigger as $fn$ begin delete from t where id = old.id; return old; end $fn$ language plpgsql;",
    "-- delete from users;\nselect 1;",
    "/* drop table users; */ select 1;",
    "select 'delete from users' as t;",
    "create trigger g before truncate on t for each statement execute function f();",
    "create trigger g before update or truncate on t for each statement execute function f();",
    "alter table t add column c int;",
])
def test_a_definition_a_comment_or_a_string_is_not_a_destructive_statement(sql):
    assert am.destructive_statements(sql) == [], sql
