"""The headroom ladder answers any hall inside the plausibility ceilings, or refuses it by name. It never gives up on a fixed step count.

Defect (stress review, 2026-11-06): ``ladder(max_steps=200)`` raised ``LadderDidNotConverge`` for any hall that needs more than 200 rungs.
Each rung adds a fixed increment (two busway runs, one CDU per bank, two UPS modules per block), so the rungs needed grow with the size of
the hall: a 200 MVA Dublin-style hall with behind-the-meter supply needs about 230. The API turned the exception into a generic 422, so a
perfectly ordinary large hall was "could not be processed as given" while the fuzzer counted the 422 as a clean refusal.

The step budget now scales with the size of the hall (3 rungs per MW of the smaller of what the supply could carry and what the free
positions could hold, never below the historical 200, never above LADDER_STEP_CAP). A hall that still cannot be finished inside the cap
is refused with a message that names the intake fields that set its size and the rung it reached; a caller that prefers the partial
ladder asks for it (``allow_partial=True``) and gets a ladder that says it is not the ceiling.

Scaling here is by construction from the shipped intakes: every power and plant figure multiplied by the same factor, so the figures
stay mutually consistent. Expected values are stated as rules (finishes; never fewer racks than as found; steps within the budget), not
read back as numbers.
"""
from __future__ import annotations

import copy
import json
import math
from pathlib import Path

import pytest

from gridforge.api import server as S
from gridforge.envelope import ladder, solver as solver_mod
from gridforge.envelope.solver import LadderDidNotConverge, ladder_step_budget
from gridforge.intake.loader import load_document
from gridforge.scenario import run_all

ROOT = Path(__file__).resolve().parents[1]


def _doc(name: str) -> dict:
    return json.loads((ROOT / "examples" / "intake" / f"{name}_hall.json").read_text(encoding="utf-8"))


def _scale(v, k):
    if isinstance(v, dict):
        return {**v, "value": v["value"] * k}
    return v * k


def scaled(name: str, firm_MVA: float) -> dict:
    """The shipped intake with every power, plant and space figure multiplied by the same factor (counts that have a loader ceiling are clipped to it)."""
    doc = _doc(name)
    k = firm_MVA / doc["grid"]["firm_capacity_MVA"]
    d = copy.deepcopy(doc)
    for key in ("firm_capacity_MVA", "contracted_MW", "current_site_peak_MW", "current_it_load_MW"):
        d["grid"][key] = _scale(d["grid"][key], k)
    for t in d["transformers"]:
        t["unit_rating_MVA"] *= k
    for u in d["ups"]:
        u["units"] = min(200, int(u["units"] * k))
    for o in d.get("btm_options", []):
        o["capacity_MW"] *= k
    d["hall"]["rack_positions"] = min(50_000, int(d["hall"]["rack_positions"] * k))
    d["hall"]["positions_available"] = min(49_000, int(d["hall"]["positions_available"] * k))
    d["lv"]["busway_runs"] = min(1000, int(d["lv"]["busway_runs"] * k))
    for key in ("chilled_water_capacity_kW", "pump_flow_capacity_l_per_min"):
        d["thermal"]["plant"][key] = _scale(d["thermal"]["plant"][key], k)
    return d


SIZES = [100, 130, 150, 200, 300]


@pytest.mark.parametrize("name", ["dublin", "reference"])
@pytest.mark.parametrize("firm_MVA", SIZES)
def test_every_scenario_of_a_large_hall_finishes_and_never_loses_racks(name, firm_MVA):
    intake = load_document(scaled(name, firm_MVA))
    for r in run_all(intake.context, intake.scenarios):          # base b649b3e: LadderDidNotConverge for full_dlc_btm at 200 and 300 MVA
        lad = r.ladder
        assert lad.final.max_racks >= lad.initial.max_racks, r.spec.id
        assert len(lad.steps) <= ladder_step_budget(lad.initial_context), (r.spec.id, len(lad.steps))
        assert lad.final.max_racks > 0 or r.spec.id in {"retained_air", "rdhx"}, r.spec.id


@pytest.mark.parametrize("firm_MVA", SIZES)
def test_a_bigger_hall_never_ends_with_fewer_racks_than_a_smaller_one(firm_MVA):
    """The ceiling grows with the supply: scaling every figure up cannot shrink the answer."""
    small = load_document(scaled("dublin", firm_MVA))
    big = load_document(scaled("dublin", firm_MVA * 1.5))
    a = {r.spec.id: r.ladder.final.max_racks for r in run_all(small.context, small.scenarios)}
    b = {r.spec.id: r.ladder.final.max_racks for r in run_all(big.context, big.scenarios)}
    assert all(b[k] >= a[k] for k in a), (a, b)


