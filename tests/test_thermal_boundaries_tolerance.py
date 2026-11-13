"""A hall exactly AT a gate limit passes it, and a hall genuinely over it still fails.

Binary floating point cannot always say that two figures are equal: ``100 * (1 - 0.85)`` is 15.000000000000002 and ``27.9 - 5.1`` is
22.799999999999997. The thermal gates and the floor-loading gate compared such figures with ``<=``, so a hall that removed exactly 15 kW of
air per position failed a 15 kW need and was given zero racks (14 of 160 facility-water cases and 74 residual-air cases failed this way
when audited). ``gridforge.numerics.leq`` allows a RELATIVE 1e-9 and no more; these tests pin both halves: the noise passes, and a value
1e-6 over the limit (a thousand times the tolerance, still far below anything an input can say) fails.

The expected "exactly at the limit" figures are written in decimal arithmetic (``decimal.Decimal``), independently of the engine's floats.
"""
from __future__ import annotations

import math
from decimal import Decimal as D

import pytest

from examples.reference_site import build_context
from gridforge.common import ASSUMED, CUSTOMER, V
from gridforge.numerics import LIMIT_REL_TOL, leq
from gridforge.site.constraints import floor_loading
from gridforge.thermal.constraints import architecture_capability, residual_air_removal, tcs_supply_achievable
from gridforge.thermal.schema import Architecture, RDHxSpec

import dataclasses

OVER = 1e-6        # a thousand times the tolerance: a genuinely larger value


# ============================================================================================================================
# the comparison itself
# ============================================================================================================================
class TestLeq:
    def test_the_audit_cases_are_float_noise_that_a_plain_comparison_gets_wrong(self):
        assert 100 * (1 - 0.85) == 15.000000000000002 and not (100 * (1 - 0.85) <= 15.0)
        assert 27.9 - 5.1 == 22.799999999999997 and not (22.8 <= 27.9 - 5.1)
        assert leq(100 * (1 - 0.85), 15.0) and leq(22.8, 27.9 - 5.1)

    def test_exact_equality_and_ordinary_ordering(self):
        assert leq(15.0, 15.0) and leq(14.0, 15.0) and not leq(16.0, 15.0)
        assert leq(-5.0, -5.0) and leq(-6.0, -5.0) and not leq(-4.0, -5.0)

    def test_the_tolerance_is_relative_so_it_scales_with_the_limit(self):
        for limit in (1e-6, 0.15, 15.0, 4500.0, 2e6):
            assert leq(limit * (1 + LIMIT_REL_TOL / 10), limit), limit            # noise-sized excess passes at every magnitude
            assert not leq(limit * (1 + OVER), limit), limit                        # a 1e-6 relative excess fails at every magnitude

    def test_a_genuinely_larger_value_never_passes(self):
        for limit in (15.0, 22.8, 135.0, 1223.0):
            for excess in (1e-6, 1e-4, 1e-2, 1.0):
                assert not leq(limit * (1 + excess), limit), (limit, excess)

    def test_against_a_limit_of_zero_only_zero_passes(self):
        assert leq(0.0, 0.0) and leq(-0.0, 0.0) and leq(-1.0, 0.0)
        assert not leq(1e-300, 0.0) and not leq(1e-12, 0.0)                         # no absolute allowance that could swallow a small limit

    def test_non_finite_values_follow_ieee_rules_and_fail_closed(self):
        assert leq(math.inf, math.inf) and leq(5.0, math.inf) and not leq(math.inf, 5.0)
        assert not leq(math.nan, 5.0) and not leq(5.0, math.nan) and not leq(math.nan, math.nan)

    def test_the_tolerance_is_the_documented_one(self):
        assert LIMIT_REL_TOL == 1e-9


# ============================================================================================================================
# residual air removal: need = rack kW x (1 - liquid fraction) against what the hall removes per position
# ============================================================================================================================
def _residual_ctx(rack_kW: float, liquid_fraction: float, have_kW: float):
    ctx = build_context()
    p = ctx.cluster.platform
    ctx.cluster.platform = dataclasses.replace(
        p, rack_kW=V(rack_kW, "kW", "rack", ASSUMED), peak_rack_kW=V(rack_kW, "kW", "rack peak", ASSUMED),
        liquid_fraction=V(liquid_fraction, "1", "liquid fraction", ASSUMED))
    ctx.thermal.residual_air_capacity_kW_per_rack = V(have_kW, "kW", "air removal per position", CUSTOMER)
    return ctx


