"""Regression tests for physics / engineering-validity defects found in the Agent-2 audit.

Every test here FAILED against the engine as it stood before the matching fix (see the defect list in the audit
report) and passes after it. Nothing here is real-world calibration: every fixture is the synthetic reference hall
from ``examples.reference_site`` (or a hand-built variant of it) and the expected values are derived by hand in the
comments from the equations, not read back from the engine. The calibration ledger is empty and these tests do not
change that.
"""
from __future__ import annotations

import dataclasses
import math
from types import SimpleNamespace

import pytest

from examples.reference_site import SCENARIOS, _full_dlc, build_context
from gridforge import constraints as constraints_mod
from gridforge.common import ASSUMED, CUSTOMER, V
from gridforge.constraints import ConstraintResult, floor_racks
from gridforge.costs import CostEntry
from gridforge.envelope import ladder, solve
from gridforge.envelope.time_to_power import full_capacity_band, schedule, schedule_complete
from gridforge.power.btm import bess_firm_factor_for_duration
from gridforge.power.constraints import grid_firm_capacity, rack_feed_tapoff
from gridforge.power.schema import GenerationOption
from gridforge.scenario import run
from gridforge.scenario.objective import Objective, pick_recommended
from gridforge.site.constraints import floor_loading
from gridforge.thermal.constraints import (architecture_capability, cdu_capacity, plant_capacity,
                                           residual_air_removal)
from gridforge.thermal.library import PUE_BY_ARCHITECTURE
from gridforge.thermal.schema import Architecture
from gridforge.validation import EvidenceClass

E0, E3 = EvidenceClass.E0_ASSUMPTION, EvidenceClass.E3_ENGINEERING_ESTIMATE


def _full_dlc_ctx():
    """Reference hall, full DLC, every constraint opened up except the one the caller then tightens."""
    ctx = _full_dlc(build_context())
    ctx.architecture = Architecture.FULL_DLC
    ctx.pue = PUE_BY_ARCHITECTURE[Architecture.FULL_DLC]
    ctx.power.options = []
    ctx.power.grid.firm_capacity_MVA = V(100, "MVA", "synthetic firm capacity", ASSUMED)
    ctx.power.grid.contracted_MW = V(100, "MW", "synthetic contracted", ASSUMED)
    ctx.power.transformers[0].units = 30
    ctx.power.ups[0].units = 60
    ctx.power.lv.busway_runs = 100
    ctx.power.lv.tapoff_max_A = V(400, "A", "synthetic tap-off", ASSUMED)
    ctx.thermal.residual_air_capacity_kW_per_rack = V(25, "kW", "synthetic air capacity", ASSUMED)
    ctx.thermal.plant.chilled_water_capacity_kW = V(60000, "kW", "synthetic plant", ASSUMED)
    ctx.thermal.plant.pump_flow_capacity_l_per_min = V(900000, "l/min", "synthetic pumps", ASSUMED)
    ctx.thermal.plant.dry_cooler_approach_K = V(6, "K", "synthetic dry cooler approach", ASSUMED)
    ctx.thermal.trim_chiller_installed = True       # facility water 6 degC <= 25 degC required: the gate passes
    ctx.hall.rack_positions = ctx.hall.positions_available = 500
    return ctx


