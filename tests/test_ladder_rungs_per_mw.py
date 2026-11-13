"""How many rungs the ladder needs per MW of hall, MEASURED, and the cap and the supported scale that follow from it (review E4).

Why this file exists. ``LADDER_STEPS_PER_MW_MEASURED = 1.3`` was measured on the rule in which a rung bought two UPS modules in EVERY block. A rung now
buys two modules in ONE block (so how a plant is listed cannot change its price), which takes about 1.7 rungs per MW, and the refusal's "about 450 MW"
was false: a 400 MW hall that was answered (507 rungs) was refused ("could not be processed as given") at the cap of 600. The constant, the cap and
every sentence that quotes the supported size are now derived from a measurement that anyone can repeat:

    python tests/test_ladder_rungs_per_mw.py            # prints rungs and rungs per MW for the whole corpus, at every size in SIZES_MW

THE CORPUS (seeded; see ``stress_hall``). Each shipped hall's own equipment (its first UPS block and transformer bank, replicated into 2, 4, 8 or 16
blocks: the number of blocks changes nothing, which the tests of order and listing already pin) under a supply of C MW with 10 free positions per MW,
the plant small beside the supply, so the ladder has to buy almost everything: the case that needs the most rungs. Every liquid scenario is run
(hybrid DLC, full DLC, full DLC with behind-the-meter supply). The size is ``solver.ladder_size_MW``, the same figure the budget reads. The cap is
lifted for the measurement, so the true count is seen, and put back after.

WHAT IT FOUND (Python 3.13). Rungs per MW of size, worst scenario of the corpus: 1.19 at 100 MW, 1.57 at 200, 1.68 at 300 and 1.70 at 400, where it
stops growing (1.70 at 450 and 1.69 at 500). Equipment smaller than the library's (a CDU under 1,350 kW, a UPS module under 1,200 kW) needs
proportionally more: the budget (200 plus 3 per MW) is 1.7 times the measured worst case and, when it runs out, the refusal says so by name.

WHAT IS PINNED. The constant is at least the measurement and no more than 0.1 above it (so it is neither stale-low, which would overstate the supported
scale, nor padded); the cap is under the recursion margin the convergence tests pin; the supported scale in the refusal and the README is what the cap
and the constant give, and a hall of exactly that size, in the corpus's widest scenario, is answered within the cap.
"""
from __future__ import annotations

import copy
import json
import random
import sys
import time
from pathlib import Path

import pytest

from gridforge.envelope import solver as solver_mod
from gridforge.envelope.solver import LadderDidNotConverge, ladder_size_MW, supported_scale_MW
from gridforge.intake.loader import load_document
from gridforge.scenario.run import run_all

ROOT = Path(__file__).resolve().parents[1]
HALLS = ("dublin", "reference", "london", "nordic")
LIQUID = ("hybrid_dlc", "full_dlc", "full_dlc_btm")
BLOCKS = (2, 4, 8, 16)
#: The sizes (MW of supply) of the full measurement. The test itself runs the one where the rate peaks.
SIZES_MW = (100, 200, 300, 400, 450, 500)
PEAK_MW = 400
SEED = 5


def _hall(name: str) -> dict:
    return json.loads((ROOT / "examples" / "intake" / f"{name}_hall.json").read_text(encoding="utf-8"))


def stress_hall(name: str, supply_MW: float, blocks: int) -> dict:
    """A shipped hall with its own equipment replicated into ``blocks`` blocks under ``supply_MW`` of supply and ten free positions per MW."""
    d = _hall(name)
    d["grid"]["contracted_MW"] = supply_MW
    d["grid"]["firm_capacity_MVA"] = supply_MW * 1.15
    d["hall"]["positions_available"] = int(supply_MW * 10)
    d["hall"]["rack_positions"] = int(supply_MW * 10) + 100
    fallback = _hall("dublin")                                    # London declares no UPS or transformer schedule: it takes Dublin's block and bank
    ups, tx = (d["ups"] or fallback["ups"])[0], (d["transformers"] or fallback["transformers"])[0]
    d["ups"] = [{**ups, "id": f"UPS-{i}"} for i in range(blocks)]
    d["transformers"] = [{**tx, "id": f"TX-{i}"} for i in range(blocks)]
    d["scenarios"] = list(LIQUID)
    return d


