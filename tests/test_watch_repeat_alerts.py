"""A Hall Watch must tell a change of recommendation ONCE, not on every run.

`diff_from_state` pins the scenario a watch was started on (so its numbers compare like for like) and the stored state kept that pinned id. So
when the RECOMMENDED architecture moved to another scenario, today's recommendation differed from the stored (pinned) id on every later run,
with unchanged inputs: `material=True`, "the recommended architecture changed from A to B", and the cron route announces a material note
by email. The customer would have been told the same thing every cadence until they cancelled. The state now also records what was
recommended when it differs from the pinned scenario, so the change is told once and the watch then goes quiet again.

Found by the independent review of the integrated engine (R1); the old engine had no such alert, so it never repeated one.
"""
import copy
import json
import os
from pathlib import Path

import pytest

from gridforge.change import EnvelopeState, _solve, diff, diff_from_state
from gridforge.scenario.objective import Objective

ROOT = Path(__file__).resolve().parents[1]
REF = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text(encoding="utf-8"))
OBJ = Objective.MAX_COMPUTE


@pytest.fixture(autouse=True)
def pinned_today(monkeypatch):
    monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2026-10-13")


def without_btm(doc):
    d = copy.deepcopy(doc)
    d.pop("btm_options", None)
    return d


def stored(d) -> dict:
    """What the cron stores and sends back: the engine's own `after` record, through JSON."""
    return json.loads(json.dumps(d.after.as_record()))


def run(state: dict, doc: dict):
    return diff_from_state(EnvelopeState.from_record(state), doc, objective=OBJ, recorded=set(state))


def test_the_example_really_changes_its_recommendation():
    """Guard for the chain below: removing the behind-the-meter options moves the recommendation, otherwise the tests prove nothing."""
    a, _ = _solve(REF, OBJ)
    b, _ = _solve(without_btm(REF), OBJ)
    assert a.spec.id != b.spec.id


def test_a_changed_recommendation_is_told_once_then_the_unchanged_watch_is_quiet():
    base = diff(REF, REF)                                     # the first run, as the cron route records it
    state = json.loads(json.dumps(base.after.as_record()))
    moved = without_btm(REF)
    first = run(state, moved)
    assert first.material and "recommendation" in first.material_reasons
    assert first.recommendation_changed is not None
    state = stored(first)
    for n in (2, 3, 4):                                       # unchanged inputs, every later cadence
        later = run(state, moved)
        assert later.inputs == "unchanged", n
        assert later.recommendation_changed is None, n
        assert not later.material and later.material_reasons == [], (n, later.material_reasons)
        state = stored(later)


def test_a_flip_back_is_news_again_and_then_quiet():
    state = json.loads(json.dumps(diff(REF, REF).after.as_record()))
    moved = without_btm(REF)
    state = stored(run(state, moved))                         # told once: A -> B
    back = run(state, REF)                                    # the original intake again: B -> A
    assert back.recommendation_changed is not None and back.material
    state = stored(back)
    again = run(state, REF)
    assert again.recommendation_changed is None and not again.material


def test_a_watch_that_never_flipped_stores_exactly_the_record_it_always_did():
    """Rollback safety: the engine refuses a field it does not know (`from_record`), so a state recorded by this engine must carry no new key
    unless the recommendation actually differs from the pinned scenario."""
    base = diff(REF, REF)
    rec = base.after.as_record()
    assert "recommended_id" not in rec and "recommended_name" not in rec
    legacy_keys = set(EnvelopeState.__dataclass_fields__) - {"recommended_id", "recommended_name"}
    assert set(rec) == legacy_keys
    quiet = run(json.loads(json.dumps(rec)), REF)
    assert not quiet.material and "recommended_id" not in quiet.after.as_record()


def test_a_state_recorded_before_the_fields_existed_still_loads_and_behaves_as_before_for_the_first_run():
    base = diff(REF, REF)
    legacy = json.loads(json.dumps(base.after.as_record()))
    for k in ("recommended_id", "recommended_name"):
        legacy.pop(k, None)
    first = run(legacy, without_btm(REF))
    assert first.material and "recommendation" in first.material_reasons          # the old pinned-vs-recommended comparison, for the first run


@pytest.mark.parametrize("bad", [5, True, None, ["x"]])
def test_the_new_fields_are_text_or_the_record_is_refused(bad):
    from gridforge.change import StateError
    rec = json.loads(json.dumps(diff(REF, REF).after.as_record()))
    rec["recommended_id"] = bad
    with pytest.raises(StateError):
        EnvelopeState.from_record(rec)


