"""The ledger gate, end to end, as a truth table: calibration_ledger_rows against a REAL PostgreSQL.

An observation may feed the shared calibration ledger only when ALL FIVE of these hold:

  F  the evidence file is verified            (0048: gf_review_evidence, confirming the stored digest)
  O  the observation is verified              (0038: a reviewer who is not the submitter, E5)
  P  its data origin is 'production'          (0047)
  C  its project's LATEST permission is a grant (0047: a revocation is a newer row)
  T  the forecast predates the outcome        (0046: the case revision was created before the observed date)

All 32 combinations are built through the real functions (each condition made false the way it can really go false, including by
out-of-band edits the guards would refuse, applied with row triggers off so the VIEW is shown to hold on its own), and the view must return
exactly one row for the one combination where all five hold and none for the other 31. Every value is a SYNTHETIC fixture.
"""
import itertools
import json

import pytest

from calibration_pg_rig import (
    GOOD, bypassing_triggers, database_fixture, export_rows, new_case, new_evidence, new_project, obs_args, psql, record_permission, review,
    scalar, skip_without_db,
)

pytestmark = skip_without_db
db = database_fixture()

NAMES = ("F_file_verified", "O_observation_verified", "P_production_origin", "C_permission_granted", "T_forecast_before_outcome")


def build(db, F, O, P, C, T):
    """One observation with exactly the given truth values; returns (observation id, project id)."""
    project = new_project(db, site=f"Site {F}{O}{P}{C}{T}")
    # T: a forecast made before the outcome (observed 2026-06-30) or after it (created a week later)
    case = new_case(db, created_at="2026-03-02T09:00:00Z" if T else "2026-07-07T09:00:00Z")
    ev = new_evidence(db, project, verified=True)                       # verified first: an observation can only be verified against a verified file
    args = obs_args(project, ev, case, data_origin="production" if P else "test")
    sql = f"select gf_submit_observation('{args}'::jsonb, '{GOOD % 'observation_submitted'}'::jsonb)"
    r = (bypassing_triggers if not T else psql)(db, sql, check=False)       # a forecast made after the outcome is refused by the insert guard
    assert r.returncode == 0, r.stderr
    oid = json.loads(r.stdout.strip().splitlines()[-1])["id"]
    if O:
        assert review(db, oid).returncode == 0
    else:
        assert review(db, oid, decision="rejected", cls=None).returncode == 0
    if not F:                                                           # the file loses its verification after the review: edited out of band
        bypassing_triggers(db, f"update project_evidence set review_status = 'unverified' where id = '{ev}'")
    record_permission(db, project)
    if not C:
        record_permission(db, project, kind="revoked", doc="e" * 64)
    return oid, project


def test_the_all_true_row_is_the_only_one_exported_and_it_is_exported_exactly_once(db):
    oid, _ = build(db, True, True, True, True, True)
    rows = export_rows(db, f"id = '{oid}'")
    assert len(rows) == 1 and rows[0]["evidence_class"] == "E5" and rows[0]["key"] == "btm.firm_MW"


@pytest.mark.parametrize("missing", range(5), ids=lambda i: f"only_{NAMES[i]}_is_false")
def test_removing_any_one_condition_yields_zero_rows(db, missing):
    values = [True] * 5
    values[missing] = False
    oid, _ = build(db, *values)
    assert export_rows(db, f"id = '{oid}'") == [], NAMES[missing]


@pytest.mark.parametrize("combo", list(itertools.product([True, False], repeat=5)), ids=lambda c: "".join("1" if x else "0" for x in c))
def test_all_thirty_two_combinations(db, combo):
    oid, _ = build(db, *combo)
    rows = export_rows(db, f"id = '{oid}'")
    assert len(rows) == (1 if all(combo) else 0), dict(zip(NAMES, combo))


def test_the_whole_table_at_once_holds_exactly_one_row():
    """All 32 built together in a database of their own: the view returns precisely the one observation whose five conditions hold."""
    from calibration_pg_rig import drop_database, make_database
    name = make_database()
    try:
        target = None
        for combo in itertools.product([True, False], repeat=5):
            oid, _ = build(name, *combo)
            if all(combo):
                target = oid
        assert scalar(name, "select count(*) from project_observations") == "32"
        assert [r["id"] for r in export_rows(name)] == [target]
    finally:
        drop_database(name)
