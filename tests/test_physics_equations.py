"""Independent validation of the engine's equations, units and conversions.

Every expected value below is computed by hand from the governing equation, with the arithmetic shown in the
comment beside it. None is read back from the engine, and none is a calibration result: the fixture is the
SYNTHETIC reference hall in ``examples.reference_site`` (not a real site) and the calibration ledger is empty.
These tests check that the code implements the stated equation; they say nothing about whether the equation or
its library inputs match a physical hall.

Reference hall (synthetic): GB300 NVL72 rack 135 kW, 90 % liquid capture (13.5 kW residual air per rack), rack
mass 1,400 kg, rack feed 205 A; PUE 1.30 (hybrid DLC); 14 MVA firm grid at PF 0.97, 12 MW contracted, 7.4 MW site
peak, 4.9 MW existing IT load; 3 x 5 MVA transformers N+1 derated 0.90; 6 x 1,200 kW UPS N+1; 8 busway runs of
400 A at 400 V three-phase derated 0.80; 6,800 kW chilled-water plant; 9,000 l/min pumps.
"""
from __future__ import annotations

import dataclasses
import itertools
import math

import pytest

from examples.reference_site import SCENARIOS, build_context
from gridforge.common import ASSUMED, CUSTOMER, ESTIMATED, MODELLED, V
from gridforge.compute.library import PLATFORMS
from gridforge.constraints import EconomicsInput, ConstraintResult
from gridforge.costs import CostEntry, cost_overlay
from gridforge.economics.model import _btm_opex, evaluate
from gridforge.envelope import ladder, solve
from gridforge.envelope.solver import HeadroomLadder, LadderStep
from gridforge.envelope.time_to_power import elapsed_bands, full_capacity_band, schedule, schedule_complete
from gridforge.power import btm
from gridforge.power.constraints import (busway_ampacity, grid_firm_capacity, rack_feed_tapoff,
                                         transformer_capacity, ups_capacity)
from gridforge.power.generation import default_generation_unit
from gridforge.power.reliability import ContingencyCase, ContingencyStatus, Redundancy, evaluate as contingency
from gridforge.power.schema import GenerationOption
from gridforge.power.storage import default_bess
from gridforge.scenario import run
from gridforge.site.constraints import floor_loading, floor_space
from gridforge.thermal.constraints import (architecture_capability, cdu_capacity, hydraulic_flow, plant_capacity,
                                           residual_air_removal, tcs_supply_achievable)
from gridforge.thermal.library import CDU_L2L_APPROACH_K, FLOW_L_PER_MIN_PER_KW, PUE_BY_ARCHITECTURE
from gridforge.thermal.schema import Architecture, CDUSpec
from gridforge.validation import EvidenceClass, Quantity

E0, E3 = EvidenceClass.E0_ASSUMPTION, EvidenceClass.E3_ENGINEERING_ESTIMATE
SQRT3 = math.sqrt(3.0)


def ctx_hybrid():
    ctx = build_context()                       # HYBRID_DLC, PUE 1.30, GB300 135 kW
    ctx.power.options = []                       # grid only, so nothing but the stated equations speaks
    return ctx


def cdu_bank(units=3, redundancy="N+1", rated_kW=1350.0, rated_approach=5.0):
    return CDUSpec(id="CDU-T", rated_capacity_kW=V(rated_kW, "kW", "synthetic CDU rating", ASSUMED),
                   rated_approach_K=V(rated_approach, "K", "synthetic CDU approach", ASSUMED),
                   rated_flow_l_per_min=V(2000, "l/min", "synthetic CDU flow", ASSUMED),
                   units=units, redundancy=redundancy)


# =====================================================================================================================
# Electrical
# =====================================================================================================================
class TestTransformerBank:
    # usable kW per unit = rating[MVA] x PF x derating x 1000[kW/MVA] = 5 x 0.97 x 0.90 x 1000 = 4,365 kW
    # racks = floor( (usable_units x 4,365 - 7,400 site peak) / PUE 1.30 / 135 kW )
    @pytest.mark.parametrize("redundancy, usable_units, expected", [
        ("N", 3, 32),      # (13,095 - 7,400) = 5,695 / 1.30 = 4,380.8 / 135 = 32.45
        ("N+1", 2, 7),     # (8,730 - 7,400) = 1,330 / 1.30 = 1,023.1 / 135 = 7.58
        ("N+2", 1, 0),     # 4,365 - 7,400 < 0: no headroom at all
        ("2N", 1, 0),      # 3 // 2 = 1 usable unit (an odd third unit adds nothing under 2N)
    ])
    def test_redundancy_accounting(self, redundancy, usable_units, expected):
        ctx = ctx_hybrid()
        ctx.power.transformers[0].redundancy = redundancy
        assert transformer_capacity(ctx).racks == expected

    def test_2n_needs_four_units_to_beat_one(self):
        ctx = ctx_hybrid()
        ctx.power.transformers[0].redundancy = "2N"
        ctx.power.transformers[0].units = 4      # 2 usable -> 8,730 kW: same as the N+1 case -> 7 racks
        assert transformer_capacity(ctx).racks == 7

    def test_unknown_redundancy_is_refused_not_treated_as_n(self):
        ctx = ctx_hybrid()
        ctx.power.transformers[0].redundancy = "2N+1"
        with pytest.raises(ValueError, match="unknown redundancy"):
            transformer_capacity(ctx)

    def test_mva_to_kw_uses_power_factor_once(self):
        # 5 MVA x PF 0.5 = 2.5 MW real power. units 1 N, derate 1.0, site peak 0: 2,500 / 1.30 / 135 = 14.2 -> 14
        ctx = ctx_hybrid()
        t = ctx.power.transformers[0]
        t.units, t.redundancy = 1, "N"
        t.derating_factor = V(1.0, "1", "no derating", ASSUMED)
        ctx.power.grid.power_factor = V(0.5, "1", "PF 0.5", ASSUMED)
        ctx.power.grid.current_site_peak_MW = V(0.0, "MW", "empty site", ASSUMED)
        assert transformer_capacity(ctx).racks == 14


class TestUPS:
    # usable = units x 1,200 kW; racks = floor((usable - 4,900 kW existing protected IT) / 135 kW)   [UPS is IT-side: no PUE]
    @pytest.mark.parametrize("redundancy, expected", [
        ("N", 17),      # (7,200 - 4,900) / 135 = 17.04
        ("N+1", 8),     # (6,000 - 4,900) / 135 = 8.15
        ("N+2", 0),     # (4,800 - 4,900) < 0
        ("2N", 0),      # 3 x 1,200 = 3,600 < 4,900
    ])
    def test_redundancy_accounting(self, redundancy, expected):
        ctx = ctx_hybrid()
        ctx.power.ups[0].redundancy = redundancy
        assert ups_capacity(ctx).racks == expected

    def test_ups_headroom_is_not_divided_by_pue(self):
        a = ctx_hybrid()
        b = ctx_hybrid()
        b.pue = V(2.0, "1", "PUE 2.0", ASSUMED)
        assert ups_capacity(a).racks == ups_capacity(b).racks == 8


