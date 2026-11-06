"""A relief must never lower capacity.

Defect (stress review, 2026-11-06): the busway relief and the tap-off relief assigned ``tapoff_max_A = 400`` unconditionally.
On a hall whose installed tap-offs were rated ABOVE 400 A (a 230 V single-phase hall needs about 618 A per rack, so a 630 A
tap-off is the right part) the "replace the busway" relief swapped the 630 A tap-offs for 400 A ones, the rack-feed gate failed, and
the ladder reported a plan that took the hall from 5 racks to 0. A relief that makes the hall worse is not a relief.

Every expected number below is written out from the raw intake figures (rack kW, voltage, power factor, busway rating), not read
back from the helper that the engine itself uses to scale the rack feed current.
"""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path

import pytest

from gridforge.common import ASSUMED, V
from gridforge.constraints import ConstraintResult, ReliefOption
from gridforge.envelope import ladder, solve
from gridforge.envelope import solver as solver_mod
from gridforge.intake.loader import load, load_document
from gridforge.power.constraints import busway_ampacity, rack_feed_tapoff
from gridforge.scenario import run_all

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = sorted((ROOT / "examples" / "intake").glob("*.json"))
DUBLIN = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text(encoding="utf-8"))

RACK_KW = 135.0           # GB300 NVL72 rack TDP, the library platform every example intake names
LIBRARY_FEED_A_AT_400V_3PH = 205.0


def _hall(tapoff: float, busway: float, *, volts: float = 230, phases: int = 1) -> dict:
    d = copy.deepcopy(DUBLIN)
    d["lv"].update(voltage_V=volts, phases=phases, busway_ampacity_A=busway, tapoff_max_A=tapoff)
    return d


# --- the hand calculation of what a rack needs on this feed --------------------------------------------------------------
def test_hand_calculation_of_the_tap_off_a_230v_single_phase_rack_needs():
    # P / (V x pf) with the rack's own power factor taken as 0.95 (the figure that makes the library's 205 A at 400 V three-phase):
    # 135,000 W / (230 V x 0.95) = 617.9 A. The library figure scaled by voltage and phase: 205 x 400 x sqrt(3) / 230 = 617.5 A.
    from_power = RACK_KW * 1000.0 / (230.0 * 0.95)
    from_library = LIBRARY_FEED_A_AT_400V_3PH * 400.0 * math.sqrt(3.0) / 230.0
    assert from_power == pytest.approx(617.9, abs=0.1)
    assert from_library == pytest.approx(617.5, abs=0.1)
    assert from_power == pytest.approx(from_library, rel=0.01)
    # So a 630 A tap-off carries the rack and a 400 A one cannot: the relief's rating is the part that matters.
    assert 400.0 < from_library < 630.0
    ctx = load_document(_hall(tapoff=630, busway=400)).context
    gate = rack_feed_tapoff(ctx)
    assert gate.racks == math.inf and "618" in gate.basis      # the need is stated in the basis (617.5 A, rendered rounded)
    assert rack_feed_tapoff(load_document(_hall(tapoff=400, busway=400)).context).racks == 0


def test_hand_calculation_of_the_busway_racks():
    # Per run: 230 V x 400 A x 0.8 x 0.97 (grid power factor) = 71.4 kW (single phase: no sqrt 3); 10 runs pooled = 714.0 kW;
    # 714.0 / 135 = 5.29 -> 5 racks.
    doc = _hall(tapoff=630, busway=400)
    runs, util, pf = doc["lv"]["busway_runs"], doc["lv"]["busway_utilisation_limit"], doc["grid"]["power_factor"]
    total_kW = runs * 230.0 * 400.0 * util * pf / 1000.0
    assert total_kW == pytest.approx(714.0, abs=0.1)
    assert busway_ampacity(load_document(doc).context).racks == math.floor(total_kW / RACK_KW) == 5


# --- the defect, at both levels --------------------------------------------------------------------------------------------
def test_the_busway_relief_does_not_swap_a_630a_tap_off_for_a_400a_one():
    ctx = load_document(_hall(tapoff=630, busway=400)).context
    relieved = busway_ampacity(ctx).relief.apply(ctx)
    assert relieved.power.lv.busway_ampacity_A.value == 1000
    assert relieved.power.lv.tapoff_max_A.value == 630            # base b649b3e: 400
    assert rack_feed_tapoff(relieved).racks == math.inf          # base: 0


