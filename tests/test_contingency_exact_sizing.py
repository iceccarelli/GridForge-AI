"""A supply sized EXACTLY to the load meets it, whichever way the float arithmetic rounds, and the order the units are listed in changes nothing.

Defect (independent numerics audit, 2026-11-13, reproduced through ``handle_power_deploy_assess``): ``margin.value >= 0`` had no tolerance, and
0.1 + 0.7 is 0.7999999999999999 in binary, so 0.1 MW of grid and 0.7 MW of storage against a 0.8 MW load came out a FAIL with a margin of
-1.1e-16 (473 of 4,000 random exactly-sized plants did). The same flaw sat in the standby start-up bridge (``gap_MW <= 0``, ``bridge >= gap``)
and in the plausibility findings (an IT load or site peak exactly at the supply ceiling was called "over" it).

Expected figures are decimal (``fractions.Fraction``): the supply is built to equal the load in exact arithmetic.
"""
from __future__ import annotations

import itertools
import random
from fractions import Fraction as F

import pytest

from gridforge.api.server import handle_power_deploy_assess
from gridforge.api.tiers import Tier
from gridforge.common import ASSUMED, CUSTOMER, V
from gridforge.intake.loader import load_document
from gridforge.power.generation import GenerationUnit
from gridforge.power.plausibility import plausibility_findings
from gridforge.power.reliability import ContingencyCase, ContingencyStatus, Redundancy, _startup_bridge_notes, evaluate
from gridforge.power.storage import BatteryEnergyStorageSystem

import json
from pathlib import Path

DUBLIN = json.loads((Path(__file__).resolve().parent.parent / "examples" / "intake" / "dublin_hall.json").read_text())


def _gen(i: str, MW: F, **kw) -> GenerationUnit:
    return GenerationUnit(id=i, kind="gas_engine", nameplate_MW=V(float(MW), "MW", f"{i} nameplate", ASSUMED),
                          availability=V(1.0, "1", f"{i} availability", ASSUMED), **kw)


def _case(load: F, grid: F, units: list[F], redundancy=Redundancy.N) -> ContingencyCase:
    return ContingencyCase(critical_load_MW=V(float(load), "MW", "load", ASSUMED), grid_firm_MW=V(float(grid), "MW", "grid", ASSUMED),
                           generation=[_gen(f"G{i}", u) for i, u in enumerate(units)], redundancy=redundancy)


class TestExactlySizedPlantPasses:
    def test_the_audit_case_through_the_api(self):
        assert 0.1 + 0.7 == 0.7999999999999999
        out = handle_power_deploy_assess(
            {"load_profile": {"flat_kW": 800}, "grid_firm_MW": 0.1, "target_MW": 0.8, "ride_through_hours": 1, "redundancy": "N",
             "bess": [{"id": "BESS-1", "power_MW": 0.7, "energy_MWh": 10}]}, Tier.CLIENT)
        arch = out["architectures"][1]                       # grid + battery
        assert arch["status"] == "pass", arch
        assert arch["margin_MW"] == 0.0 and str(arch["margin_MW"])[0] != "-"      # never a PASS with a negative margin

    def test_four_thousand_random_exactly_sized_plants_none_fails(self):
        rng = random.Random(5)
        statuses = {}
        for _ in range(4000):
            grid = F(rng.randint(1, 500), 10)
            units = [F(rng.randint(1, 300), 10) for _ in range(rng.randint(1, 3))]
            load = grid + sum(units)                         # supply == load, exactly, in decimal
            r = evaluate(_case(load, grid, units))
            statuses[r.status] = statuses.get(r.status, 0) + 1
            assert r.status != ContingencyStatus.FAIL, (float(grid), [float(u) for u in units], float(load), r.margin_MW.value)
            assert r.margin_MW.value >= 0.0
        assert statuses                                      # (every case was PASS: no blocking caveat applies to a fully declared plant)

    def test_a_shortfall_of_a_millionth_is_still_a_fail(self):
        for grid, units in ((F(1, 10), [F(7, 10)]), (F(441, 10), [F(101, 10), F(94, 10), F(101, 10)]), (F(33, 10), [F(18, 10), F(157, 10)])):
            load = grid + sum(units)
            assert evaluate(_case(load * (1 + F(1, 10**6)), grid, units)).status == ContingencyStatus.FAIL
            assert evaluate(_case(load * (1 - F(1, 10**6)), grid, units)).status == ContingencyStatus.PASS

    def test_n_plus_one_exactly_sized_after_losing_the_largest_unit_passes(self):
        for grid, units in ((F(1, 10), [F(7, 10), F(3, 10)]), (F(22, 10), [F(51, 10), F(13, 10), F(51, 10)])):
            biggest = max(units)
            load = grid + sum(units) - biggest
            assert evaluate(_case(load, grid, units, Redundancy.N_PLUS_1)).status == ContingencyStatus.PASS
            assert evaluate(_case(load * (1 + F(1, 10**6)), grid, units, Redundancy.N_PLUS_1)).status == ContingencyStatus.FAIL

    def test_the_listing_order_of_the_units_changes_nothing(self):
        grid, units = F(1, 10), [F(7, 10), F(123, 100), F(41, 100), F(9, 100)]
        load = grid + sum(units)
        seen = set()
        for perm in itertools.permutations(range(4)):
            r = evaluate(_case(load, grid, [units[i] for i in perm]))
            seen.add((r.status, r.available_MW.value, r.margin_MW.value))
        assert len(seen) == 1 and next(iter(seen))[0] == ContingencyStatus.PASS


