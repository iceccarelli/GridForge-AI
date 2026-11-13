"""Findings of the independent review of the calibration work (R3, R4, R5, R6, R8, R10). All records are SYNTHETIC and in memory.

  R3  the ratio ledger published individual sites (the median is the middle site, the 10th/90th quantiles are the extreme sites)
  R4  successive public releases differ by one site: stated as a hard precondition (publication.py), not solved here
  R5  wording said figures were reported while they were withheld, and 'calibrated' sat beside 'Indicative only'
  R6  CALIBRATED was not tied to the build answering the request
  R8  published figures were built from readings the same block says do not count
  R10 a non-uuid source_ref survived into a published row
"""
import json

import pytest

from gridforge.calibration import accuracy_block
from gridforge.calibration import residuals as R
from gridforge.calibration.ledger import Ledger
from gridforge.calibration.records import ObservationRecord
from gridforge.calibration.schema import Observation, site_only_ref
from gridforge.calibration.stats import CalibrationState, calibration_for
from gridforge.validation.evidence import EvidenceClass
from test_calibration_disclosure_hardening import DIGEST, NOW, SHA, ledger_obs, public_var, rec

RATIOS = (0.81, 0.93, 1.02, 1.11, 1.37)


def five_site_entry(**kw):
    rows = [ledger_obs(s, s, observed=20.0 * r, **kw) for s, r in enumerate(RATIOS, start=1)]
    return accuracy_block(["envelope.racks"], Ledger(observations=rows))["keys"][0]


# ---------------------------------------------------------------------------------------------------------------- R3

def test_the_ratio_ledger_publishes_no_median_no_range_no_quantile_and_no_site_s_exact_ratio():
    entry = five_site_entry()
    for gone in ("median_ratio", "observed_range", "bias_pct", "low_ratio", "high_ratio", "last_observed_on"):
        assert gone not in entry, gone
    values = json.dumps(entry)
    for site_ratio in ("0.81", "0.93", "1.02", "1.11", "1.37"):
        assert site_ratio not in values, site_ratio
    assert entry["mean_ratio"] == pytest.approx(1.048, abs=0.005)    # 1.05 at three significant figures and entry["interval_over_sites"]["published"] is True


def test_the_operator_view_keeps_the_median_and_range_and_is_not_what_leaves_the_process():
    rows = [ledger_obs(s, s, observed=20.0 * r) for s, r in enumerate(RATIOS, start=1)]
    c = calibration_for("envelope.racks", rows)
    d = c.to_dict()
    assert d["median_ratio"] == pytest.approx(1.02) and d["observed_range"] == [0.81, 1.37]
    assert "median_ratio" not in c.public_dict() and "observed_range" not in c.public_dict()


# ---------------------------------------------------------------------------------------------------------------- R5

def test_a_state_below_the_publication_floor_is_not_called_calibrated_and_no_sentence_claims_figures_that_are_withheld():
    rows = [ledger_obs(s, i, observed=10.0) for i, s in enumerate((1, 1, 2, 2, 3))]               # three sites, five readings, ratio 0.5
    block = accuracy_block(["envelope.racks"], Ledger(observations=rows))
    entry = block["keys"][0]
    assert calibration_for("envelope.racks", rows).state is CalibrationState.CALIBRATED, "internally the three-site rule is unchanged"
    assert entry["state"] == "indicative" and block["state"] == "indicative" and block["keys_calibrated"] == 0
    for text in (entry["statement"], entry["basis"], block["statement"]):
        assert "median ratio" not in text and "observed spread" not in text and "calibrated" not in text.lower().replace("not calibrated", "")
    assert "fewer than 5 sites" in entry["statement"]


def test_a_calibrated_key_never_reads_indicative_only_and_does_not_promise_a_median_or_a_spread():
    entry = five_site_entry()
    assert entry["state"] == "calibrated" and "Indicative only" not in entry["statement"]
    assert "median" not in entry["basis"].lower() and "spread" not in entry["basis"].lower()
    assert "mean" in entry["statement"] and "interval" in entry["statement"]


# ---------------------------------------------------------------------------------------------------------------- R6

@pytest.fixture
def running(monkeypatch):
    from gridforge.calibration import publication

    def set_running(*ids):
        monkeypatch.setattr(publication, "running_build_ids", lambda: tuple(ids))
    return set_running


def two_ledger_builds():
    a, b = "a" * 64, "b" * 64
    return a, b, ([ledger_obs(s, s, digest=a, observed=24.0) for s in range(1, 8)]
                  + [ledger_obs(s, 10 + s, digest=b, observed=30.0) for s in range(8, 13)])        # a: 7 sites, b: 5 sites


def test_the_ledger_headline_is_the_running_build_when_there_is_evidence_for_it(running):
    a, b, rows = two_ledger_builds()
    running(b)
    c = calibration_for("envelope.racks", rows)
    assert c.build == b and (c.n, c.sites) == (5, 5) and c.build_relation == "running"
    assert "answering this request" in c.public_dict()["statement"]


def test_the_ledger_says_so_when_the_headline_build_is_not_the_one_answering(running):
    a, b, rows = two_ledger_builds()
    running("c" * 64)
    entry = accuracy_block(["envelope.racks"], Ledger(observations=rows))["keys"][0]
    assert entry["model_builds"]["relation_to_running_build"] == "other"
    assert "a calibration of another build is not a calibration of this one" in entry["statement"]


def test_unrecorded_ledger_observations_are_labelled_unrecorded_and_not_shown_to_be_this_build(running):
    running("c" * 64)
    entry = accuracy_block(["envelope.racks"], Ledger(observations=[ledger_obs(s, s) for s in range(1, 6)]))["keys"][0]
    assert entry["model_builds"]["relation_to_running_build"] == "unrecorded"
    assert "unrecorded" in entry["statement"] and "cannot be shown" in entry["statement"]


