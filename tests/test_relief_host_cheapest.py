"""A relief's host bank is the cheapest per usable kW (or usable heat) it gains, not the one with the most (review E5).

The host of a UPS or CDU relief used to be the block whose added modules carried the most usable kW, ties to the larger module. Under 2N two modules make
one usable, so a 2N block installs two kW for every usable one: dublin_hall with A = 6 x 1200 kW under N and B = 2 x 2400 kW under 2N (both gain 2,400
usable kW) took B, a step of 1,536,000 EUR against 768,000 EUR for A alone, and adding B to the plant made the same racks dearer (capex up by 64-540 kEUR in
3 of 126 random UPS pairs and 1 of 60 CDU cases). The host is now ranked by EUR per usable kW gained, ascending, then by larger gain, then by id.

What is pinned here:
  * the rate: adding a bank never raises the EUR per usable kW (or kW of usable heat) the step costs, over 600 seeded UPS pairs and 300 CDU pairs;
  * the two reported plants, step by step and as a whole plan (the 2N bank never makes the same racks dearer);
  * a seeded set of plants whose added bank is a much larger 2N bank (the family the old rule failed on): the whole plan never costs more at the same racks;
  * the tie-break order (price per kW, larger gain, id) and that the listing order never decides;
  * the step's basis note states the rule and the rate it chose.

Not claimed: that adding ANY bank can never raise a whole plan's capex. A greedy ladder that takes a larger module at the same price per kW can overshoot
by up to one rung (the corpus the reviewer searched has such pairs under either rule: 3 in 760 here, the old rule 4); that is granularity, and the
larger-gain tie-break is the documented choice (it takes the fewest rungs).
"""
from __future__ import annotations

import copy
import itertools
import json
import random
from pathlib import Path

import pytest

from gridforge.common import CUSTOMER, V
from gridforge.intake.loader import load_document
from gridforge.power.constraints import _effective_units as _ups_effective_units
from gridforge.power.constraints import ups_capacity
from gridforge.scenario.run import run_all
from gridforge.thermal.constraints import _cdu_derate_ratio, _effective_units as _cdu_effective_units, cdu_capacity, facility_water_supply
from gridforge.thermal.schema import Architecture

ROOT = Path(__file__).resolve().parents[1]
DUBLIN = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())


def _ups(i, kw, units, scheme):
    return {"id": i, "unit_rating_kW": kw, "units": units, "redundancy": scheme, "step_load_capability": 0.5}


def _cdu(i, kw, approach, flow, units, scheme):
    return {"id": i, "rated_capacity_kW": kw, "rated_approach_K": approach, "rated_flow_l_per_min": flow, "units": units, "redundancy": scheme}


def _doc(**edits):
    d = copy.deepcopy(DUBLIN)
    d["scenarios"] = ["hybrid_dlc"]
    for k, v in edits.items():
        d[k] = v
    return d


def _plan(d: dict):
    """(racks after the ladder, total capex EUR) of the hybrid-DLC scenario."""
    i = load_document(copy.deepcopy(d))
    r = run_all(i.context, i.scenarios)[0]
    capex = r.economics.capex_total_eur
    return r.ladder.final.max_racks, (capex.value if capex is not None else None)


def _ctx(d: dict):
    ctx = load_document(copy.deepcopy(d)).context
    ctx.architecture = Architecture.HYBRID_DLC
    return ctx


# ----------------------------------------------------------------------------------------------- the reported UPS plant
A = _ups("A", 1200, 6, "N")
B = _ups("B", 2400, 2, "2N")


def _ups_step(blocks):
    ctx = load_document(_doc(ups=blocks)).context
    relief = ups_capacity(ctx).relief
    return relief, relief.apply(ctx), ctx


def test_two_blocks_that_gain_the_same_usable_kW_are_ranked_by_what_they_cost_to_install():
    """A (6 x 1200 kW under N) and B (2 x 2400 kW under 2N) both gain 2,400 usable kW; B installs 4,800 kW to do it. The step is A's: 768,000 EUR."""
    for listing in ([A], [A, B], [B, A]):
        relief, after, before = _ups_step(listing)
        assert relief.capex_eur.value == 768_000.0, [b["id"] for b in listing]
        assert relief.quantity == 2400.0 and relief.scope == "2,400 kW added"
        assert {u.id: u.units for u in after.power.ups}["A"] == 8
        assert {u.id: u.units for u in after.power.ups}.get("B", 2) == 2            # B is not touched


def test_the_step_note_states_the_rule_and_the_rate_it_chose():
    relief, _, _ = _ups_step([A, B])
    note = relief.basis_note
    assert "cost least per usable kW gained" in note and "320 EUR per usable kW (2400 usable kW gained)" in note
    assert "then the larger gain, then the id" in note and "a 2N block installs two kW for each usable one" in note
    assert "one block (A)" in note and "listed as one block or as several is priced and dated the same" in note