class TestBusway:
    # three-phase: P = sqrt(3) x V_LL x I x utilisation x PF
    def test_three_phase_run_capacity(self):
        # 1.7320508 x 400 V x 400 A = 277.128 kVA; x 0.80 = 221.70 kVA; x 0.97 = 215.05 kW per run
        # 8 runs = 1,720.4 kW; / 135 = 12.74 -> 12 racks
        assert busway_ampacity(ctx_hybrid()).racks == 12

    def test_single_phase_uses_v_times_i_with_no_sqrt3(self):
        # 400 V x 400 A x 0.80 x 0.97 = 124.16 kW per run; x 8 = 993.3 kW; / 135 = 7.36 -> 7 racks
        ctx = ctx_hybrid()
        ctx.power.lv.phases = 1
        assert busway_ampacity(ctx).racks == 7

    def test_ampacity_scales_linearly(self):
        # 1000 A: 1.7320508 x 400 x 1000 x 0.80 x 0.97 = 537.63 kW per run; x 8 = 4,301.0 kW; / 135 = 31.86 -> 31
        ctx = ctx_hybrid()
        ctx.power.lv.busway_ampacity_A = V(1000, "A", "modern busway", ASSUMED)
        assert busway_ampacity(ctx).racks == 31

    def test_zero_runs_is_zero_racks(self):
        ctx = ctx_hybrid()
        ctx.power.lv.busway_runs = 0
        assert busway_ampacity(ctx).racks == 0


class TestRackFeedGate:
    @pytest.mark.parametrize("tapoff_A, passes", [(63, False), (204, False), (205, True), (400, True)])
    def test_boundary_is_inclusive(self, tapoff_A, passes):
        # platform feed current 205 A; the gate passes when 205 <= tap-off rating
        ctx = ctx_hybrid()
        ctx.power.lv.tapoff_max_A = V(tapoff_A, "A", "tap-off", CUSTOMER)
        assert (rack_feed_tapoff(ctx).racks == math.inf) is passes
        assert (rack_feed_tapoff(ctx).racks == 0.0) is (not passes)

    def test_undeclared_platform_feed_is_not_a_pass_or_a_fail_it_is_unconstrained_and_says_so(self):
        ctx = ctx_hybrid()
        ctx.cluster.platform = dataclasses.replace(ctx.cluster.platform, rack_feed_current_A=None)
        res = rack_feed_tapoff(ctx)
        assert res.racks == math.inf and "not declared" in res.basis


class TestGridSupply:
    def test_reference_value(self):
        # ceiling = min(14 MVA x 0.97 = 13.58 MW, 12 MW contracted) = 12,000 kW; headroom = 12,000 - 7,400 = 4,600 kW
        # IT = 4,600 / 1.30 = 3,538.5 kW; racks = 3,538.5 / 135 = 26.2 -> 26
        assert grid_firm_capacity(ctx_hybrid()).racks == 26

    def test_kva_is_not_kw(self):
        # With the contracted limit removed the firm limit is 14 MVA x 0.97 = 13.58 MW, not 14 MW:
        # (13,580 - 7,400) / 1.30 / 135 = 35.2 -> 35 (a kVA/kW mix-up would give (14,000 - 7,400)/1.3/135 = 37)
        ctx = ctx_hybrid()
        ctx.power.grid.contracted_MW = V(50, "MW", "uncapped contract", CUSTOMER)
        assert grid_firm_capacity(ctx).racks == 35

    @pytest.mark.parametrize("pue, expected", [(1.20, 28), (1.30, 26), (1.45, 23), (2.00, 17)])
    def test_pue_couples_power_to_compute(self, pue, expected):
        # floor( 4,600 / PUE / 135 ): 28.39, 26.21, 23.5, 17.04
        ctx = ctx_hybrid()
        ctx.pue = V(pue, "1", "PUE sweep", ASSUMED)
        assert grid_firm_capacity(ctx).racks == expected

    def test_btm_firm_capacity_is_added_after_the_grid_limit_not_inside_it(self):
        # an installed 5 MW engine at firm factor 0.92 adds 4,600 kW: ceiling 12,000 + 4,600 = 16,600;
        # headroom 9,200; / 1.30 / 135 = 52.4 -> 52
        ctx = build_context()
        for o in ctx.power.options:
            o.installed = (o.id == "GEN-5MW")
        ctx.power.options[1].firm_capacity_factor = None            # use the library default 0.92
        assert grid_firm_capacity(ctx).racks == 52

    def test_exact_zero_headroom_is_zero_racks(self):
        ctx = ctx_hybrid()
        ctx.power.grid.current_site_peak_MW = V(12.0, "MW", "site at the ceiling", CUSTOMER)
        assert grid_firm_capacity(ctx).racks == 0

    def test_site_over_its_ceiling_is_zero_racks_never_negative(self):
        ctx = ctx_hybrid()
        ctx.power.grid.current_site_peak_MW = V(15.0, "MW", "site over the ceiling", CUSTOMER)
        assert grid_firm_capacity(ctx).racks == 0


# --- properties that follow directly from the equations ---------------------------------------------------------
class TestMathematicallyJustifiedMonotonicity:
    """Only properties that hold by inspection of the equation, on the one constraint (or the exact set of
    constraints) that reads the swept input. No monotonicity is asserted across architectures or across anything
    that couples cooling and power through a shared state."""

    def test_grid_racks_do_not_increase_with_pue_or_rack_power(self):
        # racks = floor(H / (PUE x P)) with H > 0: strictly decreasing in PUE and in P.
        last = None
        for pue in (1.05, 1.15, 1.25, 1.35, 1.45, 1.6, 2.0):
            ctx = ctx_hybrid()
            ctx.pue = V(pue, "1", "PUE sweep", ASSUMED)
            n = grid_firm_capacity(ctx).racks
            assert last is None or n <= last
            last = n
        last = None
        for kw in (50, 100, 132, 135, 150, 200):
            ctx = ctx_hybrid()
            ctx.cluster.platform = dataclasses.replace(ctx.cluster.platform, rack_kW=V(kw, "kW", "sweep", ASSUMED))
            n = grid_firm_capacity(ctx).racks
            assert last is None or n <= last
            last = n

    def test_envelope_does_not_decrease_with_contracted_power(self):
        # grid.contracted_MW is read by exactly one constraint (grid_firm_capacity), where it enters as
        # min(firm, contracted): non-decreasing. Every other constraint is independent of it, so the min is too.
        last = None
        for mw in (6.0, 8.0, 10.0, 12.0, 13.0, 20.0):
            ctx = ctx_hybrid()
            ctx.power.grid.contracted_MW = V(mw, "MW", "sweep", CUSTOMER)
            n = grid_firm_capacity(ctx).racks
            assert last is None or n >= last
            last = n

    def test_every_constraint_is_non_increasing_in_rack_power(self):
        # Checked per constraint rather than assumed: each is a threshold or a quotient with rack power (or the
        # liquid / residual share of it) in the denominator or on the "need" side of a comparison.
        previous: dict[str, float] = {}
        for kw in (60, 100, 135, 160, 250):
            ctx = ctx_hybrid()
            ctx.cluster.platform = dataclasses.replace(ctx.cluster.platform, rack_kW=V(kw, "kW", "sweep", ASSUMED))
            res = solve(ctx)
            now = {c.id: c.racks for c in res.constraints}
            for cid, n in now.items():
                if cid in previous:       # constraints independent of rack power (floor, tap-off, ...) stay equal
                    assert n <= previous[cid], (cid, kw)
            previous = now


