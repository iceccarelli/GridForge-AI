"""0054_project_quotation_claims.sql against a real PostgreSQL.

A supplier quotation a project holder attaches to an uploaded document becomes cost evidence only when its FILE has been verified (0048) and
the RECORD accepted (0022). The site's in-memory mirror cannot run a trigger, an advisory lock or two connections at once, so this applies the
real chain to a throwaway database and attacks it the way a careless or hostile service-role caller would.

Every supplier, price and date is a SYNTHETIC fixture. Needs `psql` plus PG* variables (or GRIDFORGE_TEST_PG_URL); skipped, loudly, where there
is none. GRIDFORGE_REQUIRE_DB=1 turns the skip into a failure.
"""
import hashlib
import json
import os
import shutil
import subprocess
import uuid
from pathlib import Path

import pytest

MIGRATIONS = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
BASE = os.environ.get("GRIDFORGE_TEST_PG_URL", "")
REQUIRED = os.environ.get("GRIDFORGE_REQUIRE_DB") == "1"
_NO_DB = shutil.which("psql") is None or not (BASE or os.environ.get("PGHOST"))
pytestmark = pytest.mark.skipif(_NO_DB and not REQUIRED, reason="no PostgreSQL available (set GRIDFORGE_TEST_PG_URL or PGHOST)")
THIS = "0054_project_quotation_claims.sql"
BIDI = chr(0x202E)


