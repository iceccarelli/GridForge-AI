"""0022_cost_evidence.sql against a REAL PostgreSQL (not the site's in-memory fake, which cannot run a trigger, take an
advisory lock or roll a function back). Every supplier and price is a SYNTHETIC fixture.

Needs a reachable PostgreSQL (psql plus the standard PG* variables, or GRIDFORGE_TEST_PG_URL). Skipped loudly where there
is none; GRIDFORGE_REQUIRE_DB=1 turns that skip into a failure. A skip is a gap in what was checked, not a pass.
"""
import json
import os
import shutil
import subprocess
import threading
import uuid
from pathlib import Path

import pytest

MIGRATIONS = Path(__file__).resolve().parent.parent / "supabase" / "migrations"
BASE = os.environ.get("GRIDFORGE_TEST_PG_URL", "")
REQUIRED = os.environ.get("GRIDFORGE_REQUIRE_DB") == "1"
_NO_DB = shutil.which("psql") is None or not (BASE or os.environ.get("PGHOST"))
pytestmark = pytest.mark.skipif(_NO_DB and not REQUIRED, reason="no PostgreSQL available (set GRIDFORGE_TEST_PG_URL or PGHOST)")

D64 = lambda c: c * 64          # a syntactically valid sha256 hex string


def psql(db, sql=None, file=None, check=True):
    cmd = ["psql", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-X"]
    cmd += [f"{BASE}/{db}"] if BASE else ["-d", db]
    cmd += ["-c", sql] if sql else ["-f", str(file)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if check and r.returncode:
        raise AssertionError(r.stderr)
    return r


@pytest.fixture(scope="module", autouse=True)
def _reachable():
    if REQUIRED:
        assert not _NO_DB, "GRIDFORGE_REQUIRE_DB=1 but psql or PGHOST/GRIDFORGE_TEST_PG_URL is missing"


@pytest.fixture(scope="module")
def db():
    name = f"gf_{uuid.uuid4().hex[:10]}"
    psql("postgres", f"create database {name}")
    psql(name, "create table public.qualifications (id uuid primary key default gen_random_uuid())")
    for f in ("0003_deliverables.sql", "0014_power_deployment_cases.sql", "0015_projects.sql", "0016_project_purchases.sql",
              "0017_project_observations.sql", "0018_supplier_reality.sql", "0019_engagement_deposits.sql",
              "0020_function_privileges.sql", "0022_cost_evidence.sql"):
        psql(name, file=MIGRATIONS / f)
    yield name
    psql("postgres", f"drop database {name}")


def new_deliverable(db, project=False):
    tok = uuid.uuid4().hex
    did = psql(db, f"insert into deliverables (token, kind) values ('{tok}', 'procurement_spec') returning id").stdout.split()[0]
    pid = None
    if project:
        pid = psql(db, f"insert into projects (project_token, project_name) values ('{uuid.uuid4().hex}', 'Hall') returning id").stdout.split()[0]
        psql(db, f"insert into project_links (project_id, object_type, object_id) values ('{pid}', 'deliverable', '{did}')")
    return did, pid


def line(deliverable, **over):
    d = {"deliverable_id": deliverable, "line_digest": uuid.uuid4().hex + uuid.uuid4().hex, "cost_key": "transformer.replacement",
         "unit": "EUR", "value": 2340000, "submitted_value": 2340000, "currency": "EUR", "supplier": "SYNTHETIC-SUPPLIER-A",
         "received_on": "2026-10-01", "valid_until": "2099-12-31", "reference": "SYN-1", "scope": "Replace transformer capacity",
         "quoted_quantity": 23.4, "quoted_quantity_unit": "MVA", "specification": {"hall": "DUB-01"},
         "response_digest": D64("a"), "validation_status": "validated", "problems": [], "limitations": [],
         "comparability": "exact", "synthetic": True}
    d.update(over)
    return d


def sql_json(obj):
    return "'" + json.dumps(obj).replace("'", "''") + "'::jsonb"


EVENT = lambda t: sql_json({"event_type": t, "actor": "test", "payload": {}})


def submit(db, **kw):
    out = psql(db, f"select public.gf_submit_cost_evidence({sql_json(line(kw.pop('deliverable_id'), **kw))}, {EVENT('cost_evidence_received')})").stdout.strip()
    return json.loads(out)


def review(db, evidence_id, decision="accepted", check=True, **over):
    p = {"evidence_id": evidence_id, "decision": decision, "reviewer": "Test Reviewer", "reason": "synthetic review"}
    if decision == "accepted":
        p.update(basis="firm_quote", comparability="exact", includes_keys=[], region="IE")
    p.update(over)
    return psql(db, f"select public.gf_review_cost_evidence({sql_json(p)}, {EVENT('cost_evidence_reviewed')})", check=check)


def state(db, evidence_id):
    return psql(db, f"select state from cost_evidence_state where id = '{evidence_id}'").stdout.strip()


def refused(db, sql, needle):
    r = psql(db, sql, check=False)
    assert r.returncode != 0, f"expected refusal: {sql}"
    assert needle in r.stderr, r.stderr


# --- receipt is not trust ----------------------------------------------------------------------------------------

def test_a_received_line_is_validated_or_invalid_and_never_accepted_by_receipt(db):
    d, _ = new_deliverable(db)
    ok = submit(db, deliverable_id=d)
    bad = submit(db, deliverable_id=d, validation_status="invalid", problems=["currency USD"])
    assert state(db, ok["id"]) == "validated" and state(db, bad["id"]) == "invalid"
    assert psql(db, f"select count(*) from cost_evidence_reviews where evidence_id in ('{ok['id']}','{bad['id']}')").stdout.strip() == "0"


def test_the_same_response_line_submitted_twice_is_one_row(db):
    d, _ = new_deliverable(db)
    payload = line(d)
    q = lambda: json.loads(psql(db, f"select public.gf_submit_cost_evidence({sql_json(payload)}, {EVENT('cost_evidence_received')})").stdout)
    a, b = q(), q()
    assert a["created"] is True and b["created"] is False and a["id"] == b["id"]
    assert psql(db, f"select count(*) from cost_evidence where deliverable_id = '{d}'").stdout.strip() == "1"


def test_an_invalid_line_cannot_be_accepted_but_can_be_rejected(db):
    d, _ = new_deliverable(db)
    bad = submit(db, deliverable_id=d, validation_status="invalid", problems=["unit mismatch"])
    r = review(db, bad["id"], check=False)
    assert r.returncode != 0 and "only a validated quotation line can be accepted" in r.stderr
    assert state(db, bad["id"]) == "invalid"
    review(db, bad["id"], decision="rejected")
    assert state(db, bad["id"]) == "rejected"


def test_an_expired_quotation_cannot_be_accepted(db):
    d, _ = new_deliverable(db)
    e = submit(db, deliverable_id=d, valid_until="2020-01-01")
    r = review(db, e["id"], check=False)
    assert r.returncode != 0 and "expired" in r.stderr and state(db, e["id"]) == "validated"


def test_a_decision_is_made_once_and_never_flipped(db):
    d, _ = new_deliverable(db)
    e = submit(db, deliverable_id=d)
    review(db, e["id"], decision="rejected")
    again = review(db, e["id"], decision="accepted", check=False)
    assert again.returncode != 0 and "already been reviewed" in again.stderr
    assert state(db, e["id"]) == "rejected"


@pytest.mark.parametrize("table,sql", [
    ("cost_evidence", "update cost_evidence set value = 1"),
    ("cost_evidence", "delete from cost_evidence"),
    ("cost_evidence_reviews", "update cost_evidence_reviews set reviewer = 'x'"),
    ("cost_evidence_reviews", "delete from cost_evidence_reviews"),
    ("cost_evidence_retirements", "delete from cost_evidence_retirements"),
    ("cost_evidence_runs", "update cost_evidence_runs set effect = '{}'"),
])
def test_the_evidence_record_is_append_only_even_for_the_service_role(db, table, sql):
    d, _ = new_deliverable(db)
    e = submit(db, deliverable_id=d)
    review(db, e["id"])
    review2 = submit(db, deliverable_id=d)
    review(db, review2["id"])                    # retires the first: every table has a row to attack
    psql(db, f"select public.gf_record_cost_evidence_run({sql_json({'deliverable_id': d, 'intake_digest': D64('1'), 'evidence_digest': D64('2'), 'evidence_ids': [e['id']], 'effect': {}, 'document_sha256': D64('3')})}, {EVENT('cost_evidence_run')})")
    refused(db, sql, "append-only")


@pytest.mark.parametrize("bad", [
    {"value": 0}, {"value": -5}, {"currency": "USD"}, {"quoted_quantity": 0}, {"quoted_quantity_unit": None},
    {"line_digest": "xyz"}, {"cost_key": "NotAKey"}, {"supplier": "  "}, {"validation_status": "maybe"},
    {"validation_status": "validated", "problems": ["x"]}, {"comparability": "great"}, {"scope": ""},
])
def test_a_malformed_line_is_refused_by_the_schema_itself(db, bad):
    d, _ = new_deliverable(db)
    r = psql(db, f"select public.gf_submit_cost_evidence({sql_json(line(d, **bad))}, {EVENT('cost_evidence_received')})", check=False)
    assert r.returncode != 0, bad


def test_an_accepted_review_must_state_what_kind_of_quotation_it_is(db):
    d, _ = new_deliverable(db)
    e = submit(db, deliverable_id=d)
    r = review(db, e["id"], check=False, basis="library_default")
    assert r.returncode != 0 and state(db, e["id"]) == "validated"
    r = review(db, e["id"], check=False, basis=None)
    assert r.returncode != 0 and state(db, e["id"]) == "validated"
    r = review(db, e["id"], check=False, reviewer="  ")
    assert r.returncode != 0


# --- supersession, withdrawal -------------------------------------------------------------------------------------

def test_accepting_a_newer_quote_retires_the_older_one_for_that_key_only(db):
    d, _ = new_deliverable(db)
    old = submit(db, deliverable_id=d)
    other_key = submit(db, deliverable_id=d, cost_key="ups.per_kW", quoted_quantity=9600, quoted_quantity_unit="kW")
    other_hall, _ = new_deliverable(db)
    elsewhere = submit(db, deliverable_id=other_hall)
    for e in (old, other_key, elsewhere):
        review(db, e["id"])
    new = submit(db, deliverable_id=d, supplier="SYNTHETIC-SUPPLIER-B", value=2100000)
    out = json.loads(review(db, new["id"]).stdout)
    assert out["superseded"] == [old["id"]]
    assert state(db, old["id"]) == "superseded" and state(db, new["id"]) == "accepted"
    assert state(db, other_key["id"]) == "accepted" and state(db, elsewhere["id"]) == "accepted"
    assert psql(db, f"select superseded_by from cost_evidence_retirements where evidence_id = '{old['id']}'").stdout.strip() == new["id"]


def test_a_rejected_newer_quote_leaves_the_current_one_alone(db):
    d, _ = new_deliverable(db)
    cur = submit(db, deliverable_id=d)
    review(db, cur["id"])
    worse = submit(db, deliverable_id=d, supplier="SYNTHETIC-SUPPLIER-B")
    review(db, worse["id"], decision="rejected")
    assert state(db, cur["id"]) == "accepted"


def test_failure_between_the_persistence_steps_leaves_nothing_half_done(db):
    """Acceptance retires the old line and then writes the review. If the review is refused, the retirement must go too."""
    d, _ = new_deliverable(db)
    cur = submit(db, deliverable_id=d)
    review(db, cur["id"])
    new = submit(db, deliverable_id=d, supplier="SYNTHETIC-SUPPLIER-B")
    r = review(db, new["id"], check=False, comparability=None)        # violates the review table's own check, AFTER the retirement
    assert r.returncode != 0
    assert state(db, cur["id"]) == "accepted", "the retirement of the previous line must have rolled back"
    assert state(db, new["id"]) == "validated"
    assert psql(db, f"select count(*) from cost_evidence_retirements where evidence_id = '{cur['id']}'").stdout.strip() == "0"


def test_concurrent_acceptances_for_one_key_leave_exactly_one_current(db):
    d, _ = new_deliverable(db)
    ids = [submit(db, deliverable_id=d, supplier=f"SYNTHETIC-SUPPLIER-{c}")["id"] for c in "BCDE"]
    out = []

    def go(i):
        out.append(review(db, i, check=False).returncode)

    ts = [threading.Thread(target=go, args=(i,)) for i in ids]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert out == [0, 0, 0, 0]
    states = sorted(state(db, i) for i in ids)
    assert states.count("accepted") == 1 and states.count("superseded") == 3, states
    # and the chain is coherent: every superseded line points at a line that exists
    assert psql(db, f"select count(*) from cost_evidence_retirements t join cost_evidence e on e.id = t.superseded_by"
                    f" where e.deliverable_id = '{d}'").stdout.strip() == "3"


def test_only_accepted_evidence_can_be_withdrawn_and_then_it_is_not_current(db):
    d, _ = new_deliverable(db)
    e = submit(db, deliverable_id=d)
    nope = psql(db, f"select public.gf_retire_cost_evidence({sql_json({'evidence_id': e['id'], 'retired_by': 'r'})}, {EVENT('cost_evidence_retired')})", check=False)
    assert nope.returncode != 0 and "only accepted evidence" in nope.stderr
    review(db, e["id"])
    psql(db, f"select public.gf_retire_cost_evidence({sql_json({'evidence_id': e['id'], 'retired_by': 'r', 'reason': 'supplier withdrew'})}, {EVENT('cost_evidence_retired')})")
    assert state(db, e["id"]) == "withdrawn"
    again = psql(db, f"select public.gf_retire_cost_evidence({sql_json({'evidence_id': e['id'], 'retired_by': 'r'})}, {EVENT('cost_evidence_retired')})", check=False)
    assert again.returncode != 0


# --- the project record -------------------------------------------------------------------------------------------

def test_events_reach_the_project_only_when_the_engagement_belongs_to_one(db):
    d, pid = new_deliverable(db, project=True)
    e = submit(db, deliverable_id=d)
    review(db, e["id"])
    types = psql(db, f"select event_type from project_events where project_id = '{pid}' order by occurred_at, id").stdout.split()
    assert types == ["cost_evidence_received", "cost_evidence_reviewed"]
    assert psql(db, f"select project_id from cost_evidence where id = '{e['id']}'").stdout.strip() == pid
    d2, _ = new_deliverable(db)
    e2 = submit(db, deliverable_id=d2)
    assert psql(db, f"select project_id is null from cost_evidence where id = '{e2['id']}'").stdout.strip() == "t"


def test_an_evidence_run_is_recorded_once_per_engagement_intake_and_evidence_set(db):
    d, _ = new_deliverable(db)
    e = submit(db, deliverable_id=d)
    p = {"deliverable_id": d, "intake_digest": D64("1"), "evidence_digest": D64("2"), "evidence_ids": [e["id"]],
         "effect": {"capex_delta_eur": -1}, "ignored": [], "document_sha256": D64("3")}
    q = lambda: json.loads(psql(db, f"select public.gf_record_cost_evidence_run({sql_json(p)}, {EVENT('cost_evidence_run')})").stdout)
    a, b = q(), q()
    assert a["created"] is True and b["created"] is False and a["run"]["id"] == b["run"]["id"]
    p2 = dict(p, evidence_digest=D64("9"))
    assert json.loads(psql(db, f"select public.gf_record_cost_evidence_run({sql_json(p2)}, {EVENT('cost_evidence_run')})").stdout)["created"] is True


def test_rls_is_enabled_and_grants_nothing_to_anyone_but_the_service_role(db):
    assert psql(db, "select bool_and(relrowsecurity) from pg_class where relname in ('cost_evidence','cost_evidence_reviews','cost_evidence_retirements','cost_evidence_runs')").stdout.strip() == "t"
    assert psql(db, "select count(*) from pg_policies where tablename like 'cost_evidence%'").stdout.strip() == "0"