# =====================================================================================================================
# Thermal, hydraulic, physical
# =====================================================================================================================
class TestPlant:
    def test_hybrid_plant_takes_the_whole_rack_load(self):
        # (6,800 kW plant - 4,900 kW existing) = 1,900 kW headroom / 135 kW per rack = 14.07 -> 14
        assert plant_capacity(ctx_hybrid()).racks == 14

    def test_full_dlc_plant_takes_only_the_residual_air_share(self):
        # liquid goes to the dedicated loop: 1,900 / (135 x (1 - 0.90) = 13.5) = 140.7 -> 140
        ctx = ctx_hybrid()
        ctx.architecture = Architecture.FULL_DLC
        assert plant_capacity(ctx).racks == 140

    def test_plant_uprate_relief_is_plus_50_percent(self):
        # 6,800 x 1.5 = 10,200; headroom 5,300 / 135 = 39.26 -> 39
        ctx = ctx_hybrid()
        relieved = plant_capacity(ctx).relief.apply(ctx)
        assert plant_capacity(relieved).racks == 39

    def test_existing_load_above_plant_capacity_is_zero_racks(self):
        ctx = ctx_hybrid()
        ctx.thermal.plant.chilled_water_capacity_kW = V(4000, "kW", "plant smaller than existing load", CUSTOMER)
        assert plant_capacity(ctx).racks == 0


class TestHydraulics:
    def test_flow_limit(self):
        # 9,000 l/min / 130 l/min per rack (GB300) = 69.2 -> 69
        assert hydraulic_flow(ctx_hybrid()).racks == 69

    def test_pump_relief_is_plus_80_percent(self):
        # 9,000 x 1.8 = 16,200 / 130 = 124.6 -> 124
        ctx = ctx_hybrid()
        assert hydraulic_flow(hydraulic_flow(ctx).relief.apply(ctx)).racks == 124

    def test_retained_air_has_no_liquid_circuit(self):
        ctx = ctx_hybrid()
        ctx.architecture = Architecture.RETAINED_AIR
        assert hydraulic_flow(ctx).racks == math.inf

    def test_energy_balance_q_equals_mdot_cp_dT_for_the_library_platforms(self):
        # Q = m_dot x cp x dT.  With water (cp 4.186 kJ/kg/K, ~1 kg/l): dT = Q[kW] x 60 / (flow[l/min] x 4.186).
        # The library rack flows must imply a physically sensible technology-loop delta-T (a few K to ~20 K),
        # otherwise either the flow or the liquid fraction is off by an order of magnitude.
        cp = 4.186
        for p in PLATFORMS.values():
            liquid_kW = p.rack_kW.value * p.liquid_fraction.value
            dT = liquid_kW * 60.0 / (p.flow_l_per_min_per_rack.value * cp)
            assert 5.0 <= dT <= 20.0, (p.id, dT)

    def test_library_flow_per_kw_matches_water_at_ten_kelvin(self):
        # 1 kW / (4.186 kJ/kg/K x 10 K) = 0.02389 kg/s = 1.433 kg/min ~ 1.433 l/min.  Library: 1.45 (within 2 %).
        exact = 60.0 / (4.186 * 10.0)
        assert exact == pytest.approx(1.4333, abs=1e-3)
        assert FLOW_L_PER_MIN_PER_KW.value == pytest.approx(exact, rel=0.02)

    def test_rack_feed_current_library_is_consistent_with_rack_power(self):
        # I = P / (sqrt(3) x V_LL x PF) at 400 V, PF 0.99:  GB300 135 kW -> 196.8 A; GB200 132 kW -> 192.4 A;
        # generic 50 kW -> 72.9 A. The library figures (205 / 200 / 76 A) must sit within 10 % above these.
        for p in PLATFORMS.values():
            calc = p.rack_kW.value * 1000.0 / (SQRT3 * 400.0 * 0.99)
            assert calc <= p.rack_feed_current_A.value <= calc * 1.10, p.id


class TestCDUDerating:
    def _ctx(self, supply_C=6.0, **bank):
        ctx = ctx_hybrid()
        ctx.thermal.cdus = [cdu_bank(**bank)]
        ctx.thermal.plant.design_supply_C = V(supply_C, "degC", "facility water supply", CUSTOMER)
        return ctx

    def test_cold_facility_water_gives_full_rating(self):
        # approach available = 30 degC TCS target - 6 degC FWS = 24 K >= 5 K rated -> derate 1.0
        # usable = (3 - 1) x 1,350 kW = 2,700 kW; liquid load = 135 x 0.90 = 121.5 kW; 2,700 / 121.5 = 22.2 -> 22
        assert cdu_capacity(self._ctx()).racks == 22

    def test_warm_facility_water_derates_linearly(self):
        # FWS 28 degC: approach 30 - 28 = 2 K of the 5 K rated -> derate 0.4; usable 2 x 1,350 x 0.4 = 1,080 kW
        # 1,080 / 121.5 = 8.89 -> 8
        assert cdu_capacity(self._ctx(supply_C=28.0)).racks == 8

    @pytest.mark.parametrize("supply_C", [30.0, 31.0, 45.0])
    def test_no_approach_available_means_no_capacity(self, supply_C):
        # TCS target 30 degC is not above the facility water: approach <= 0 K -> derate clamps to 0
        assert cdu_capacity(self._ctx(supply_C=supply_C)).racks == 0

    def test_derate_never_exceeds_the_rating(self):
        # approach 24 K vs 5 K rated would be 4.8x: capped at 1.0, not extrapolated
        assert cdu_capacity(self._ctx(supply_C=6.0)).racks == cdu_capacity(self._ctx(supply_C=20.0)).racks == 22

    @pytest.mark.parametrize("units, redundancy, usable", [
        (1, "N+1", 0), (2, "N+1", 1), (3, "N", 3), (5, "2N", 2), (4, "2N", 2), (6, "N+2", 4), (1, "N+2", 0)])
    def test_redundancy_accounting(self, units, redundancy, usable):
        # racks = floor(usable x 1,350 / 121.5) = floor(usable x 11.11)
        expected = math.floor(usable * 1350.0 / 121.5)
        assert cdu_capacity(self._ctx(units=units, redundancy=redundancy)).racks == expected

    def test_no_cdu_schedule_is_unbounded_and_says_so(self):
        ctx = ctx_hybrid()
        res = cdu_capacity(ctx)
        assert res.racks == math.inf and "no CDU schedule declared" in res.basis
        # ... and the reason given is the real one for each case: an air architecture genuinely has no CDUs,
        # a liquid architecture without a schedule has simply not been assessed.
        air = ctx_hybrid()
        air.architecture = Architecture.RETAINED_AIR
        assert "does not use CDUs" in cdu_capacity(air).basis
        air.thermal.cdus = [cdu_bank()]
        assert "does not use CDUs" in cdu_capacity(air).basis