# ---------------------------------------------------------------------------------------------------------------
# D1. Division by zero returned +inf whatever the sign of the numerator (infeasible declared unlimited), and a
#     divisor band that reached zero produced a finite interval.
# ---------------------------------------------------------------------------------------------------------------
class TestDivisionByZero:
    def test_sign_of_numerator_is_kept(self):
        zero = V(0, "kW", "zero divisor", CUSTOMER)
        assert (V(5, "kW", "pos", CUSTOMER) / zero).value == math.inf
        assert (V(-5, "kW", "neg", CUSTOMER) / zero).value == -math.inf

    def test_zero_over_zero_is_undetermined_not_unlimited(self):
        q = V(0, "kW", "zero", CUSTOMER) / V(0, "kW", "zero divisor", CUSTOMER)
        assert math.isnan(q.value)

    def test_divisor_band_that_reaches_zero_gives_an_unbounded_interval(self):
        # [2, 8] / [-1, 1]: the quotient takes every value of large magnitude. The old code returned (-8, 8).
        num = V(4, "kW", "num", CUSTOMER, band=(2, 8))
        den = V(0.5, "kW", "den", CUSTOMER, band=(-1, 1))
        q = num / den
        assert q.band == (-math.inf, math.inf)
        assert q.value == pytest.approx(8.0)         # the nominal quotient is still 4 / 0.5

    def test_ordinary_division_is_unchanged(self):
        q = V(10, "kW", "num", CUSTOMER, band=(8, 12)) / V(2, "kW", "den", CUSTOMER, band=(1, 4))
        assert q.value == 5.0
        assert q.band == (2.0, 12.0)                  # 8/4 .. 12/1

    def test_negative_headroom_over_zero_rack_power_is_zero_racks_not_unlimited_or_a_crash(self):
        ctx = build_context()
        ctx.architecture = Architecture.HYBRID_DLC
        # Existing hall load 4,900 kW against a 1,000 kW plant: headroom = 1000 - 4900 = -3900 kW.
        ctx.thermal.plant.chilled_water_capacity_kW = V(1000, "kW", "tiny plant", CUSTOMER)
        ctx.cluster.platform = dataclasses.replace(ctx.cluster.platform, rack_kW=V(0, "kW", "degenerate rack", ASSUMED))
        res = plant_capacity(ctx)                      # old code: +inf -> OverflowError inside floor_racks
        assert res.racks == 0.0


class TestNonFiniteRackCounts:
    def test_floor_racks_survives_infinite_and_nan(self):
        assert floor_racks(V(math.inf, "racks", "unlimited", ASSUMED)).value == math.inf
        assert floor_racks(V(-math.inf, "racks", "negative", ASSUMED)).value == 0.0
        assert floor_racks(V(math.nan, "racks", "undetermined", ASSUMED)).value == 0.0

    def test_nan_racks_fail_closed_in_the_solver(self):
        r = ConstraintResult("x", "thermal", "x", V(math.nan, "racks", "nan", ASSUMED), basis="")
        assert r.racks == 0.0                          # never an unordered value for min() to resolve by position


# ---------------------------------------------------------------------------------------------------------------
# D3. A failed gate claimed E3 although the figure it rejected was an E0 library assumption.
# ---------------------------------------------------------------------------------------------------------------
class TestGateEvidence:
    def test_rack_feed_gate_is_no_better_evidenced_than_the_platform_current(self):
        ctx = build_context()                        # GB300 feed current 205 A is E0; tap-off 63 A is E5
        res = rack_feed_tapoff(ctx)
        assert res.racks == 0.0
        assert res.max_racks.evidence == E0

    def test_residual_air_gate_is_no_better_evidenced_than_the_platform_residual(self):
        res = residual_air_removal(build_context())   # 135*(1-0.9) = 13.5 kW (E0) against 9 kW (E3)
        assert res.racks == 0.0
        assert res.max_racks.evidence == E0

    def test_architecture_gate_rests_on_a_library_capability(self):
        ctx = build_context()
        ctx.architecture = Architecture.RETAINED_AIR   # 22 kW library capability (E0) vs 135 kW
        res = architecture_capability(ctx)
        assert res.racks == 0.0 and res.max_racks.evidence == E0

    def test_floor_gate_rests_on_a_library_rack_mass(self):
        res = floor_loading(build_context())            # mass 1,400 kg is E0 even though the floor rating is E5
        assert res.max_racks.evidence == E0

    def test_a_gate_never_claims_more_than_e3_even_on_customer_inputs(self):
        ctx = build_context()
        ctx.cluster.platform = dataclasses.replace(
            ctx.cluster.platform,
            rack_feed_current_A=V(205, "A", "customer-supplied rack feed", CUSTOMER))
        assert rack_feed_tapoff(ctx).max_racks.evidence == E3


# ---------------------------------------------------------------------------------------------------------------
# D4. IT and facility load were built from a flat-E3 rack count.
# ---------------------------------------------------------------------------------------------------------------
def test_deployable_load_is_no_better_evidenced_than_the_constraints_that_cap_the_rack_count():
    ctx = _full_dlc_ctx()
    # A customer-supplied rack power is stronger than every hall constraint's inputs, so the old flat-E3 count
    # made the IT load E3 although the count itself rests on E0 library figures (PUE, platform residual, ...).
    ctx.cluster.platform = dataclasses.replace(
        ctx.cluster.platform, rack_kW=V(135, "kW", "customer-supplied rack power", CUSTOMER))
    ctx.thermal.tcs_target_supply_C = V(30, "degC", "customer TCS target", CUSTOMER)
    res = solve(ctx)
    assert res.max_racks > 0
    weakest = min(c.max_racks.evidence for c in res.constraints if c.max_racks.value != math.inf)
    assert weakest == E0
    assert res.it_load_kW.evidence <= weakest
    assert res.facility_load_kW.evidence <= weakest


