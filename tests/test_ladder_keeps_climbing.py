"""The ladder keeps climbing while a relief is still closing a shortfall, so an undersized plant is not lost (review E2).

A relief is a fixed increment (two UPS modules in ONE block, one CDU unit, a 60% transformer uprate). When the protected load exceeds the usable UPS by
more than one increment the first rung only SHRINKS a negative headroom: `max_racks` stays 0, the binding constraint stays the same, and the stop rule
read that as "this relief earns nothing, the ladder has converged". The reference hall with `ups` = 4 blocks x {1200 kW, 2 units, N+1} under a 9.0 MW
protected load went from 8 / 9 / 43 racks (hybrid DLC / full DLC / full DLC + BTM, back when a rung bought modules in every block at once) to 0 / 0 / 0
with ups_capacity binding. The ladder now keeps climbing while the binding constraint's own capacity strictly rises and the hall is still at zero
racks (`ConstraintResult.margin_racks`); the step budget is the only backstop.

The expectations are derived, not recorded: a UPS shortfall is closable by buying modules, so an undersized UPS can never lower the CEILING of the hall,
which is what the same hall reaches with the UPS schedule left out (nothing limiting there). The six plants the reviewer's seeded search lost are kept as
explicit cases with the rack counts the earlier engine reached as floors.
"""
from __future__ import annotations

import copy
import json
import math
import random
from pathlib import Path

import pytest

from gridforge.envelope.solver import LadderDidNotConverge, _relief_moved_the_binding_constraint, ladder
from gridforge.intake.loader import load_document
from gridforge.power.redundancy import usable_units
from gridforge.scenario.run import run_all
from gridforge.thermal.library import PUE_BY_ARCHITECTURE

ROOT =Path(__file__).resolve().parents[1]
DUBLIN = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())
REFERENCE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())


def _block(i: int, kw: int, units: int, scheme: str) -> dict:
    return {"id": f"U{i}", "unit_rating_kW": kw, "units": units, "redundancy": scheme, "step_load_capability": 0.5}


def _plant(blocks: list[dict], load_MW: float, *, scenario: str = "hybrid_dlc") -> dict:
    """The Dublin hall with this UPS plant under this protected load, and the grid and contract sized so that nothing else binds first."""
    d = copy.deepcopy(DUBLIN)
    d["scenarios"] = [scenario]
    d["ups"] = blocks
    d["grid"]["current_it_load_MW"] = load_MW
    d["grid"]["current_site_peak_MW"] = load_MW * 1.15
    d["grid"]["contracted_MW"] = max(30, load_MW * 3)
    d["grid"]["firm_capacity_MVA"] = max(35, load_MW * 3.5)
    return d


def _result(d: dict):
    intake = load_document(d)
    return run_all(intake.context, intake.scenarios)[0]


def _ceiling_without_ups(d: dict) -> int:
    """What the same hall reaches when no UPS schedule limits it: the ceiling a shortfall in the UPS cannot lower."""
    free = copy.deepcopy(d)
    free["ups"] = []
    return _result(free).ladder.final.max_racks


# ----------------------------------------------------------------------------------------------- the reported plant
def _reference_with_small_blocks(nblocks: int, units: int) -> dict:
    d = copy.deepcopy(REFERENCE)
    d["scenarios"] = ["hybrid_dlc", "full_dlc", "full_dlc_btm"]
    d["grid"]["current_it_load_MW"] = 9.0
    d["grid"]["current_site_peak_MW"] = 10.5
    d["ups"] = [_block(i, 1200, units, "N+1") for i in range(nblocks)]
    return d


def test_four_small_ups_blocks_under_a_larger_protected_load_keep_their_plan():
    """4 blocks x 2 modules N+1 is 4.8 MW usable under a 9.0 MW protected load. The earlier engine reached 8 / 9 / 43 racks; the lost-plan engine 0 / 0 / 0."""
    d = _reference_with_small_blocks(4, 2)
    intake = load_document(d)
    got = {r.spec.id: (r.ladder.initial.max_racks, r.ladder.final.max_racks, r.ladder.final.binding.id) for r in run_all(intake.context, intake.scenarios)}
    assert got == {"hybrid_dlc": (0, 8, "grid_firm_capacity"), "full_dlc": (0, 9, "grid_firm_capacity"), "full_dlc_btm": (0, 43, "grid_firm_capacity")}