def corpus(supply_MW: float, seed: int = SEED):
    """(hall name, blocks, document) for every shipped hall at ``supply_MW``, the block count drawn from a seeded generator."""
    rng = random.Random(seed + int(supply_MW))
    for name in HALLS:
        blocks = rng.choice(BLOCKS)
        yield name, blocks, stress_hall(name, supply_MW, blocks)


def measure(supply_MW: float, seed: int = SEED, halls=HALLS) -> list[tuple[str, int, str, int, float, float]]:
    """[(hall, blocks, scenario, rungs, size_MW, rungs_per_MW)] with the cap lifted to see the true count."""
    saved = solver_mod.LADDER_STEP_CAP
    solver_mod.LADDER_STEP_CAP = 10_000
    try:
        rows = []
        for name, blocks, d in corpus(supply_MW, seed):
            if name not in halls:
                continue
            intake = load_document(d)
            size = ladder_size_MW(intake.context)
            for r in run_all(intake.context, intake.scenarios):
                n = len(r.ladder.steps)
                rows.append((name, blocks, r.spec.id, n, size, n / size))
        return rows
    finally:
        solver_mod.LADDER_STEP_CAP = saved


# ----------------------------------------------------------------------------------------------- the measurement and the constant
@pytest.fixture(scope="module")
def peak():
    return measure(PEAK_MW)


def test_the_corpus_is_what_the_docstring_says_and_is_reproducible():
    a, b = list(corpus(PEAK_MW)), list(corpus(PEAK_MW))
    assert [(n, k) for n, k, _ in a] == [(n, k) for n, k, _ in b] and {n for n, _, _ in a} == set(HALLS)
    for name, blocks, d in a:
        assert len(d["ups"]) == len(d["transformers"]) == blocks and d["grid"]["contracted_MW"] == PEAK_MW and d["scenarios"] == list(LIQUID)


def test_the_measured_worst_case_is_the_constant_up_to_the_margin(peak):
    worst = max(rate for *_, rate in peak)
    assert worst <= solver_mod.LADDER_STEPS_PER_MW_MEASURED, (worst, "the constant understates what a rung costs: raise it from this measurement")
    assert solver_mod.LADDER_STEPS_PER_MW_MEASURED - worst <= 0.1, (worst, "the constant is padded well past the measurement: re-measure and lower it")


def test_the_budget_allows_more_than_the_measured_need():
    """200 plus 3 per MW against at most 1.75 measured per MW: library-sized equipment never runs the budget out before the cap."""
    assert solver_mod.LADDER_STEPS_PER_MW >= 1.5 * max(rate for *_, rate in measure(200, halls=("london", "nordic")))


def test_every_hall_of_the_corpus_at_the_peak_size_needs_more_than_the_old_cap_allowed_per_mw(peak):
    """The reason for the change: at the rate the old constant stated (1.3 per MW) the measurement is exceeded in every hall's widest scenario."""
    widest = {name: max(rate for n2, _, _, _, _, rate in peak if n2 == name) for name, *_ in peak}
    assert all(rate > 1.3 for rate in widest.values()), widest


# ----------------------------------------------------------------------------------------------- the cap and the supported scale
def test_the_cap_sits_under_the_recursion_margin_the_convergence_tests_pin():
    assert solver_mod.LADDER_STEP_CAP * 3 <= sys.getrecursionlimit() * 2
    assert solver_mod.LADDER_STEP_CAP > 600, "raised from 600: a rung buys two UPS modules in one block now, which needs about 1.7 rungs per MW"


