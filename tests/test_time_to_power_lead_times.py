"""A supplied transformer lead time and the record behind every projected date (GitHub issue #107 and its neighbours).

Pinned here, against the real engine and the real compare route (nothing stubbed):

  * a supplied lead time carries a band AROUND ITSELF, never the library band 80-210, and a stated date never lies
    outside its own range (10, 52, 160, 400 weeks; inside and outside the library range);
  * an absent lead time is a named library placeholder (160 weeks, 80-210) and says so;
  * zero, negative, NaN, infinite, boolean, text and over-ceiling values are refused, never turned into a date;
  * where the evidence class is set (intake/loader.py builds a supplied transformer lead time with ASSUMED, i.e. E0) and
    that the report distinguishes "customer-supplied (unverified)" from "library placeholder" WITHOUT raising the class;
  * the controlling date is the longest single lead time (all reliefs parallel): the limitation is stated, not hidden.
"""
import copy
import json
from pathlib import Path

import pytest

from gridforge.api.server import handle_compare, handle_screen
from gridforge.api.tiers import Tier
from gridforge.envelope.time_to_power import (
    CALCULATION_VERSION, LEAD_SOURCE_LIBRARY, LEAD_SOURCE_MISSING, LEAD_SOURCE_SUPPLIED, LEAD_SOURCE_UNKNOWN,
    SCHEDULE_LIMITATION, date_record, schedule, step_lead_source)
from gridforge.intake.loader import IntakeError, load_document
from gridforge.scenario.run import run_all
from gridforge.validation import EvidenceClass

ROOT = Path(__file__).resolve().parent.parent
BASE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())


def hall(weeks="keep"):
    d = copy.deepcopy(BASE)
    if weeks is None:
        d["transformers"][0].pop("replacement_lead_time_weeks", None)
    elif weeks != "keep":
        d["transformers"][0]["replacement_lead_time_weeks"] = weeks
    return d


def dated(doc):
    out = handle_compare({"intake": doc}, Tier.CLIENT)
    return [r for r in out["scenarios"] if r["time_to_power"]["status"] == "dated"], out


# --- #107: the band is around the supplied value ----------------------------------------------------------------------------------

@pytest.mark.parametrize("weeks", [10, 52, 100, 160, 300, 400])
def test_a_stated_date_never_lies_outside_its_own_range(weeks):
    rows, _ = dated(hall(weeks))
    assert rows
    for r in rows:
        t = r["time_to_power"]
        assert t["low"] <= t["weeks"] <= t["high"], (weeks, r["id"], t["weeks"], t["low"], t["high"])


@pytest.mark.parametrize("weeks", [160, 300, 400])
def test_when_the_supplied_transformer_sets_the_date_its_range_is_around_the_supplied_value(weeks):
    rows, _ = dated(hall(weeks))
    setters = [r for r in rows if r["time_to_power"]["date_record"]["controlling_component"] == "Transformer capacity"]
    assert setters
    for r in setters:
        t = r["time_to_power"]
        assert t["weeks"] == weeks
        assert (t["low"], t["high"]) == pytest.approx((weeks * 0.65, weeks * 1.35))
        assert (t["low"], t["high"]) != (80, 210)


@pytest.mark.parametrize("weeks", [10, 52])
def test_a_short_supplied_lead_time_does_not_inherit_the_library_range(weeks):
    # below the library's own figures other reliefs may set the date; whichever does, the supplied bank's band is its own
    intake = load_document(hall(weeks))
    lt = intake.context.power.transformers[0].replacement_lead_time_weeks
    assert lt.value == weeks and lt.band == pytest.approx((weeks * 0.65, weeks * 1.35))


def test_an_absent_lead_time_is_the_named_library_placeholder_with_the_library_range():
    intake = load_document(hall(None))
    lt = intake.context.power.transformers[0].replacement_lead_time_weeks
    assert (lt.value, lt.band) == (160, (80, 210))
    assert any(g.path == "transformers.replacement_lead_time_weeks" for g in intake.report.gaps)
    rows, _ = dated(hall(None))
    rec = rows[0]["time_to_power"]["date_record"]
    assert rec["lead_time_source"] == LEAD_SOURCE_LIBRARY and rec["lead_time_source_label"] == "library placeholder"


