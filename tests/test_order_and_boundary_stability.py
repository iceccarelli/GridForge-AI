"""A hall exactly at a limit gets the racks it exactly fits, and the order the customer lists equipment in cannot change the answer.

Defects (independent numerics audit, 2026-11-13, each reproduced before it was fixed):

* N1  ``floor_racks`` floored with no tolerance and the capacity sums added floats in list order. The Dublin example with enlarged hall inputs and
      UPS blocks 5 x 1823.7 kW, 2 x 1747.6 kW, 2 x 1155.6 kW under N, an IT load of 12.7649 MW, has EXACTLY 2160 kW (16 racks of 135 kW) of headroom:
      listing the blocks U0, U1, U2 gave 16 racks, U1, U2, U0 gave 15. At about 55 kEUR a rack, a number that moves with the order of a list (or with
      binary noise) is a money defect. Measured with the exact boundary: racks N-1 in 16.5% of UPS cases, 9.7% pump flow, 6.6% plant, 1.3% grid.
* N10 ``need.value <= lv.tapoff_max_A.value`` had no tolerance: 76 A x 400 V / 500 V is 60.800000000000004 in binary, so a 60.8 A tap-off failed the
      rack it exactly carries (0 racks, a EUR 6.17M plan) while 60.81 A gave 36.

The expected figures are written in decimal arithmetic (``decimal.Decimal``), independently of the engine's floats: the inputs are chosen so that
the headroom is exactly ``k`` racks in DECIMAL, and the engine must say ``k``.
"""
from __future__ import annotations

import copy
import itertools
import json
import math
import random
from decimal import Decimal as D
from pathlib import Path

import pytest

from gridforge.common import ASSUMED, CUSTOMER, V
from gridforge.compute.library import get_platform
from gridforge.constraints import floor_racks
from gridforge.intake.loader import load_document
from gridforge.numerics import LIMIT_REL_TOL, floor_whole
from gridforge.power.constraints import grid_firm_capacity, rack_feed_tapoff, transformer_capacity, ups_capacity
from gridforge.power.schema import GenerationOption, UPSBlock
from gridforge.scenario.run import run_all
from gridforge.envelope.time_to_power import schedule
from gridforge.thermal.constraints import cdu_capacity, hydraulic_flow, plant_capacity
from gridforge.thermal.library import PUE_BY_ARCHITECTURE
from gridforge.thermal.schema import Architecture, CDUSpec
from gridforge.validation import Quantity, qmin, qsum, EvidenceClass

INTAKE = Path(__file__).resolve().parent.parent / "examples" / "intake"
HALLS = ("reference_hall", "dublin_hall", "london_hall", "nordic_hall")
PLATFORMS = ("gb200_nvl72", "gb300_nvl72", "generic_dlc_50")
SAMPLE = 520          # at least 500 exact-boundary cases per family


def _doc(name: str) -> dict:
    return json.loads((INTAKE / f"{name}.json").read_text())


def _ctx(platform: str = "gb300_nvl72", arch: Architecture = Architecture.HYBRID_DLC):
    doc = _doc("dublin_hall")
    doc["compute"]["platform"] = platform
    ctx = load_document(doc).context
    ctx.architecture = arch
    ctx.pue = PUE_BY_ARCHITECTURE[arch]
    return ctx


def _dec(x: float) -> D:
    """The decimal a float was written as (its shortest repr), so the expected figure is decimal and the engine's binary one is compared to it."""
    return D(repr(x))


