"""The FINAL state of the supplier-quotation gate, read back from a database built by the whole migration chain.

0022 and 0026 define gf_review_cost_evidence, gf_retire_cost_evidence and gf_save_comparison; 0054 replaces all three and adds two ROW TRIGGERS and
a text CHECK. The definition that governs is whichever ran last, so a reordered migration, a replay of an older one, or a later migration that
redefines a function from an old copy would silently remove the file gate without any behavioural test noticing (those build fixtures that happen
to satisfy the missing condition). This reads what the database ACTUALLY holds at the end of the chain (pg_get_functiondef, pg_trigger,
pg_get_constraintdef) and fails if any gate is absent. It also proves the reader bites, and that the row triggers keep the file gate in force even
when an older migration's function is replayed over the new one.
"""
import re

from calibration_pg_rig import MIGRATIONS, database_fixture, make_database, drop_database, psql, scalar, skip_without_db

import pytest

pytestmark = skip_without_db
db = database_fixture()


def fn(name, signature):
    # lower-cased: a plpgsql body is stored as written, a constraint is re-printed by PostgreSQL; both are compared in one case
    return " ".join(scalar(name, f"select pg_get_functiondef('public.{signature}'::regprocedure)").split()).lower()


# Each is one clause of the policy, as a regular expression over the normalised function text.
FILE_GATE = {
    "the file belongs to the line's project": r"pe\.project_id = e\.project_id",
    "the file's review_status is verified": r"pe\.review_status = 'verified'",
    "a decision row says verified": r"er\.decision = 'verified'",
    "the decision's confirmed digest equals the stored one": r"er\.sha256_confirmed = pe\.sha256",
    "only an acceptance is gated": r"decision = 'accepted'",
    "the error is GF009": r"gf009",
}


def final_gaps(name):
    """Everything the FINAL state of database `name` is missing from the gate (empty means complete)."""
    gaps = []
    review = fn(name, "gf_review_cost_evidence(jsonb, jsonb)")
    for label, pattern in FILE_GATE.items():
        if label != "only an acceptance is gated" and not re.search(pattern, review):
            gaps.append(f"gf_review_cost_evidence: {label}")
    if "coalesce(e.deliverable_id::text" not in review:
        gaps.append("gf_review_cost_evidence: lock key is not scope-aware (a null deliverable makes the lock a no-op)")
    if "s.deliverable_id is null" not in review:
        gaps.append("gf_review_cost_evidence: supersession is not scoped to a project line's project")
    retire = fn(name, "gf_retire_cost_evidence(jsonb, jsonb)")
    if "coalesce(s.deliverable_id::text" not in retire:
        gaps.append("gf_retire_cost_evidence: lock key is not scope-aware")
    save = fn(name, "gf_save_comparison(jsonb, jsonb, jsonb, jsonb)")
    if "source_file_id is not null" not in save:
        gaps.append("gf_save_comparison: a project line cannot be named")
    if "coalesce(e.deliverable_id::text" not in save:
        gaps.append("gf_save_comparison: lock key is not scope-aware")
    sub = fn(name, "gf_submit_project_quotation(jsonb, jsonb)")
    for needle in ("gf010", "gf011", "gf012", "gf013", "current_date", "pg_advisory_xact_lock"):
        if needle not in sub:
            gaps.append(f"gf_submit_project_quotation: lost {needle}")
    # the row triggers: present, enabled, and carrying every clause
    for table, trigger in (("cost_evidence_reviews", "cost_evidence_review_guard"), ("cost_evidence", "cost_evidence_line_guard")):
        on = scalar(name, f"select count(*) from pg_trigger where tgrelid = 'public.{table}'::regclass and tgname = '{trigger}' and tgenabled = 'O' and tgtype & 1 = 1 and tgtype & 2 = 2")
        if on != "1":
            gaps.append(f"trigger {trigger} on {table} is missing, disabled, or not BEFORE INSERT FOR EACH ROW")
    review_guard = fn(name, "gf_cost_evidence_review_guard()")
    for label, pattern in FILE_GATE.items():
        if not re.search(pattern, review_guard):
            gaps.append(f"gf_cost_evidence_review_guard: {label}")
    if "gf014" not in review_guard or "lower(btrim(new.reviewer)) = lower(btrim(e.submitted_by))" not in review_guard:
        gaps.append("gf_cost_evidence_review_guard: the reviewer may be the submitter")
    line_guard = fn(name, "gf_cost_evidence_line_guard()")
    for needle in ("gf010", "gf011", "gf012", "f.project_id is distinct from new.project_id", "new.valid_until < current_date", "new.received_on > current_date"):
        if needle not in line_guard:
            gaps.append(f"gf_cost_evidence_line_guard: lost '{needle}'")
    # the CHECK that bounds a project line
    check = " ".join(scalar(name, "select pg_get_constraintdef(oid) from pg_constraint where conname = 'cost_evidence_origin'").split()).lower()
    for needle in ("gf_quotation_text_ok(supplier, false)", "gf_quotation_text_ok(scope, false)", "gf_quotation_text_ok(notes, true)", "gf_quotation_text_ok(submitted_by, false)",
                   "value >= 0.01", "quoted_quantity >= 0.001", "valid_until >= received_on"):
        if needle not in check:
            gaps.append(f"cost_evidence_origin: lost '{needle}'")
    if not re.search(r"lead_time_weeks <= \(?520", check):
        gaps.append("cost_evidence_origin: lost 'lead_time_weeks <= 520'")
    textfn = fn(name, "gf_quotation_text_ok(text, boolean)")
    if "[:cntrl:]" in textfn:
        gaps.append("gf_quotation_text_ok: uses [[:cntrl:]], which depends on the cluster's locale")
    # the view keeps its old columns and appends the new ones
    cols = scalar(name, "select string_agg(column_name, ',' order by ordinal_position) from information_schema.columns where table_name = 'cost_evidence_state'")
    if not cols.endswith("retired_by,source_file_id,claimed_quote_type,lead_time_weeks,notes,submitted_by"):
        gaps.append("cost_evidence_state: the column list or order changed")
    # privileges
    for sig in ("gf_submit_project_quotation(jsonb, jsonb)", "gf_cost_evidence_line_guard()", "gf_cost_evidence_review_guard()", "gf_quotation_text_ok(text, boolean)"):
        for role in ("anon", "authenticated", "public"):
            if role == "public":
                open_to_public = scalar(name, f"select (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))::text from pg_proc p where p.oid = 'public.{sig}'::regprocedure")
                if open_to_public != "false":
                    gaps.append(f"{sig} is executable by PUBLIC")
            elif scalar(name, f"select has_function_privilege('{role}', 'public.{sig}', 'execute')") != "f":
                gaps.append(f"{sig} is executable by {role}")
    return gaps