class TestStandbyStartBridgeAtExactlyTheNeed:
    def _bess(self, MW: F) -> BatteryEnergyStorageSystem:
        return BatteryEnergyStorageSystem(
            id="B", power_MW=V(float(MW), "MW", "B power", ASSUMED), energy_MWh=V(1000.0, "MWh", "B energy", ASSUMED),
            soc_min=V(0.1, "1", "soc min", ASSUMED), soc_max=V(0.95, "1", "soc max", ASSUMED),
            round_trip_efficiency=V(0.88, "1", "rte", ASSUMED))

    def test_a_load_exactly_met_without_the_generator_raises_no_start_up_caveat(self):
        """0.1 MW grid + 0.7 MW storage = 0.8 MW load exactly: the standby engine is not relied on, so its missing start-up time is not a caveat.
        The old ``gap_MW <= 0`` saw a gap of 1.1e-16 and wrote 'relies on generation for at least 0.00 MW' (a PASS became an engineering study)."""
        case = ContingencyCase(
            critical_load_MW=V(0.8, "MW", "load", ASSUMED), grid_firm_MW=V(0.1, "MW", "grid", ASSUMED),
            generation=[_gen("G", F(5), operating_mode="standby")], bess=[self._bess(F(7, 10))],
            ride_through_hours=V(1.0, "h", "ride-through", CUSTOMER))
        assert _startup_bridge_notes(case, set(), set()) == []
        r = evaluate(case)
        assert r.status == ContingencyStatus.PASS and r.blocking == []

    def test_storage_exactly_the_size_of_the_gap_bridges_it(self):
        """grid 0.1 + storage 0.5 against 1.1 MW leaves a gap of exactly 0.5 MW for the engine; the storage's 0.5 MW bridges it. Binary subtraction
        says the gap is 0.5000000000000001, which the old ``bridge >= gap`` called a failure to bridge."""
        assert 1.1 - (0.1 + 0.5) > 0.5
        case = ContingencyCase(
            critical_load_MW=V(1.1, "MW", "load", ASSUMED), grid_firm_MW=V(0.1, "MW", "grid", ASSUMED),
            generation=[_gen("G", F(5), operating_mode="standby", startup_time_min=V(5.0, "min", "start", CUSTOMER))],
            bess=[self._bess(F(1, 2))], ride_through_hours=V(1.0, "h", "ride-through", CUSTOMER))
        assert _startup_bridge_notes(case, set(), set()) == []

    def test_storage_genuinely_smaller_than_the_gap_still_warns(self):
        case = ContingencyCase(
            critical_load_MW=V(1.1 * (1 + 1e-6), "MW", "load", ASSUMED), grid_firm_MW=V(0.1, "MW", "grid", ASSUMED),
            generation=[_gen("G", F(5), operating_mode="standby", startup_time_min=V(5.0, "min", "start", CUSTOMER))],
            bess=[self._bess(F(1, 2))], ride_through_hours=V(1.0, "h", "ride-through", CUSTOMER))
        notes = _startup_bridge_notes(case, set(), set())
        assert len(notes) == 1 and "cannot carry" in notes[0]


class TestPlausibilityAtTheCeiling:
    def _ctx(self, **grid):
        d = json.loads(json.dumps(DUBLIN))
        d["grid"].update(grid)
        return load_document(d).context

    def test_a_peak_exactly_at_the_ceiling_is_not_overdrawn(self):
        assert 18.0 * 0.95 == 17.099999999999998                                    # the ceiling is a product, with binary noise
        ctx = self._ctx(firm_capacity_MVA=18.0, power_factor=0.95, contracted_MW=40.0, current_site_peak_MW=17.1, current_it_load_MW=4.0)
        assert not [f for f in plausibility_findings(ctx) if "cannot cover" in f]

    def test_an_it_load_exactly_at_the_ceiling_is_not_over_it(self):
        ctx = self._ctx(firm_capacity_MVA=18.0, power_factor=0.95, contracted_MW=40.0, current_site_peak_MW=17.1, current_it_load_MW=17.1)
        assert not [f for f in plausibility_findings(ctx) if "cannot cover" in f or "is below the current IT load" in f]

    def test_a_peak_genuinely_over_the_ceiling_is_still_a_finding(self):
        ctx = self._ctx(firm_capacity_MVA=18.0, power_factor=0.95, contracted_MW=40.0, current_site_peak_MW=17.1 * (1 + 1e-6),
                        current_it_load_MW=4.0)
        assert [f for f in plausibility_findings(ctx) if "cannot cover the current site peak" in f]

    def test_a_peak_genuinely_below_the_it_load_is_still_a_finding(self):
        ctx = self._ctx(firm_capacity_MVA=50.0, contracted_MW=40.0, current_site_peak_MW=10.0, current_it_load_MW=10.0 * (1 + 1e-6))
        assert [f for f in plausibility_findings(ctx) if "is below the current IT load" in f]
        ctx = self._ctx(firm_capacity_MVA=50.0, contracted_MW=40.0, current_site_peak_MW=10.0, current_it_load_MW=10.0)
        assert not [f for f in plausibility_findings(ctx) if "is below the current IT load" in f]