def _residual_cases():
    for kw10 in range(1000, 1500, 7):
        for lf100 in (80, 85, 87, 90, 92):
            kw, lf = kw10 / 10, lf100 / 100
            yield kw, lf, float(D(str(kw)) * (D(1) - D(str(lf))))        # the need in exact decimal arithmetic


class TestResidualAirAtTheLimit:
    def test_the_audit_headline_a_hall_removing_exactly_15_kw_per_position_gets_racks(self):
        # 100 kW rack, 85% liquid: 15 kW of air per rack. A hall that removes exactly 15 kW passes.
        assert residual_air_removal(_residual_ctx(100.0, 0.85, 15.0)).racks == math.inf
        assert residual_air_removal(_residual_ctx(100.0, 0.85, 15.0 * (1 - OVER))).racks == 0.0

    def test_every_exactly_at_the_limit_case_passes_and_the_set_really_contains_float_noise(self):
        cases = list(_residual_cases())
        noisy = [(kw, lf, have) for kw, lf, have in cases if kw * (1 - lf) > have]       # the plain comparison would refuse these
        assert len(noisy) >= 50, len(noisy)
        for kw, lf, have in cases:
            assert residual_air_removal(_residual_ctx(kw, lf, have)).racks == math.inf, (kw, lf, have)

    def test_every_genuinely_over_case_still_fails(self):
        for kw, lf, need in _residual_cases():
            assert residual_air_removal(_residual_ctx(kw, lf, need * (1 - OVER))).racks == 0.0, (kw, lf, need)

    def test_a_clearly_insufficient_hall_fails_and_a_clearly_sufficient_one_passes(self):
        assert residual_air_removal(_residual_ctx(135.0, 0.90, 9.0)).racks == 0.0          # 13.5 kW needed, 9 kW removed
        assert residual_air_removal(_residual_ctx(135.0, 0.90, 14.0)).racks == math.inf


# ============================================================================================================================
# facility water: the water the plant supplies against the TCS target less the CDU approach
# ============================================================================================================================
def _tcs_ctx(tcs: float, approach: float, supply: float):
    ctx = build_context()
    ctx.architecture = Architecture.HYBRID_DLC
    ctx.thermal.tcs_target_supply_C = V(tcs, "degC", "TCS target", CUSTOMER)
    ctx.thermal.cdu_approach_K = V(approach, "K", "CDU approach", CUSTOMER)
    ctx.thermal.plant.design_supply_C = V(supply, "degC", "plant supply", CUSTOMER)
    return ctx


def _tcs_cases():
    for t10 in range(270, 330, 3):          # TCS target 27.0 .. 32.9 degC
        for a10 in range(30, 80, 7):        # approach 3.0 .. 7.9 K
            t, a = t10 / 10, a10 / 10
            yield t, a, float(D(str(t)) - D(str(a)))            # the limit in exact decimal arithmetic


class TestFacilityWaterAtTheLimit:
    def test_the_audit_cases_a_plant_at_exactly_the_required_temperature_passes(self):
        cases = list(_tcs_cases())
        assert len(cases) == 160
        noisy = [(t, a, fws) for t, a, fws in cases if fws > t - a]            # the plain comparison would refuse these
        assert len(noisy) >= 10, len(noisy)
        for t, a, fws in cases:
            assert tcs_supply_achievable(_tcs_ctx(t, a, fws)).racks == math.inf, (t, a, fws)

    def test_a_plant_genuinely_warmer_than_required_still_fails(self):
        for t, a, fws in _tcs_cases():
            assert tcs_supply_achievable(_tcs_ctx(t, a, fws * (1 + OVER))).racks == 0.0, (t, a, fws)
        assert tcs_supply_achievable(_tcs_ctx(30.0, 5.0, 25.5)).racks == 0.0
        assert tcs_supply_achievable(_tcs_ctx(30.0, 5.0, 24.9)).racks == math.inf

    def test_the_dry_cooler_path_is_held_to_the_same_comparison(self):
        # full DLC: dry bulb 15.3 + approach 9.9 = 25.2 (25.200000000000003 in binary) against 30.2 - 5.0
        ctx = _tcs_ctx(30.2, 5.0, 6.0)
        ctx.architecture = Architecture.FULL_DLC
        ctx.site.design_drybulb_C = V(15.3, "degC", "dry bulb", CUSTOMER)
        ctx.thermal.plant.dry_cooler_approach_K = V(9.9, "K", "dry cooler approach", CUSTOMER)
        assert 15.3 + 9.9 > 25.2
        assert tcs_supply_achievable(ctx).racks == math.inf
        ctx.site.design_drybulb_C = V(15.3 * (1 + OVER), "degC", "dry bulb", CUSTOMER)
        assert tcs_supply_achievable(ctx).racks == 0.0


