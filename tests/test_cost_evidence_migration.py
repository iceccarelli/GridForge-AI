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
              "0020_function_privileges.sql", "0022_cost_evidence.sql", "0023_cost_evidence_artifacts.sql"):
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


def run_payload(deliverable, accepted, **over):
    """A complete 0023 run record. SYNTHETIC digests; the fingerprint is the identity the database enforces."""
    fp = over.pop("run_fingerprint", uuid.uuid4().hex + uuid.uuid4().hex)
    art = over.pop("artifact_sha256", uuid.uuid4().hex + uuid.uuid4().hex)
    p = {"deliverable_id": deliverable, "identity_version": "gridforge/cost-evidence-run/1", "run_fingerprint": fp,
         "intake_digest": D64("1"), "intake_snapshot": {"hall": {"id": "DUB-01"}}, "accepted_snapshot": [{"evidence_id": i} for i in accepted],
         "accepted_snapshot_digest": D64("4"), "accepted_evidence_ids": accepted, "evidence_digest": D64("2"),
         "evidence_ids": accepted, "effect": {"capex_delta_eur": -1}, "ignored": [],
         "engine_provenance": {"digest": D64("5")}, "engine_fingerprint": D64("5"), "request_options": {"endpoint": "/v1/study"},
         "report_date": "2026-10-13", "document_sha256": art,
         "artifact_storage_ref": f"cost-evidence-artifacts/{deliverable}/{fp}/{art}.html", "artifact_sha256": art,
         "artifact_bytes": 1234, "artifact_media_type": "text/html; charset=utf-8"}
    p.update(over)
    return p


def record(db, p):
    return json.loads(psql(db, f"select public.gf_record_cost_evidence_run({sql_json(p)}, {EVENT('cost_evidence_run')})").stdout)


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
    record(db, run_payload(d, [e["id"]]))
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


def test_an_invalid_line_may_lack_what_made_it_invalid_but_cannot_become_evidence(db):
    d, _ = new_deliverable(db)
    e = submit(db, deliverable_id=d, value=None, submitted_value=None, currency="USD", received_on=None,
               validation_status="invalid", problems=["currency USD", "no price"])
    assert state(db, e["id"]) == "invalid"
    refused(db, f"select public.gf_review_cost_evidence({sql_json({'evidence_id': e['id'], 'decision': 'accepted', 'reviewer': 'R', 'basis': 'firm_quote', 'comparability': 'exact'})}, {EVENT('cost_evidence_reviewed')})",
            "only a validated")


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


def test_an_evidence_run_is_recorded_once_per_run_fingerprint(db):
    d, _ = new_deliverable(db)
    e = submit(db, deliverable_id=d)
    p = run_payload(d, [e["id"]])
    a, b = record(db, p), record(db, p)
    assert a["created"] is True and b["created"] is False and a["run"]["id"] == b["run"]["id"]
    # Same intake digest AND same USED-evidence digest, different engine: 0022 would have collided; now it is a new run.
    p2 = run_payload(d, [e["id"]], engine_fingerprint=D64("6"), engine_provenance={"digest": D64("6")})
    c = record(db, p2)
    assert c["created"] is True and c["run"]["id"] != a["run"]["id"]
    assert c["run"]["intake_digest"] == a["run"]["intake_digest"] and c["run"]["evidence_digest"] == a["run"]["evidence_digest"]


def test_an_existing_identity_returns_the_existing_record_and_never_a_second_event_or_artifact(db):
    d, proj = new_deliverable(db, project=True)
    e = submit(db, deliverable_id=d)
    first = record(db, run_payload(d, [e["id"]], run_fingerprint=D64("a"), artifact_sha256=D64("b")))
    replay = record(db, run_payload(d, [e["id"]], run_fingerprint=D64("a"), artifact_sha256=D64("c")))   # a different candidate
    assert first["created"] is True and replay["created"] is False
    assert replay["run"]["artifact_sha256"] == D64("b") == first["run"]["artifact_sha256"]
    assert replay["run"]["artifact_storage_ref"] == first["run"]["artifact_storage_ref"]
    assert psql(db, f"select count(*) from cost_evidence_runs where deliverable_id = '{d}'").stdout.strip() == "1"
    assert psql(db, f"select count(*) from project_events where project_id = '{proj}' and event_type = 'cost_evidence_run'").stdout.strip() == "1"