# ============================================================================================================================
# the one floor
# ============================================================================================================================
class TestFloor:
    def test_noise_below_a_whole_number_is_that_number(self):
        for whole in (1, 2, 15, 16, 60, 1000, 123456):
            noisy = whole * (1 - 2.2e-16 * 8)                        # a handful of roundings below
            assert noisy < whole
            assert floor_whole(noisy) == whole, whole
            assert floor_whole(float(whole)) == whole
            assert floor_whole(whole * (1 + 2.2e-16 * 8)) == whole

    def test_a_genuine_shortfall_still_floors_down(self):
        assert floor_whole(15.99999) == 15 and floor_whole(15.999) == 15 and floor_whole(0.999) == 0
        for whole in (2, 16, 1000):
            assert floor_whole(whole * (1 - 1e-6)) == whole - 1      # a thousand times the tolerance: a different number

    def test_the_allowance_is_relative_and_never_below_the_tolerance_itself(self):
        assert floor_whole(1 - LIMIT_REL_TOL / 2) == 1               # 5e-10 short of one rack
        assert floor_whole(0.5) == 0 and floor_whole(1e-12) == 0
        big = 5_000_000.0
        assert floor_whole(big - big * LIMIT_REL_TOL / 2) == 5_000_000
        assert floor_whole(big - big * LIMIT_REL_TOL * 4) == 4_999_999

    def test_floor_racks_uses_it_for_value_and_band_and_keeps_the_non_finite_rules(self):
        q = Quantity(15.999999999999998, "racks", V(1, "1", "x", ASSUMED).prov, 15.999999999999998, 16.000000000000004)
        out = floor_racks(q)
        assert (out.value, out.band) == (16, (16, 16))
        assert floor_racks(V(math.inf, "racks", "unlimited", ASSUMED)).value == math.inf
        assert floor_racks(V(-math.inf, "racks", "negative", ASSUMED)).value == 0.0
        assert floor_racks(V(math.nan, "racks", "undetermined", ASSUMED)).value == 0.0
        assert floor_racks(V(-1e-12, "racks", "spent", ASSUMED)).value == 0.0


# ============================================================================================================================
# N1 - the audit's own case, in every listing order
# ============================================================================================================================
def _audit_doc() -> dict:
    d = _doc("dublin_hall")
    d["scenarios"] = ["hybrid_dlc"]
    g = d["grid"]
    g.update(firm_capacity_MVA=300, contracted_MW=290, current_site_peak_MW=20, current_it_load_MW=12.7649)
    d["hall"].update(positions_available=2000, rack_positions=2500)
    d["transformers"] = [{"id": "T", "unit_rating_MVA": 100, "units": 5, "redundancy": "N", "derating_factor": 0.9,
                          "replacement_lead_time_weeks": 100}]
    d["lv"].update(busway_ampacity_A=3200, busway_runs=40, tapoff_max_A=400)
    d["thermal"]["plant"].update(chilled_water_capacity_kW=900000, pump_flow_capacity_l_per_min=4000000)
    return d


AUDIT_BLOCKS = [{"id": "U0", "unit_rating_kW": 1823.7, "units": 5, "redundancy": "N", "step_load_capability": 0.5},
                {"id": "U1", "unit_rating_kW": 1747.6, "units": 2, "redundancy": "N", "step_load_capability": 0.5},
                {"id": "U2", "unit_rating_kW": 1155.6, "units": 2, "redundancy": "N", "step_load_capability": 0.5}]


class TestAuditUpsCase:
    def test_the_headroom_is_exactly_sixteen_racks_in_decimal(self):
        total = 5 * D("1823.7") + 2 * D("1747.6") + 2 * D("1155.6")
        assert total - D("12764.9") == 16 * 135                      # 2160 kW: the premise of the test, in exact arithmetic

    def test_every_listing_order_gives_sixteen_racks_the_same_binding_constraint_and_the_same_money(self):
        seen = set()
        for order in itertools.permutations(range(3)):
            d = _audit_doc()
            d["ups"] = [AUDIT_BLOCKS[i] for i in order]
            it = load_document(d)
            r = run_all(it.context, it.scenarios)[0]
            ups = next(c for c in r.envelope.constraints if c.id == "ups_capacity")
            assert ups.max_racks.value == 16, order
            seen.add((r.envelope.max_racks, r.envelope.binding.id, r.unlocked_racks, r.economics.capex_total_eur.value))
        assert len(seen) == 1, seen
        assert next(iter(seen))[:2] == (16, "ups_capacity")