def test_control_a_plan_that_buys_ups_does_not_cost_more_for_having_the_2n_bank_installed():
    """A CONTROL (it passes on the old rule as well: B's own 2,400 usable kW saves more rungs than the one step it spoils; the old rule's failure needs
    a larger 2N module, which the seeded set below draws). The same racks with the 2N block B already in the hall are never dearer than with A alone."""
    def doc(blocks, load_MW):
        d = _doc(ups=blocks)
        d["grid"]["current_it_load_MW"] = load_MW
        d["grid"]["current_site_peak_MW"] = load_MW * 1.1
        return d
    alone, both = _plan(doc([A], 6.6)), _plan(doc([A, B], 6.6))
    assert both[0] >= alone[0] > 0
    if both[0] == alone[0]:
        assert both[1] <= alone[1]


# ----------------------------------------------------------------------------------------------- the reported CDU plant
C0 = _cdu("C0", 1000, 4, 600, 2, "N")
C99 = _cdu("C99", 1500, 3, 600, 1, "2N")


def _cdu_doc(banks):
    d = _doc()
    d["thermal"]["cdus"] = banks
    return d


def test_a_cdu_bank_that_needs_two_units_to_gain_one_is_not_chosen_for_being_larger():
    """C0 (1000 kW, 2 units under N) and C99 (1500 kW, 1 unit under 2N): C99 gains 1500 kW for TWO CDUs, C0 gains 1000 kW for one."""
    ctx = _ctx(_cdu_doc([C0, C99]))
    relief = cdu_capacity(ctx).relief
    after = relief.apply(ctx)
    assert {c.id: c.units for c in after.thermal.cdus} == {"C0": 3, "C99": 1}
    assert relief.quantity == 1.0
    note = relief.basis_note
    assert "costs least per kW of usable heat gained" in note and "a 2N bank buys two units to gain one" in note and "then the larger heat gain" in note


def test_the_whole_plan_with_the_second_cdu_bank_is_no_dearer_for_the_same_racks():
    """540 kEUR dearer at the same 22 racks under the old rule (4.258 against 3.718 MEUR)."""
    one, both = _plan(_cdu_doc([C0])), _plan(_cdu_doc([C0, C99]))
    assert both[0] == one[0] == 22
    assert both[1] <= one[1]


# ----------------------------------------------------------------------------------------------- the rate property, seeded
def _usable_kW_ups(ctx) -> float:
    return sum(u.unit_rating_kW.value * _ups_effective_units(u.units, u.redundancy) for u in ctx.power.ups)


def _ups_rate(ctx) -> float:
    """EUR per usable kW the UPS step costs on this context, measured by APPLYING it: price over the usable kW that actually appeared."""
    relief = ups_capacity(ctx).relief
    gained = _usable_kW_ups(relief.apply(ctx)) - _usable_kW_ups(ctx)
    return relief.capex_eur.value / gained if gained > 0 else float("inf")


def _usable_heat_kW(ctx) -> float:
    avail = ctx.thermal.tcs_target_supply_C.value - facility_water_supply(ctx).temperature.value
    return sum(c.rated_capacity_kW.value * _cdu_derate_ratio(c, avail) * _cdu_effective_units(c.units, c.redundancy) for c in ctx.thermal.cdus)


def _cdu_rate(ctx) -> float:
    relief = cdu_capacity(ctx).relief
    gained = _usable_heat_kW(relief.apply(ctx)) - _usable_heat_kW(ctx)
    return relief.capex_eur.value / gained if gained > 0 else float("inf")


def _random_ups(rng: random.Random, k: int) -> dict:
    return _ups(f"U{k}", rng.choice([500, 800, 1000, 1200, 1600, 2000, 2500, 4000]), rng.choice([1, 2, 3, 4, 5, 6, 8]), rng.choice(["N", "N+1", "2N", "N+1"]))


def test_adding_a_ups_bank_never_raises_the_eur_per_usable_kW_of_the_step_600_seeded_pairs():
    rng = random.Random(20261113)
    pairs = 0
    violations = []
    while pairs < 600:
        plant = [_random_ups(rng, k) for k in range(rng.randint(1, 5))]
        extra = _random_ups(rng, 99)
        if _ups_effective_units(extra["units"], extra["redundancy"]) <= 0 or all(_ups_effective_units(b["units"], b["redundancy"]) <= 0 for b in plant):
            continue
        before, after = _ups_rate(_ctx(_doc(ups=plant))), _ups_rate(_ctx(_doc(ups=plant + [extra])))
        pairs += 1
        if after > before * (1 + 1e-9):
            violations.append((plant, extra, before, after))
    assert not violations, violations[:3]


def _random_cdu(rng: random.Random, k: int) -> dict:
    return _cdu(f"C{k}", rng.choice([500, 800, 1000, 1500, 2000]), rng.choice([3, 4, 5, 6, 8]), rng.choice([600, 1000, 1500]), rng.choice([1, 2, 3, 4, 5]),
                rng.choice(["N", "N+1", "2N"]))