class TestTcsGate:
    @pytest.mark.parametrize("fws_C, passes", [(6.0, True), (24.9, True), (25.0, True), (25.1, False), (30.0, False)])
    def test_required_facility_water_is_target_minus_approach(self, fws_C, passes):
        # required FWS = 30 degC TCS target - 5 K approach = 25 degC; the plant must deliver <= 25 degC
        ctx = ctx_hybrid()
        ctx.thermal.plant.design_supply_C = V(fws_C, "degC", "plant supply", CUSTOMER)
        assert (tcs_supply_achievable(ctx).racks == math.inf) is passes

    def test_dry_coolers_deliver_dry_bulb_plus_approach(self):
        # 34 degC design dry bulb + 10 K approach = 44 degC > 25 degC required: fails; a 5 degC dry-bulb site with a
        # 10 K approach delivers 15 degC <= 25: passes.
        ctx = ctx_hybrid()
        ctx.architecture = Architecture.FULL_DLC
        ctx.thermal.plant.dry_cooler_approach_K = V(10, "K", "dry cooler approach", ASSUMED)
        assert tcs_supply_achievable(ctx).racks == 0
        ctx.site.design_drybulb_C = V(5, "degC", "cold climate", CUSTOMER)
        assert tcs_supply_achievable(ctx).racks == math.inf


class TestFloorLoading:
    def test_pitch_averaged_load_and_kpa_conversion(self):
        # imposed = 1,400 kg / (2.4 m pitch x 0.6 m rack width = 1.44 m2) = 972.2 kg/m2
        # capacity = 12 kPa x 101.97 kg/m2 per kPa (1 kPa = 1000 Pa / 9.80665 m/s2) = 1,223.6 kg/m2
        res = floor_loading(ctx_hybrid())
        assert "972" in res.basis and "1,224" in res.basis
        assert res.racks == math.inf

    @pytest.mark.parametrize("kPa, passes", [(9.4, False), (9.5, False), (9.6, True), (12.0, True)])
    def test_threshold_is_972_2_kg_per_m2(self, kPa, passes):
        # threshold = 972.2 / 101.97 = 9.534 kPa
        ctx = ctx_hybrid()
        ctx.hall.floor_loading_kPa = V(kPa, "kPa", "floor rating", CUSTOMER)
        assert (floor_loading(ctx).racks == math.inf) is passes

    def test_tighter_aisle_pitch_raises_the_imposed_load(self):
        # pitch 1.2 m: 1,400 / 0.72 = 1,944 kg/m2 > 1,223.6 -> fails
        ctx = ctx_hybrid()
        ctx.hall.aisle_pitch_m = V(1.2, "m", "tight pitch", CUSTOMER)
        assert floor_loading(ctx).racks == 0

    def test_zero_pitch_fails_closed(self):
        ctx = ctx_hybrid()
        ctx.hall.aisle_pitch_m = V(0.0, "m", "degenerate pitch", CUSTOMER)
        assert floor_loading(ctx).racks == 0               # infinite imposed load, not a crash and not a pass


class TestResidualAirAndArchitecture:
    @pytest.mark.parametrize("have_kW, passes", [(9.0, False), (13.4, False), (13.6, True), (25.0, True)])
    def test_residual_air_share_of_a_hybrid_rack(self, have_kW, passes):
        # need = 135 kW x (1 - 0.90) = 13.5 kW of air per position
        ctx = ctx_hybrid()
        ctx.thermal.residual_air_capacity_kW_per_rack = V(have_kW, "kW", "air capacity", CUSTOMER)
        assert (residual_air_removal(ctx).racks == math.inf) is passes

    def test_retained_air_must_remove_the_whole_rack_with_air(self):
        # retained air: need = 135 kW per position; 25 kW is not enough
        ctx = ctx_hybrid()
        ctx.architecture = Architecture.RETAINED_AIR
        ctx.thermal.residual_air_capacity_kW_per_rack = V(25, "kW", "augmented air", CUSTOMER)
        assert residual_air_removal(ctx).racks == 0

    @pytest.mark.parametrize("arch, passes", [
        (Architecture.RETAINED_AIR, False),     # 22 kW library capability < 135 kW
        (Architecture.RDHX, False),             # 60 kW < 135 kW
        (Architecture.HYBRID_DLC, True),        # 142 kW >= 135 kW
        (Architecture.FULL_DLC, True)])         # 150 kW >= 135 kW
    def test_architecture_capability_against_a_135_kw_rack(self, arch, passes):
        ctx = ctx_hybrid()
        ctx.architecture = arch
        assert (architecture_capability(ctx).racks == math.inf) is passes

    def test_declared_rear_door_rating_replaces_the_library_default(self):
        from gridforge.thermal.schema import RDHxSpec
        ctx = ctx_hybrid()
        ctx.architecture = Architecture.RDHX
        ctx.thermal.rdhx = RDHxSpec(id="RD", capacity_kW_per_rack=V(134, "kW", "client rear door", CUSTOMER))
        assert architecture_capability(ctx).racks == 0
        ctx.thermal.rdhx = RDHxSpec(id="RD", capacity_kW_per_rack=V(135, "kW", "client rear door", CUSTOMER))
        assert architecture_capability(ctx).racks == math.inf

    def test_floor_space_is_the_smaller_of_positions_and_availability(self):
        # 180 of 560 -> 180; and a hall whose available count exceeds its positions cannot host more than it has
        ctx = ctx_hybrid()
        assert floor_space(ctx).racks == 180
        ctx.hall.positions_available = 900
        assert floor_space(ctx).racks == 560


# =====================================================================================================================
# Behind-the-meter supply, storage, generation, contingency
# =====================================================================================================================
def _opt(id_, kind, MW, firm=True, factor=None, lead=30.0, capex=900.0, **kw):
    return GenerationOption(
        id=id_, kind=kind, capacity_MW=V(MW, "MW", f"{id_} capacity", ASSUMED),
        capex_eur_per_kW=V(capex, "EUR/kW", f"{id_} capex", ASSUMED),
        lead_time_weeks=V(lead, "weeks", f"{id_} lead time", ASSUMED), firm=firm,
        firm_capacity_factor=None if factor is None else V(factor, "1", f"{id_} firm factor", ASSUMED), **kw)