def test_concurrent_recordings_of_one_identity_leave_one_row_and_one_event(db):
    d, proj = new_deliverable(db, project=True)
    e = submit(db, deliverable_id=d)
    out = []
    def go(art):
        out.append(record(db, run_payload(d, [e["id"]], run_fingerprint=D64("d"), artifact_sha256=art)))
    ts = [threading.Thread(target=go, args=(D64(c),)) for c in "1234567"]
    [t.start() for t in ts]; [t.join() for t in ts]
    assert sorted(o["created"] for o in out).count(True) == 1
    winner = [o for o in out if o["created"]][0]["run"]
    assert {o["run"]["id"] for o in out} == {winner["id"]}
    assert {o["run"]["artifact_sha256"] for o in out} == {winner["artifact_sha256"]}
    assert psql(db, f"select count(*) from cost_evidence_runs where deliverable_id = '{d}'").stdout.strip() == "1"
    assert psql(db, f"select count(*) from project_events where project_id = '{proj}' and event_type = 'cost_evidence_run'").stdout.strip() == "1"


@pytest.mark.parametrize("field", ["identity_version", "intake_snapshot", "accepted_snapshot", "accepted_snapshot_digest",
                                   "accepted_evidence_ids", "engine_provenance", "engine_fingerprint", "request_options",
                                   "report_date", "artifact_storage_ref", "artifact_sha256", "artifact_bytes",
                                   "artifact_media_type", "document_sha256"])
def test_a_versioned_run_without_complete_metadata_is_refused_by_the_database(db, field):
    d, _ = new_deliverable(db)
    e = submit(db, deliverable_id=d)
    bad = run_payload(d, [e["id"]])
    bad[field] = None
    r = psql(db, f"select public.gf_record_cost_evidence_run({sql_json(bad)}, {EVENT('cost_evidence_run')})", check=False)
    assert r.returncode != 0, f"{field} may not be missing from a versioned run"
    assert psql(db, f"select count(*) from cost_evidence_runs where deliverable_id = '{d}'").stdout.strip() == "0"


@pytest.mark.parametrize("over", [{"artifact_bytes": 0}, {"artifact_sha256": "nothex"}, {"engine_fingerprint": "short"},
                                  {"artifact_storage_ref": ""}, {"accepted_evidence_ids": []},
                                  {"document_sha256": D64("9"), "artifact_sha256": D64("8")}])
def test_a_versioned_run_with_malformed_metadata_is_refused(db, over):
    d, _ = new_deliverable(db)
    e = submit(db, deliverable_id=d)
    r = psql(db, f"select public.gf_record_cost_evidence_run({sql_json(run_payload(d, [e['id']], **over))}, {EVENT('cost_evidence_run')})", check=False)
    assert r.returncode != 0


def test_used_evidence_must_be_part_of_the_accepted_snapshot(db):
    d, _ = new_deliverable(db)
    e = submit(db, deliverable_id=d)
    other = submit(db, deliverable_id=d)
    r = psql(db, f"select public.gf_record_cost_evidence_run({sql_json(run_payload(d, [e['id']], evidence_ids=[other['id']]))}, {EVENT('cost_evidence_run')})", check=False)
    assert r.returncode != 0
    ok = record(db, run_payload(d, [e["id"], other["id"]], evidence_ids=[e["id"]]))      # offered two, used one: allowed
    assert ok["created"] is True