def test_adding_a_cdu_bank_never_raises_the_eur_per_kW_of_usable_heat_of_the_step_300_seeded_pairs():
    rng = random.Random(20261114)
    pairs = 0
    violations = []
    while pairs < 300:
        plant = [_random_cdu(rng, k) for k in range(rng.randint(1, 5))]
        extra = _random_cdu(rng, 99)
        before_ctx, after_ctx = _ctx(_cdu_doc(plant)), _ctx(_cdu_doc(plant + [extra]))
        before, after = _cdu_rate(before_ctx), _cdu_rate(after_ctx)
        if before == float("inf"):
            continue                                  # no bank of the plant gains any heat at this water temperature: there is no rate to compare
        pairs += 1
        if after > before * (1 + 1e-9):
            violations.append((plant, extra, before, after))
    assert not violations, violations[:3]


# ----------------------------------------------------------------------------------------------- whole plans, the family the old rule failed on
def test_a_seeded_set_of_plants_with_a_much_larger_2n_bank_added_is_never_dearer_for_the_same_racks():
    """The added block is a 2N block whose module is 2.2 to 4 times the biggest module of the plant: the old rule chose it for its usable kW and paid
    for twice the kW it could use. Same racks (or more), never a higher total capex."""
    rng = random.Random(77)
    checked = 0
    for _ in range(30):
        plant = [_ups(f"U{k}", rng.choice([800, 1000, 1200, 1600]), rng.choice([2, 3, 4, 6]), rng.choice(["N", "N+1"])) for k in range(rng.randint(1, 3))]
        biggest = max(b["unit_rating_kW"] for b in plant)
        extra = _ups("U99", int(round(biggest * rng.uniform(2.2, 4.0), -2)), rng.choice([2, 4, 6]), "2N")
        usable = sum(b["unit_rating_kW"] * _ups_effective_units(b["units"], b["redundancy"]) for b in plant) / 1000
        if usable <= 0.5:
            continue
        load = round(usable * rng.uniform(0.4, 0.97), 3)
        d = _doc(ups=plant)
        d["grid"]["current_it_load_MW"], d["grid"]["current_site_peak_MW"] = load, max(load * 1.1, 1.0)
        d2 = copy.deepcopy(d)
        d2["ups"] = plant + [extra]
        alone, both = _plan(d), _plan(d2)
        checked += 1
        assert both[0] >= alone[0], (plant, extra, load, alone, both)
        if both[0] == alone[0] and alone[1] is not None and both[1] is not None:
            assert both[1] <= alone[1] + 1.0, (plant, extra, load, alone, both)
    assert checked >= 20


# ----------------------------------------------------------------------------------------------- the tie-break order
def test_at_the_same_price_per_usable_kW_the_larger_gain_wins_then_the_id():
    """800, 1000 and 1200 kW modules under N are all 320 EUR per usable kW (float noise included): the 1200 kW block gains most, then equal blocks go by id."""
    blocks = [_ups("U-800", 800, 4, "N"), _ups("U-1200", 1200, 4, "N"), _ups("U-1000", 1000, 4, "N")]
    for perm in itertools.permutations(blocks):
        relief, after, _ = _ups_step(list(perm))
        assert relief.capex_eur.value == 2 * 1200 * 320 and {u.id: u.units for u in after.power.ups}["U-1200"] == 6
    twins = [_ups("T-b", 1000, 4, "N"), _ups("T-a", 1000, 4, "N")]
    for perm in itertools.permutations(twins):
        _, after, _ = _ups_step(list(perm))
        assert {u.id: u.units for u in after.power.ups} == {"T-a": 6, "T-b": 4}


def test_a_2n_block_is_chosen_only_when_nothing_cheaper_per_usable_kW_exists():
    sole = _ups_step([_ups("only-2N", 1800, 4, "2N")])
    assert sole[0].capex_eur.value == 2 * 1800 * 320 and {u.id: u.units for u in sole[1].power.ups} == {"only-2N": 6}
    assert {u.id: u.units for u in _ups_step([_ups("U-2N", 4000, 4, "2N"), _ups("U-N", 500, 2, "N")])[1].power.ups} == {"U-2N": 4, "U-N": 4}


def test_a_bank_whose_added_units_gain_no_usable_heat_is_never_the_host():
    """A bank of ONE unit under N+2 gains nothing from one more unit (2 units less 2 spare is still no usable unit): however large its rating, it is not
    chosen while another bank gains heat."""
    ctx = _ctx(_cdu_doc([_cdu("big-N+2", 5000, 4, 600, 1, "N+2"), _cdu("small-N", 800, 4, 600, 2, "N")]))
    assert {c.id: c.units for c in cdu_capacity(ctx).relief.apply(ctx).thermal.cdus} == {"big-N+2": 1, "small-N": 3}