class TestFirmBehindTheMeter:
    @pytest.mark.parametrize("kind, MW, expected_kW", [
        ("gas_engine", 5.0, 4600.0),     # 5 MW x 0.92 x 1000
        ("chp", 4.0, 3600.0),            # 4 x 0.90
        ("fuel_cell", 1.0, 900.0),       # 1 x 0.90
        ("bess", 2.0, 1000.0),           # 2 x 0.50 flat default
        ("pv", 10.0, 0.0),               # firm factor 0: energy, not capacity
        ("wind", 10.0, 0.0),
        ("unknown_tech", 3.0, 0.0),      # an unrecognised technology contributes nothing
    ])
    def test_nameplate_is_not_firm(self, kind, MW, expected_kW):
        assert btm.firm_contribution_kW(_opt("O", kind, MW)).value == pytest.approx(expected_kW)

    def test_an_option_not_marked_firm_contributes_zero_whatever_its_nameplate(self):
        assert btm.firm_contribution_kW(_opt("O", "gas_engine", 50.0, firm=False)).value == 0.0

    def test_default_factor_is_an_assumption_not_a_measurement(self):
        q = btm.firm_contribution_kW(_opt("O", "gas_engine", 5.0))
        assert q.evidence == E0

    def test_next_option_is_earliest_then_cheapest_and_never_a_zero_firm_option(self):
        slow = _opt("slow", "gas_engine", 5.0, lead=44)
        quick_dear = _opt("quick_dear", "bess", 2.0, lead=30, capex=1200)       # 2,000 kW x 1,200 = 2.4 MEUR
        quick_cheap = _opt("quick_cheap", "bess", 2.0, lead=30, capex=900)      # 2,000 kW x 900   = 1.8 MEUR
        pv = _opt("pv", "pv", 20.0, lead=4, capex=500)                           # fastest and cheapest, firm 0
        ctx = ctx_hybrid()
        ctx.power.options = [slow, quick_dear, pv, quick_cheap]
        assert btm.next_option(ctx.power).id == "quick_cheap"

    def test_capex_is_mw_times_1000_times_eur_per_kw(self):
        # 2 MW x 1,000 kW/MW x 900 EUR/kW = 1,800,000 EUR
        assert btm.option_capex(_opt("O", "bess", 2.0)).value == pytest.approx(1_800_000.0)


class TestBatteryDuration:
    # default_bess: usable energy = 8 MWh x (0.95 - 0.10) x 0.92 degradation = 6.256 MWh
    @pytest.mark.parametrize("hours, expected_MW, binding", [
        (2.0, 2.0, "power"),            # energy limit 6.256 / 2 = 3.128 MW > 2 MW rating
        (3.128, 2.0, "power"),          # exactly at the crossover (6.256 / 3.128 = 2.0)
        (4.0, 1.564, "energy"),         # 6.256 / 4
        (6.0, 6.256 / 6.0, "energy"),   # 1.0427 MW
    ])
    def test_firm_power_is_the_lesser_of_power_and_energy_limits(self, hours, expected_MW, binding):
        b = default_bess("B", 2.0, 8.0)
        h = V(hours, "h", "ride-through", ASSUMED)
        assert b.firm_MW_for_duration(h).value == pytest.approx(expected_MW)
        assert b.binding_limit(h) == ("power" if hours <= 3.128 + 1e-9 else binding)

    def test_zero_duration_requested_is_zero_firm_power_not_a_division_by_zero(self):
        assert default_bess("B", 2.0, 8.0).firm_MW_for_duration(V(0.0, "h", "none", ASSUMED)).value == 0.0

    def test_reserve_is_subtracted_from_power_and_floored_at_zero(self):
        b = default_bess("B", 2.0, 8.0)
        b.reserve_MW = V(0.5, "MW", "FFR reserve", ASSUMED)
        assert b.firm_MW_for_duration(V(1.0, "h", "short", ASSUMED)).value == pytest.approx(1.5)   # 2.0 - 0.5
        b.reserve_MW = V(3.0, "MW", "reserve above the rating", ASSUMED)
        assert b.firm_MW_for_duration(V(1.0, "h", "short", ASSUMED)).value == 0.0

    def test_evidence_of_a_library_battery_is_e0(self):
        assert default_bess("B", 2.0, 8.0).firm_MW_for_duration(V(4.0, "h", "rt", ASSUMED)).evidence == E0


class TestGenerationUnit:
    def test_firm_capacity_is_nameplate_times_one_minus_forced_outage_rate(self):
        # 10 MW x (1 - 0.08) = 9.2 MW
        assert default_generation_unit("G", "gas_engine", 10.0).firm_MW().value == pytest.approx(9.2)

    @pytest.mark.parametrize("window_min, expected_MW", [
        (2.0, 0.0),        # start-up takes 3 min: nothing within 2 min
        (3.0, 0.0),        # ramp window = 3 - 3 = 0 min, minimum output floor 0 -> 0 MW
        (5.0, 1.0),        # ramp window 2 min x 0.5 MW/min = 1.0 MW
        (30.0, 9.2),       # 27 min x 0.5 = 13.5 MW >= firm 9.2 MW -> capped at firm capacity
    ])
    def test_output_inside_a_response_window(self, window_min, expected_MW):
        g = default_generation_unit("G", "gas_engine", 10.0)
        assert g.output_available_within(V(window_min, "min", "window", ASSUMED)).value == pytest.approx(expected_MW)