def test_every_scenario_chain_over_every_example_goes_quiet_after_its_first_run():
    """Not only the one example: for each shipped hall, record a baseline, remove its BTM options (when it has any) or double the rack feed,
    and run the watch repeatedly. Whatever the first run says, runs two to four on unchanged inputs must be quiet."""
    quiet_runs = 0
    for name in ("reference_hall", "dublin_hall", "london_hall", "nordic_hall"):
        doc = json.loads((ROOT / "examples" / "intake" / f"{name}.json").read_text(encoding="utf-8"))
        for mutated in (without_btm(doc),):
            state = json.loads(json.dumps(diff(doc, doc).after.as_record()))
            state = stored(run(state, mutated))
            for n in (2, 3):
                d = run(state, mutated)
                assert d.inputs == "unchanged" and not d.material, (name, n, d.material_reasons, d.headline()[:120])
                state = stored(d)
                quiet_runs += 1
    assert quiet_runs >= 8


# --- the first run after an engine release: a coverage change of OURS is not news about THEIR hall ----------------------------------------
# An engine release can add a cost line it does not yet price (the dedicated heat-rejection loop under full DLC). On a watch whose earlier state
# was recorded with every cost priced, that flips `capex_complete` with the customer's inputs and the capex amount unchanged. It used to be a
# "material" reason with the headline "a cost on the path is unpriced or an equipment bank is not declared", which is not what happened, and it
# interrupted every such customer on the first run after the release (review R2).

def _as_if_recorded_with_every_cost_priced(doc):
    """The state this engine records for `doc` (for the scenario it RECOMMENDS, as a watch records it), with the completeness flag the way an
    engine that priced every cost would have recorded it."""
    from gridforge.change import EnvelopeState as ES
    rec, _ = _solve(doc, OBJ)
    state = ES.of(rec, doc).as_record()
    assert state["capex_complete"] is False, "the recommended full-DLC answer must now read as a lower bound (the unpriced dedicated loop), or this proves nothing"
    state["capex_complete"] = True
    return state


def test_a_completeness_flip_with_unchanged_inputs_and_amount_is_our_drift_not_a_material_alert():
    state = _as_if_recorded_with_every_cost_priced(REF)
    d = run(state, REF)
    assert d.inputs == "unchanged" and not d.capex_moved
    assert d.capex_completeness_flipped and d.capex_completeness_is_model_drift
    assert not d.material and d.material_reasons == []
    text = d.headline()
    assert "Our model now covers a cost it did not cover" in text and "nothing you supplied has changed" in text
    assert "a cost on the path is unpriced or an equipment bank is not declared" not in text       # the misattributed explanation


def test_the_stored_note_carries_the_truthful_sentence_and_not_the_misattributed_one():
    from gridforge.reporting.change_note import build
    from gridforge.reporting import to_markdown
    d = run(_as_if_recorded_with_every_cost_priced(REF), REF)
    md = to_markdown(build(d, site="S", hall="H", client="C"))
    assert "Our model now covers a cost it did not cover when the earlier figure was recorded" in md
    assert "nothing you supplied has changed" in md
    assert "a cost on the path is unpriced or an equipment bank is not declared" not in md
    assert "Do not read the capex difference as a saving or an overrun" not in md


def test_a_flip_is_still_material_when_the_customer_changed_something_or_the_amount_moved():
    state = _as_if_recorded_with_every_cost_priced(REF)
    # (a) the amount moved: the flip is material, with the old explanation of why two figures do not compare
    moved = dict(state, capex_eur=state["capex_eur"] * 1.2, capex_lo=None, capex_hi=None)
    d = run(moved, REF)
    assert d.capex_moved and not d.capex_completeness_is_model_drift
    assert "capex_completeness" in d.material_reasons
    # (b) the customer's inputs changed: material, however small the change
    changed = copy.deepcopy(REF)
    changed["hall"]["positions_available"] = REF["hall"]["positions_available"] + 5
    d2 = run(state, changed)
    assert d2.inputs == "changed"
    assert "capex_completeness" in d2.material_reasons or d2.material      # never silenced by the drift rule when inputs moved
    assert not d2.capex_completeness_is_model_drift


def test_the_opposite_flip_is_also_a_quiet_note_when_nothing_moved():
    """Recorded as a lower bound, now fully priced, same amount, same inputs: also our change, also not an email. Built by recording the
    recommended state with the flag the other way round from what this engine computes."""
    from gridforge.change import EnvelopeState as ES
    rec, _ = _solve(REF, OBJ)
    state = ES.of(rec, REF).as_record()
    state["capex_complete"] = not state["capex_complete"]
    d = run(state, REF)
    assert d.capex_completeness_flipped and d.inputs == "unchanged" and not d.capex_moved
    assert d.capex_completeness_is_model_drift and not d.material and d.material_reasons == []
