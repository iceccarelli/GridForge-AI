"""Observation records and the per-subsystem residual framework.

Everything here uses SYNTHETIC records built in the test. Nothing is written to any ledger, and the
shipped ledger stays empty.
"""
import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from gridforge.calibration import (ObservationRecord, RecordError, accuracy_block, load_batch,
                                   pending_counts, residual, residual_report)
from gridforge.calibration import residuals as R
from gridforge.calibration.ledger import Ledger
from gridforge.calibration.records import VARIABLES
from gridforge.calibration.schema import site_only_ref
from gridforge.calibration.stats import CALIBRATED_MIN, CALIBRATED_MIN_SITES
from gridforge.validation.evidence import EvidenceClass

ROOT = Path(__file__).resolve().parents[1]
NOW = datetime(2026, 11, 3, 12, 0, tzinfo=timezone.utc)


def row(i=1, site="A", variable="it_load_kW", predicted=100.0, measured=95.0, status="approved", **kw):
    d = {"observation_id": f"obs-{i:04d}", "site_id": site_only_ref(site), "hall_id": "H1",
         "measured_at": "2026-10-01T00:00:00Z", "variable": variable,
         "predicted": predicted, "measured": measured, "unit": VARIABLES.get(variable, ("", "kW"))[1],
         "measurement_source": "metered", "quality": "high", "model_version": "1.2.3",
         "evidence": "E5_CUSTOMER_DATA", "approval_status": status}
    if status == "approved":
        d["reviewer"] = "R. Reviewer"
    d.update(kw)
    return d


def rec(*a, **kw):
    return ObservationRecord.from_dict(row(*a, **kw), now=NOW)


def many(n, sites=3, **kw):
    return [rec(i, site=f"S{i % sites}", **kw) for i in range(n)]


# --- record validation ------------------------------------------------------

def test_a_valid_record_normalises_to_utc_and_hashes_deterministically():
    a = ObservationRecord.from_dict(row(measured_at="2026-10-01T02:00:00+02:00"), now=NOW)
    b = ObservationRecord.from_dict(row(measured_at="2026-10-01T00:00:00Z"), now=NOW)
    assert a.measured_at == b.measured_at and a.measured_at.utcoffset() == timedelta(0)
    assert a.content_hash() == b.content_hash() and len(a.content_hash()) == 64
    assert rec(1, measured=96.0).content_hash() != rec(1).content_hash()


@pytest.mark.parametrize("bad", [float("nan"), float("inf"), float("-inf"), "100", None, True, [1], 1e300])
def test_non_finite_or_non_numeric_values_are_refused(bad):
    for field in ("predicted", "measured"):
        with pytest.raises(RecordError):
            rec(**{field: bad})


def test_negative_values_refused_except_where_physical():
    with pytest.raises(RecordError, match="minimum"):
        rec(measured=-1.0)
    with pytest.raises(RecordError, match="minimum"):
        rec(variable="pue", predicted=1.3, measured=0.9)          # PUE below 1 is impossible
    assert rec(variable="coolant_supply_temp_C", predicted=-3.0, measured=-2.5).measured == -2.5


def test_units_are_per_variable_and_never_converted():
    for unit in ("MW", "W", "kw", "", 5):
        with pytest.raises(RecordError, match="unit"):
            rec(unit=unit)


def test_future_and_naive_timestamps_are_refused():
    with pytest.raises(RecordError, match="future"):
        rec(measured_at="2026-11-04T00:00:00Z")
    with pytest.raises(RecordError, match="timezone"):
        rec(measured_at="2026-10-01T00:00:00")
    with pytest.raises(RecordError, match="ISO"):
        rec(measured_at="yesterday")
    with pytest.raises(RecordError):
        rec(measured_at=12345)


def test_approved_requires_a_named_reviewer():
    with pytest.raises(RecordError, match="reviewer"):
        rec(reviewer=None)
    with pytest.raises(RecordError, match="reviewer"):
        rec(reviewer="   ")
    assert rec(status="draft").reviewer is None


def test_model_runs_and_client_names_cannot_enter():
    with pytest.raises(RecordError, match="below"):
        rec(evidence="E1_MODEL")
    with pytest.raises(RecordError, match="hashed"):
        rec(site_id="Acme Corp")


def test_closed_vocabularies_and_unknown_fields():
    for k, v in [("variable", "overall_accuracy"), ("quality", "great"), ("measurement_source", "vibes"),
                 ("approval_status", "maybe"), ("cooling_mode", "magic")]:
        with pytest.raises(RecordError):
            rec(**{k: v})
    with pytest.raises(RecordError, match="unknown"):
        rec(extra="x")
    with pytest.raises(RecordError, match="missing"):
        d = row()
        del d["measured"]
        ObservationRecord.from_dict(d, now=NOW)