def test_a_200_mva_hall_is_answered_over_the_api_not_refused():
    out = S.handle_screen({"intake": scaled("dublin", 200)}, S.Tier.CLIENT)
    assert {s["id"] for s in out["scenarios"]} >= {"hybrid_dlc", "full_dlc", "full_dlc_btm"}
    btm = next(s for s in out["scenarios"] if s["id"] == "full_dlc_btm")
    assert len(btm["ladder"]) > 200      # more rungs than the old fixed budget could carry


def test_the_budget_of_an_ordinary_hall_is_never_below_the_historical_200():
    for name in ("dublin", "reference", "nordic", "london"):
        intake = load_document(_doc(name))
        assert ladder_step_budget(intake.context) >= 200, name
        for r in run_all(intake.context, intake.scenarios):
            assert len(r.ladder.steps) < 200, (name, r.spec.id)      # the shipped halls never needed more than the old budget


def test_the_budget_grows_with_the_hall_and_is_capped():
    budgets = [ladder_step_budget(load_document(scaled("dublin", m)).context) for m in SIZES]
    assert budgets == sorted(budgets) and budgets[-1] > budgets[0] >= 200
    assert all(b <= solver_mod.LADDER_STEP_CAP for b in budgets)
    # By hand for the 300 MVA Dublin-style hall: the supply carries min(300 x 0.97, contracted 10 x 300/11 = 272.7) MW = 272.7 MW, plus the
    # behind-the-meter options (2 + 5 MW) scaled by 300/11 = 191 MW, = 464 MW; the free positions (180 x 27.3 = 4,909 -> 4,909 x 135 kW =
    # 663 MW) hold more, so the smaller, 464 MW, sets the size: 200 + 3 x 464 = 1,593 rungs.
    ctx = load_document(scaled("dublin", 300)).context
    g = ctx.power.grid
    supply = min(g.firm_capacity_MVA.value * g.power_factor.value, g.contracted_MW.value)
    btm = sum(o.capacity_MW.value for o in ctx.power.options)
    hall = ctx.hall.positions_available * ctx.cluster.platform.rack_kW.value / 1000.0
    assert ladder_step_budget(ctx) == min(solver_mod.LADDER_STEP_CAP, 200 + math.ceil(3.0 * min(supply + btm, hall)))


@pytest.mark.parametrize("bad", [float("inf"), float("nan"), -5.0])
def test_a_size_that_is_not_a_finite_positive_number_never_breaks_the_budget(bad):
    from gridforge.common import ASSUMED, V
    ctx = load_document(_doc("dublin")).context
    ctx.power.grid.firm_capacity_MVA = V(bad, "MVA", "bad", ASSUMED)
    assert 200 <= ladder_step_budget(ctx) <= solver_mod.LADDER_STEP_CAP


# --- past the cap: refused by name, or handed back as a ladder that says it is not the ceiling -----------------------------------
@pytest.fixture
def tiny_cap(monkeypatch):
    monkeypatch.setattr(solver_mod, "LADDER_STEP_CAP", 12)


def _btm_context(intake):
    from gridforge.thermal.library import PUE_BY_ARCHITECTURE
    spec = next(s for s in intake.scenarios if s.id == "full_dlc_btm")
    ctx = intake.context.copy()
    ctx.architecture, ctx.pue = spec.architecture, PUE_BY_ARCHITECTURE[spec.architecture]
    return spec.overrides(ctx)


def test_past_the_cap_the_refusal_names_the_fields_that_set_the_size_and_the_rung_reached(tiny_cap):
    ctx = _btm_context(load_document(scaled("dublin", 150)))
    with pytest.raises(LadderDidNotConverge) as e:
        ladder(ctx)
    msg = str(e.value)
    assert "hall.positions_available" in msg and "grid.firm_capacity_MVA" in msg and "grid.contracted_MW" in msg
    assert "12 steps" in msg and "rack(s)" in msg
    assert isinstance(e.value, ValueError)                          # still a 422 over REST, refunded


def test_an_explicit_step_budget_is_still_honoured_exactly():
    ctx = _btm_context(load_document(_doc("nordic")))
    with pytest.raises(LadderDidNotConverge):
        ladder(ctx, max_steps=2)
    assert ladder(ctx).final is not None


def test_a_caller_that_asks_for_the_partial_ladder_gets_one_that_says_it_is_not_the_ceiling(tiny_cap):
    ctx = _btm_context(load_document(scaled("dublin", 150)))
    lad = ladder(ctx, allow_partial=True)
    assert lad.converged is False
    assert len(lad.steps) == 12 and lad.final is not None and lad.final.max_racks >= lad.initial.max_racks
    assert "not the ceiling" in lad.non_convergence_reason and "12 steps" in lad.non_convergence_reason
    assert lad.non_convergence_reason in lad.incomplete_reason
    assert lad.critical_path_complete is False                      # no date, no complete path, for a ladder that stopped early
    assert "hall.positions_available" in lad.non_convergence_reason


def test_a_ladder_that_finishes_is_converged_with_no_reason():
    lad = ladder(load_document(_doc("dublin")).context)
    assert lad.converged is True and lad.non_convergence_reason == ""