def test_when_the_running_build_cannot_be_determined_the_statement_says_that(running):
    running()
    rows = [ledger_obs(s, s, digest="a" * 64) for s in range(1, 6)]
    entry = accuracy_block(["envelope.racks"], Ledger(observations=rows))["keys"][0]
    assert entry["model_builds"]["relation_to_running_build"] == "unknown" and "could not be determined" in entry["statement"]


def v_rows(layout, version, start, err=-50.0):
    rows, i = [], start
    for site, n in layout:
        for _ in range(n):
            i += 1
            rows.append(rec(i, site, 1000.0, 1000.0 - err + (i % 7), version=version, day=i))
    return rows


def test_residual_calibration_prefers_the_running_build_and_is_not_borrowed_from_another(running):
    rows = v_rows([(1, 4), (2, 3), (3, 3)], "v1", 0) + v_rows([(10, 15), (11, 15)], "v2", 100)     # v1: 3 sites, 10 readings; v2: 2 sites, 30
    running("v2")
    assert R.variable_state(rows) == R.INDICATIVE, "the running build is v2, which has two sites: v1's calibration is not v2's"
    running("v9")
    block = R.residual_report(rows)["subsystems"]["envelope"]["variables"]["it_load_kW"]
    assert block["state"] == R.CALIBRATED and block["model_versions"]["headline_build"] == "other"
    assert "a calibration of another build is not a calibration of this one" in block["model_versions"]["headline"]


def test_a_calibrated_subsystem_statement_says_when_its_build_is_not_the_running_one(running):
    from gridforge.calibration.records import VARIABLES
    rows, i = [], 0
    for v, spec in VARIABLES.items():
        if spec[0] == "grid":
            for k in range(10):
                i += 1
                d = rec(i, k % 3 + 1, 100.0, 90.0 + 0.01 * i, version="v1", day=i).to_dict()
                rows.append(ObservationRecord.from_dict({**d, "variable": v, "unit": spec[1]}, now=NOW))
    running("v9")
    sub = R.residual_report(rows)["subsystems"]["grid"]
    assert sub["state"] == R.CALIBRATED and "not the build answering this request" in sub["statement"]


@pytest.mark.parametrize("label", ["unknown", "Unknown", "na", "none", "unrecorded"])
def test_a_version_label_that_names_no_build_is_unrecorded_not_the_one_build_recorded(label, running):
    running("v9")
    rows = v_rows([(1, 4), (2, 3), (3, 3)], label, 0)
    mv = R.residual_report(rows)["subsystems"]["envelope"]["variables"]["it_load_kW"]["model_versions"]
    assert mv["headline_build"] == "unrecorded" and "one build recorded" not in mv["headline"] and "unrecorded" in mv["headline"]
    pub_mv = public_var(rows)["model_versions"]
    assert pub_mv["headline_build"] == "unrecorded" and "one build recorded" not in json.dumps(pub_mv)


def test_the_api_registers_its_version_label_so_records_made_against_it_are_recognised():
    from gridforge.api import server
    from gridforge.calibration import publication
    assert publication.build_relation(server.VERSION) == "running" and publication.build_relation("0.0.1-other") == "other"
    assert publication.build_relation(publication.running_build_ids()[-1]) == "running", "and the sha256 of the engine's own code"


# ---------------------------------------------------------------------------------------------------------------- R8

def test_published_figures_come_only_from_readings_that_count():
    base = [rec(i, i % 12 + 1, 100.0, 100.0 - (i % 5) + 2.0 * (i % 3), day=i) for i in range(24)]
    before = public_var(base)
    assert before["state"] == "CALIBRATED" and before["counting_toward_calibration"] == 24
    low = rec(900, 3, 100.0, 1.0, quality="low", day=100)                     # a reading the block itself says does not count
    d = base[0].to_dict()
    d.update(observation_id="obs-00901", site_id=f"site_{4:012x}")            # the same measurement as base[0], entered again
    dup = ObservationRecord.from_dict(d, now=NOW)
    after = public_var(base + [low, dup])
    assert after["counting_toward_calibration"] == 24
    for part in ("residuals", "by_capacity_bucket", "by_evidence_class", "lead_time_error", "interval_coverage"):
        assert after[part] == before[part], part


# ---------------------------------------------------------------------------------------------------------------- R10

def test_a_non_uuid_source_ref_is_scrubbed_from_a_published_row():
    from gridforge.calibration import ledger as L
    o = Observation(key="btm.firm_MW", site_ref=site_only_ref("Site 9"), predicted=30.0, observed=28.5, unit="MW", observed_on="2026-06-30",
                    evidence=EvidenceClass.E5_CUSTOMER_DATA, method="metered", source_ref=f"AcmeDublinDC1:{SHA}", model_digest=DIGEST,
                    reviewed_by="J. Murphy", reviewed_at="2026-07-02", source="import", published=True)
    view = L.published_form(o)
    assert "Acme" not in json.dumps(view.to_dict()) and view.source_ref.endswith(f":{SHA}")
    assert L.published_form(view) == view, "idempotent"


# ---------------------------------------------------------------------------------------------------------------- R4

def test_the_release_precondition_is_stated_where_a_maintainer_reads_it_and_not_in_the_empty_report():
    from gridforge.calibration import publication
    assert "PRECONDITION" in publication.__doc__ and "successive" in publication.__doc__.lower()
    rep = R.public_report([rec(i, i + 1, 100, 90 - i) for i in range(6)])
    assert "successive" in rep["requirements"]["release_precondition"].lower()
    assert "release_precondition" not in R.public_report([])["requirements"]