def test_interval_and_forecast_consistency():
    with pytest.raises(RecordError, match="together"):
        rec(predicted_low=90.0)
    with pytest.raises(RecordError, match="low <= predicted"):
        rec(predicted_low=101.0, predicted_high=110.0)
    with pytest.raises(RecordError, match="without an interval"):
        rec(interval_nominal_coverage=0.9)
    with pytest.raises(RecordError, match="after measured_at"):
        rec(forecast_issued_at="2026-10-02T00:00:00Z")


def test_duplicate_observation_ids_are_refused_in_every_copy_and_order_does_not_matter():
    rows = [row(1), row(1, measured=50.0), row(2)]
    a = load_batch(rows, now=NOW)
    b = load_batch(list(reversed(rows)), now=NOW)
    assert [r.observation_id for r in a.accepted] == ["obs-0002"] == [r.observation_id for r in b.accepted]
    assert len(a.rejected) == 2 and all("duplicate" in why for _, why in a.rejected)


# --- hostile input ----------------------------------------------------------

HOSTILE = [None, 5, "str", [], [[]], {}, {"observation_id": {"a": 1}}, {"variable": ["x"]},
           row(predicted=float("nan")), row(measured=float("inf")), row(unit="W"), row(variable=5),
           row(observation_id="x" * 10_000), row(observation_id="a\x00b-1"), row(measured_at=float("nan")),
           row(evidence=99), row(evidence=True), row(capacity_mw=-5), row(it_load_fraction=2),
           row(ambient_temp_c=float("nan")), row(measured=10 ** 400), row(hall_id="../../etc"),
           row(measured_at="9999-12-31T23:59:59-23:59")]


def test_hostile_rows_are_rejected_not_raised_and_nothing_hostile_is_accepted():
    res = load_batch(HOSTILE + [row(7)], now=NOW)
    assert [r.observation_id for r in res.accepted] == ["obs-0007"]
    assert len(res.rejected) == len(HOSTILE)


def test_mixed_units_in_one_batch_cannot_both_survive():
    res = load_batch([row(1), row(2, unit="MW")], now=NOW)
    assert len(res.accepted) == 1 and len(res.rejected) == 1


def test_report_never_raises_on_hostile_batches():
    report = residual_report(load_batch(HOSTILE, now=NOW).accepted)
    assert all(s["state"] == R.UNCALIBRATED for s in report["subsystems"].values())


# --- residual arithmetic ----------------------------------------------------

def test_percentage_error_is_undefined_not_zero_when_measured_is_zero():
    r = residual(rec(predicted=5.0, measured=0.0))
    assert r.absolute_error == 5.0 and r.percentage_error is None
    assert residual(rec(predicted=100.0, measured=80.0)).percentage_error == pytest.approx(25.0)
    stats = R._stats([rec(1, predicted=5.0, measured=0.0), rec(2, predicted=100.0, measured=80.0)])
    assert stats["pct_error_undefined_n"] == 1 and stats["median_pct_error"] == pytest.approx(25.0)


def test_grouping_by_variable_configuration_capacity_evidence_and_lead_time():
    recs = [rec(1, configuration="dlc-a", capacity_mw=0.5, forecast_issued_at="2026-09-30T23:30:00Z"),
            rec(2, configuration="dlc-a", capacity_mw=3.0, forecast_issued_at="2026-09-30T00:00:00Z", evidence="E6_FIELD_VALIDATED"),
            rec(3, configuration="air-b", capacity_mw=150.0),
            rec(4, variable="pue", predicted=1.3, measured=1.4)]
    rep = residual_report(recs)
    v = rep["subsystems"]["envelope"]["variables"]["it_load_kW"]
    assert set(v["by_configuration"]) == {"dlc-a", "air-b"}
    assert set(v["by_capacity_bucket"]) == {"<1 MW", "1-5 MW", ">=100 MW"}
    assert set(v["by_evidence_class"]) == {"E5", "E6"}
    assert set(v["lead_time_error"]) == {"<=1 h", "6-24 h"}
    assert rep["subsystems"]["thermal"]["variables"]["pue"]["residuals"]["mean_signed_error"] == pytest.approx(-0.1)


def test_interval_coverage_counts_hits_and_withholds_a_verdict_on_small_n():
    recs = [rec(i, measured=95.0 if i % 4 else 150.0, predicted_low=90.0, predicted_high=110.0,
                interval_nominal_coverage=0.9, site=f"S{i % 3}") for i in range(12)]
    cov = residual_report(recs)["subsystems"]["envelope"]["variables"]["it_load_kW"]["interval_coverage"]
    assert cov["n_intervals"] == 12 and cov["hits"] == 9 and cov["observed_coverage"] == 0.75
    assert cov["assessed"] and cov["coverage_minus_nominal"] == pytest.approx(-0.15)
    small = residual_report(recs[:3])["subsystems"]["envelope"]["variables"]["it_load_kW"]["interval_coverage"]
    assert not small["assessed"] and small["coverage_minus_nominal"] is None


