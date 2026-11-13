"""A change note must not say "nothing changed" when the basis of the answer changed.

Found by running the real handler (/v1/diff) on the shipped example halls:

  A. dublin_hall with btm_options[0].lead_time_weeks deleted: the date goes from 160 weeks to none, and the answer was
     "Nothing that changes the answer. The envelope, the binding constraint and the date all hold."
  B. nordic_hall, scenarios [hybrid_dlc], ups[0].unit_rating_kW 1200 -> 1000: the racks usable as found fall from 3 to 0 and
     the answer was the same sentence.

`material` ignored a date appearing or vanishing (weeks_delta is None unless both sides have one), the racks usable as found,
a schedule or capex that stopped being complete, and a changed recommendation on the recorded-state path. A recorded state
with no evidence fingerprint was read as "the evidence changed", which made the first scheduled run of an older watch cry wolf.

Every test goes through the real solver and the real handler or document builder. No fixture is data about a real asset.
"""
from __future__ import annotations

import copy
import json
from dataclasses import replace
from pathlib import Path

import pytest

from gridforge.api.server import Tier, handle_diff
from gridforge.change import EnvelopeDiff, EnvelopeState, diff, diff_from_state, evidence_digest
from gridforge.reporting import to_markdown
from gridforge.reporting.change_note import build as build_note
from gridforge.reporting.gates import run_all_gates

ROOT = Path(__file__).resolve().parents[1]
INTAKES = ROOT / "examples" / "intake"


def doc(name: str) -> dict:
    return json.loads((INTAKES / f"{name}_hall.json").read_text())


REFERENCE, DUBLIN, LONDON, NORDIC = (doc(n) for n in ("reference", "dublin", "london", "nordic"))
HALLS = {"reference": REFERENCE, "dublin": DUBLIN, "london": LONDON, "nordic": NORDIC}


def post(body: dict) -> dict:
    return handle_diff(body, Tier.CLIENT)


def state_of(d: dict) -> EnvelopeState:
    return diff(d, copy.deepcopy(d), attribute=False).after


def without_lead_time() -> dict:
    after = copy.deepcopy(DUBLIN)
    del after["btm_options"][0]["lead_time_weeks"]
    return after


def hybrid_with_smaller_ups() -> tuple[dict, dict]:
    before = copy.deepcopy(NORDIC)
    before["scenarios"] = ["hybrid_dlc"]
    after = copy.deepcopy(before)
    after["ups"][0]["unit_rating_kW"] = 1000
    return before, after


def note_md(d: EnvelopeDiff) -> str:
    report = build_note(d, site="S", hall="H", client="C")
    md = to_markdown(report)
    run_all_gates(report, md)           # the disclosure gates must still pass on the new wording
    return md


def pair(before: EnvelopeState, **changes) -> EnvelopeDiff:
    """A diff whose only difference between the two sides is `changes`: isolates one property of `material`."""
    return EnvelopeDiff(before=before, after=replace(before, **changes))


# ---- A. the date vanishes ---------------------------------------------------------------------------------------------------
def test_a_date_that_vanishes_is_material_and_the_headline_says_what_it_means():
    out = post({"before": DUBLIN, "after": without_lead_time()})
    assert out["before"]["weeks_to_full"] == 160.0 and out["after"]["weeks_to_full"] is None      # premise: the reproduced case
    assert out["material"] is True
    assert "Nothing that changes the answer" not in out["headline"]
    low = out["headline"].lower()
    assert "the date has gone" in low and "no longer carries a delivery date" in low
    assert "date_vanished" in out["material_reasons"]


def test_the_change_note_for_a_vanished_date_does_not_say_no_action_and_names_the_next_step():
    out = post({"before": DUBLIN, "after": without_lead_time(), "format": "md"})
    md = out["document"]
    assert "No action" not in md and "Nothing that changes the answer" not in md
    assert "lead time" in md.lower() and "do not quote" in md.lower()


def test_the_vanished_date_is_found_on_the_recorded_state_path_too():
    recorded = post({"before": DUBLIN, "after": DUBLIN})["after"]
    out = post({"previous_state": recorded, "after": without_lead_time()})
    assert out["material"] is True and "date_vanished" in out["material_reasons"]