# ---------------------------------------------------------------------------------------------------------------
# D5. Constraint registry order followed first-import order, and ties (several gates at zero racks) are resolved
#     by position: the binding constraint depended on which module a process happened to import first.
# ---------------------------------------------------------------------------------------------------------------
def test_binding_constraint_does_not_depend_on_registry_order(monkeypatch):
    ctx = build_context()
    ctx.architecture = Architecture.RETAINED_AIR       # several gates tie at zero racks
    ctx.pue = PUE_BY_ARCHITECTURE[Architecture.RETAINED_AIR]
    base = solve(ctx)
    base_order = [c.id for c in base.constraints]
    reg = constraints_mod._REGISTRY
    assert len([c for c in base.constraints if c.racks == 0.0]) >= 2, "this test needs a genuine tie"
    for ordering in (list(reg.items())[::-1], sorted(reg.items(), key=lambda kv: kv[0])):
        monkeypatch.setattr(constraints_mod, "_REGISTRY", dict(ordering))
        again = solve(ctx)
        assert again.binding.id == base.binding.id
        assert [c.id for c in again.constraints] == base_order


# ---------------------------------------------------------------------------------------------------------------
# D6. A 2N bank gains capacity only in pairs: the one-unit relief bought nothing and stopped the ladder.
# ---------------------------------------------------------------------------------------------------------------
class TestTwoNReliefStep:
    def _ctx(self):
        ctx = _full_dlc_ctx()
        ctx.thermal.cdus[0].units = 4
        ctx.thermal.cdus[0].redundancy = "2N"
        return ctx

    def test_ladder_continues_past_a_2n_cdu_bank(self):
        # 4 units 2N -> 2 usable x 1350 kW = 2700 kW; liquid load 135 x 0.90 = 121.5 kW/rack -> 22.2 -> 22 racks.
        # +2 units (matched pair) -> 6 -> 3 usable = 4050 kW / 121.5 = 33.3 -> 33 racks.
        lad = ladder(self._ctx())
        cdu = [s for s in lad.steps if s.binding_id == "cdu_capacity"]
        assert cdu, "the CDU bank must bind"
        first = cdu[0]
        assert (first.racks_before, first.racks_after) == (22, 33)
        assert first.taken is True

    def test_the_priced_quantity_is_the_units_actually_added(self):
        ctx = self._ctx()
        relief = cdu_capacity(ctx).relief
        assert relief.quantity == 2.0                   # one bank, a pair under 2N (it was 1.0)
        assert relief.apply(ctx).thermal.cdus[0].units == 6

    def test_n_plus_1_still_adds_a_single_unit(self):
        ctx = self._ctx()
        ctx.thermal.cdus[0].redundancy = "N+1"
        relief = cdu_capacity(ctx).relief
        assert relief.quantity == 1.0
        assert relief.apply(ctx).thermal.cdus[0].units == 5


def test_a_cdu_with_no_rated_approach_has_no_capacity_instead_of_a_division_by_zero():
    ctx = _full_dlc_ctx()
    ctx.thermal.cdus[0].rated_approach_K = V(0, "K", "degenerate CDU rating", ASSUMED)
    assert cdu_capacity(ctx).racks == 0.0               # was ZeroDivisionError


# ---------------------------------------------------------------------------------------------------------------
# D7. A schedule with a relief that has no lead time carried no marker that its dates were understated.
# ---------------------------------------------------------------------------------------------------------------
def _reference_runs():
    ctx = build_context()
    return {s.id: run(ctx, s) for s in SCENARIOS}