# --- the calibration gate ---------------------------------------------------

def test_thresholds_are_pinned_and_never_laxer_than_the_ledger():
    assert (R.MIN_APPROVED_OBSERVATIONS, R.MIN_DISTINCT_SITES) == (10, 3)
    assert R.MIN_APPROVED_OBSERVATIONS >= CALIBRATED_MIN and R.MIN_DISTINCT_SITES >= CALIBRATED_MIN_SITES


def all_variables_of(sub, n=R.MIN_APPROVED_OBSERVATIONS):
    out, i = [], 0
    for v, spec in VARIABLES.items():
        if spec[0] == sub:
            for k in range(n):
                out.append(rec(i, site=f"S{k % 3}", variable=v, predicted=max(2.0, 100.0), measured=max(2.0, 98.0)))
                i += 1
    return out


def test_a_single_approved_point_never_yields_calibrated():
    rep = residual_report([rec(1)])
    assert rep["subsystems"]["envelope"]["state"] == R.INDICATIVE
    assert rep["subsystems"]["envelope"]["variables"]["it_load_kW"]["state"] == R.INDICATIVE
    assert all(s["state"] != R.CALIBRATED for s in rep["subsystems"].values())
    assert rep["subsystems"]["envelope"]["variables"]["it_load_kW"]["still_needed"] == {"observations": 9, "sites": 2}


def test_empty_input_is_uncalibrated_with_the_count():
    rep = residual_report([])
    assert set(rep["subsystem_states"].values()) == {R.UNCALIBRATED}
    assert "n=0" in rep["subsystems"]["power"]["statement"]


def test_enough_observations_from_one_site_is_not_calibrated():
    assert residual_report(many(50, sites=1))["subsystems"]["envelope"]["variables"]["it_load_kW"]["state"] == R.INDICATIVE


def test_low_quality_does_not_count_toward_calibration():
    recs = [rec(i, site=f"S{i % 3}", quality="low") for i in range(30)]
    assert residual_report(recs)["subsystems"]["envelope"]["variables"]["it_load_kW"]["state"] == R.INDICATIVE


def test_variable_calibrates_but_subsystem_needs_every_variable():
    rep = residual_report(many(12))
    assert rep["subsystems"]["envelope"]["variables"]["it_load_kW"]["state"] == R.CALIBRATED
    assert rep["subsystems"]["envelope"]["state"] == R.INDICATIVE   # facility_load_kW, racks still empty


def test_subsystem_is_calibrated_when_every_variable_meets_the_minimum():
    rep = residual_report(all_variables_of("grid"))
    assert rep["subsystems"]["grid"]["state"] == R.CALIBRATED
    assert rep["subsystem_states"]["envelope"] == R.UNCALIBRATED


def test_no_global_accuracy_headline():
    rep = residual_report(many(12))
    assert set(rep) == {"schema", "headline", "requirements", "subsystem_states", "subsystems"}
    assert "no single accuracy figure" in rep["headline"]
    assert all(not isinstance(v, (int, float)) for v in rep.values())
    assert "overall" not in json.dumps(rep).lower()


# --- properties -------------------------------------------------------------

def test_permutation_invariance():
    recs = many(14) + [rec(100 + i, variable="pue", predicted=1.3, measured=1.35, site=f"S{i}") for i in range(4)]
    base = json.dumps(residual_report(recs), sort_keys=True)
    rng = random.Random(7)
    for _ in range(10):
        shuffled = recs[:]
        rng.shuffle(shuffled)
        assert json.dumps(residual_report(shuffled), sort_keys=True) == base


@pytest.mark.parametrize("status", ["draft", "rejected"])
def test_adding_an_unapproved_observation_changes_nothing(status):
    recs = many(12)
    base = json.dumps(residual_report(recs), sort_keys=True)
    extra = rec(999, site="Z", status=status, measured=1.0, quality="high")
    assert json.dumps(residual_report(recs + [extra]), sort_keys=True) == base
    assert pending_counts(recs + [extra])[status] == 1


def test_adding_an_approved_observation_does_change_the_report():
    recs = many(12)
    assert residual_report(recs) != residual_report(recs + [rec(999, site="Z")])


# --- the empty ledger is untouched -----------------------------------------

def test_empty_ledger_output_is_byte_identical_to_the_committed_reference():
    committed = (ROOT / "public" / "reference" / "calibration.json").read_text()
    assert json.dumps(accuracy_block(ledger=Ledger()), indent=2) == committed
    block = json.loads(committed)
    assert (block["state"], block["observations"], block["sites"]) == ("uncalibrated", 0, 0)
    assert block["keys"] == []


def test_the_shipped_ledger_holds_no_observations():
    from gridforge.calibration.ledger import BUNDLED_PATH
    assert json.loads(BUNDLED_PATH.read_text()).get("observations") == []