def test_the_busway_relief_still_raises_a_weaker_tap_off_to_400a():
    ctx = load_document(_hall(tapoff=63, busway=400, volts=400, phases=3)).context
    relieved = busway_ampacity(ctx).relief.apply(ctx)
    assert relieved.power.lv.tapoff_max_A.value == 400
    assert relieved.power.lv.tapoff_max_A.evidence <= ASSUMED


def test_the_tap_off_relief_never_lowers_the_rating():
    ctx = load_document(_hall(tapoff=500, busway=400)).context     # 500 A is below the 617.5 A needed, so the gate fails
    res = rack_feed_tapoff(ctx)
    assert res.racks == 0
    assert res.relief.apply(ctx).power.lv.tapoff_max_A.value == 500     # base: 400, a LOWER rating than the one installed
    weak = load_document(_hall(tapoff=63, busway=400, volts=400, phases=3)).context
    assert rack_feed_tapoff(weak).relief.apply(weak).power.lv.tapoff_max_A.value == 400


def test_the_dublin_single_phase_hall_keeps_its_racks_through_the_ladder():
    lad = ladder(load_document(_hall(tapoff=630, busway=400)).context)
    assert lad.initial.max_racks == 5
    assert lad.final.max_racks >= 5            # base: 0
    assert all(s.racks_after >= s.racks_before for s in lad.taken_steps)


# --- 4 x 4 grid: no combination of installed ratings can make the plan worse than the hall as found -----------------------
@pytest.mark.parametrize("tapoff", [63, 250, 400, 630])
@pytest.mark.parametrize("busway", [250, 400, 630, 1000])
@pytest.mark.parametrize("volts, phases", [(230, 1), (400, 3)])
def test_after_ladder_racks_are_never_below_as_found(tapoff, busway, volts, phases):
    intake = load_document(_hall(tapoff, busway, volts=volts, phases=phases))
    for r in run_all(intake.context, intake.scenarios):
        lad = r.ladder
        assert lad.final.max_racks >= lad.initial.max_racks, (r.spec.id, tapoff, busway, [
            (s.binding_id, s.racks_before, s.racks_after, s.taken) for s in lad.steps])
        for s in lad.taken_steps:
            assert s.racks_after >= s.racks_before, (r.spec.id, s.binding_id, s.racks_before, s.racks_after)


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.stem)
def test_every_shipped_example_never_loses_racks_in_the_ladder(path):
    intake = load(path)
    for r in run_all(intake.context, intake.scenarios):
        assert r.ladder.final.max_racks >= r.ladder.initial.max_racks, (path.stem, r.spec.id)
        assert all(s.racks_after >= s.racks_before for s in r.ladder.taken_steps)


def test_the_reference_hall_on_a_630a_single_phase_feed():
    d = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text(encoding="utf-8"))
    d["lv"].update(voltage_V=230, phases=1, busway_ampacity_A=400, tapoff_max_A=630)
    intake = load_document(d)
    for r in run_all(intake.context, intake.scenarios):
        assert r.ladder.final.max_racks >= r.ladder.initial.max_racks, r.spec.id
        assert r.ladder.final.max_racks > 0 or r.ladder.initial.max_racks == 0


# --- the ladder's own guard: a relief that WOULD lower capacity is rejected, whoever wrote it ------------------------------
def test_the_ladder_rejects_a_relief_that_would_lower_the_rack_count(monkeypatch):
    base = load_document(_hall(tapoff=630, busway=400)).context

    def toy(ctx):
        racks = math.floor(ctx.power.lv.tapoff_max_A.value / 100.0)        # 630 A -> 6 racks

        def worse(c):
            c = c.copy()
            c.power.lv.tapoff_max_A = V(200, "A", "a relief that lowers the rating", ASSUMED)   # 2 racks
            return c

        return ConstraintResult(
            "toy", "electrical", "Toy", V(float(racks), "racks", "toy racks", ASSUMED), basis="toy",
            relief=ReliefOption("lower it", capex_eur=None, lead_time_weeks=V(10, "weeks", "toy lead", ASSUMED), apply=worse))

    monkeypatch.setattr(solver_mod, "all_constraints", lambda: [toy])
    assert solve(base).max_racks == 6
    lad = ladder(base)
    assert lad.final.max_racks == 6
    assert lad.taken_steps == []
    step = lad.steps[0]
    assert step.taken is False and step.racks_after == step.racks_before == 6
    assert "lower" in step.not_taken_reason and "6" in step.not_taken_reason and "2" in step.not_taken_reason