@pytest.mark.parametrize("bad", [-1, -160, float("nan"), float("inf"), -float("inf"), True, False, "160", ""])
def test_a_value_that_is_not_a_positive_finite_number_never_becomes_a_date(bad):
    doc = hall()
    doc["transformers"][0]["replacement_lead_time_weeks"] = bad
    with pytest.raises(IntakeError):
        load_document(doc)


@pytest.mark.xfail(strict=True, reason="CONFIRMED DEFECT (intake/loader.py _pos accepts 0): a supplied transformer lead time of 0 is "
                   "taken as 0 weeks with a band of (0, 0), so a power transformer is dated as instantly available and another "
                   "relief sets the date. Owned by the intake agent; remove this xfail when the loader refuses a non-positive lead time.")
def test_a_zero_lead_time_is_refused_not_dated_as_instant():
    doc = hall(0)
    with pytest.raises(IntakeError):
        load_document(doc)


def test_a_value_above_the_plausibility_ceiling_is_refused_not_dated():
    with pytest.raises(IntakeError, match="above 520"):
        load_document(hall(521))
    assert load_document(hall(520)).context.power.transformers[0].replacement_lead_time_weeks.value == 520


# --- the evidence class: where it is set, and that the source is told without raising it -----------------------------------------

@pytest.mark.parametrize("doc_weeks", [None, 40, 160, 300])
def test_supplied_and_placeholder_lead_times_are_both_E0_in_the_engine(doc_weeks):
    """Pins the current architecture: intake/loader.py builds the transformer lead time with ASSUMED for a supplied value
    and for the library default alike (the supplied value gets a +-35% band, the placeholder 80-210). The source is NOT in
    the class; it is read from the document by step_lead_source."""
    lt = load_document(hall(doc_weeks)).context.power.transformers[0].replacement_lead_time_weeks
    assert lt.evidence == EvidenceClass.E0_ASSUMPTION


def _first(doc):
    intake = load_document(doc)
    return intake, run_all(intake.context, intake.scenarios)


def _with_transformer(results):
    """The first solved scenario whose taken ladder includes the transformer relief (the as-found ones take nothing)."""
    return next(r for r in results if any(s.binding_id == "transformer_capacity" for s in r.ladder.taken_steps))


def test_the_record_tells_a_supplied_figure_from_a_placeholder_and_leaves_the_class_at_E0():
    sup = dated(hall(160))[0][0]["time_to_power"]["date_record"]
    lib = dated(hall(None))[0][0]["time_to_power"]["date_record"]
    assert sup["lead_time_source"] == LEAD_SOURCE_SUPPLIED and sup["lead_time_source_label"] == "customer-supplied (unverified)"
    assert lib["lead_time_source"] == LEAD_SOURCE_LIBRARY and lib["lead_time_source_label"] == "library placeholder"
    assert sup["evidence_class"] == lib["evidence_class"] == "E0"
    assert "customer-supplied (unverified)" in sup["limitation"] and "library placeholder" in lib["limitation"]
    assert "not checked against a written quotation" in sup["limitation"]


def test_the_compare_caveats_say_a_supplied_figure_is_unverified_and_still_E0():
    notes = " ".join(handle_compare({"intake": hall(160)}, Tier.CLIENT)["caveats"])
    assert "customer-supplied (unverified)" in notes and "E0" in notes
    placeholder = " ".join(handle_compare({"intake": hall(None)}, Tier.CLIENT)["caveats"])
    assert "library placeholder" in placeholder and "customer-supplied" not in placeholder


def test_the_source_is_not_guessed_without_the_document():
    intake, results = _first(hall(160))
    step = next(s for s in _with_transformer(results).ladder.taken_steps if s.binding_id == "transformer_capacity")
    assert step_lead_source(step, None) == LEAD_SOURCE_UNKNOWN
    assert date_record(_with_transformer(results).ladder)["lead_time_source"] == LEAD_SOURCE_UNKNOWN
    step.lead_time_weeks = None
    assert step_lead_source(step, intake.document) == LEAD_SOURCE_MISSING