def test_the_plan_that_is_kept_is_bought_one_block_at_a_time_and_costed_for_what_it_buys():
    r = _result(_reference_with_small_blocks(4, 2))
    ups_steps = [s for s in r.ladder.taken_steps if s.binding_id == "ups_capacity"]
    assert len(ups_steps) >= 2                      # the first rung alone leaves the headroom negative: it takes more than one
    assert ups_steps[0].racks_before == 0 and ups_steps[0].racks_after == 0 and ups_steps[0].taken     # a rung that earns no whole rack yet stays in the plan
    assert all(s.capex_eur is not None and s.capex_eur.value > 0 for s in ups_steps)
    assert r.ladder.converged and r.ladder.final.max_racks > 0


def test_a_single_block_plant_is_not_lost_either():
    """1 block x 6 modules N+1 (6.0 MW usable) under 9.0 MW: lost by the earlier engine too (one rung adds 2.4 MW and leaves it short)."""
    d = _reference_with_small_blocks(1, 6)
    r = {x.spec.id: x for x in run_all(*(lambda i: (i.context, i.scenarios))(load_document(d)))}
    assert {k: v.ladder.final.max_racks for k, v in r.items()} == {"hybrid_dlc": 8, "full_dlc": 9, "full_dlc_btm": 43}


# ----------------------------------------------------------------------------------------------- the six plants the seeded search lost
#: (UPS blocks as (kW, units, scheme), protected load MW, racks the earlier engine reached after its ladder). Dublin hall, hybrid DLC. The
#: lost-plan engine answered 0 for each of them.
LOST_PLANS = [
    ([(1200, 2, "N+1"), (800, 2, "N+1")], 4.92, 138),
    ([(800, 3, "N+1"), (800, 2, "N+1")], 4.2, 143),
    ([(800, 3, "2N"), (1600, 3, "N+1"), (800, 6, "2N")], 9.67, 107),
    ([(800, 3, "N+1"), (1600, 2, "N+1")], 6.4, 129),
    ([(1200, 3, "N+1"), (1000, 2, "2N"), (1200, 6, "2N")], 10.18, 107),
    ([(1600, 2, "N+1"), (1600, 4, "2N"), (1000, 3, "N")], 11.03, 116),
]


@pytest.mark.parametrize("blocks,load,earlier", LOST_PLANS, ids=[f"{len(b)}blocks-{load}MW" for b, load, _ in LOST_PLANS])
def test_each_plant_the_seeded_search_lost_keeps_at_least_what_the_earlier_engine_reached(blocks, load, earlier):
    d = _plant([_block(i, kw, units, scheme) for i, (kw, units, scheme) in enumerate(blocks)], load)
    r = _result(d)
    assert r.ladder.final.max_racks > 0
    assert r.ladder.final.max_racks >= r.ladder.initial.max_racks
    assert r.ladder.final.max_racks >= earlier
    assert r.ladder.final.max_racks == _ceiling_without_ups(d)          # the shortfall was closed, so the UPS does not lower the ceiling


# ----------------------------------------------------------------------------------------------- the seeded search
def _random_undersized_plants(rng: random.Random, trials: int):
    """The reviewer's search: 2-6 UPS blocks of mixed rating, size and scheme, under a protected load 1.05-2.5x the usable UPS."""
    for t in range(trials):
        n = rng.randint(2, 6)
        blocks = [_block(k, rng.choice([800, 1000, 1200, 1600, 2000]), rng.choice([2, 3, 4, 6]), rng.choice(["N+1", "N+1", "N", "2N"])) for k in range(n)]
        usable_MW = sum(b["unit_rating_kW"] * usable_units(b["units"], b["redundancy"]) for b in blocks) / 1000
        if usable_MW <= 0.3:
            continue
        yield t, blocks, round(usable_MW * rng.uniform(1.05, 2.5), 2), usable_MW