# ============================================================================================================================
# N1 - every equipment list, in every order, on every example
# ============================================================================================================================
def _multi_item(doc: dict) -> dict:
    """The example with each equipment list made of three DIFFERENT items, so that a permutation actually reorders something and a float sum
    has something to round. The ratings are not meant to be a good hall: only to give each list three distinct, plausible entries."""
    d = copy.deepcopy(doc)
    t0 = d["transformers"][0]
    r = float(t0["unit_rating_MVA"])
    d["transformers"] = [
        dict(t0, id="TX-1"),
        dict(t0, id="TX-2", unit_rating_MVA=round(r * 0.8, 1), units=2, redundancy="N", replacement_lead_time_weeks=120),
        dict(t0, id="TX-3", unit_rating_MVA=round(r * 1.3, 1), units=2, redundancy="N+1", replacement_lead_time_weeks=200)]
    u0 = (d.get("ups") or [{"id": "UPS-1", "unit_rating_kW": 1200, "units": 6, "redundancy": "N+1", "step_load_capability": 0.5}])[0]
    d["ups"] = [
        dict(u0, id="UPS-1"),
        dict(u0, id="UPS-2", unit_rating_kW=round(float(u0["unit_rating_kW"]) * 0.7, 1), units=4, redundancy="N"),
        dict(u0, id="UPS-3", unit_rating_kW=round(float(u0["unit_rating_kW"]) * 1.1, 1), units=3, redundancy="N+1")]
    d["thermal"]["cdus"] = [
        {"id": "CDU-1", "rated_capacity_kW": 1350, "rated_approach_K": 5, "rated_flow_l_per_min": 2000, "units": 3, "redundancy": "N+1"},
        {"id": "CDU-2", "rated_capacity_kW": 910.3, "rated_approach_K": 5, "rated_flow_l_per_min": 1500, "units": 2, "redundancy": "N"},
        {"id": "CDU-3", "rated_capacity_kW": 1790.7, "rated_approach_K": 6, "rated_flow_l_per_min": 2500, "units": 4, "redundancy": "N+1"}]
    base = {"firm": True, "annual_run_hours": 5000, "opex_eur_per_MWh": 95, "fixed_om_eur_per_kW_year": 18}
    d["btm_options"] = [
        dict(base, id="GEN-A", kind="gas_engine", capacity_MW=3.3, capex_eur_per_kW=800, lead_time_weeks=44),
        dict(base, id="CHP-B", kind="chp", capacity_MW=2.2, capex_eur_per_kW=1100, lead_time_weeks=52),
        dict(base, id="FC-C", kind="fuel_cell", capacity_MW=1.7, capex_eur_per_kW=1500, lead_time_weeks=30)]
    d["scenarios"] = ["hybrid_dlc", "full_dlc", "full_dlc_btm"]
    return d


def _fingerprint(doc: dict) -> list:
    """Everything a customer is shown that is a number or a name: per scenario the as-found and unlocked racks, every constraint's own rack count,
    the binding constraints, the money, the date and the plan."""
    it = load_document(doc)
    out = []
    for r in run_all(it.context, it.scenarios):
        t = schedule(r.ladder)
        out.append((
            r.spec.id, r.envelope.max_racks, r.envelope.binding.id, tuple(sorted((c.id, c.max_racks.value) for c in r.envelope.constraints)),
            r.unlocked_racks, r.ladder.final.binding.id, r.economics.capex_total_eur.value, r.economics.capex_relief_eur.value,
            r.economics.annual_energy_cost_eur.value, t.weeks_to_full, r.ladder.critical_path_weeks,
            tuple((s.binding_id, s.capex_eur.value if s.capex_eur is not None else None, s.racks_after) for s in r.ladder.taken_steps)))
    return out


LISTS = (("transformers",), ("ups",), ("thermal", "cdus"), ("btm_options",))


def _get(d: dict, path: tuple):
    for p in path:
        d = d[p]
    return d


def _set(d: dict, path: tuple, value: list) -> None:
    for p in path[:-1]:
        d = d[p]
    d[path[-1]] = value