def test_a_date_that_appears_is_material_and_says_it_is_new():
    out = post({"before": without_lead_time(), "after": DUBLIN})
    assert out["before"]["weeks_to_full"] is None and out["after"]["weeks_to_full"] == 160.0
    assert out["material"] is True and "date_appeared" in out["material_reasons"]
    low = out["headline"].lower()
    assert "a date now exists" in low
    assert "assumed lead time, not a date" in low        # never a bare number of weeks over an assumption


@pytest.mark.parametrize("name", sorted(HALLS))
def test_materiality_is_symmetric_for_the_date_flags(name):
    """Metamorphic: swapping before and after cannot turn a material change into 'nothing' (a vanished date is an appeared one reversed)."""
    d = copy.deepcopy(HALLS[name])
    if not d.get("btm_options"):
        pytest.skip("no behind-the-meter option to strip a lead time from")
    d2 = copy.deepcopy(d)
    d2["btm_options"][0].pop("lead_time_weeks", None)
    fwd, back = diff(d, d2, attribute=False), diff(d2, d, attribute=False)
    assert fwd.material == back.material
    assert {fwd.date_vanished, fwd.date_appeared} == {back.date_appeared, back.date_vanished}


# ---- B. racks usable as found -----------------------------------------------------------------------------------------------
def test_racks_usable_as_found_changing_is_material_even_when_the_capacity_after_works_holds():
    before, after = hybrid_with_smaller_ups()
    out = post({"before": before, "after": after})
    assert (out["before"]["racks_as_found"], out["after"]["racks_as_found"]) == (3, 0)           # premise: the reproduced case
    assert out["racks_delta"] == 0
    assert out["material"] is True and "racks_as_found" in out["material_reasons"]
    low = out["headline"].lower()
    assert "nothing that changes the answer" not in low
    assert "as found" in low and "3 to 0" in low
    assert "wait for the relief works" in low and "holds at" in low     # the effect on the decision, not just that a field moved


def test_racks_as_found_rising_says_less_waits_on_works():
    before, after = hybrid_with_smaller_ups()
    out = post({"before": after, "after": before})
    assert out["material"] is True
    assert "rose from 0 to 3" in out["headline"] and "no longer wait" in out["headline"]


def test_the_note_for_a_changed_as_found_count_is_not_a_no_action_note():
    before, after = hybrid_with_smaller_ups()
    md = post({"before": before, "after": after, "format": "md"})["document"]
    assert "No action" not in md and "as found" in md.lower()


# ---- the flags, one at a time -----------------------------------------------------------------------------------------------
@pytest.fixture(scope="module")
def ref_state() -> EnvelopeState:
    return state_of(REFERENCE)


def test_a_schedule_that_stops_being_complete_is_material(ref_state):
    d = pair(ref_state, schedule_complete=False)
    assert d.material and "schedule_completeness" in d.material_reasons
    assert "lead time" in d.headline().lower() and "Nothing that changes" not in d.headline()


def test_a_schedule_that_becomes_complete_is_material(ref_state):
    d = pair(replace(ref_state, schedule_complete=False), schedule_complete=True)
    assert d.material and "now has a lead time" in d.headline()


def test_capex_stopping_being_complete_is_material_and_is_not_a_saving(ref_state):
    full = replace(ref_state, capex_complete=True)
    d = EnvelopeDiff(before=full, after=replace(full, capex_complete=False))
    assert d.material and "capex_completeness" in d.material_reasons
    low = d.headline().lower()
    assert "lower bound" in low and "no longer covers" in low


def test_capex_becoming_complete_says_a_rise_is_better_coverage_not_a_price_rise(ref_state):
    d = pair(replace(ref_state, capex_complete=False), capex_complete=True)
    assert d.material
    assert "no longer a lower bound" in d.headline() and "not a price rise" in d.headline()


def test_an_unchanged_state_is_not_material(ref_state):
    d = pair(ref_state)
    assert not d.material and d.material_reasons == []


def test_racks_as_found_alone_is_material(ref_state):
    d = pair(ref_state, racks_as_found=ref_state.racks_as_found + 4)
    assert d.material and d.material_reasons == ["racks_as_found"]


# ---- recommendation_changed on the recorded-state path ----------------------------------------------------------------------
def test_a_changed_recommendation_is_set_when_diffing_against_a_recorded_state():
    after = copy.deepcopy(REFERENCE)
    after["btm_options"] = []
    from_docs = diff(REFERENCE, after, attribute=False)
    assert from_docs.recommendation_changed is not None                        # premise: this edit moves the recommendation
    from_state = diff_from_state(state_of(REFERENCE), after)
    assert from_state.recommendation_changed is not None
    assert from_state.recommendation_changed[0] != from_state.recommendation_changed[1]
    assert from_state.material and "recommendation" in from_state.material_reasons
    assert "recommended architecture changed" in from_state.headline()