class TestContingency:
    def _case(self, redundancy, load_MW=5.0):
        g1 = default_generation_unit("G1", "gas_engine", 5.0)      # firm 5 x 0.92 = 4.60 MW
        g2 = default_generation_unit("G2", "gas_engine", 3.0)      # firm 3 x 0.92 = 2.76 MW
        b = default_bess("B1", 2.0, 8.0)                           # 2 h ride-through: power-limited 2.0 MW
        return ContingencyCase(critical_load_MW=V(load_MW, "MW", "critical load", ASSUMED),
                               grid_firm_MW=V(0.0, "MW", "no grid", ASSUMED),
                               generation=[g1, g2], bess=[b],
                               ride_through_hours=V(2.0, "h", "declared ride-through", ASSUMED),
                               redundancy=redundancy)

    def test_base_case_n(self):
        # 4.60 + 2.76 + 2.00 = 9.36 MW vs 5 MW load -> margin +4.36 MW
        r = contingency(self._case(Redundancy.N))
        assert r.status is ContingencyStatus.PASS
        assert r.available_MW.value == pytest.approx(9.36) and r.margin_MW.value == pytest.approx(4.36)

    def test_n_plus_1_removes_the_largest_contributor(self):
        # lose G1 (4.60): 2.76 + 2.00 = 4.76 MW vs 5 MW -> margin -0.24 MW -> FAIL
        r = contingency(self._case(Redundancy.N_PLUS_1))
        assert r.status is ContingencyStatus.FAIL
        assert r.available_MW.value == pytest.approx(4.76) and r.margin_MW.value == pytest.approx(-0.24)

    def test_n_plus_1_passes_with_a_lighter_load(self):
        r = contingency(self._case(Redundancy.N_PLUS_1, load_MW=4.0))     # margin 4.76 - 4.0 = +0.76
        assert r.status is ContingencyStatus.PASS

    def test_n_plus_2_removes_the_two_largest(self):
        # lose G1 (4.60) and G2 (2.76): only the 2.00 MW battery remains
        r = contingency(self._case(Redundancy.N_PLUS_2))
        assert r.available_MW.value == pytest.approx(2.0) and r.status is ContingencyStatus.FAIL

    def test_two_n_is_never_a_clean_pass_because_the_path_split_is_unknown(self):
        r = contingency(self._case(Redundancy.TWO_N, load_MW=0.5))
        assert r.status is ContingencyStatus.REQUIRES_ENGINEERING_STUDY and r.blocking

    def test_undeclared_availability_blocks_a_pass(self):
        case = self._case(Redundancy.N)
        case.generation[0].forced_outage_rate = None
        case.generation[0].availability = None
        r = contingency(case)
        assert r.margin_MW.value > 0 and r.status is ContingencyStatus.REQUIRES_ENGINEERING_STUDY

    def test_nothing_declared_is_not_a_pass(self):
        case = ContingencyCase(critical_load_MW=V(1.0, "MW", "load", ASSUMED), grid_firm_MW=V(0.0, "MW", "none", ASSUMED))
        assert contingency(case).status is ContingencyStatus.REQUIRES_ENGINEERING_STUDY


# =====================================================================================================================
# Time to power and energisation-date logic
# =====================================================================================================================
def _ladder(steps):
    """steps: (name, lead_weeks_or_None, racks_before, racks_after)"""
    lad = HeadroomLadder()
    first = steps[0][2]
    last = steps[-1][3]

    class _R:                      # the two attributes schedule() reads
        def __init__(self, n):
            self.max_racks = n
    lad.initial, lad.final = _R(first), _R(last)
    for i, (name, lead, before, after) in enumerate(steps, 1):
        lad.steps.append(LadderStep(
            i, name.lower(), name, "electrical", before, after, "", "relief", None,
            None if lead is None else V(lead, "weeks", f"{name} lead time", ASSUMED, band=(lead * 0.5, lead * 1.5))))
    return lad


class TestEnergisationDates:
    STEPS = [("A", 10.0, 0, 5), ("B", 30.0, 5, 8), ("C", 20.0, 8, 8), ("D", 15.0, 8, 12)]

    def test_parallel_reliefs_governed_by_the_longest_lead_time_so_far(self):
        # reliefs run in parallel: elapsed after step n = max(lead_1..lead_n)
        #   A: 10 wk -> 5 racks;  B: 30 wk -> 8 racks;  C (no gain) -> max(30,20) = 30;  D: max(30,15) = 30 -> 12 racks
        t = schedule(_ladder(self.STEPS))
        assert [(p.weeks, p.racks) for p in t.points] == [(10.0, 5), (30.0, 8), (30.0, 12)]
        assert t.weeks_to_first_rack == 10.0
        assert t.weeks_to_full == 30.0
        assert (t.critical_item, t.critical_weeks) == ("B", 30.0)

    def test_low_and_high_bands_use_the_lead_times_own_bands(self):
        # bands are 0.5x..1.5x each lead: elapsed low = max(lows), high = max(highs) -> at the end (15, 45)
        bands = elapsed_bands(_ladder(self.STEPS))
        assert bands[-1][:3] == (30.0, 15.0, 45.0)
        assert full_capacity_band(_ladder(self.STEPS), schedule(_ladder(self.STEPS)))[:3] == (30.0, 15.0, 45.0)

    def test_dates_inherit_the_weakest_lead_time_evidence(self):
        lad = _ladder(self.STEPS)
        lad.steps[2].lead_time_weeks = V(20.0, "weeks", "quoted", CUSTOMER)
        assert full_capacity_band(lad, schedule(lad))[3] == E0           # A, B, D are still E0 assumptions

    def test_a_missing_lead_time_yields_no_date_at_all(self):
        lad = _ladder([("A", 10.0, 0, 5), ("B", None, 5, 8)])
        assert schedule_complete(lad) is False
        assert schedule(lad).complete is False            # the flag a caller must check before quoting weeks_*
        assert full_capacity_band(lad, schedule(lad)) is None

    def test_a_hall_that_already_hosts_racks_has_a_first_rack_at_week_zero(self):
        lad = _ladder([("A", 10.0, 3, 6)])
        t = schedule(lad)
        assert t.weeks_to_first_rack == 0.0 and t.points[0].weeks == 0.0 and t.points[0].racks == 3

    def test_a_hall_that_can_host_nothing_has_no_full_capacity_date(self):
        lad = _ladder([("A", 10.0, 0, 0)])
        assert schedule(lad).weeks_to_full is None and full_capacity_band(lad, schedule(lad)) is None

    def test_untaken_steps_do_not_set_the_date(self):
        lad = _ladder([("A", 10.0, 0, 5), ("B", 300.0, 5, 5)])
        lad.steps[1].taken = False
        assert schedule(lad).weeks_to_full == 10.0