# ============================================================================================================================
# architecture capability: the platform's rack power against what the architecture can carry
# ============================================================================================================================
class TestArchitectureCapabilityAtTheLimit:
    def _rdhx(self, rack_kW: float, capability: float):
        ctx = build_context()
        ctx.architecture = Architecture.RDHX
        ctx.thermal.rdhx = RDHxSpec(id="RDHX", capacity_kW_per_rack=V(capability, "kW", "declared rear-door rating", CUSTOMER))
        p = ctx.cluster.platform
        ctx.cluster.platform = dataclasses.replace(p, rack_kW=V(rack_kW, "kW", "rack", ASSUMED))
        return ctx

    def test_a_rack_exactly_at_the_declared_capability_passes(self):
        assert architecture_capability(self._rdhx(135.0, 135.0)).racks == math.inf

    def test_a_rack_one_unit_in_the_last_place_over_passes_and_one_part_in_a_million_over_fails(self):
        assert architecture_capability(self._rdhx(math.nextafter(135.0, math.inf), 135.0)).racks == math.inf
        assert architecture_capability(self._rdhx(135.0 * (1 + OVER), 135.0)).racks == 0.0
        assert architecture_capability(self._rdhx(135.0, 100.0)).racks == 0.0

    def test_the_library_capabilities_still_separate_the_architectures(self):
        for arch, rack, expect in ((Architecture.RETAINED_AIR, 22.0, math.inf), (Architecture.RETAINED_AIR, 22.1, 0.0),
                                   (Architecture.FULL_DLC, 150.0, math.inf), (Architecture.FULL_DLC, 150.2, 0.0)):
            ctx = build_context()
            ctx.architecture = arch
            ctx.cluster.platform = dataclasses.replace(ctx.cluster.platform, rack_kW=V(rack, "kW", "rack", ASSUMED))
            assert architecture_capability(ctx).racks == expect, (arch, rack)


# ============================================================================================================================
# floor loading: the imposed load averaged over the aisle pitch against the hall's design capacity
# ============================================================================================================================
KG_PER_M2_PER_KPA = 101.97


def _floor_ctx(mass_kg: float, kpa: float, pitch_m: float = 2.4):
    ctx = build_context()
    p = ctx.cluster.platform
    ctx.cluster.platform = dataclasses.replace(p, rack_mass_kg=V(mass_kg, "kg", "rack mass", ASSUMED))
    ctx.hall.aisle_pitch_m = V(pitch_m, "m", "aisle pitch", CUSTOMER)
    ctx.hall.floor_loading_kPa = V(kpa, "kPa", "floor loading", CUSTOMER)
    return ctx


class TestFloorLoadingAtTheLimit:
    def test_a_hall_designed_for_exactly_the_imposed_load_passes_and_the_set_really_contains_float_noise(self):
        passed = noisy = 0
        for mass in range(1000, 2000, 7):
            imposed = mass / (2.4 * 0.6)
            kpa = imposed / KG_PER_M2_PER_KPA            # the design loading that supports exactly this imposed load
            noisy += kpa * KG_PER_M2_PER_KPA < imposed   # one unit in the last place short: the plain comparison would refuse it
            assert floor_loading(_floor_ctx(float(mass), kpa)).racks == math.inf, mass
            passed += 1
        assert passed > 100 and noisy >= 5, (passed, noisy)

    def test_a_floor_genuinely_weaker_than_the_imposed_load_fails(self):
        for mass in range(1000, 2000, 7):
            kpa = mass / (2.4 * 0.6) / KG_PER_M2_PER_KPA
            assert floor_loading(_floor_ctx(float(mass), kpa * (1 - OVER))).racks == 0.0, mass

    def test_the_reference_numbers_still_hold(self):
        # GB300 rack 1,400 kg over 2.4 m x 0.6 m = 972 kg/m2 against 12 kPa = 1,224 kg/m2: passes; against 9 kPa = 918 kg/m2: fails.
        assert floor_loading(_floor_ctx(1400.0, 12.0)).racks == math.inf
        assert floor_loading(_floor_ctx(1400.0, 9.0)).racks == 0.0