def test_an_unchanged_recommendation_is_not_reported_on_the_recorded_state_path():
    assert diff_from_state(state_of(REFERENCE), REFERENCE).recommendation_changed is None


# ---- P3: a missing recorded evidence fingerprint is unknown, not changed -----------------------------------------------------
def test_a_blank_recorded_evidence_digest_is_unknown_not_changed():
    st = replace(state_of(REFERENCE), evidence_digest="")
    assert evidence_digest(REFERENCE) != ""          # premise: the hall declares evidence
    d = diff_from_state(st, REFERENCE)
    assert not d.evidence_digest_changed and not d.evidence_moved
    assert d.evidence_unrecorded
    assert d.inputs == "unchanged"                    # the values are verified; only the evidence classes cannot be compared
    assert not d.material
    assert "no earlier evidence record to compare" in d.headline()


def test_an_absent_evidence_digest_in_the_posted_record_is_unknown_not_changed():
    recorded = post({"before": REFERENCE, "after": REFERENCE})["after"]
    del recorded["evidence_digest"]
    out = post({"previous_state": recorded, "after": REFERENCE})
    assert out["material"] is False and "evidence_digest" not in out["material_reasons"]
    assert any("evidence" in x for x in out["not_compared"])
    assert "no earlier evidence record to compare" in out["headline"]


def test_the_note_says_the_evidence_could_not_be_compared():
    st = replace(state_of(REFERENCE), evidence_digest="")
    md = note_md(diff_from_state(st, REFERENCE))
    assert "no earlier evidence record to compare" in md


def test_a_recorded_evidence_digest_that_differs_is_still_a_change():
    st = replace(state_of(REFERENCE), evidence_digest="0123456789abcdef")
    d = diff_from_state(st, REFERENCE)
    assert d.evidence_digest_changed and d.material and not d.evidence_unrecorded


def test_a_hall_recorded_with_no_declared_evidence_can_still_see_evidence_arrive():
    """The blank digest used to mean both 'none declared' and 'not recorded'. A state recorded from a document now carries a digest of the
    empty set, so a first declaration is detected, while a truly blank record stays unknown."""
    assert LONDON.get("grid") and evidence_digest(LONDON) != ""
    st = state_of(LONDON)
    assert st.evidence_digest != ""
    declared = copy.deepcopy(LONDON)
    declared["grid"]["contracted_MW"] = {"value": LONDON["grid"]["contracted_MW"], "evidence": "E5"}
    d = diff_from_state(st, declared)
    assert d.evidence_digest_changed and d.material


# ---- an older record that does not carry a flag is not read as "the flag was true" ----------------------------------------------
def test_flags_missing_from_an_older_record_are_not_compared():
    recorded = post({"before": DUBLIN, "after": DUBLIN})["after"]
    assert recorded["capex_complete"] is False                      # premise: dublin's capex is a lower bound today
    for k in ("schedule_complete", "capex_complete"):
        del recorded[k]                                               # a state recorded before these fields existed
    out = post({"previous_state": recorded, "after": DUBLIN})
    assert out["material"] is False
    joined = " ".join(out["not_compared"])
    assert "capex" in joined and "schedule" in joined and "earlier record" in joined


# ---- no false alarms: a hall compared with its own record is nothing, and says what was compared ------------------------------
@pytest.mark.parametrize("name", sorted(HALLS))
def test_a_hall_against_its_own_recorded_state_is_not_material_and_lists_what_was_compared(name):
    d = HALLS[name]
    recorded = post({"before": d, "after": d})["after"]
    out = post({"previous_state": recorded, "after": d})
    assert out["material"] is False and out["material_reasons"] == [] and out["not_compared"] == []
    h = out["headline"]
    assert h.startswith("Nothing that changes the answer.")
    for fragment in ("racks as found", "racks after works", "what binds first", "date", "capex", "evidence"):
        assert fragment in h.lower(), fragment


def test_a_non_material_note_repeats_what_was_compared():
    md = note_md(diff(REFERENCE, copy.deepcopy(REFERENCE), attribute=False))
    assert "Compared with the earlier answer" in md and "racks as found" in md.lower()
    assert "No action" in md