# =====================================================================================================================
# Costs, scaling and economics
# =====================================================================================================================
class TestReliefPricingUnits:
    """EUR = (EUR per unit) x (units added). The unit price is a labelled placeholder (E0, band -50 %/+100 %)."""

    def test_transformer_uprate_priced_per_mva_added(self):
        # added = 3 units x 5 MVA x (1.6 - 1) = 9 MVA;  x (1,200,000 / 9 EUR per MVA) = 1,200,000 EUR
        q = transformer_capacity(ctx_hybrid()).relief.capex_eur
        assert q.value == pytest.approx(1_200_000.0) and q.unit == "EUR" and q.evidence == E0

    def test_transformer_price_follows_the_quantity(self):
        ctx = ctx_hybrid()
        ctx.power.transformers[0].units = 6               # 6 x 5 x 0.6 = 18 MVA -> 2.4 MEUR
        assert transformer_capacity(ctx).relief.capex_eur.value == pytest.approx(2_400_000.0)

    def test_ups_priced_per_kw_added(self):
        # 2 modules x 1,200 kW per block = 2,400 kW x 320 EUR/kW = 768,000 EUR
        assert ups_capacity(ctx_hybrid()).relief.capex_eur.value == pytest.approx(768_000.0)

    def test_busway_priced_per_run_bought(self):
        # ampacity 400 A < 1000 A: the whole bank is renewed: 8 runs x 56,250 EUR = 450,000 EUR
        assert busway_ampacity(ctx_hybrid()).relief.capex_eur.value == pytest.approx(450_000.0)
        ctx = ctx_hybrid()
        ctx.power.lv.busway_ampacity_A = V(1000, "A", "modern", ASSUMED)       # then +2 runs: 112,500 EUR
        assert busway_ampacity(ctx).relief.capex_eur.value == pytest.approx(112_500.0)

    def test_plant_pump_and_floor_prices(self):
        ctx = ctx_hybrid()
        assert plant_capacity(ctx).relief.capex_eur.value == pytest.approx(900_000.0)    # 3,400 kW x 264.71
        assert hydraulic_flow(ctx).relief.capex_eur.value == pytest.approx(420_000.0)    # 7,200 lpm x 58.33
        assert floor_loading(ctx).relief.capex_eur.value == pytest.approx(260_000.0)     # 2,400 m2 x 108.33

    def test_per_rack_reliefs_cost_the_racks_finally_fitted_not_the_racks_at_their_rung(self):
        res = run(build_context(), SCENARIOS[2])            # hybrid DLC
        n = res.unlocked_racks
        by = {s.binding_id: s for s in res.ladder.taken_steps}
        assert by["rack_feed_tapoff"].capex_eur.value == pytest.approx(6_000.0 * n)      # tap-off unit per rack
        assert by["residual_air_removal"].capex_eur.value == pytest.approx(9_000.0 * n)  # in-row / RDHx per rack

    def test_a_firm_quote_for_exactly_the_quoted_scope_is_used_as_quoted(self, monkeypatch):
        monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2026-06-01")
        quote = CostEntry(key="plant.uprate", label="synthetic plant quotation", unit="EUR", value=1_000_000.0,
                          basis="firm_quote", supplier="Synthetic Supplier Ltd", quoted_on="2026-05-01",
                          valid_until="2026-12-31", quoted_quantity=3400.0, quoted_quantity_unit="kW",
                          reviewer="reviewer", reviewed_on="2026-05-02", synthetic=True)
        with cost_overlay([quote]):
            q = plant_capacity(ctx_hybrid()).relief.capex_eur           # 3,400 kW added = the quoted scope
            assert q.value == pytest.approx(1_000_000.0)
            assert q.evidence == EvidenceClass.E5_CUSTOMER_DATA
            big = ctx_hybrid()
            big.thermal.plant.chilled_water_capacity_kW = V(13_600, "kW", "plant twice the size", CUSTOMER)
            scaled = plant_capacity(big).relief                          # 6,800 kW added: quote scaled x2
            assert scaled.capex_eur.value == pytest.approx(2_000_000.0)
            assert scaled.limited is True                                # and flagged: the supplier did not price it
            assert scaled.capex_eur.evidence <= E3                       # scaling is an assumption, not a quote


def _quiet_ctx(racks=10):
    """Hybrid-style hall in which only the position count (10) binds: no relief is bought."""
    ctx = build_context()
    ctx.power.options = []
    ctx.architecture = Architecture.FULL_DLC
    ctx.pue = PUE_BY_ARCHITECTURE[Architecture.FULL_DLC]                    # 1.20
    ctx.thermal.cdus = [cdu_bank(units=3)]
    ctx.thermal.trim_chiller_installed = True
    ctx.power.lv.tapoff_max_A = V(400, "A", "tap-off", CUSTOMER)
    ctx.thermal.residual_air_capacity_kW_per_rack = V(25, "kW", "air", CUSTOMER)
    ctx.power.transformers[0].units = 6            # (5 usable x 4,365 - 7,400) / 1.20 / 135 = 89 racks
    ctx.power.ups[0].units = 12                    # (11 x 1,200 - 4,900) / 135 = 61 racks
    ctx.hall.rack_positions = ctx.hall.positions_available = racks
    return ctx


class TestEconomicsArithmetic:
    def _evaluate(self, ctx):
        lad = ladder(ctx)
        return lad, evaluate(lad.final, lad, ctx.cluster.utilisation)

    def test_quiet_hall_binds_on_positions_and_buys_nothing(self):
        lad = ladder(_quiet_ctx())
        assert lad.final.max_racks == 10 and lad.final.binding.id == "floor_space" and not lad.taken_steps

    def test_energy_cost_and_capex_arithmetic(self):
        ctx = _quiet_ctx()
        ctx.economics = EconomicsInput(electricity_eur_per_MWh=V(100.0, "EUR/MWh", "declared tariff", CUSTOMER))
        lad, e = self._evaluate(ctx)
        it_kW = 10 * 135.0                                    # 1,350 kW
        facility_kW = it_kW * 1.20                            # PUE 1.20 -> 1,620 kW
        energy_MWh = facility_kW * 0.75 * 8760 / 1000.0       # x 0.75 utilisation x 8,760 h / 1,000 kWh/MWh = 10,643.4
        assert e.annual_energy_MWh.value == pytest.approx(energy_MWh) and energy_MWh == pytest.approx(10_643.4)
        assert e.annual_energy_cost_eur.value == pytest.approx(energy_MWh * 100.0)           # 1,064,340 EUR
        assert e.capex_conversion_eur.value == pytest.approx(10 * 55_000.0)                  # 550,000 EUR
        assert e.capex_total_eur.value == pytest.approx(550_000.0)
        assert e.capex_eur_per_kW_it.value == pytest.approx(550_000.0 / it_kW)               # 407.4 EUR/kW
        gpu_hours = 10 * 72 * 8760.0                                                          # 6,307,200
        assert e.energy_cost_per_gpu_hour_eur.value == pytest.approx(energy_MWh * 100.0 / gpu_hours)
        assert e.tariff_declared is True and e.capex_complete is True and e.unpriced == []

    def test_a_placeholder_tariff_is_not_declared_and_is_a_limitation(self):
        lad, e = self._evaluate(_quiet_ctx())
        assert e.tariff_declared is False and e.tariff_eur_per_MWh.value == 140.0
        assert any("placeholder" in x for x in e.limitations)
        assert e.decision_grade is False

    def test_lifecycle_undiscounted_and_discounted(self):
        energy_MWh = 1620.0 * 0.75 * 8760 / 1000.0
        annual = energy_MWh * 100.0
        ctx = _quiet_ctx()
        ctx.economics = EconomicsInput(electricity_eur_per_MWh=V(100.0, "EUR/MWh", "tariff", CUSTOMER), horizon_years=10)
        _, e = self._evaluate(ctx)
        assert e.lifecycle_cost_eur.value == pytest.approx(550_000.0 + 10 * annual)          # capex + 10 flat years
        ctx.economics = EconomicsInput(electricity_eur_per_MWh=V(100.0, "EUR/MWh", "tariff", CUSTOMER),
                                       horizon_years=10, discount_rate=V(0.05, "1", "rate", CUSTOMER))
        _, e = self._evaluate(ctx)
        annuity = (1 - 1.05 ** -10) / 0.05                                                    # 7.7217349
        assert annuity == pytest.approx(7.7217349, abs=1e-6)
        assert e.lifecycle_cost_eur.value == pytest.approx(550_000.0 + annual * annuity)

    def test_no_horizon_means_no_lifecycle_value_never_an_invented_horizon(self):
        _, e = self._evaluate(_quiet_ctx())
        assert e.lifecycle_cost_eur is None and e.horizon_years is None

    def test_capex_total_is_no_better_evidenced_than_its_cheapest_input(self):
        _, e = self._evaluate(_quiet_ctx())
        assert e.capex_total_eur.evidence == E0 and e.rests_on_placeholders >= 1

    def test_btm_variable_and_fixed_cost_arithmetic(self):
        gen = _opt("GEN-5MW", "gas_engine", 5.0,
                   opex_eur_per_MWh=V(95.0, "EUR/MWh", "all-in variable cost", ASSUMED),
                   annual_run_hours=V(5000.0, "h", "run hours", ASSUMED),
                   fixed_om_eur_per_kW_year=V(18.0, "EUR/kW/yr", "fixed O&M", ASSUMED))
        site_MWh = V(10_643.4, "MWh", "site energy", ESTIMATED)
        o = _btm_opex([gen], site_MWh)
        # generation = 5 MW x 5,000 h = 25,000 MWh, but the hall consumes 10,643.4 MWh: used share 0.425736;
        # variable = 25,000 x 95 x 0.425736 = 1,011,123 EUR (= 95 x 10,643.4); fixed = 5,000 kW x 18 = 90,000 EUR
        assert o.applied and o.curtailed
        assert o.generated_MWh.value == pytest.approx(25_000.0)
        assert o.used_MWh.value == pytest.approx(10_643.4)
        assert o.variable_eur.value == pytest.approx(95.0 * 10_643.4)
        assert o.fixed_eur.value == pytest.approx(90_000.0)

    def test_fuel_route_divides_fuel_price_by_electrical_efficiency(self):
        gen = _opt("GEN", "gas_engine", 1.0,
                   fuel_price_eur_per_MWh=V(40.0, "EUR/MWh_fuel", "fuel", ASSUMED),
                   electrical_efficiency=V(0.40, "1", "efficiency", ASSUMED),
                   variable_om_eur_per_MWh=V(5.0, "EUR/MWh", "variable O&M", ASSUMED),
                   annual_run_hours=V(1000.0, "h", "run hours", ASSUMED),
                   fixed_om_eur_per_kW_year=V(0.0, "EUR/kW/yr", "fixed O&M declared zero", ASSUMED))
        o = _btm_opex([gen], V(1000.0, "MWh", "site energy", ESTIMATED))
        # fuel per MWh generated = 40 / 0.40 = 100; + 5 variable O&M = 105 EUR/MWh; 1,000 MWh generated and used
        assert o.options[0]["cost_eur_per_MWh"] == pytest.approx(105.0)
        assert o.variable_eur.value == pytest.approx(105_000.0)

    def test_missing_btm_operating_inputs_apply_nothing_rather_than_a_partial_figure(self):
        gen = _opt("GEN", "gas_engine", 5.0, opex_eur_per_MWh=V(95.0, "EUR/MWh", "variable", ASSUMED))
        o = _btm_opex([gen], V(1000.0, "MWh", "site energy", ESTIMATED))
        assert o.applied is False and o.variable_eur is None and o.fixed_eur is None
        assert any("annual_run_hours not declared" in m for m in o.missing)
        assert any("fixed_om_eur_per_kW_year not declared" in m for m in o.missing)