def test_the_supported_scale_is_the_cap_over_the_measured_rate_rounded_down_to_ten():
    assert supported_scale_MW() == int(solver_mod.LADDER_STEP_CAP / solver_mod.LADDER_STEPS_PER_MW_MEASURED // 10 * 10) == 370


def test_the_readme_states_the_cap_and_the_supported_scale_the_solver_computes():
    text = (ROOT / "gridforge" / "README.md").read_text(encoding="utf-8")
    assert f"bounded at {solver_mod.LADDER_STEP_CAP} steps per scenario" in text
    assert f"above {supported_scale_MW()} MW of supply plus behind-the-meter capacity" in text
    assert "450 MW" not in text


def test_a_hall_of_the_supported_size_is_answered_in_every_scenario_within_the_cap():
    """The claim itself: at ``supported_scale_MW()`` every shipped hall's widest scenario fits the cap (the earlier claim, 450 MW, did not hold)."""
    rows = measure(supported_scale_MW())
    assert rows and all(rungs <= solver_mod.LADDER_STEP_CAP for _, _, _, rungs, _, _ in rows), [r for r in rows if r[3] > solver_mod.LADDER_STEP_CAP]


def test_the_reviewers_400_mw_halls_are_answered_not_refused():
    """The case that was answered before the rung rule changed (507 rungs) and refused after it ('could not be processed as given' at the cap of 600):
    nordic at 400 MW, 4,000 positions, UPS and transformer banks in 8 blocks."""
    d = stress_hall("nordic", 400, 8)
    d["scenarios"] = ["hybrid_dlc", "full_dlc"]
    intake = load_document(d)
    for r in run_all(intake.context, intake.scenarios):
        assert len(r.ladder.steps) <= solver_mod.LADDER_STEP_CAP and r.ladder.converged, r.spec.id


# ----------------------------------------------------------------------------------------------- past the supported scale: a named refusal
def test_a_hall_past_the_cap_is_refused_by_name_with_the_rungs_taken_the_cap_and_about_how_many_it_needs():
    from gridforge.api import server as S
    d = stress_hall("london", 520, 2)
    d["scenarios"] = ["full_dlc"]
    with pytest.raises(S.ApiError) as e:
        S._invoke("/v1/screen", S.ROUTES["/v1/screen"][0], {"intake": d}, S.Tier.CLIENT)
    err = e.value
    assert err.status == 422 and err.message.startswith(f"the headroom ladder was still finding reliefs after {solver_mod.LADDER_STEP_CAP} steps")
    assert err.message != "the request could not be processed as given"
    assert f"one request may take at most {solver_mod.LADDER_STEP_CAP}" in err.message
    assert f"about {supported_scale_MW()} MW of firm supply plus behind-the-meter capacity" in err.message
    assert err.extra["rungs_taken"] == err.extra["step_cap"] == solver_mod.LADDER_STEP_CAP and err.extra["supported_MW"] == supported_scale_MW()
    need = err.extra["rungs_needed_estimate"]
    assert need > solver_mod.LADDER_STEP_CAP, "an estimate of what it needs must exceed what it was allowed"
    assert "(an estimate:" in err.message                       # it says it is an estimate


def test_the_estimate_is_near_what_the_hall_really_needs():
    """The figure the refusal gives is an estimate: it must be the right size, not a number. Run the same hall to the end with the cap lifted."""
    from gridforge.api import server as S
    d = stress_hall("london", 520, 2)
    d["scenarios"] = ["full_dlc"]
    with pytest.raises(S.ApiError) as e:
        S._invoke("/v1/screen", S.ROUTES["/v1/screen"][0], {"intake": d}, S.Tier.CLIENT)
    estimate = e.value.extra["rungs_needed_estimate"]
    saved = solver_mod.LADDER_STEP_CAP
    solver_mod.LADDER_STEP_CAP = 10_000
    try:
        intake = load_document(d)
        actual = len(run_all(intake.context, intake.scenarios)[0].ladder.steps)
    finally:
        solver_mod.LADDER_STEP_CAP = saved
    assert 0.8 * actual <= estimate <= 1.25 * actual, (estimate, actual)


def test_a_ladder_that_was_cut_off_without_a_ceiling_to_scale_to_says_more_than_not_a_number():
    from gridforge.envelope.solver import _rungs_needed_estimate

    class C:
        def __init__(self, id, racks, margin=None):
            self.id, self.racks, self.margin_racks = id, racks, margin

    class R:
        def __init__(self, racks, *cs):
            self.max_racks, self.constraints = racks, list(cs)

    assert _rungs_needed_estimate(R(0, C("floor_space", 100.0), C("grid_firm_capacity", 50.0, 50.0)), 600) == (None, None)       # nothing reached yet
    assert _rungs_needed_estimate(R(80, C("floor_space", 100.0)), 600) == (None, None)                                           # no supply figure
    assert _rungs_needed_estimate(R(100, C("floor_space", 100.0), C("grid_firm_capacity", 50.0, 90.0)), 600) == (None, 90)      # already at the ceiling (the supply's 90)
    assert _rungs_needed_estimate(R(100, C("floor_space", 400.0), C("grid_firm_capacity", 50.0, 900.0)), 600) == (2400, 400)    # a quarter of the way: 4 x 600


def _climb_context(supply_MW: float):
    from gridforge.thermal.library import PUE_BY_ARCHITECTURE
    d = stress_hall("nordic", supply_MW, 2)
    d["scenarios"] = ["full_dlc"]
    intake = load_document(d)
    spec = intake.scenarios[0]
    ctx = intake.context.copy()
    ctx.architecture, ctx.pue = spec.architecture, PUE_BY_ARCHITECTURE[spec.architecture]
    return ctx


def test_the_message_for_a_hall_under_the_cap_names_its_own_limit(monkeypatch):
    """A hall whose own budget (the floor plus a rate per MW of its size) runs out below the cap: the refusal says the limit is the hall's, and that no
    request may take more than the cap. (The budget is made small here so that a 60 MW hall can run it out.)"""
    monkeypatch.setattr(solver_mod, "LADDER_STEP_FLOOR", 6)
    monkeypatch.setattr(solver_mod, "LADDER_STEPS_PER_MW", 0.2)
    ctx = _climb_context(60)
    budget = solver_mod.ladder_step_budget(ctx)
    assert budget < 30
    with pytest.raises(LadderDidNotConverge) as e:
        solver_mod.ladder(ctx)
    assert f"the limit for a hall of this size is {budget} steps (6 plus 0.2 per MW of its size)" in str(e.value)
    assert f"no request may take more than {solver_mod.LADDER_STEP_CAP}" in str(e.value) and e.value.step_limit == budget


def test_a_ladder_given_its_own_limit_says_so_rather_than_claiming_the_halls():
    ctx = _climb_context(60)
    with pytest.raises(LadderDidNotConverge) as e:
        solver_mod.ladder(ctx, max_steps=10)
    assert "this ladder was given a limit of 10 steps" in str(e.value) and e.value.rungs_taken == e.value.step_limit == 10


if __name__ == "__main__":
    print(f"rungs per MW of ladder_size_MW, seeded corpus (seed {SEED}), cap lifted; constant LADDER_STEPS_PER_MW_MEASURED = {solver_mod.LADDER_STEPS_PER_MW_MEASURED}")
    worst_overall = 0.0
    for size in (float(a) for a in (sys.argv[1:] or SIZES_MW)):
        started = time.time()
        rows = measure(size)
        worst = max(rate for *_, rate in rows)
        worst_overall = max(worst_overall, worst)
        print(f"\n{size:g} MW   worst {worst:.3f} rungs/MW   [{time.time() - started:.0f} s]")
        for name, blocks, scenario, rungs, sz, rate in rows:
            print(f"  {name:10s} {blocks:2d} blocks  {scenario:12s} {rungs:5d} rungs  size {sz:7.1f} MW  {rate:.3f}/MW")
    print(f"\nworst overall {worst_overall:.3f}: set LADDER_STEPS_PER_MW_MEASURED to this rounded UP by 0.05 ({-(-worst_overall // 0.05) * 0.05:.2f}), and the cap, README and "
          f"supported scale follow (supported_scale_MW() = {supported_scale_MW()} MW at {solver_mod.LADDER_STEP_CAP} steps)")
