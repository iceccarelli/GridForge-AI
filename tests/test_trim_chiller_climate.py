"""The trim-chiller relief (``tcs_supply_achievable``) is climate-blind and cost-flat, and says so.

What this pins (the owner has reserved these engine assumptions; this test changes none of them):

* In the synthetic reference hall under full DLC the achievable-water-temperature gate fails at EVERY design dry-bulb tried
  (20, 34, 45, 60 degC), so the one relief that clears it, adiabatic assist plus a trim chiller, is taken every time, at one
  fixed library price and lead time. The racks after the ladder and the PUE used do not move with the climate.
* That relief is a lump whose cost and load depend on a heat duty the engine does not model, and PUE is a fixed library figure per architecture that is
  not recomputed for the achievable water temperature or for a trim chiller's power. Every result in which the relief is taken
  must carry that disclosure, once, in the ladder step's basis note, and the constraint's notes carry the PUE limit once.
"""
from __future__ import annotations

import pytest

from examples.reference_site import SCENARIOS, build_context
from gridforge.common import ESTIMATED, V
from gridforge.scenario import run
from gridforge.thermal.constraints import tcs_supply_achievable
from gridforge.thermal.schema import Architecture

TRIM = "tcs_supply_achievable"
#: the markers each disclosure must carry (lower-cased substring match)
LUMP_MARKER = "would depend on the heat it must reject, which is not modelled"
PUE_MARKER = "pue is not recomputed"
CLIMATES = (20, 34, 45, 60)
FULL = {s.id: s for s in SCENARIOS if s.architecture == Architecture.FULL_DLC}


def _result(scenario_id: str, drybulb: float):
    base = build_context()
    base.site.design_drybulb_C = V(drybulb, "degC", "design dry-bulb under test", ESTIMATED, band=(drybulb - 2, drybulb + 2))
    return run(base, FULL[scenario_id])


def _trim_steps(res):
    return [s for s in res.ladder.steps if s.binding_id == TRIM and s.taken]


# --------------------------------------------------------------------------------------------- current numbers, pinned
@pytest.mark.parametrize("scenario_id, racks_after", [("s4_full", 28), ("s5_full_btm", 62)])
@pytest.mark.parametrize("drybulb", CLIMATES)
def test_trim_chiller_numbers_do_not_move_with_the_climate(scenario_id, racks_after, drybulb):
    res = _result(scenario_id, drybulb)
    assert res.headline_racks == 0                      # the gate fails as found at every climate here
    assert res.unlocked_racks == racks_after
    assert res.context.pue.value == 1.2                 # PUE is the library constant, never recomputed
    steps = _trim_steps(res)
    assert len(steps) == 1
    assert steps[0].capex_eur.value == 350_000          # one fixed lump
    assert steps[0].lead_time_weeks.value == 32


def test_the_trim_chiller_price_does_not_scale_with_the_heat_it_must_reject():
    """Doubling the rack power (70 to 140 kW, so the liquid heat per rack doubles; both within the 150 kW architecture capability) leaves the lump unchanged."""
    import dataclasses
    prices = []
    for rack_kW in (70, 140):
        ctx = build_context()
        ctx.cluster.platform = dataclasses.replace(ctx.cluster.platform, rack_kW=V(rack_kW, "kW", "rack power under test", ESTIMATED))
        prices.append(_trim_steps(run(ctx, FULL["s4_full"]))[0].capex_eur.value)
    assert prices == [350_000, 350_000]


# ---------------------------------------------------------------------------------------------------- the disclosure
@pytest.mark.parametrize("scenario_id", sorted(FULL))
@pytest.mark.parametrize("drybulb", CLIMATES)
def test_every_result_taking_the_trim_chiller_discloses_the_lump_and_the_pue_limit(scenario_id, drybulb):
    res = _result(scenario_id, drybulb)
    steps = _trim_steps(res)
    assert steps, "the trim-chiller relief should be taken in every reference full-DLC case"
    for step in steps:
        note = step.basis_note.lower()
        assert note.count(LUMP_MARKER) == 1, step.basis_note
        assert note.count(PUE_MARKER) == 1, step.basis_note
        assert note.count("not scaled") == 1, step.basis_note        # the lump is described once, never repeated
        assert "would cost more" not in note                           # no unsupported claim about a sized chiller's price


@pytest.mark.parametrize("drybulb", CLIMATES)
def test_the_constraint_notes_state_the_pue_limit_once(drybulb):
    ctx = build_context()
    ctx.site.design_drybulb_C = V(drybulb, "degC", "design dry-bulb under test", ESTIMATED, band=(drybulb - 2, drybulb + 2))
    ctx.architecture = Architecture.FULL_DLC
    notes = " ".join(tcs_supply_achievable(ctx).notes).lower()
    assert notes.count(PUE_MARKER) == 1, notes