def test_a_run_without_a_fingerprint_can_no_longer_be_recorded(db):
    d, _ = new_deliverable(db)
    e = submit(db, deliverable_id=d)
    legacy = {"deliverable_id": d, "intake_digest": D64("1"), "evidence_digest": D64("2"), "evidence_ids": [e["id"]], "effect": {}, "document_sha256": D64("3")}
    assert psql(db, f"select public.gf_record_cost_evidence_run({sql_json(legacy)}, {EVENT('cost_evidence_run')})", check=False).returncode != 0


def test_run_rows_stay_append_only_including_the_new_columns(db):
    d, _ = new_deliverable(db)
    e = submit(db, deliverable_id=d)
    record(db, run_payload(d, [e["id"]]))
    refused(db, f"update cost_evidence_runs set artifact_sha256 = '{D64('f')}', document_sha256 = '{D64('f')}' where deliverable_id = '{d}'", "append-only")
    refused(db, f"delete from cost_evidence_runs where deliverable_id = '{d}'", "append-only")


def test_the_state_view_exposes_retirement_reason_and_person(db):
    d, _ = new_deliverable(db)
    e = submit(db, deliverable_id=d)
    review(db, e["id"])
    psql(db, f"select public.gf_retire_cost_evidence({sql_json({'evidence_id': e['id'], 'retired_by': 'Test Person', 'reason': 'retracted'})}, {EVENT('cost_evidence_retired')})")
    row = psql(db, f"select state, retired_by, retirement_reason from cost_evidence_state where id = '{e['id']}'").stdout.strip()
    assert row == "withdrawn|Test Person|retracted"


def test_rls_is_enabled_and_grants_nothing_to_anyone_but_the_service_role(db):
    assert psql(db, "select bool_and(relrowsecurity) from pg_class where relname in ('cost_evidence','cost_evidence_reviews','cost_evidence_retirements','cost_evidence_runs')").stdout.strip() == "t"
    assert psql(db, "select count(*) from pg_policies where tablename like 'cost_evidence%'").stdout.strip() == "0"


# ----------------------------------------------------------------------------------------------- upgrading a database
# that already holds 0022 runs. This is the case production is in: runs recorded without a document.

CHAIN_TO_0022 = ("0003_deliverables.sql", "0014_power_deployment_cases.sql", "0015_projects.sql", "0016_project_purchases.sql",
                 "0017_project_observations.sql", "0018_supplier_reality.sql", "0019_engagement_deposits.sql",
                 "0020_function_privileges.sql", "0022_cost_evidence.sql")


@pytest.fixture(scope="module")
def upgraded():
    name = f"gf_{uuid.uuid4().hex[:10]}"
    psql("postgres", f"create database {name}")
    psql(name, "create table public.qualifications (id uuid primary key default gen_random_uuid())")
    for f in CHAIN_TO_0022:
        psql(name, file=MIGRATIONS / f)
    d, proj = new_deliverable(name, project=True)
    e = submit(name, deliverable_id=d)
    review(name, e["id"])
    old_run = {"deliverable_id": d, "intake_digest": D64("1"), "evidence_digest": D64("2"), "evidence_ids": [e["id"]],
               "effect": {"capex_delta_eur": -5}, "ignored": [{"key": "x", "reason": "expired"}], "document_sha256": D64("3")}
    made = json.loads(psql(name, f"select public.gf_record_cost_evidence_run({sql_json(old_run)}, {EVENT('cost_evidence_run')})").stdout)
    before = json.loads(psql(name, f"select to_jsonb(r) from cost_evidence_runs r where id = '{made['run']['id']}'").stdout)
    evidence_before = psql(name, "select md5(string_agg(to_jsonb(e)::text, '' order by id)) from cost_evidence e").stdout.strip()
    events_before = psql(name, "select count(*) from project_events").stdout.strip()
    psql(name, file=MIGRATIONS / "0023_cost_evidence_artifacts.sql")
    yield {"db": name, "d": d, "proj": proj, "e": e, "before": before, "evidence_before": evidence_before, "events_before": events_before}
    psql("postgres", f"drop database {name}")