# =====================================================================================================================
# Quantity arithmetic: units, intervals, evidence
# =====================================================================================================================
class TestQuantityArithmetic:
    def test_kw_plus_eur_is_refused(self):
        with pytest.raises(ValueError, match="unit mismatch"):
            _ = V(1, "kW", "a", ASSUMED) + V(1, "EUR", "b", ASSUMED)
        with pytest.raises(ValueError, match="unit mismatch"):
            _ = V(1, "kW", "a", ASSUMED) - V(1, "MW", "b", ASSUMED)       # kW and MW are not silently mixed

    def test_a_temperature_difference_may_be_added_to_a_temperature(self):
        q = V(30, "degC", "TCS", ASSUMED) - V(5, "K", "approach", ASSUMED)
        assert q.value == 25 and q.unit == "degC"

    def test_unit_algebra_cancels(self):
        assert (V(2, "EUR/rack", "p", ASSUMED) * V(3, "racks", "n", ASSUMED)).unit == "EUR"
        assert (V(6, "kW", "p", ASSUMED) / V(3, "kW", "q", ASSUMED)).unit == "1"

    def test_convert_multiplies_by_the_factor_and_relabels_the_unit(self):
        q = V(4.9, "MW", "load", CUSTOMER).convert(1000.0, "kW", "load in kW")
        assert q.value == pytest.approx(4900.0) and q.unit == "kW"

    def test_interval_arithmetic(self):
        a = V(3, "kW", "a", ASSUMED, band=(2, 4))
        b = V(4, "kW", "b", ASSUMED, band=(3, 5))
        assert (a + b).band == (5, 9)            # 2+3 .. 4+5
        assert (b - a).band == (-1, 3)           # 3-4 .. 5-2
        assert (a * b).band == (6, 20)           # 2*3 .. 4*5
        assert (b / a).band == (0.75, 2.5)       # 3/4 .. 5/2

    @pytest.mark.parametrize("ea, eb", list(itertools.product(list(EvidenceClass), repeat=2)))
    def test_every_operation_takes_the_weaker_evidence_class(self, ea, eb):
        a, b = V(2, "kW", "a", ea), V(3, "kW", "b", eb)
        for q in (a + b, a - b, a * b, a / b):
            assert q.evidence == min(ea, eb)

    @pytest.mark.parametrize("ev", list(EvidenceClass))
    def test_relabel_and_convert_cannot_raise_the_class(self, ev):
        q = V(2, "kW", "a", ev)
        assert q.relabel("b", "m", step_evidence=EvidenceClass.E7_DEPLOYED).evidence == ev
        assert q.convert(1000.0, "W", "c").evidence == ev
        assert q.relabel("b", "m", step_evidence=EvidenceClass.E0_ASSUMPTION).evidence == E0

    def test_arithmetic_with_a_bare_number_does_not_lift_the_class(self):
        assert (V(2, "kW", "a", E0) * 3.0).evidence == E0
        assert (V(2, "kW", "a", CUSTOMER) * 3.0).evidence == EvidenceClass.E5_CUSTOMER_DATA

    def test_rendering_does_not_invent_precision_for_weak_evidence(self):
        assert V(1234.5678, "kW", "a", E0).rounded() == 1230.0
        assert V(1234.5678, "kW", "a", EvidenceClass.E5_CUSTOMER_DATA).rounded() == 1235.0

    def test_derived_provenance_reaches_every_leaf(self):
        q = (V(10, "kW", "leaf a", CUSTOMER) * V(2, "1", "leaf b", E0)) + V(1, "kW", "leaf c", E0)
        labels = {p.label for p in q.prov.walk()}
        assert {"leaf a", "leaf b", "leaf c"} <= labels
