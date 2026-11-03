"""Properties of the time-to-power schedule, on random ladders and on the real engine (seeded; no new dependency).

  1. a larger lead time never produces an earlier date;
  2. adding a parallel item that does not control the date never moves it;
  3. a missing lead time never produces a date (not zero, not the longest known one).
"""
import copy
import json
import random
from pathlib import Path
from types import SimpleNamespace

import pytest

from gridforge.envelope.solver import HeadroomLadder, LadderStep
from gridforge.envelope.time_to_power import (
    DATE_BASIS_NONE, date_basis, date_record, full_capacity_band, schedule)
from gridforge.intake.loader import load_document
from gridforge.scenario.run import run_all
from gridforge.validation import EvidenceClass, Quantity

ROOT = Path(__file__).resolve().parent.parent
BASE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())
E0 = EvidenceClass.E0_ASSUMPTION


def lead(w):
    return None if w is None else Quantity.given(w, "weeks", "lead", E0, band=(w * 0.65, w * 1.35))


def step(i, name, racks_before, racks_after, w):
    return LadderStep(i, name.lower(), name, "electrical", racks_before, racks_after, "", "relief", None, lead(w))


def ladder(spec, start=0):
    """spec: [(name, racks_after, weeks)] in order; racks_after must be non-decreasing."""
    steps, before = [], start
    for i, (name, after, w) in enumerate(spec, 1):
        steps.append(step(i, name, before, after, w))
        before = after
    return HeadroomLadder(steps=steps, initial=SimpleNamespace(max_racks=start),
                          final=SimpleNamespace(max_racks=before))


def random_spec(rng):
    n = rng.randint(1, 7)
    racks, spec = 0, []
    for i in range(n):
        racks += rng.randint(1, 9)
        spec.append((f"Item {i}", racks, float(rng.randint(1, 300))))
    return spec


def date(lad):
    return schedule(lad).weeks_to_full


# --- 1. a larger lead time never gives an earlier date ---------------------------------------------------------------------------

def test_synthetic_a_larger_lead_time_never_gives_an_earlier_date():
    rng = random.Random(107)
    for _ in range(400):
        spec = random_spec(rng)
        k = rng.randrange(len(spec))
        name, after, w = spec[k]
        base = date(ladder(spec))
        for bump in (1.0, 7.0, 90.0):
            longer = list(spec)
            longer[k] = (name, after, w + bump)
            assert date(ladder(longer)) >= base, (spec, k, bump)


def test_synthetic_the_date_is_the_longest_lead_time_and_is_one_of_them():
    rng = random.Random(1)
    for _ in range(200):
        spec = random_spec(rng)
        lad = ladder(spec)
        weeks = date(lad)
        assert weeks == max(w for _, _, w in spec)
        lo, hi = full_capacity_band(lad, schedule(lad))[1:3]
        assert lo <= weeks <= hi


@pytest.mark.parametrize("weeks", [[10, 52, 100, 160, 300, 400]])
def test_engine_a_larger_supplied_transformer_lead_time_never_gives_an_earlier_date(weeks):
    previous: dict[str, float] = {}
    for w in weeks:
        doc = copy.deepcopy(BASE)
        doc["transformers"][0]["replacement_lead_time_weeks"] = w
        intake = load_document(doc)
        for res in run_all(intake.context, intake.scenarios):
            d = date(res.ladder)
            if d is None:
                continue
            assert d >= previous.get(res.spec.id, 0.0), (res.spec.id, w, d, previous.get(res.spec.id))
            previous[res.spec.id] = d
    assert previous            # something was dated


# --- 2. a parallel item that does not control the date never moves it -------------------------------------------------------------

def test_synthetic_adding_a_parallel_non_controlling_item_never_moves_the_date():
    rng = random.Random(2)
    for _ in range(400):
        spec = random_spec(rng)
        base_lad = ladder(spec)
        base, ttp = date(base_lad), schedule(base_lad)
        final_racks = spec[-1][1]
        shorter = float(rng.randint(1, int(base)))                 # at most the controlling lead time
        for grown in ([("Extra", 0, shorter), *spec],          # first, adding no racks of its own
                      [*spec, ("Extra", final_racks, shorter)]):  # last, adding no racks of its own
            lad = ladder(grown)
            assert date(lad) == base, (spec, shorter)
            if shorter < base:          # an equal lead time ties; the first among equals is named, the date is the same
                assert schedule(lad).critical_item == ttp.critical_item


def test_synthetic_a_tied_item_leaves_the_date_and_is_named_as_tied():
    spec = [("A", 4, 60.0), ("B", 9, 120.0)]
    lad = ladder(spec + [("C", 9, 120.0)])
    assert date(lad) == 120.0
    rec = date_record(lad)
    assert rec["status"] == "dated"
    assert {rec["controlling_component"], *rec["tied_components"]} == {"B", "C"}


def test_engine_adding_a_short_parallel_relief_to_the_real_ladder_does_not_move_the_date():
    intake = load_document(copy.deepcopy(BASE))
    for res in run_all(intake.context, intake.scenarios):
        lad = res.ladder
        base = date(lad)
        if base is None or not lad.taken_steps:
            continue
        before_item = schedule(lad).critical_item
        shortest = min(s.lead_time_weeks.value for s in lad.taken_steps)
        extra = LadderStep(len(lad.steps) + 1, "extra", "Extra", "electrical", lad.final.max_racks, lad.final.max_racks,
                           "", "parallel relief", None, lead(shortest))
        grown = HeadroomLadder(steps=[*lad.steps, extra], initial=lad.initial, final=lad.final)
        assert date(grown) == base and schedule(grown).critical_item == before_item


# --- 3. a missing lead time never produces a date --------------------------------------------------------------------------------

def test_synthetic_a_missing_lead_time_never_produces_a_date():
    rng = random.Random(3)
    for _ in range(400):
        spec = random_spec(rng)
        k = rng.randrange(len(spec))
        spec[k] = (spec[k][0], spec[k][1], None)
        lad = ladder(spec)
        ttp = schedule(lad)
        assert ttp.complete is False
        assert ttp.weeks_to_full is None and ttp.weeks_to_first_rack is None
        assert full_capacity_band(lad, ttp) is None
        assert date_basis(lad, ttp).basis == DATE_BASIS_NONE
        rec = date_record(lad, ttp)
        assert rec["status"] == "lead_time_missing" and rec["controlling_component"] is None
        assert rec["date_interval_weeks"] is None and rec["missing_inputs"] == [f"lead time: {spec[k][0]}"]


def test_engine_removing_any_one_taken_lead_time_removes_the_date():
    intake = load_document(copy.deepcopy(BASE))
    checked = 0
    for res in run_all(intake.context, intake.scenarios):
        for victim in range(len(res.ladder.taken_steps)):
            r = copy.deepcopy(res)
            r.ladder.taken_steps[victim].lead_time_weeks = None
            ttp = schedule(r.ladder)
            assert ttp.weeks_to_full is None and full_capacity_band(r.ladder, ttp) is None
            assert date_record(r.ladder, ttp)["status"] in ("lead_time_missing", "no_deployable_racks")
            checked += 1
    assert checked > 10


def test_a_ladder_that_is_deployable_as_found_and_has_no_steps_is_dated_zero_not_missing():
    lad = HeadroomLadder(steps=[], initial=SimpleNamespace(max_racks=12), final=SimpleNamespace(max_racks=12))
    ttp = schedule(lad)
    assert ttp.weeks_to_first_rack == 0.0 and ttp.complete
