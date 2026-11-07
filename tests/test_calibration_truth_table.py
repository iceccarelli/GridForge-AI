"""The ledger gate, end to end, as a truth table: calibration_ledger_rows against a REAL PostgreSQL.

An observation may feed the shared calibration ledger only when ALL SEVEN of these hold:

  F  the evidence file's status is verified                      (0048: gf_review_evidence)
  R  a verified decision row exists for that file, and its confirmed digest still equals the file's stored one   (0048)
  O  the observation is verified                                 (0038: a reviewer who is not the submitter, E5)
  P  its data origin is 'production'                             (0047)
  C  its project's LATEST permission is a grant                  (0047: a revocation is a newer row)
  T  the forecast predates the outcome                           (0046: the case revision was created before the observed date)
  B  the observation's predicted value is the number the frozen forecast holds for that architecture   (0046)

All 128 combinations are built ONCE, through the real functions, in a database of their own (each condition made false the way it can really
go false, including by out-of-band edits the guards would refuse, applied with row triggers off so the VIEW is shown to hold on its own).
The view must return exactly one row for the one combination where all seven hold and none for the other 127. Further tests cover the
conditions that are about the forecast row itself (a revision with no digest, a revision whose content no longer matches its digest).
The eighth condition (0052: the project is not sitting in a test or synthetic site) is a truth table of its own in tests/test_site_origin_gate.py,
because it needs the site registry (0049/0050).
Every value is a SYNTHETIC fixture.
"""
import itertools
import json

import pytest

from calibration_pg_rig import (
    GOOD, bypassing_triggers, drop_database, export_rows, make_database, new_case, new_evidence, new_project, obs_args, psql, record_permission,
    review, scalar, skip_without_db,
)

pytestmark = skip_without_db

NAMES = ("F_file_status_verified", "R_verdict_row_matches", "O_observation_verified", "P_production_origin", "C_permission_granted",
         "T_forecast_before_outcome", "B_predicted_value_is_the_forecasts")
COMBOS = list(itertools.product([True, False], repeat=len(NAMES)))
ID = lambda c: "".join("1" if x else "0" for x in c)  # noqa: E731


def build(db, F, R, O, P, C, T, B, n):
    """One observation with exactly the given truth values; returns (observation id, project id)."""
    project = new_project(db, site=f"Site {n}")
    case = new_case(db, created_at="2026-03-02T09:00:00Z" if T else "2026-07-07T09:00:00Z")
    ev = new_evidence(db, project, verified=True)                       # verified first: an observation can only be verified against a verified file
    args = obs_args(project, ev, case, data_origin="production" if P else "test", predicted_value=30 if B else 31)
    sql = f"select gf_submit_observation('{args}'::jsonb, '{GOOD % 'observation_submitted'}'::jsonb)"
    # a forecast made after the outcome, or a prediction that is not the forecast's, is refused by the insert guard: build those with it off
    r = (psql if (T and B) else bypassing_triggers)(db, sql, check=False)
    assert r.returncode == 0, r.stderr
    oid = json.loads(r.stdout.strip().splitlines()[-1])["id"]
    if O:
        assert review(db, oid).returncode == 0
    else:
        assert review(db, oid, decision="rejected", cls=None).returncode == 0
    if not F:                                                           # the file loses its verification after the review: edited out of band
        bypassing_triggers(db, f"update project_evidence set review_status = 'unverified' where id = '{ev}'")
    if not R:                                                           # the file was marked verified without a verdict on record
        bypassing_triggers(db, f"delete from project_evidence_reviews where evidence_id = '{ev}'")
    record_permission(db, project)
    if not C:
        record_permission(db, project, kind="revoked", doc="1" * 63 + "2")
    return oid, project


@pytest.fixture(scope="module")
def world():
    """All 128 combinations in one database; maps combination -> observation id."""
    name = make_database()
    try:
        ids = {c: build(name, *c, n)[0] for n, c in enumerate(COMBOS)}
        assert scalar(name, "select count(*) from project_observations") == str(len(COMBOS))
        yield name, ids, {r["id"] for r in export_rows(name)}
    finally:
        drop_database(name)