def test_a_document_that_disagrees_with_the_solved_value_is_not_dated_as_supplied():
    intake, results = _first(hall(160))
    step = next(s for s in _with_transformer(results).ladder.taken_steps if s.binding_id == "transformer_capacity")
    other = copy.deepcopy(intake.document)
    other["transformers"][0]["replacement_lead_time_weeks"] = 99
    assert step_lead_source(step, other) == LEAD_SOURCE_UNKNOWN


def test_the_slowest_bank_decides_whether_the_date_is_supplied_or_a_placeholder():
    doc = hall(40)                                   # bank 1 supplied at 40 ...
    doc["transformers"].append({"id": "TX-B", "unit_rating_MVA": 5.0, "units": 2})   # ... bank 2 has no figure: 160 placeholder
    intake, results = _first(doc)
    step = next(s for s in _with_transformer(results).ladder.taken_steps if s.binding_id == "transformer_capacity")
    assert step.lead_time_weeks.value == 160
    assert step_lead_source(step, intake.document) == LEAD_SOURCE_LIBRARY


# --- every projected date carries its record ------------------------------------------------------------------------------------------

RECORD_KEYS = {"status", "controlling_component", "tied_components", "lead_time_source", "lead_time_source_label",
               "evidence_class", "date_interval_weeks", "missing_inputs", "dependency_model", "limitation",
               "calculation_version"}


def test_every_dated_scenario_exposes_the_full_record_in_compare_and_the_model_pack():
    from gridforge.serialize import model_pack
    rows, _ = dated(hall(160))
    for r in rows:
        rec = r["time_to_power"]["date_record"]
        assert set(rec) == RECORD_KEYS
        assert rec["controlling_component"] == r["time_to_power"]["sets_the_date"]
        assert rec["date_interval_weeks"] == {"low": r["time_to_power"]["low"], "high": r["time_to_power"]["high"]}
        assert rec["evidence_class"] == r["time_to_power"]["date_evidence_class"]
        assert rec["limitation"].startswith(SCHEDULE_LIMITATION) and rec["calculation_version"] == CALCULATION_VERSION
        assert rec["dependency_model"] == "all_parallel" and rec["missing_inputs"] == []
    intake, results = _first(hall(160))
    for sc in model_pack(intake, results)["scenarios"]:
        rec = sc["time_to_power"]["date_record"]
        assert set(rec) == RECORD_KEYS
        if rec["status"] == "dated":
            assert rec["lead_time_source"] == LEAD_SOURCE_SUPPLIED


def test_an_undated_scenario_has_no_controlling_component_no_interval_and_names_what_is_missing():
    intake, results = _first(hall(160))
    res = _with_transformer(results)
    next(s for s in res.ladder.taken_steps if s.binding_id == "transformer_capacity").lead_time_weeks = None
    rec = date_record(res.ladder, document=intake.document)
    assert rec["status"] == "lead_time_missing" and rec["controlling_component"] is None
    assert rec["date_interval_weeks"] is None and rec["lead_time_source"] is None
    assert rec["missing_inputs"] == ["lead time: Transformer capacity"]


def test_the_public_screen_carries_no_date_record():
    out = handle_screen({"intake": hall(160)}, Tier.PUBLIC)
    assert "date_record" not in json.dumps(out)


# --- how the controlling date is chosen: the longest single lead time -------------------------------------------------------------

def test_the_date_is_the_longest_single_lead_time_not_a_sum_and_ties_are_disclosed():
    intake, results = _first(hall(160))
    for res in results:
        ttp = schedule(res.ladder)
        leads = [s.lead_time_weeks.value for s in res.ladder.taken_steps]
        if not leads or not ttp.complete:
            continue
        assert ttp.critical_weeks == max(leads)
        if len(leads) > 1:
            assert ttp.critical_weeks < sum(leads)
        if ttp.max_racks:
            assert ttp.weeks_to_full == max(leads)
        rec = date_record(res.ladder, ttp, intake.document)
        if rec["status"] == "dated":
            tied = {s.binding_name for s in res.ladder.taken_steps if s.lead_time_weeks.value == max(leads)}
            assert {rec["controlling_component"], *rec["tied_components"]} == tied


def test_the_limitation_says_dependencies_are_not_modelled():
    assert "no dependency" in SCHEDULE_LIMITATION.lower() and "in parallel" in SCHEDULE_LIMITATION
    assert "not a statistical confidence interval" in SCHEDULE_LIMITATION
