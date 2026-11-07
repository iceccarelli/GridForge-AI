"""Migrations 0049-0051 as an OPERATOR meets them: the sanctioned applier's gates, a database that already holds production data, and a re-run.

The three files are written, not applied. What has to hold before anybody applies them: the applier's destructive-statement gate passes (nothing
that drops, truncates or deletes RUNS), applying them to a database whose projects already exist changes none of those rows, applying them again
is harmless, and they say plainly that they are not applied.

Needs a reachable PostgreSQL for the replay tests (`psql` plus PG* variables, or GRIDFORGE_TEST_PG_URL); the static checks always run.
"""
import importlib.util
import re
import uuid

import pytest
from registry_pg import MIGRATIONS, ROOT, drop_database, make_database, needs_db, psql, scalar

NUMBERS = ("0049", "0050", "0051")
FILES = {n: next(MIGRATIONS.glob(f"{n}_*.sql")) for n in NUMBERS}


def _applier():
    spec = importlib.util.spec_from_file_location("apply_migration", ROOT / "scripts" / "apply-migration.py")
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


am = _applier()


@pytest.mark.parametrize("n", NUMBERS)
def test_the_destructive_statement_gate_of_the_sanctioned_applier_passes(n):
    assert am.destructive_statements(FILES[n].read_text()) == []


@pytest.mark.parametrize("n", NUMBERS)
def test_the_file_says_it_is_written_not_applied_and_is_numbered_once(n):
    head = FILES[n].read_text().split("\n\n")[0]
    assert "WRITTEN, NOT APPLIED" in FILES[n].read_text()[:2500], head
    assert len(list(MIGRATIONS.glob(f"{n}_*.sql"))) == 1


def test_the_numbers_belong_to_this_stream_and_no_applied_migration_is_edited():
    owned = {p.name[:4] for p in MIGRATIONS.glob("*.sql")}
    assert set(NUMBERS) <= owned
    for n in NUMBERS:                      # nothing in them rewrites a table that earlier migrations created, beyond the two additive columns
        sql = FILES[n].read_text()
        altered = re.findall(r"alter\s+table\s+(?:public\.)?(\w+)\s+(?!enable row level security)(\w+)", sql, re.I)
        for table, verb in altered:
            assert (table, verb.lower()) in {("projects", "add"), ("project_events", "drop"), ("project_events", "add")}, (n, table, verb)
    # the one existing constraint it rebuilds is rebuilt as a UNION read from the catalog, never as a fixed list that could drop another migration's type
    sql50 = FILES["0050"].read_text()
    assert "pg_get_constraintdef" in sql50 and "project_attached_to_hall" in sql50 and "project_detached_from_hall" in sql50
    assert not re.search(r"check \(event_type in \('project_created'", sql50)


def test_every_function_in_the_three_files_is_closed_to_public_and_the_api_roles_by_name():
    for n in NUMBERS:
        sql = FILES[n].read_text()
        for fn in re.findall(r"create or replace function public\.(gf_\w+)\(", sql):
            assert re.search(rf"public\.{fn}\(", sql.split("-- G. Service role only")[-1] if n == "0049" else sql[sql.rfind("do $$"):]), (n, fn)


@needs_db
def test_applying_them_to_a_database_that_holds_projects_changes_none_of_them_and_a_second_run_is_harmless():
    db = make_database(through="0045")
    try:
        tokens = [uuid.uuid4().hex for _ in range(3)]
        for t in tokens:
            psql(db, f"insert into projects (project_token, project_name, site_label, location) values ('{t}', 'Existing', 'North hall', '{{\"city\": \"Dublin\"}}')")
            psql(db, f"insert into project_events (project_id, event_type, actor) select id, 'project_created', 'x' from projects where project_token = '{t}'")
        before = scalar(db, "select md5(string_agg(to_jsonb(p)::text, '|' order by project_token)) from (select id, project_token, company, project_name, site_label, location, status, created_at, updated_at from projects) p")
        events = scalar(db, "select count(*) from project_events")
        for n in NUMBERS:
            psql(db, file=FILES[n])
        after = scalar(db, "select md5(string_agg(to_jsonb(p)::text, '|' order by project_token)) from (select id, project_token, company, project_name, site_label, location, status, created_at, updated_at from projects) p")
        assert after == before
        assert scalar(db, "select count(*) from projects where site_id is not null or hall_id is not null") == "0"
        assert scalar(db, "select count(*) from project_events") == events
        assert scalar(db, "select count(*) from projects") == "3"
        # existing code keeps working: a project is still created and updated the way the application does it
        psql(db, "insert into projects (project_token, project_name) values ('t-new', 'New')")
        psql(db, "update projects set status = 'active', updated_at = now() where project_token = 't-new'")
        for n in NUMBERS:                                         # the second run
            psql(db, file=FILES[n])
        assert scalar(db, "select count(*) from pg_proc where proname in ('gf_create_org', 'gf_record_hall_input', 'gf_hall_timeline')") == "3"
        assert scalar(db, "select count(*) from pg_trigger where tgname in ('hall_inputs_guard', 'hall_inputs_append_only', 'hall_inputs_no_truncate', "
                      "'hall_project_attachments_append_only', 'hall_project_attachments_no_truncate', 'projects_hall_guard') and not tgisinternal") == "6"
    finally:
        drop_database(db)