def test_the_all_true_row_is_the_only_one_exported_and_it_is_exported_exactly_once(world):
    db, ids, exported = world
    assert exported == {ids[tuple([True] * len(NAMES))]}
    rows = export_rows(db, f"id = '{ids[tuple([True] * len(NAMES))]}'")
    assert len(rows) == 1 and rows[0]["evidence_class"] == "E5" and rows[0]["key"] == "btm.firm_MW"


@pytest.mark.parametrize("missing", range(len(NAMES)), ids=lambda i: f"only_{NAMES[i]}_is_false")
def test_removing_any_one_condition_yields_zero_rows(world, missing):
    db, ids, exported = world
    values = [True] * len(NAMES)
    values[missing] = False
    assert ids[tuple(values)] not in exported, NAMES[missing]
    assert export_rows(db, f"id = '{ids[tuple(values)]}'") == []


@pytest.mark.parametrize("combo", COMBOS, ids=ID)
def test_all_combinations(world, combo):
    _, ids, exported = world
    assert (ids[combo] in exported) == all(combo), dict(zip(NAMES, combo))


# ---------------------------------------------------------------------------------------------- conditions about the forecast row itself

@pytest.fixture(scope="module")
def db():
    name = make_database()
    yield name
    drop_database(name)


def exportable(db, **over):
    """A fully cleared, permitted, production observation; returns (id, case token)."""
    project = new_project(db, site=f"Extra {over.get('tag', '')}")
    case = new_case(db, created_at="2026-03-02T09:00:00Z")
    ev = new_evidence(db, project)
    r = psql(db, f"select gf_submit_observation('{obs_args(project, ev, case)}'::jsonb, '{GOOD % 'observation_submitted'}'::jsonb)")
    oid = json.loads(r.stdout.strip().splitlines()[-1])["id"]
    assert review(db, oid).returncode == 0
    record_permission(db, project)
    assert [x["id"] for x in export_rows(db, f"id = '{oid}'")] == [oid]       # the control: it IS exported before the edit
    return oid, case


def test_a_forecast_with_no_digest_is_not_exported(db):
    oid, case = exportable(db)
    bypassing_triggers(db, f"update power_deployment_cases set case_digest = null where case_token = '{case}'")
    assert export_rows(db, f"id = '{oid}'") == []


@pytest.mark.parametrize("edit", ["request = '{\"target_MW\": 1}'::jsonb",
                                  "result = '{\"architectures\": [{\"label\": \"ARCH\", \"available_MW\": 30, \"note\": \"edited\"}]}'::jsonb"])
def test_a_forecast_whose_content_no_longer_matches_its_digest_is_not_exported(db, edit):
    oid, case = exportable(db)
    bypassing_triggers(db, f"update power_deployment_cases set {edit} where case_token = '{case}'")
    assert export_rows(db, f"id = '{oid}'") == []


def test_a_forecast_edited_to_change_its_prediction_is_not_exported_even_if_its_digest_is_recomputed(db):
    """The digest is stored, so an editor who also rewrote it is caught by the prediction bound instead."""
    oid, case = exportable(db)
    bypassing_triggers(db, "update power_deployment_cases set result = '{\"architectures\": [{\"label\": \"ARCH\", \"available_MW\": 99}]}'::jsonb,"
                           " case_digest = encode(sha256(convert_to(jsonb_build_object('request', request, 'result',"
                           f" '{{\"architectures\": [{{\"label\": \"ARCH\", \"available_MW\": 99}}]}}'::jsonb)::text, 'UTF8')), 'hex') where case_token = '{case}'")
    assert export_rows(db, f"id = '{oid}'") == []


def test_a_file_marked_verified_before_the_review_path_existed_does_not_qualify(db):
    """A file verified by a raw update (the only way before 0048) has no decision row, so its observations are not exported."""
    project = new_project(db, site="Legacy file")
    case = new_case(db, created_at="2026-03-02T09:00:00Z")
    ev = new_evidence(db, project, verified=False)
    bypassing_triggers(db, f"update project_evidence set review_status = 'verified' where id = '{ev}'")
    oid = json.loads(psql(db, f"select gf_submit_observation('{obs_args(project, ev, case)}'::jsonb, '{GOOD % 'observation_submitted'}'::jsonb)").stdout.strip().splitlines()[-1])["id"]
    assert review(db, oid).returncode == 0                  # the older gate (status only) lets the review through...
    record_permission(db, project)
    assert export_rows(db, f"id = '{oid}'") == []           # ...and the final view still does not export it