def test_the_final_state_of_the_chain_holds_every_gate(db):
    assert final_gaps(db) == []


def test_the_migrations_that_define_these_functions_run_in_the_order_the_header_notes_say():
    """0054 is the last definition of each; a further one is a new deliberate decision that must update this test, not an accident."""
    def holders(name):
        return [f.name[:4] for f in sorted(MIGRATIONS.glob("*.sql")) if f"create or replace function public.{name}(" in f.read_text()]
    assert holders("gf_review_cost_evidence")[-1] == "0054" and holders("gf_review_cost_evidence") == ["0022", "0054"], holders("gf_review_cost_evidence")
    assert holders("gf_retire_cost_evidence") == ["0022", "0054"], holders("gf_retire_cost_evidence")
    assert holders("gf_save_comparison") == ["0025", "0026", "0054"], holders("gf_save_comparison")
    assert holders("gf_cost_evidence_review_guard") == ["0054"] and holders("gf_cost_evidence_line_guard") == ["0054"]
    head = next(MIGRATIONS.glob("0054_*.sql")).read_text()
    assert "REPLAY ORDER" in head and "WRITTEN, NOT APPLIED" in head
    assert "tests/test_project_quotation_final_gate.py" in head


def test_the_reader_bites_replaying_0026_last_is_reported_as_gaps():
    name = make_database()
    try:
        assert final_gaps(name) == []
        psql(name, file=next(MIGRATIONS.glob("0026_*.sql")))
        gaps = final_gaps(name)
        assert any("gf_save_comparison: a project line cannot be named" in g for g in gaps) and any("gf_save_comparison: lock key" in g for g in gaps), gaps
    finally:
        drop_database(name)


def test_replaying_0022_s_function_over_0054_loses_the_function_gate_but_the_row_trigger_still_refuses():
    """The reason the gate is ALSO a trigger: 0022/0026 do not touch it, so a replay of their functions cannot remove it."""
    name = make_database()
    try:
        text = next(MIGRATIONS.glob("0022_*.sql")).read_text()
        old = re.search(r"create or replace function public\.gf_review_cost_evidence\(.*?\n\$\$;", text, flags=re.S).group(0)
        psql(name, old)
        gaps = final_gaps(name)
        assert any(g.startswith("gf_review_cost_evidence:") for g in gaps), gaps          # the reader names what the replay removed from the function
        assert not any("trigger" in g or "gf_cost_evidence_review_guard" in g for g in gaps), gaps   # ...and the trigger is intact
        # and behaviour agrees: with the OLD function in place, an acceptance on an unverified file is still refused
        pid = psql(name, "insert into projects (project_token, project_name) values ('t1', 'P') returning id").stdout.split("\n")[0]
        fid = psql(name, f"insert into project_evidence (project_id, filename, media_type, sha256, byte_size, storage_ref) values ('{pid}', 'q.pdf', 'application/pdf', '{'a' * 64}', 1, 'x') returning id").stdout.split("\n")[0]
        ev = '{"event_type": "cost_evidence_received", "actor": "t", "payload": {}}'
        sub = ("{\"project_id\": \"%s\", \"source_file_id\": \"%s\", \"line_digest\": \"%s\", \"cost_key\": \"cdu.addition\", \"unit\": \"EUR\", \"value\": 100, \"supplier\": \"S\", "
               "\"received_on\": \"2026-10-01\", \"valid_until\": \"2099-12-31\", \"scope\": \"s\", \"comparability\": \"exact\", \"claimed_quote_type\": \"firm_quote\", \"submitted_by\": \"H\"}") % (pid, fid, "b" * 64)
        eid = psql(name, f"select gf_submit_project_quotation('{sub}'::jsonb, '{ev}'::jsonb)->>'id'").stdout.strip()
        r = psql(name, f"select gf_review_cost_evidence('{{\"evidence_id\": \"{eid}\", \"decision\": \"accepted\", \"basis\": \"firm_quote\", \"comparability\": \"exact\", \"reviewer\": \"R\"}}'::jsonb, '{ev}'::jsonb)", check=False)
        assert r.returncode != 0 and "has not been verified" in r.stderr
    finally:
        drop_database(name)


def test_the_reader_bites_a_dropped_trigger_is_reported():
    name = make_database()
    try:
        psql(name, "drop trigger cost_evidence_review_guard on public.cost_evidence_reviews")
        assert any("cost_evidence_review_guard" in g for g in final_gaps(name))
    finally:
        drop_database(name)