def _cmd(db):
    return ["psql", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-X"] + ([f"{BASE}/{db}"] if BASE else ["-d", db])


def psql(db, sql=None, file=None, check=True):
    cmd = _cmd(db) + (["-c", sql] if sql else ["-f", str(file)])
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode:
        raise AssertionError(r.stderr)
    return r


def parallel(db, statements):
    procs = [subprocess.Popen(_cmd(db) + ["-c", s], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) for s in statements]
    out = []
    for p in procs:
        so, se = p.communicate()
        out.append((p.returncode, so.strip(), se))
    return out


def refused(db, sql, needle):
    r = psql(db, sql, check=False)
    assert r.returncode != 0, f"expected refusal: {sql}"
    assert needle in r.stderr, r.stderr


def _fresh(name, upto=False):
    psql("postgres", f"create database {name}")
    psql(name, "create extension if not exists pgcrypto")
    psql(name, "create schema if not exists storage;"
               "create table if not exists storage.buckets (id text primary key, name text, public boolean)")
    for role in ("anon", "authenticated", "service_role"):
        psql("postgres", f"do $$ begin if not exists (select 1 from pg_roles where rolname = '{role}') "
                         f"then create role {role} nologin; end if; end $$")
    for f in sorted(MIGRATIONS.glob("*.sql")):
        if f.name == THIS and upto:
            return
        psql(name, file=f)


@pytest.fixture(scope="module")
def db():
    name = f"gf_{uuid.uuid4().hex[:10]}"
    _fresh(name)
    yield name
    psql("postgres", f"drop database {name} with (force)")


def h(s):
    return hashlib.sha256(s.encode()).hexdigest()


def q(s):
    return s.replace("'", "''")


def n(db, sql):
    return int(psql(db, sql).stdout.strip())


def project(db):
    return psql(db, f"insert into projects (project_token, project_name) values ('{uuid.uuid4().hex}', 'Synthetic hall') returning id").stdout.split("\n")[0]


def file(db, pid, verified=False):
    digest = h(str(uuid.uuid4()))
    fid = psql(db, "insert into project_evidence (project_id, filename, media_type, sha256, byte_size, storage_ref, source_category) "
                   f"values ('{pid}', 'q.pdf', 'application/pdf', '{digest}', 10, 'project-evidence/{pid}/{digest}-q.pdf', 'supplier_document') returning id").stdout.split("\n")[0]
    if verified:
        verify(db, fid, digest)
    return fid


def verify(db, fid, digest):
    p = json.dumps({"evidence_id": fid, "decision": "verified", "reviewer": "F", "reason": "ok", "sha256_confirmed": digest})
    psql(db, f"select gf_review_evidence('{q(p)}'::jsonb, '{q(EVENT)}'::jsonb)")


EVENT = json.dumps({"event_type": "cost_evidence_received", "actor": "t", "occurred_at": "2026-10-01T00:00:00Z", "payload": {}})


def claim(pid, fid, **over):
    p = {"project_id": pid, "source_file_id": fid, "line_digest": h(str(uuid.uuid4())), "cost_key": "cdu.addition", "unit": "EUR", "value": 317450,
         "supplier": "SYNTHETIC-SUPPLIER-A", "received_on": "2026-10-01", "valid_until": "2099-12-31", "scope": "synthetic scope",
         "comparability": "exact", "claimed_quote_type": "firm_quote", "submitted_by": "A. Holder", "lead_time_weeks": 26}
    p.update(over)
    return p


def submit_sql(p):
    return f"select gf_submit_project_quotation('{q(json.dumps(p))}'::jsonb, '{q(EVENT)}'::jsonb)"


def submit(db, p):
    return json.loads(psql(db, submit_sql(p)).stdout.split("\n")[0])


def review_sql(eid, decision="accepted", **over):
    p = {"evidence_id": eid, "decision": decision, "reviewer": "R"}
    if decision == "accepted":
        p.update({"basis": "firm_quote", "comparability": "exact", "includes_keys": [], "region": ""})
    p.update(over)
    return f"select gf_review_cost_evidence('{q(json.dumps(p))}'::jsonb, '{q(EVENT)}'::jsonb)"


def state(db, eid):
    return psql(db, f"select state from cost_evidence_state where id='{eid}'").stdout.strip()


def test_the_upgrade_leaves_every_engagement_quotation_exactly_as_it_was_and_the_view_keeps_its_columns():
    name = f"gf_{uuid.uuid4().hex[:10]}"
    try:
        _fresh(name, upto=True)                                             # everything before 0054
        before_cols = psql(name, "select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) from information_schema.columns where table_name='cost_evidence_state'").stdout.strip()
        d = psql(name, "insert into deliverables (token, kind, status, intake) values ('" + uuid.uuid4().hex + "', 'procurement_spec', 'released', '{\"_gridforge\": {\"review\": {\"by\": \"A. Reviewer\"}}}') returning id").stdout.split("\n")[0]
        legacy = {"deliverable_id": d, "line_digest": h("legacy"), "cost_key": "cdu.addition", "unit": "EUR", "value": 100, "submitted_value": 100, "currency": "EUR",
                  "supplier": "SYNTHETIC-SUPPLIER-A", "received_on": "2026-10-01", "valid_until": "2099-12-31", "scope": "s", "specification": {},
                  "response_digest": h("r"), "validation_status": "validated", "problems": [], "limitations": [], "comparability": "exact", "synthetic": False}
        eid = psql(name, f"select gf_submit_cost_evidence('{q(json.dumps(legacy))}'::jsonb, '{q(EVENT)}'::jsonb)->>'id'").stdout.strip()
        snap = "select md5(t::text) from (select id, deliverable_id, project_id, line_digest, cost_key, unit, value, supplier, received_on, valid_until, state from cost_evidence_state) t"
        before = psql(name, snap).stdout
        psql(name, file=MIGRATIONS / THIS)
        psql(name, file=MIGRATIONS / THIS)                                  # idempotent
        assert psql(name, snap).stdout == before
        after_cols = psql(name, "select string_agg(column_name || ':' || data_type, ',' order by ordinal_position) from information_schema.columns where table_name='cost_evidence_state'").stdout.strip()
        assert after_cols.startswith(before_cols + ",")                     # appended only: no existing column moved, renamed or retyped
        assert after_cols[len(before_cols) + 1:] == "source_file_id:uuid,claimed_quote_type:text,lead_time_weeks:numeric,notes:text,submitted_by:text"
        # the engagement flow still works: accept, supersede, withdraw
        psql(name, review_sql(eid))
        assert state(name, eid) == "accepted"
        legacy2 = dict(legacy, line_digest=h("legacy2"), value=90)
        eid2 = psql(name, f"select gf_submit_cost_evidence('{q(json.dumps(legacy2))}'::jsonb, '{q(EVENT)}'::jsonb)->>'id'").stdout.strip()
        psql(name, review_sql(eid2))
        assert state(name, eid) == "superseded" and state(name, eid2) == "accepted"
        psql(name, f"select gf_retire_cost_evidence('{q(json.dumps({'evidence_id': eid2, 'retired_by': 'R'}))}'::jsonb, '{q(EVENT)}'::jsonb)")
        assert state(name, eid2) == "withdrawn"
    finally:
        psql("postgres", f"drop database if exists {name} with (force)")


def test_a_claim_is_stored_unverified_tied_to_its_file_and_the_same_claim_twice_is_one_line(db):
    pid = project(db)
    fid = file(db, pid)
    p = claim(pid, fid)
    first = submit(db, p)
    assert first["created"] is True
    assert submit(db, p) == {"created": False, "id": first["id"]}
    assert n(db, f"select count(*) from cost_evidence where project_id='{pid}'") == 1
    assert n(db, f"select count(*) from project_events where project_id='{pid}' and event_type='cost_evidence_received'") == 1
    row = psql(db, f"select state, source_file_id::text, deliverable_id is null, response_digest = (select sha256 from project_evidence where id='{fid}'), lead_time_weeks, synthetic "
                   f"from cost_evidence_state where id='{first['id']}'").stdout.strip()
    assert row == f"validated|{fid}|t|t|26|f"


def test_a_quotation_is_accepted_only_on_a_file_a_person_verified_with_a_matching_digest(db):
    pid = project(db)
    unverified = file(db, pid)
    a = submit(db, claim(pid, unverified))["id"]
    refused(db, review_sql(a), "file has not been verified")
    assert state(db, a) == "validated"
    # a rejection never needs the file
    b = submit(db, claim(pid, unverified, cost_key="plant.uprate"))["id"]
    psql(db, review_sql(b, "rejected"))
    assert state(db, b) == "rejected"
    # verified through the one door (gf_review_evidence)
    ok = file(db, pid, verified=True)
    c = submit(db, claim(pid, ok))["id"]
    psql(db, review_sql(c))
    assert state(db, c) == "accepted"
    # a file marked verified by a raw update has NO decision row: it does not count (the owner bypasses the guard here on purpose)
    raw = file(db, pid)
    d = submit(db, claim(pid, raw, cost_key="busway.replacement"))["id"]
    psql(db, "alter table project_evidence disable trigger project_evidence_guard;"
             f"update project_evidence set review_status='verified' where id='{raw}';"
             "alter table project_evidence enable trigger project_evidence_guard")
    refused(db, review_sql(d), "file has not been verified")
    # a rejected file cannot back a new claim
    rej = file(db, pid)
    psql(db, f"select gf_review_evidence('{q(json.dumps({'evidence_id': rej, 'decision': 'rejected', 'reviewer': 'F', 'reason': 'no'}))}'::jsonb, '{q(EVENT)}'::jsonb)")
    refused(db, submit_sql(claim(pid, rej)), "was reviewed and rejected")


def test_a_claim_cannot_cite_another_projects_file_or_an_expired_or_inverted_validity(db):
    a, b = project(db), project(db)
    theirs = file(db, b)
    refused(db, submit_sql(claim(a, theirs)), "not part of this project")
    mine = file(db, a)
    refused(db, submit_sql(claim(a, mine, valid_until="2020-01-01")), "already expired")
    refused(db, submit_sql(claim(a, mine, received_on="2098-01-01", valid_until="2097-01-01")), "earlier than the quotation date")
    assert n(db, f"select count(*) from cost_evidence where project_id in ('{a}','{b}')") == 0


@pytest.mark.parametrize("over,needle", [
    ({"supplier": "ACME" + BIDI + "SYN"}, "cost_evidence_origin"),
    ({"scope": "a\nb"}, "cost_evidence_origin"),
    ({"lead_time_weeks": 521}, "cost_evidence_origin"),
    ({"lead_time_weeks": 0}, "cost_evidence_origin"),
    ({"claimed_quote_type": "contracted"}, "cost_evidence_origin"),
    ({"submitted_by": "   "}, "cost_evidence_origin"),
    ({"notes": "x" * 1001}, "cost_evidence_origin"),
    ({"value": 1e10}, "cost_evidence_origin"),
    ({"value": 0}, "violates check constraint"),
])
def test_the_database_refuses_a_claim_the_site_would_have_refused(db, over, needle):
    pid = project(db)
    fid = file(db, pid)
    refused(db, submit_sql(claim(pid, fid, **over)), needle)
    assert n(db, f"select count(*) from cost_evidence where project_id='{pid}'") == 0


def test_a_line_is_either_an_engagement_line_or_a_project_line_never_both_or_neither(db):
    pid = project(db)
    fid = file(db, pid)
    d = psql(db, "insert into deliverables (token, kind, status, intake) values ('" + uuid.uuid4().hex + "', 'procurement_spec', 'released', '{\"_gridforge\": {\"review\": {\"by\": \"A. Reviewer\"}}}') returning id").stdout.split("\n")[0]
    base = ("insert into cost_evidence (deliverable_id, project_id, source_file_id, line_digest, cost_key, unit, value, currency, supplier, received_on, valid_until, scope, "
            "specification, response_digest, validation_status, comparability, claimed_quote_type, submitted_by) values ")
    both = f"({'$$' + d + '$$'}::uuid, '{pid}', '{fid}', '{h('x1')}', 'cdu.addition', 'EUR', 5, 'EUR', 's', '2026-10-01', '2099-01-01', 's', '{{}}', '{h('r')}', 'validated', 'exact', 'firm_quote', 'x')"
    neither = f"(null, '{pid}', null, '{h('x2')}', 'cdu.addition', 'EUR', 5, 'EUR', 's', '2026-10-01', '2099-01-01', 's', '{{}}', '{h('r')}', 'validated', 'exact', null, null)"
    refused(db, base + both, "cost_evidence_origin")
    refused(db, base + neither, "cost_evidence_origin")


def test_the_lifecycle_rows_stay_append_only_for_a_project_line(db):
    pid = project(db)
    fid = file(db, pid, verified=True)
    eid = submit(db, claim(pid, fid))["id"]
    psql(db, review_sql(eid))
    refused(db, f"update cost_evidence set value = 1 where id = '{eid}'", "append-only")
    refused(db, f"delete from cost_evidence where id = '{eid}'", "append-only")
    refused(db, f"update cost_evidence_reviews set decision = 'rejected' where evidence_id = '{eid}'", "append-only")
    refused(db, review_sql(eid, "rejected"), "already been reviewed")


def test_two_reviewers_accepting_project_quotations_for_one_item_take_turns(db):
    pid = project(db)
    f1, f2 = file(db, pid, verified=True), file(db, pid, verified=True)
    a = submit(db, claim(pid, f1))["id"]
    b = submit(db, claim(pid, f2, value=250000))["id"]
    results = parallel(db, [review_sql(a, reviewer="R1"), review_sql(b, reviewer="R2")])
    assert all(code == 0 for code, _, _ in results), [e for _, _, e in results]
    states = sorted([state(db, a), state(db, b)])
    assert states == ["accepted", "superseded"]                             # exactly one accepted line per (project, item) is current
    assert n(db, f"select count(*) from cost_evidence_state where project_id='{pid}' and cost_key='cdu.addition' and state='accepted'") == 1


def test_a_project_quotation_of_another_item_or_project_does_not_retire_it(db):
    a, b = project(db), project(db)
    fa, fb = file(db, a, verified=True), file(db, b, verified=True)
    keep = submit(db, claim(a, fa))["id"]
    psql(db, review_sql(keep))
    other = submit(db, claim(a, file(db, a, verified=True), cost_key="plant.uprate"))["id"]
    psql(db, review_sql(other))
    theirs = submit(db, claim(b, fb))["id"]
    psql(db, review_sql(theirs))
    assert [state(db, x) for x in (keep, other, theirs)] == ["accepted"] * 3


def save_sql(pid, evidence):
    rec = {"project_id": pid, "request": {"intake": {}}, "result": {"schema": "gridforge/ttp-compare/1"}, "schema": "gridforge/ttp-compare/1",
           "request_digest": h(str(uuid.uuid4())), "provenance_digest": h("prov"), "engine_version": "t", "grade": "indicative", "evidence_ids": evidence}
    ev = json.dumps({"event_type": "comparison_saved", "actor": "t", "occurred_at": "2026-10-01T00:00:00Z", "payload": {}})
    return f"select gf_save_comparison('{q(json.dumps(rec))}'::jsonb, '{q(ev)}'::jsonb)"


def test_a_saved_comparison_may_rest_on_an_accepted_project_quotation_of_its_own_project_only(db):
    a, b = project(db), project(db)
    mine = submit(db, claim(a, file(db, a, verified=True)))["id"]
    unaccepted = submit(db, claim(a, file(db, a, verified=True), cost_key="plant.uprate"))["id"]
    theirs = submit(db, claim(b, file(db, b, verified=True)))["id"]
    psql(db, review_sql(mine))
    psql(db, review_sql(theirs))
    assert json.loads(psql(db, save_sql(a, [mine])).stdout.split("\n")[0])["created"] is True
    for label, eid in {"not accepted": unaccepted, "another project's": theirs}.items():
        refused(db, save_sql(a, [eid]), "accepted quotations of its own project")
    psql(db, f"select gf_retire_cost_evidence('{q(json.dumps({'evidence_id': mine, 'retired_by': 'R'}))}'::jsonb, '{q(EVENT)}'::jsonb)")
    refused(db, save_sql(a, [mine]), "accepted quotations of its own project")


def test_the_new_function_is_service_role_only(db):
    for role in ("anon", "authenticated"):
        assert psql(db, f"select has_function_privilege('{role}', 'public.gf_submit_project_quotation(jsonb, jsonb)', 'execute')").stdout.strip() == "f"
        assert psql(db, f"select has_table_privilege('{role}', 'public.cost_evidence_state', 'select')").stdout.strip() == "f"
    assert psql(db, "select has_function_privilege('service_role', 'public.gf_submit_project_quotation(jsonb, jsonb)', 'execute')").stdout.strip() == "t"


def test_a_hall_figure_of_origin_quotation_cites_the_same_file_row(db):
    pid = project(db)
    fid = file(db, pid)
    submit(db, claim(pid, fid))
    actor = f"owner-{uuid.uuid4().hex[:8]}@example.test"
    org = json.loads(psql(db, f"select gf_create_org('{actor}', 'Org Q')").stdout.split("\n")[0])["org_id"]
    site = json.loads(psql(db, f"select gf_create_site('{actor}', '{org}', 'Site Q', 'IE', 'synthetic')").stdout.split("\n")[0])["site_id"]
    hall = json.loads(psql(db, f"select gf_create_hall('{actor}', '{site}', 'Hall Q')").stdout.split("\n")[0])["hall_id"]
    token = psql(db, f"select project_token from projects where id='{pid}'").stdout.strip()
    psql(db, f"select gf_attach_project_to_hall('{actor}', '{hall}', '{token}')")
    out = json.loads(psql(db, f"select gf_record_hall_input('{actor}', '{hall}', 'plant.cdu_quote_eur', '317450'::jsonb, 'EUR', 'E3', 'quotation', '{fid}', null, '2026-10-01')").stdout.split("\n")[0])
    assert out["ok"] is True and out["input"]["source"]["id"] == fid
    assert n(db, f"select count(*) from project_evidence where project_id='{pid}'") == 1
