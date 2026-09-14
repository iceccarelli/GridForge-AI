"""The accuracy record, and the rules that keep it worth having.

The ledger is the only asset in this product that a competent engineer with three
months cannot reproduce, and it is worthless the moment it can be gamed. So the
rules are tested harder than the arithmetic:

  * an observation must come from site data, never from another run of our model
  * client site data must be impossible to commit by accident
  * the same site-month may not be counted twice
  * an empty ledger must produce a printed "uncalibrated", never silence
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

from gridforge.calibration import (Observation, ObservationError, accuracy_block, all_keys,
                                   calibration_for, constraint_key, may_claim_field_validated)
from gridforge.calibration.keys import CONSTRAINT_IDS, constraint_id_of, known
from gridforge.calibration.ledger import BUNDLED_PATH, Ledger, append_observation, _read
from gridforge.calibration.schema import site_ref
from gridforge.calibration.stats import CALIBRATED_MIN, CalibrationState
from gridforge.validation.evidence import EvidenceClass

ROOT = Path(__file__).resolve().parents[1]


def obs(key="envelope.racks", predicted=26.0, observed=24.0, on="2026-11-30",
        site="Client A", hall="DH-02", evidence=EvidenceClass.E5_CUSTOMER_DATA):
    return Observation(key=key, site_ref=site_ref(site, hall), predicted=predicted,
                       observed=observed, unit="racks", observed_on=on,
                       evidence=evidence, method="half-hourly metering")


def run_cli(*args, env=None):
    import os
    r = subprocess.run([sys.executable, "-m", "gridforge", *args], cwd=ROOT,
                       capture_output=True, text=True, env={**os.environ, **(env or {})})
    assert "Traceback" not in r.stderr, r.stderr
    return r


# --- the rules -------------------------------------------------------------

def test_an_observation_must_come_from_site_data():
    """E4 and below is our own model. Admitting it would let the ledger validate
    the engine against itself — the most attractive lie available to this business."""
    for weak in [EvidenceClass.E0_ASSUMPTION, EvidenceClass.E1_MODEL,
                 EvidenceClass.E3_ENGINEERING_ESTIMATE, EvidenceClass.E4_EXPERIMENTAL]:
        with pytest.raises(ObservationError, match="below"):
            obs(evidence=weak)
    for strong in [EvidenceClass.E5_CUSTOMER_DATA, EvidenceClass.E6_FIELD_VALIDATED,
                   EvidenceClass.E7_DEPLOYED]:
        assert obs(evidence=strong).evidence is strong


def test_a_client_name_can_never_reach_the_ledger():
    with pytest.raises(ObservationError, match="site_ref"):
        Observation(key="envelope.racks", site_ref="Acme Datacentres Ltd", predicted=1,
                    observed=1, unit="racks", observed_on="2026-01-01",
                    evidence=EvidenceClass.E5_CUSTOMER_DATA, method="metering")


def test_the_site_reference_is_stable_and_not_reversible():
    a = site_ref("Acme", "DH-02")
    assert a == site_ref(" acme ", "dh-02"), "the same hall must hash the same way"
    assert a != site_ref("Acme", "DH-03")
    assert "acme" not in a.lower()


def test_an_observation_needs_a_method_and_a_real_date():
    with pytest.raises(ObservationError, match="method"):
        Observation(key="envelope.racks", site_ref=site_ref("A", "1"), predicted=1, observed=1,
                    unit="racks", observed_on="2026-01-01",
                    evidence=EvidenceClass.E5_CUSTOMER_DATA, method="  ")
    with pytest.raises(ObservationError, match="ISO date"):
        obs(on="2026-13-01")


def test_a_key_that_is_not_in_the_vocabulary_is_refused():
    with pytest.raises(ObservationError, match="dotted"):
        obs(key="Racks!")
    assert known("envelope.racks")
    assert known(constraint_key("rack_feed_tapoff"))
    assert not known("constraint.invented_constraint.racks")


def test_the_vocabulary_still_covers_every_constraint_the_engine_evaluates():
    """Keys are written out by hand so a rename cannot orphan years of observations.
    This is the test that notices when a constraint is added and the vocabulary is not."""
    from gridforge.envelope import solver  # noqa: F401  (registers every constraint)
    from gridforge.intake.loader import load
    from gridforge.scenario.run import run_all
    intake = load(ROOT / "examples" / "intake" / "reference_hall.json")
    results = run_all(intake.context, intake.scenarios)
    seen = {c.id for r in results for c in r.envelope.sorted_constraints()}
    missing = sorted(seen - set(CONSTRAINT_IDS))
    assert not missing, f"constraints with no calibration key: {missing}"


def test_the_committed_ledger_holds_no_client_data():
    doc = json.loads(BUNDLED_PATH.read_text())
    assert doc["observations"] == [], (
        "the published ledger must stay empty until we have observations we are free "
        "to publish; client site data belongs in the gitignored local file")


def test_writing_to_the_committed_ledger_is_refused(tmp_path):
    with pytest.raises(ObservationError, match="published with the engine"):
        append_observation(obs(), BUNDLED_PATH)


def test_the_same_observation_cannot_be_counted_twice(tmp_path):
    p = tmp_path / "cal.json"
    append_observation(obs(), p)
    with pytest.raises(ObservationError, match="already recorded"):
        append_observation(obs(), p)
    assert len(_read(p)) == 1


# --- the statistics --------------------------------------------------------

def test_nothing_is_calibrated_until_there_are_enough_sites():
    o = [obs(site=f"C{i}", hall=f"H{i}", observed=24 + i, on=f"2026-0{i}-01")
         for i in range(1, CALIBRATED_MIN)]
    c = calibration_for("envelope.racks", o)
    assert c.n == CALIBRATED_MIN - 1
    assert c.state is CalibrationState.INDICATIVE
    assert c.low_ratio is None and c.high_ratio is None, (
        "a spread quoted from four halls is fake precision")
    o.append(obs(site="CX", hall="HX", observed=30, on="2026-09-01"))
    c = calibration_for("envelope.racks", o)
    assert c.state is CalibrationState.CALIBRATED
    assert c.low_ratio is not None and c.high_ratio is not None


def test_bias_direction_is_stated_the_right_way_round():
    conservative = calibration_for("envelope.racks", [obs(predicted=20, observed=25)])
    assert conservative.conservative is True and conservative.bias_pct > 0
    optimistic = calibration_for("envelope.racks", [obs(predicted=25, observed=20)])
    assert optimistic.conservative is False and optimistic.bias_pct < 0
    assert "optimistic" in optimistic.sentence()


def test_an_empty_ledger_states_uncalibrated_rather_than_saying_nothing():
    block = accuracy_block(all_keys(), Ledger())
    assert block["state"] == "uncalibrated"
    assert block["observations"] == 0
    assert block["coverage"] == 0.0
    assert "has not been established" in block["statement"]
    assert len(block["uncalibrated_keys"]) == len(all_keys())
    assert "modelled" in block["statement"]


def test_field_validated_cannot_be_claimed_without_observations():
    """E6 is the one evidence class a report asserts about itself. It is earned per
    output, from site data, or it is not claimed."""
    assert may_claim_field_validated(["envelope.racks"], Ledger()) is False
    enough = [obs(site=f"C{i}", hall=f"H{i}", observed=24 + i, on=f"2026-0{i}-01")
              for i in range(1, CALIBRATED_MIN + 1)]
    assert may_claim_field_validated(["envelope.racks"], Ledger(observations=enough)) is True
    assert may_claim_field_validated([], Ledger(observations=enough)) is False


def test_coverage_counts_only_keys_with_real_observations():
    led = Ledger(observations=[obs()])
    block = accuracy_block(["envelope.racks", "envelope.it_load_kW"], led)
    assert block["keys_with_site_observations"] == 1
    assert block["keys_asserted"] == 2
    assert block["coverage"] == 0.5


# --- the command line ------------------------------------------------------

def test_calibrate_show_is_honest_on_an_empty_ledger(tmp_path):
    r = run_cli("calibrate", "show",
                env={"GRIDFORGE_CALIBRATION_LEDGER": str(tmp_path / "none.json")})
    assert r.returncode == 0
    assert "has not been established" in r.stdout
    assert "uncalibrated" in r.stdout


def test_calibrate_add_records_and_reports(tmp_path):
    p = tmp_path / "cal.json"
    r = run_cli("calibrate", "add", "--key", "envelope.racks", "--site", "Client A",
                "--hall", "DH-02", "--predicted", "26", "--observed", "24",
                "--unit", "racks", "--on", "2026-11-30", "--method", "metering",
                "--ledger", str(p))
    assert r.returncode == 0, r.stderr
    assert "-7.7%" in r.stdout
    assert "n=1" in r.stdout
    assert "Client A" not in p.read_text(), "a client name reached the ledger file"


def test_calibrate_add_refuses_an_unknown_key(tmp_path):
    r = run_cli("calibrate", "add", "--key", "envelope.invented", "--site", "A", "--hall", "1",
                "--predicted", "1", "--observed", "1", "--on", "2026-01-01",
                "--method", "m", "--ledger", str(tmp_path / "c.json"))
    assert r.returncode == 2
    assert "orphans" in r.stderr


def test_calibrate_keys_lists_the_whole_vocabulary():
    r = run_cli("calibrate", "keys")
    assert r.returncode == 0
    for k in all_keys():
        assert k in r.stdout


# --- the deliverable -------------------------------------------------------

def test_the_study_prints_its_accuracy_record(tmp_path):
    out = tmp_path / "study"
    r = run_cli("study", "examples/intake/reference_hall.json", "-o", str(out),
                env={"GRIDFORGE_CALIBRATION_LEDGER": str(tmp_path / "none.json")})
    assert r.returncode == 0, r.stderr
    md = (out / "envelope_study.md").read_text()
    assert "Model accuracy against instrumented sites" in md
    assert "has not been established" in md
    assert "uncalibrated" in md


def test_the_accuracy_section_does_not_trip_the_language_gate(tmp_path):
    """The section talks about measurement, which is exactly what the gates police.
    If it ever phrases that as a claim about this hall, generation must fail."""
    from gridforge.intake.loader import load
    from gridforge.reporting import to_markdown
    from gridforge.reporting.gates import ReportMode, run_all_gates
    from gridforge.reporting.study import build, collect_claims
    from gridforge.scenario.run import run_all
    intake = load(ROOT / "examples" / "intake" / "reference_hall.json")
    results = run_all(intake.context, intake.scenarios)
    report = build(intake.context, results, client=intake.client)
    run_all_gates(report, to_markdown(report), claims=collect_claims(results),
                  mode=ReportMode.SCREENING)