class TestMissingLeadTime:
    def test_a_schedule_with_a_missing_lead_time_says_it_is_incomplete(self):
        res = _reference_runs()["s4_full"]
        assert schedule(res.ladder).complete is True
        for st in res.ladder.taken_steps:
            if st.binding_id == "transformer_capacity":
                st.lead_time_weeks = None               # the 160-week step loses its lead time
        t = schedule(res.ladder)
        assert t.complete is False                       # the flag did not exist: nothing marked the date as unsafe
        assert schedule_complete(res.ladder) is False
        assert full_capacity_band(res.ladder, t) is None          # the defensible-date path still refuses to answer

    def test_a_complete_schedule_is_unchanged(self):
        t = schedule(_reference_runs()["s4_full"].ladder)
        assert t.complete is True and t.weeks_to_full == 160.0


# ---------------------------------------------------------------------------------------------------------------
# D8. The "recommended" scenario ranked a lower bound (unpriced capex) as if it were a complete figure.
# ---------------------------------------------------------------------------------------------------------------
class TestRecommendationDoesNotRankMissingFigures:
    @staticmethod
    def _fake(id_, racks, capex, complete):
        return SimpleNamespace(
            spec=SimpleNamespace(id=id_), unlocked_racks=racks,
            economics=SimpleNamespace(capex_total_eur=SimpleNamespace(value=capex), capex_complete=complete))

    def test_min_cost_prefers_a_complete_capex_over_a_smaller_lower_bound(self):
        partial = self._fake("partial", 10, 1_000_000, False)    # 100,000 EUR/rack but a component is unpriced
        complete = self._fake("complete", 10, 1_500_000, True)   # 150,000 EUR/rack, every line priced
        assert pick_recommended([partial, complete], Objective.MIN_COST_PER_RACK).spec.id == "complete"

    def test_min_cost_among_complete_is_still_the_cheapest(self):
        a = self._fake("a", 10, 1_500_000, True)
        b = self._fake("b", 10, 1_200_000, True)
        assert pick_recommended([a, b], Objective.MIN_COST_PER_RACK).spec.id == "b"

    def test_max_compute_tie_break_prefers_complete_capex(self):
        partial = self._fake("partial", 20, 1_000_000, False)
        complete = self._fake("complete", 20, 1_500_000, True)
        assert pick_recommended([partial, complete], Objective.MAX_COMPUTE).spec.id == "complete"
        assert pick_recommended([self._fake("more", 21, 9e9, False), complete],
                                Objective.MAX_COMPUTE).spec.id == "more"      # capacity still ranks first

    @pytest.mark.xfail(strict=True, reason=(
        "KNOWN DEFECT, NOT FIXED: schedule() reads a missing lead time as zero weeks and pick_recommended(FASTEST) "
        "ranks on it, so a scenario with an unknown lead time can win 'fastest'. compare_payload already refuses "
        "to rank such a scenario. Fixing it makes tests/test_portfolio_change_provenance.py::"
        "test_a_missing_lead_time_gives_no_date_instead_of_zero_weeks fail, because that existing test only "
        "reaches its assertion when the undated scenario is still the 'fastest' pick. Needs a decision from the "
        "owner of that test."))
    def test_fastest_does_not_reward_a_missing_lead_time(self):
        runs = _reference_runs()
        for st in runs["s4_full"].ladder.taken_steps:
            if st.binding_id == "transformer_capacity":
                st.lead_time_weeks = None
        pool = [runs["s3_hybrid"], runs["s4_full"], runs["s5_full_btm"]]
        # s3, s4 and s5 all wait 160 weeks on the transformer. With its lead time missing, s4 looks ~36 weeks
        # faster than the other two and wins.
        assert pick_recommended(pool, Objective.FASTEST_TO_POWER).spec.id != "s4_full"


# ---------------------------------------------------------------------------------------------------------------
# D9. An unreadable valid_until kept a quotation at E5 forever.
# ---------------------------------------------------------------------------------------------------------------
class TestQuotationValidity:
    def _quote(self, valid_until):
        return CostEntry(key="busway.replacement", label="busway (synthetic test quotation)", unit="EUR",
                         value=500_000.0, basis="firm_quote", supplier="Synthetic Supplier Ltd",
                         quoted_on="2026-01-15", valid_until=valid_until, synthetic=True)

    def test_unparseable_validity_date_is_treated_as_expired(self, monkeypatch):
        monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2026-06-01")
        q = self._quote("31/12/2099")                   # not ISO: nobody can say when it expires
        assert q.stale is True
        assert q.quantity().evidence == EvidenceClass.E1_MODEL

    def test_a_readable_future_date_is_still_a_live_quotation(self, monkeypatch):
        monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2026-06-01")
        q = self._quote("2099-12-31")
        assert q.stale is False
        assert q.quantity().evidence == EvidenceClass.E5_CUSTOMER_DATA

    def test_the_day_after_expiry_is_stale_and_the_last_day_is_not(self, monkeypatch):
        q = self._quote("2026-06-01")
        monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2026-06-01")
        assert q.stale is False
        monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2026-06-02")
        assert q.stale is True