@pytest.mark.parametrize("hall", HALLS)
class TestEveryListInEveryOrder:
    def test_the_as_shipped_example_does_not_move(self, hall):
        doc = _doc(hall)
        ref = _fingerprint(doc)
        for path in LISTS:
            items = _get(doc, path)
            for perm in itertools.permutations(items):
                d = copy.deepcopy(doc)
                _set(d, path, list(perm))
                assert _fingerprint(d) == ref, (hall, path)

    def test_a_three_item_list_in_all_six_orders_gives_one_answer(self, hall):
        doc = _multi_item(_doc(hall))
        ref = _fingerprint(doc)
        assert any(row[4] > 0 for row in ref), "the variant must unlock racks, or the property proves nothing"
        for path in LISTS:
            items = _get(doc, path)
            assert len(items) == 3
            for perm in itertools.permutations(range(3)):
                d = copy.deepcopy(doc)
                _set(d, path, [items[i] for i in perm])
                assert _fingerprint(d) == ref, (hall, path, perm)

    def test_all_lists_shuffled_together_give_one_answer(self, hall):
        doc = _multi_item(_doc(hall))
        ref = _fingerprint(doc)
        rng = random.Random(f"joint-{hall}")
        for _ in range(6):
            d = copy.deepcopy(doc)
            for path in LISTS:
                items = _get(d, path)
                rng.shuffle(items)
            assert _fingerprint(d) == ref, hall


# ============================================================================================================================
# N1 - the exact-boundary families, in decimal
# ============================================================================================================================
def _stream(family: str):
    return random.Random(f"exact-boundary-{family}")