def test_a_seeded_search_of_undersized_plants_never_loses_the_plan():
    """Every 3rd plant of the first 150 the seeded search draws (50 plants): the ladder ends at the ceiling of the hall with no UPS limit (physically the
    most it can reach), never at zero, never below what it started with, and it converges inside the step budget."""
    checked = 0
    for t, blocks, load, usable_MW in _random_undersized_plants(random.Random(3), 150):
        if t % 3:
            continue
        d = _plant(blocks, load)
        r = _result(d)
        assert r.ladder.converged, (t, blocks, load)
        assert r.ladder.final.max_racks > 0, (t, blocks, load, usable_MW)
        assert r.ladder.final.max_racks >= r.ladder.initial.max_racks, (t, blocks, load)
        assert r.ladder.final.max_racks == _ceiling_without_ups(d), (t, blocks, load, usable_MW)
        checked += 1
    assert checked >= 40


# ----------------------------------------------------------------------------------------------- the rule itself
class _C:
    def __init__(self, cid: str, margin):
        self.id, self.margin_racks = cid, margin


class _R:
    def __init__(self, racks: int, *constraints):
        self.max_racks, self.constraints = racks, list(constraints)


@pytest.mark.parametrize("before,after,expect", [
    (_R(0, _C("ups_capacity", -31.1)), _R(0, _C("ups_capacity", -13.3)), True),            # still short, but less short: keep climbing
    (_R(0, _C("ups_capacity", -0.4)), _R(0, _C("ups_capacity", 0.7)), True),               # now ahead of the load, still under one whole rack
    (_R(0, _C("ups_capacity", -5.0)), _R(0, _C("ups_capacity", -5.0)), False),             # the relief moved nothing: stop (a control)
    (_R(0, _C("ups_capacity", -5.0)), _R(0, _C("ups_capacity", -6.0)), False),             # it made it worse: stop
    (_R(5, _C("ups_capacity", 5.2)), _R(5, _C("ups_capacity", 5.9)), False),               # the hall holds racks: the old stop rule stands
    (_R(0, _C("ups_capacity", -5.0)), _R(0, _C("ups_capacity", None)), False),             # no margin reported: judged by max_racks alone, as before
    (_R(0, _C("ups_capacity", None)), _R(0, _C("ups_capacity", -2.0)), False),
    (_R(0, _C("ups_capacity", -math.inf)), _R(0, _C("ups_capacity", -2.0)), False),        # non-finite never extends the ladder
    (_R(0, _C("ups_capacity", -5.0)), _R(0, _C("ups_capacity", math.nan)), False),
    (_R(0, _C("ups_capacity", -5.0)), _R(0, _C("other", -2.0)), False),                    # the binding constraint is not in the result: stop
], ids=["short-then-less-short", "crosses-zero", "no-movement", "worse", "has-racks", "after-none", "before-none", "inf", "nan", "absent"])
def test_the_continue_rule_reads_the_binding_constraints_own_margin(before, after, expect):
    assert _relief_moved_the_binding_constraint(before, after, "ups_capacity") is expect


def test_the_step_budget_is_the_backstop_for_a_shortfall_too_large_to_close():
    """Climbing is bounded: with too few steps the ladder is refused by name (or returned unconverged), never an endless loop."""
    intake = load_document(_reference_with_small_blocks(4, 2))
    spec = next(s for s in intake.scenarios if s.id == "hybrid_dlc")
    ctx = intake.context.copy()
    ctx.architecture = spec.architecture                      # what scenario.run.run does before it climbs
    ctx.pue = PUE_BY_ARCHITECTURE[spec.architecture]
    if spec.overrides is not None:
        ctx = spec.overrides(ctx)
    with pytest.raises(LadderDidNotConverge) as e:
        ladder(ctx, max_steps=2)
    assert "still finding reliefs after 2 steps" in str(e.value)
    partial = ladder(ctx, max_steps=2, allow_partial=True)
    assert partial.converged is False and len(partial.steps) == 2
    assert ladder(ctx).converged and ladder(ctx).final.max_racks == 8          # the default budget is ample for it