# ---------------------------------------------------------------------------------------------------------------
# D10. The firm-supply ceiling kept only the nominal winner's band and evidence.
# ---------------------------------------------------------------------------------------------------------------
class TestFirmSupplyCeiling:
    def _ctx(self):
        ctx = build_context()
        ctx.power.options = []
        ctx.power.grid.firm_capacity_MVA = V(12.5, "MVA", "firm connection", CUSTOMER, band=(11, 14))
        ctx.power.grid.power_factor = V(1.0, "1", "unity power factor", CUSTOMER)
        ctx.power.grid.contracted_MW = V(12.0, "MW", "contracted", CUSTOMER)
        return ctx

    def test_downside_of_the_loser_is_not_dropped(self):
        # firm 12.5 MVA x 1.0 = 12,500 kW [11,000-14,000]; contracted 12,000 kW. min() nominal = 12,000, but the
        # firm figure could be as low as 11,000, so the ceiling's low bound is 11,000 and its high bound 12,000.
        # Headroom low = 11,000 - 7,400 = 3,600 kW; IT low = 3,600 / 1.40 (PUE high) = 2,571.4 kW;
        # racks low = 2,571.4 / 142 (rack kW high) = 18.1 -> 18.   (The old code returned 23.)
        res = grid_firm_capacity(self._ctx())
        assert res.max_racks.band[0] == 18
        # nominal: (12,000 - 7,400) / 1.30 / 135 = 26.2 -> 26
        assert res.max_racks.value == 26

    def test_weak_loser_lowers_the_evidence_of_the_ceiling(self):
        ctx = self._ctx()
        ctx.power.grid.firm_capacity_MVA = V(12.5, "MVA", "assumed firm connection", ASSUMED)
        # Make every other input customer-grade so the ceiling is the only E0 left in the chain.
        ctx.pue = V(1.3, "1", "customer-declared PUE", CUSTOMER)
        ctx.cluster.platform = dataclasses.replace(
            ctx.cluster.platform, rack_kW=V(135, "kW", "customer-supplied rack power", CUSTOMER))
        res = grid_firm_capacity(ctx)
        # "the ceiling is the contracted 12 MW" holds only if the E0 firm figure really is higher.
        assert res.max_racks.evidence == E0


# ---------------------------------------------------------------------------------------------------------------
# D11. The duration-aware BESS firm factor lost its uncertainty band.
# ---------------------------------------------------------------------------------------------------------------
def test_bess_firm_factor_keeps_its_band():
    opt = GenerationOption(
        id="BESS-T", kind="bess",
        capacity_MW=V(2.0, "MW", "synthetic inverter rating", ASSUMED, band=0.10),       # 1.8 .. 2.2 MW
        capex_eur_per_kW=V(900, "EUR/kW", "synthetic capex", ASSUMED),
        lead_time_weeks=V(30, "weeks", "synthetic lead time", ASSUMED), firm=True,
        energy_MWh=V(8.0, "MWh", "synthetic energy", ASSUMED, band=0.15))
    f = bess_firm_factor_for_duration(opt, V(2.0, "h", "ride-through", ASSUMED))
    # 2-hour ride-through: energy limit = 8 x (0.95 - 0.10) / 2 = 3.4 MW > 2 MW, so power binds: firm = 2.0 MW
    # [1.8, 2.2] and the factor is 1.0. Its low bound is 1.8 / 2.2 = 0.818 (inverter at the bottom of its band
    # against a nameplate at the top); it cannot exceed 1.
    assert f.value == pytest.approx(1.0)
    assert f.band[0] == pytest.approx(1.8 / 2.2)
    assert f.band[1] == 1.0
    assert f.evidence == E0