def _usable(units: int, redundancy: str) -> int:
    return {"N": units, "N+1": max(units - 1, 0), "2N": units // 2}[redundancy]


def _in_other_orders(rng: random.Random, items: list, n: int = 3) -> list[list]:
    """The list as written, then ``n`` shuffles of it (and the reverse): the orders a customer might have typed the same equipment in."""
    out = [list(items), list(reversed(items))]
    for _ in range(n):
        x = list(items)
        rng.shuffle(x)
        out.append(x)
    return out


class TestExactBoundaryFamilies:
    """Headroom EXACTLY k racks of the platform's rack power, in decimal arithmetic, over random decimal ratings: the constraint must say k."""

    def test_ups(self):
        rng, bases, done, bad = _stream("ups"), {p: _ctx(p) for p in PLATFORMS}, 0, []
        while done < SAMPLE:
            platform = rng.choice(PLATFORMS)
            ctx = bases[platform].copy()
            rack = _dec(ctx.cluster.platform.rack_kW.value)
            blocks = [(D(rng.randint(2000, 30000)) / 10, rng.randint(1, 8), rng.choice(("N", "N", "N+1", "2N")))
                      for _ in range(rng.randint(1, 4))]
            total = sum(rt * _usable(u, rd) for rt, u, rd in blocks)
            k = rng.randint(1, 60)
            load_kW = total - k * rack
            if load_kW <= 0:
                continue
            ups = [UPSBlock(f"U{i}", V(float(rt), "kW", f"U{i}", CUSTOMER), u, rd, V(0.5, "1", "step", ASSUMED))
                   for i, (rt, u, rd) in enumerate(blocks)]
            ctx.power.current_it_load_MW = V(float(load_kW / 1000), "MW", "existing protected IT load", CUSTOMER)
            done += 1
            for order in _in_other_orders(rng, ups):
                ctx.power.ups = order
                got = ups_capacity(ctx).max_racks.value
                if got != k:
                    bad.append((platform, [(str(a), b, c) for a, b, c in blocks], [u.id for u in order], str(load_kW), k, got))
        assert not bad, f"{len(bad)} of {done}: {bad[:3]}"

    def test_pump_flow(self):
        rng, bases, done, bad = _stream("pump"), {p: _ctx(p) for p in PLATFORMS}, 0, []
        while done < SAMPLE:
            platform = rng.choice(PLATFORMS)
            ctx = bases[platform].copy()
            per_rack = _dec(ctx.cluster.platform.flow_l_per_min_per_rack.value)
            k = rng.randint(1, 80)
            existing = D(rng.randint(0, 50000)) / 10 if rng.random() < 0.6 else None
            pump = k * per_rack + (existing or 0)
            ctx.thermal.plant.pump_flow_capacity_l_per_min = V(float(pump), "l/min", "pumped flow", CUSTOMER)
            ctx.thermal.plant.existing_flow_l_per_min = (V(float(existing), "l/min", "existing flow", CUSTOMER)
                                                         if existing is not None else None)
            got = hydraulic_flow(ctx).max_racks.value
            done += 1
            if got != k:
                bad.append((platform, str(pump), None if existing is None else str(existing), k, got))
        assert not bad, f"{len(bad)} of {done}: {bad[:3]}"

    def test_plant(self):
        rng, bases, done, bad = _stream("plant"), {p: _ctx(p) for p in PLATFORMS}, 0, []
        while done < SAMPLE:
            platform = rng.choice(PLATFORMS)
            ctx = bases[platform].copy()
            rack = _dec(ctx.cluster.platform.rack_kW.value)          # hybrid DLC: the whole rack load lands on the plant
            k = rng.randint(1, 60)
            it_MW = D(rng.randint(100, 9000)) / 1000
            other = D(rng.randint(0, 40000)) / 10 if rng.random() < 0.5 else None
            capacity = it_MW * 1000 + (other or 0) + k * rack
            ctx.power.current_it_load_MW = V(float(it_MW), "MW", "existing IT load", CUSTOMER)
            ctx.thermal.plant.chilled_water_capacity_kW = V(float(capacity), "kW", "plant capacity", CUSTOMER)
            ctx.thermal.plant.existing_non_it_heat_kW = V(float(other), "kW", "other heat", CUSTOMER) if other is not None else None
            ctx.thermal.plant.dry_cooler_capacity_kW = None
            got = plant_capacity(ctx).max_racks.value
            done += 1
            if got != k:
                bad.append((platform, str(capacity), str(it_MW), None if other is None else str(other), k, got))
        assert not bad, f"{len(bad)} of {done}: {bad[:3]}"

    def test_grid(self):
        rng, bases, done, bad = _stream("grid"), {p: _ctx(p) for p in PLATFORMS}, 0, []
        while done < SAMPLE:
            platform = rng.choice(PLATFORMS)
            ctx = bases[platform].copy()
            facility_per_rack = _dec(ctx.cluster.platform.rack_kW.value) * _dec(ctx.pue.value)
            k = rng.randint(1, 60)
            peak_MW = D(rng.randint(100, 40000)) / 1000
            contracted = (peak_MW * 1000 + k * facility_per_rack) / 1000
            ctx.power.options = []
            ctx.power.grid.firm_capacity_MVA = V(5000.0, "MVA", "firm connection", CUSTOMER)
            ctx.power.grid.contracted_MW = V(float(contracted), "MW", "contracted", CUSTOMER)
            ctx.power.grid.current_site_peak_MW = V(float(peak_MW), "MW", "site peak", CUSTOMER)
            got = grid_firm_capacity(ctx).max_racks.value
            done += 1
            if got != k:
                bad.append((platform, str(contracted), str(peak_MW), k, got))
        assert not bad, f"{len(bad)} of {done}: {bad[:3]}"

    def test_transformers(self):
        rng, bases, done, bad = _stream("transformer"), {p: _ctx(p) for p in PLATFORMS}, 0, []
        while done < SAMPLE:
            platform = rng.choice(PLATFORMS)
            ctx = bases[platform].copy()
            facility_per_rack = _dec(ctx.cluster.platform.rack_kW.value) * _dec(ctx.pue.value)
            pf, derate = D(rng.randint(90, 99)) / 100, D(rng.randint(80, 95)) / 100
            banks = [(D(rng.randint(10, 150)) / 10, rng.randint(1, 5), rng.choice(("N", "N+1"))) for _ in range(rng.randint(1, 4))]
            total_kW = sum(rt * pf * derate * 1000 * _usable(u, rd) for rt, u, rd in banks)
            k = rng.randint(1, 60)
            peak_kW = total_kW - k * facility_per_rack
            if peak_kW <= 0:
                continue
            ctx.power.grid.power_factor = V(float(pf), "1", "power factor", CUSTOMER)
            ctx.power.grid.current_site_peak_MW = V(float(peak_kW / 1000), "MW", "site peak", CUSTOMER)
            txs = [type(ctx.power.transformers[0])(
                f"T{i}", V(float(rt), "MVA", f"T{i}", CUSTOMER), u, rd, V(float(derate), "1", "derating", CUSTOMER), None)
                for i, (rt, u, rd) in enumerate(banks)]
            done += 1
            for order in _in_other_orders(rng, txs):
                ctx.power.transformers = order
                got = transformer_capacity(ctx).max_racks.value
                if got != k:
                    bad.append((platform, [(str(a), b, c) for a, b, c in banks], [t.id for t in order], str(pf), str(derate),
                                str(peak_kW), k, got))
        assert not bad, f"{len(bad)} of {done}: {bad[:3]}"

    def test_cdus(self):
        """CDU banks whose usable heat capacity is exactly k racks of liquid load (derate 1: the rated approach is small)."""
        rng, bases, done, bad = _stream("cdu"), {p: _ctx(p) for p in PLATFORMS}, 0, []
        while done < SAMPLE:
            platform = rng.choice(PLATFORMS)
            ctx = bases[platform].copy()
            liquid = _dec(ctx.cluster.platform.liquid_kW().value)
            k = rng.randint(1, 60)
            banks = [(D(rng.randint(2000, 30000)) / 10, rng.randint(1, 6), rng.choice(("N", "N+1"))) for _ in range(rng.randint(2, 4))]
            usable = sum(rt * _usable(u, rd) for rt, u, rd in banks)
            if usable <= 0:
                continue
            # scale the first bank's units so that the total is exactly k racks: choose the last bank's rating to close the gap exactly
            gap = k * liquid - sum(rt * _usable(u, rd) for rt, u, rd in banks[:-1])
            last_rt, last_u, last_rd = banks[-1]
            n = _usable(last_u, last_rd)
            if n == 0 or gap <= 0:
                continue
            closing = gap / n
            if closing != closing.quantize(D("0.0001")) or closing > 20000:
                continue                                              # keep the rating a short decimal
            banks[-1] = (closing, last_u, last_rd)
            cdus = [CDUSpec(f"C{i}", V(float(rt), "kW", f"C{i}", CUSTOMER), V(1.0, "K", "rated approach", CUSTOMER),
                            V(1e6, "l/min", "rated flow", CUSTOMER), u, rd, True, True)
                    for i, (rt, u, rd) in enumerate(banks)]
            done += 1
            for order in _in_other_orders(rng, cdus):
                ctx.thermal.cdus = order
                got = cdu_capacity(ctx).max_racks.value
                if got != k:
                    bad.append((platform, [(str(a), b, c) for a, b, c in banks], [c.id for c in order], str(liquid), k, got))
        assert not bad, f"{len(bad)} of {done}: {bad[:3]}"

    def test_behind_the_meter_options(self):
        """Installed behind-the-meter options whose firm capacity, added to the grid ceiling, leaves exactly k racks of headroom."""
        rng, bases, done, bad = _stream("btm"), {p: _ctx(p) for p in PLATFORMS}, 0, []
        while done < SAMPLE:
            platform = rng.choice(PLATFORMS)
            ctx = bases[platform].copy()
            facility_per_rack = _dec(ctx.cluster.platform.rack_kW.value) * _dec(ctx.pue.value)
            k = rng.randint(1, 40)
            opts = [(D(rng.randint(5, 80)) / 10, D(rng.randint(70, 99)) / 100) for _ in range(rng.randint(2, 4))]
            btm_kW = sum(cap * 1000 * f for cap, f in opts)
            peak_MW = D(rng.randint(100, 40000)) / 1000
            contracted_kW = peak_MW * 1000 + k * facility_per_rack - btm_kW
            if contracted_kW <= 0:
                continue
            options = [GenerationOption(f"G{i}", "gas_engine", V(float(cap), "MW", f"G{i}", ASSUMED), None, None, firm=True,
                                        firm_capacity_factor=V(float(f), "1", f"G{i} firm factor", CUSTOMER), installed=True)
                       for i, (cap, f) in enumerate(opts)]
            ctx.power.grid.firm_capacity_MVA = V(5000.0, "MVA", "firm connection", CUSTOMER)
            ctx.power.grid.contracted_MW = V(float(contracted_kW / 1000), "MW", "contracted", CUSTOMER)
            ctx.power.grid.current_site_peak_MW = V(float(peak_MW), "MW", "site peak", CUSTOMER)
            done += 1
            for order in _in_other_orders(rng, options):
                ctx.power.options = order
                got = grid_firm_capacity(ctx).max_racks.value
                if got != k:
                    bad.append((platform, [(str(a), str(b)) for a, b in opts], [o.id for o in order], str(contracted_kW), k, got))
        assert not bad, f"{len(bad)} of {done}: {bad[:3]}"

    def test_a_shortfall_of_one_part_in_a_million_is_still_a_rack_short(self):
        """The tolerance is for noise, not for generosity: 1e-6 short (a thousand times the tolerance) loses the rack."""
        ctx = _ctx()
        rack = ctx.cluster.platform.rack_kW.value
        ctx.power.ups = [UPSBlock("U", V(1000.0, "kW", "U", CUSTOMER), 10, "N", V(0.5, "1", "s", ASSUMED))]
        for k in (5, 20, 40):
            load_kW = 10000.0 - k * rack
            ctx.power.current_it_load_MW = V(load_kW / 1000 * (1 + 1e-6), "MW", "load", CUSTOMER)
            assert ups_capacity(ctx).max_racks.value == k - 1
            ctx.power.current_it_load_MW = V(load_kW / 1000, "MW", "load", CUSTOMER)
            assert ups_capacity(ctx).max_racks.value == k


# ============================================================================================================================
# N10 - the tap-off gate at exactly the rack's feed current
# ============================================================================================================================
def _tapoff_doc(volts: float, tapoff: float, platform: str = "generic_dlc_50") -> dict:
    d = _doc("dublin_hall")
    d["compute"] = {"platform": platform, "default_architecture": "hybrid_dlc"}
    d["lv"].update(voltage_V=volts, phases=3, tapoff_max_A=tapoff)
    d["scenarios"] = ["hybrid_dlc"]
    return d


class TestTapOffAtExactlyTheNeed:
    def test_the_audit_case(self):
        assert 76.0 * (400.0 / 500.0) == 60.800000000000004          # the noise: 76 A at 400 V, scaled to a 500 V busway
        out = {}
        for tap in (60.8, 60.81, 60.79):
            it = load_document(_tapoff_doc(500, tap))
            r = run_all(it.context, it.scenarios)[0]
            out[tap] = (r.envelope.max_racks, r.envelope.binding.id, r.economics.capex_total_eur.value)
        assert out[60.8] == out[60.81]                               # exactly at the need passes like a hair above it
        assert out[60.8][0] > 0 and out[60.8][1] != "rack_feed_tapoff"
        assert out[60.79][0] == 0 and out[60.79][1] == "rack_feed_tapoff"      # a genuinely smaller part still fails the gate
        assert out[60.79][2] > out[60.8][2]                          # and the plan to replace it is priced

    @pytest.mark.parametrize("platform", PLATFORMS)
    def test_exactly_the_need_passes_and_a_millionth_less_fails(self, platform):
        feed = _dec(get_platform(platform).rack_feed_current_A.value)
        volts = (100, 125, 160, 200, 250, 320, 400, 500, 625, 800, 1000)      # every one divides 400 x feed into a terminating decimal
        n = 0
        for v in volts:
            need = feed * 400 / v                                   # exact, in decimal
            ctx = load_document(_tapoff_doc(v, float(need), platform)).context
            assert rack_feed_tapoff(ctx).max_racks.value == math.inf, (platform, v, str(need))
            ctx = load_document(_tapoff_doc(v, float(need) * (1 - 1e-6), platform)).context
            assert rack_feed_tapoff(ctx).max_racks.value == 0.0, (platform, v, str(need))
            n += 1
        assert n == len(volts)


# ============================================================================================================================
# qsum
# ============================================================================================================================
class TestQsum:
    def _q(self, v, label, ev=EvidenceClass.E5_CUSTOMER_DATA):
        return Quantity.given(v, "kW", label, ev, band=0.1)

    def test_the_sum_does_not_depend_on_the_order(self):
        parts = [self._q(v, f"p{i}") for i, v in enumerate((1823.7 * 5, 1747.6 * 2, 1155.6 * 2, 0.1, 0.7, 1e-9))]
        ref = qsum(parts)
        assert ref.value == math.fsum(p.value for p in parts)
        for perm in itertools.permutations(parts):
            out = qsum(perm)
            assert (out.value, out.band, out.prov.label, out.prov.digest) == (ref.value, ref.band, ref.prov.label, ref.prov.digest)

    def test_it_carries_the_weakest_evidence_and_the_interval_sum(self):
        a, b = self._q(100.0, "a", EvidenceClass.E5_CUSTOMER_DATA), self._q(50.0, "b", EvidenceClass.E1_MODEL)
        s = qsum([a, b])
        assert s.value == 150.0 and s.evidence == EvidenceClass.E1_MODEL
        assert s.band == pytest.approx((135.0, 165.0))

    def test_one_input_is_returned_unchanged_and_units_must_agree(self):
        a = self._q(3.0, "a")
        assert qsum([a]) is a
        with pytest.raises(ValueError):
            qsum([a, Quantity.given(1.0, "EUR", "b", EvidenceClass.E5_CUSTOMER_DATA)])
        with pytest.raises(ValueError):
            qsum([])

    def test_non_finite_terms_fall_back_deterministically(self):
        a, b = self._q(1.0, "a"), Quantity.given(math.inf, "kW", "b", EvidenceClass.E5_CUSTOMER_DATA)
        assert qsum([a, b]).value == math.inf == qsum([b, a]).value


class TestQmin:
    def test_the_minimum_carries_the_weakest_evidence_of_every_input_and_the_lower_band(self):
        firm = Quantity.given(9.0, "MW", "firm connection", EvidenceClass.E0_ASSUMPTION, band=(8.0, 10.0))
        contracted = Quantity.given(7.0, "MW", "contracted", EvidenceClass.E5_CUSTOMER_DATA, band=(6.5, 7.5))
        m = qmin(contracted, firm)
        assert m.value == 7.0                                         # the winner is the contracted figure ...
        assert m.evidence == EvidenceClass.E0_ASSUMPTION               # ... but the ceiling is only as sure as the firm figure it was found below
        assert m.band == (6.5, 7.5)
        m2 = qmin(firm, contracted)                                   # the argument order does not decide it
        assert (m2.value, m2.evidence, m2.band) == (m.value, m.evidence, m.band)
        assert {p.label for p in m.prov.inputs} == {"firm connection", "contracted"}

    def test_the_band_of_the_loser_can_lower_the_minimum(self):
        a = Quantity.given(5.0, "MW", "a", EvidenceClass.E5_CUSTOMER_DATA, band=(4.9, 5.1))
        b = Quantity.given(6.0, "MW", "b", EvidenceClass.E5_CUSTOMER_DATA, band=(3.0, 9.0))
        assert qmin(a, b).band == (3.0, 5.1)

    def test_one_input_is_itself_nan_propagates_and_no_input_is_refused(self):
        a = Quantity.given(5.0, "MW", "a", EvidenceClass.E5_CUSTOMER_DATA)
        assert qmin(a) is a
        n = Quantity.given(math.nan, "MW", "n", EvidenceClass.E5_CUSTOMER_DATA)
        assert math.isnan(qmin(a, n).value) and math.isnan(qmin(n, a).value)
        with pytest.raises(ValueError):
            qmin()