def test_upgrade_keeps_every_historical_run_exactly_and_marks_it_legacy_without_an_artifact(upgraded):
    db, before = upgraded["db"], upgraded["before"]
    after = json.loads(psql(db, f"select to_jsonb(r) from cost_evidence_runs r where id = '{before['id']}'").stdout)
    for k, v in before.items():
        assert after[k] == v, f"historical column {k} changed"
    for k in ("run_fingerprint", "identity_version", "accepted_snapshot", "accepted_snapshot_digest", "accepted_evidence_ids",
              "engine_provenance", "engine_fingerprint", "request_options", "report_date", "intake_snapshot",
              "artifact_storage_ref", "artifact_sha256", "artifact_bytes", "artifact_media_type"):
        assert after[k] is None, f"{k} was fabricated for a legacy run"
    assert psql(db, "select md5(string_agg(to_jsonb(e)::text, '' order by id)) from cost_evidence e").stdout.strip() == upgraded["evidence_before"]
    assert psql(db, "select count(*) from project_events").stdout.strip() == upgraded["events_before"]


def test_after_upgrade_history_is_still_protected_and_legacy_rows_cannot_gain_an_artifact(upgraded):
    db, rid = upgraded["db"], upgraded["before"]["id"]
    refused(db, f"update cost_evidence_runs set artifact_storage_ref = 'cost-evidence-artifacts/x' where id = '{rid}'", "append-only")
    refused(db, f"delete from cost_evidence_runs where id = '{rid}'", "append-only")
    # A legacy-shaped row cannot claim an artifact, and a second identical legacy row is still refused.
    r = psql(db, f"insert into cost_evidence_runs (deliverable_id, intake_digest, evidence_digest, evidence_ids, effect, document_sha256, artifact_storage_ref) "
                 f"values ('{upgraded['d']}', '{D64('7')}', '{D64('8')}', '{{}}', '{{}}', '{D64('9')}', 'cost-evidence-artifacts/x')", check=False)
    assert r.returncode != 0
    r = psql(db, f"insert into cost_evidence_runs (deliverable_id, intake_digest, evidence_digest, evidence_ids, effect, document_sha256) "
                 f"values ('{upgraded['d']}', '{D64('1')}', '{D64('2')}', '{{}}', '{{}}', '{D64('9')}')", check=False)
    assert r.returncode != 0


def test_after_upgrade_a_new_run_with_the_old_intake_and_used_evidence_is_a_distinct_versioned_run(upgraded):
    db, d, e = upgraded["db"], upgraded["d"], upgraded["e"]
    new = record(db, run_payload(d, [e["id"]]))          # the SAME intake_digest and evidence_digest as the legacy run
    assert new["created"] is True and new["run"]["id"] != upgraded["before"]["id"]
    assert psql(db, f"select count(*) filter (where run_fingerprint is null), count(*) filter (where run_fingerprint is not null) from cost_evidence_runs where deliverable_id = '{d}'").stdout.strip() == "1|1"
    assert psql(db, f"select count(*) from project_events where project_id = '{upgraded['proj']}' and event_type = 'cost_evidence_run'").stdout.strip() == "2"


def test_after_upgrade_the_old_unfingerprinted_call_is_refused_and_the_view_still_works(upgraded):
    db, d, e = upgraded["db"], upgraded["d"], upgraded["e"]
    old = {"deliverable_id": d, "intake_digest": D64("e"), "evidence_digest": D64("f"), "evidence_ids": [e["id"]], "effect": {}, "document_sha256": D64("3")}
    assert psql(db, f"select public.gf_record_cost_evidence_run({sql_json(old)}, {EVENT('cost_evidence_run')})", check=False).returncode != 0
    assert psql(db, f"select state from cost_evidence_state where id = '{e['id']}'").stdout.strip() == "accepted"
