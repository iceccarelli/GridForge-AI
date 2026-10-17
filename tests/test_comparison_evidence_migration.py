"""0026_comparison_quotation_evidence.sql against a real PostgreSQL.

A saved comparison may name the accepted supplier quotations its prices rest on. The site's in-memory mirror cannot run a
trigger, an advisory lock or two connections at once, so it cannot show that the claim is checked in the same
transaction that writes it, that it takes turns with a withdrawal, or that the upgrade leaves every earlier comparison
exactly as it was. This applies the real chain of migrations to a throwaway database and attacks it the way a careless or
hostile service-role caller would.

Every supplier, price and date is a SYNTHETIC fixture. Needs `psql` plus PG* variables (or GRIDFORGE_TEST_PG_URL); skipped,
loudly, where there is none -- a skip is a gap in what was checked. GRIDFORGE_REQUIRE_DB=1 turns the skip into a failure.
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
THIS = "0026_comparison_quotation_evidence.sql"


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


@pytest.fixture(scope="module", autouse=True)
def _database_is_reachable():
    if REQUIRED:
        assert not _NO_DB, "GRIDFORGE_REQUIRE_DB=1 but psql or PGHOST/GRIDFORGE_TEST_PG_URL is missing"


def _fresh(name, upto=None, after=None):
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


def project(db):
    return psql(db, f"insert into projects (project_token, project_name) values ('{uuid.uuid4().hex}', 'Synthetic hall') returning id").stdout.split("\n")[0]


def engagement(db, pid=None):
    d = psql(db, "insert into deliverables (token, kind, status) values ('" + uuid.uuid4().hex + "', 'procurement_spec', 'released') returning id").stdout.split("\n")[0]
    if pid:
        psql(db, f"insert into project_links (project_id, object_type, object_id) values ('{pid}', 'deliverable', '{d}')")
    return d


EVENT = json.dumps({"event_type": "cost_evidence_received", "actor": "t", "occurred_at": "2026-10-01T00:00:00Z", "payload": {}})


def q(s):
    return s.replace("'", "''")


def line(db, deliverable, key="cdu.addition", decision="accepted", synthetic=False, value=317450):
    p = {"deliverable_id": deliverable, "line_digest": h(str(uuid.uuid4())), "cost_key": key, "unit": "EUR", "value": value,
         "submitted_value": value, "currency": "EUR", "supplier": "SYNTHETIC-SUPPLIER-A", "received_on": "2026-10-01",
         "valid_until": "2099-12-31", "reference": "SYN", "scope": "synthetic scope", "specification": {},
         "response_digest": h(str(uuid.uuid4())), "validation_status": "validated", "problems": [], "limitations": [],
         "comparability": "exact", "synthetic": synthetic}
    eid = psql(db, f"select gf_submit_cost_evidence('{q(json.dumps(p))}'::jsonb, '{q(EVENT)}'::jsonb)->>'id'").stdout.strip()
    if decision:
        rv = ({"evidence_id": eid, "decision": "rejected", "reviewer": "R", "reason": "synthetic"} if decision == "rejected" else
              {"evidence_id": eid, "decision": "accepted", "basis": "firm_quote", "comparability": "exact", "includes_keys": [],
               "region": "", "reviewer": "R"})
        psql(db, f"select gf_review_cost_evidence('{q(json.dumps(rv))}'::jsonb, '{q(EVENT)}'::jsonb)")
    return eid


def withdraw_sql(eid):
    p = json.dumps({"evidence_id": eid, "retired_by": "R", "reason": "synthetic"})
    return f"select gf_retire_cost_evidence('{q(p)}'::jsonb, '{q(EVENT)}'::jsonb)"


def save_sql(pid, evidence, digest=None):
    rec = {"project_id": pid, "request": {"intake": {}}, "result": {"schema": "gridforge/ttp-compare/1"}, "schema": "gridforge/ttp-compare/1",
           "request_digest": digest or h(str(uuid.uuid4())), "provenance_digest": h("prov"), "engine_version": "t", "grade": "indicative",
           "evidence_ids": evidence}
    ev = json.dumps({"event_type": "comparison_saved", "actor": "t", "occurred_at": "2026-10-01T00:00:00Z", "payload": {}})
    return f"select gf_save_comparison('{q(json.dumps(rec))}'::jsonb, '{q(ev)}'::jsonb)"


def n(db, sql):
    return int(psql(db, sql).stdout.strip())


def test_the_upgrade_leaves_every_earlier_comparison_exactly_as_it_was():
    name = f"gf_{uuid.uuid4().hex[:10]}"
    try:
        _fresh(name, upto=THIS)                                            # everything before 0026
        pid = project(name)
        psql(name, save_sql(pid, []).replace(', "evidence_ids": []', ""))
        before = psql(name, "select md5(t::text) from (select id, project_id, request, result, request_digest, provenance_digest, engine_version, grade, saved_at from project_comparisons) t").stdout
        assert psql(name, "select count(*) from information_schema.columns where table_name='project_comparisons' and column_name='evidence_ids'").stdout.strip() == "0"
        psql(name, file=MIGRATIONS / THIS)
        psql(name, file=MIGRATIONS / THIS)                                  # idempotent: re-applying changes nothing
        after = psql(name, "select md5(t::text) from (select id, project_id, request, result, request_digest, provenance_digest, engine_version, grade, saved_at from project_comparisons) t").stdout
        assert after == before
        assert psql(name, "select evidence_ids::text from project_comparisons").stdout.strip() == "{}"   # true of every earlier row
    finally:
        psql("postgres", f"drop database if exists {name} with (force)")


def test_a_comparison_names_only_accepted_real_euro_evidence_of_its_own_project(db):
    pid, other = project(db), project(db)
    mine = line(db, engagement(db, pid))
    r = psql(db, save_sql(pid, [mine, mine]))
    assert json.loads(r.stdout.split("\n")[0])["created"] is True
    assert psql(db, f"select evidence_ids::text from project_comparisons where project_id='{pid}'").stdout.strip() == "{" + mine + "}"
    bad = {
        "another project's": line(db, engagement(db, other)),
        "never reviewed": line(db, engagement(db, pid), decision=None),
        "rejected": line(db, engagement(db, pid), decision="rejected"),
        "synthetic": line(db, engagement(db, pid), synthetic=True),
        "not a line": str(uuid.uuid4()),
    }
    for label, eid in bad.items():
        refused(db, save_sql(pid, [eid]), "accepted quotations of its own project")
    # A withdrawn line, a replaced line, and a line whose engagement is no longer linked.
    gone = line(db, engagement(db, pid))
    psql(db, withdraw_sql(gone))
    refused(db, save_sql(pid, [gone]), "accepted quotations of its own project")
    e = engagement(db, pid)
    old = line(db, e)
    line(db, e, value=250000)
    refused(db, save_sql(pid, [old]), "accepted quotations of its own project")
    e2 = engagement(db, pid)
    unlinked = line(db, e2)
    psql(db, f"delete from project_links where object_id = '{e2}'")
    refused(db, save_sql(pid, [unlinked]), "accepted quotations of its own project")
    # Nothing was written by any refusal; one bad line among good ones refuses the whole record.
    assert n(db, f"select count(*) from project_comparisons where project_id='{pid}'") == 1
    refused(db, save_sql(pid, [mine, bad["another project's"]]), "accepted quotations of its own project")
    assert n(db, f"select count(*) from project_events where project_id='{pid}' and event_type='comparison_saved'") == 1


def test_a_new_project_cannot_be_created_with_evidence_it_cannot_have(db):
    other = project(db)
    mine = line(db, engagement(db, other))
    newp = json.dumps({"project_token": uuid.uuid4().hex, "project_name": "never created", "status": "draft"})
    rec = json.dumps({"request": {}, "result": {}, "schema": "s", "request_digest": h("x"), "provenance_digest": h("y"),
                      "engine_version": "t", "grade": "indicative", "evidence_ids": [mine]})
    ev = json.dumps({"event_type": "comparison_saved", "actor": "t", "occurred_at": "2026-10-01T00:00:00Z", "payload": {}})
    created = json.dumps({"event_type": "project_created", "actor": "t", "occurred_at": "2026-10-01T00:00:00Z", "payload": {}})
    refused(db, f"select gf_save_comparison('{q(rec)}'::jsonb, '{q(ev)}'::jsonb, '{q(newp)}'::jsonb, '{q(created)}'::jsonb)", "a new project has no accepted quotations")
    assert n(db, "select count(*) from projects where project_name = 'never created'") == 0


def test_the_evidence_of_a_saved_comparison_cannot_be_edited_or_deleted(db):
    pid = project(db)
    eid = line(db, engagement(db, pid))
    psql(db, save_sql(pid, [eid]))
    refused(db, f"update project_comparisons set evidence_ids = '{{}}' where project_id = '{pid}'", "append-only")
    refused(db, f"delete from project_comparisons where project_id = '{pid}'", "append-only")
    refused(db, "truncate project_comparisons", "append-only")


def test_a_withdrawal_and_a_save_racing_for_one_line_take_turns(db):
    pid = project(db)
    first_saved = refused_save = 0
    for _ in range(8):
        eid = line(db, engagement(db, pid))
        (rc_save, out, err), (rc_ret, _, _) = parallel(db, [save_sql(pid, [eid]), withdraw_sql(eid)])
        assert rc_ret == 0                                                  # an accepted line can always be withdrawn
        if rc_save == 0:
            first_saved += 1
            # Both committed: the save's transaction must have come first (it held the lock before the withdrawal did).
            cx = int(psql(db, f"select xmin::text from project_comparisons where evidence_ids @> array['{eid}']::uuid[]").stdout.strip())
            rx = int(psql(db, f"select xmin::text from cost_evidence_retirements where evidence_id = '{eid}'").stdout.strip())
            assert cx < rx
        else:
            refused_save += 1
            assert "accepted quotations of its own project" in err
            assert n(db, f"select count(*) from project_comparisons where evidence_ids @> array['{eid}']::uuid[]") == 0
    assert first_saved + refused_save == 8


def test_the_save_function_is_still_closed_to_the_api_roles(db):
    for role in ("anon", "authenticated"):
        assert psql(db, f"select has_function_privilege('{role}', 'public.gf_save_comparison(jsonb, jsonb, jsonb, jsonb)', 'execute')").stdout.strip() == "f"
    assert psql(db, "select has_function_privilege('service_role', 'public.gf_save_comparison(jsonb, jsonb, jsonb, jsonb)', 'execute')").stdout.strip() == "t"
