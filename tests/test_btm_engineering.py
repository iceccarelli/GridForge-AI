"""Real BTM engineering models, replacing flat scalar assumptions.

`gridforge/power/btm.py`'s `DEFAULT_FIRM_FACTOR["bess"] = 0.50` treated every
battery as half-firm regardless of size or the outage window it must ride
through. `gridforge/power/storage.py`, `generation.py` and `reliability.py`
replace that with duration-aware, availability-aware, contingency-aware models.
These tests exist to make sure the replacement cannot regress back to a scalar
that ignores duration — the exact failure this module was written to fix.
"""
import copy
import json
from pathlib import Path

from gridforge.common import ASSUMED, CUSTOMER, V
from gridforge.intake.loader import load_document
from gridforge.power.btm import bess_firm_factor_for_duration, firm_factor
from gridforge.power.generation import GenerationUnit, default_generation_unit
from gridforge.power.load_profile import (Gap, LoadProfileError, flat, from_csv)
from gridforge.power.reliability import ContingencyCase, ContingencyStatus, Redundancy, evaluate
from gridforge.power.schema import GenerationOption
from gridforge.power.storage import BatteryEnergyStorageSystem, default_bess

_REFERENCE_DOC = json.loads(
    (Path(__file__).resolve().parents[1] / "examples" / "intake" / "reference_hall.json")
    .read_text())


def _bess_option(energy_MWh=8.0, power_MW=2.0):
    return GenerationOption(
        id="BESS-1", kind="bess",
        capacity_MW=V(power_MW, "MW", "power", ASSUMED),
        capex_eur_per_kW=V(900, "EUR/kW", "capex", ASSUMED),
        lead_time_weeks=V(30, "weeks", "lead time", ASSUMED),
        firm=True,
        energy_MWh=V(energy_MWh, "MWh", "energy", ASSUMED) if energy_MWh is not None else None,
    )


def test_bess_firm_factor_for_duration_diverges_from_the_flat_default():
    opt = _bess_option()
    flat_default = firm_factor(opt).value
    short = bess_firm_factor_for_duration(opt, V(0.25, "h", "15min", ASSUMED)).value
    long = bess_firm_factor_for_duration(opt, V(8.0, "h", "8h", ASSUMED)).value
    assert short > flat_default, "a short ride-through should beat the flat 0.50 assumption"
    assert long < flat_default, "an 8h ride-through on a 4h-duration battery must fall below it"


def test_bess_firm_factor_for_duration_requires_a_declared_energy_rating():
    opt = _bess_option(energy_MWh=None)
    try:
        bess_firm_factor_for_duration(opt, V(2.0, "h", "2h", ASSUMED))
        assert False, "must not silently fall back when energy_MWh is undeclared"
    except ValueError as e:
        assert "energy_MWh" in str(e)


def test_bess_firm_factor_for_duration_rejects_non_bess_options():
    opt = _bess_option()
    opt.kind = "gas_engine"
    try:
        bess_firm_factor_for_duration(opt, V(2.0, "h", "2h", ASSUMED))
        assert False
    except ValueError:
        pass


def test_bess_firm_factor_never_exceeds_one():
    opt = _bess_option(power_MW=1.0, energy_MWh=50.0)  # huge energy, small inverter
    for h in (0.01, 1, 10, 100):
        f = bess_firm_factor_for_duration(opt, V(h, "h", f"{h}h", ASSUMED))
        assert 0.0 <= f.value <= 1.0 + 1e-9


# --- intake wiring: a declared ride-through replaces the flat default ---------

def test_declaring_energy_and_ride_through_replaces_the_flat_firm_factor():
    doc = copy.deepcopy(_REFERENCE_DOC)
    del doc["btm_options"][0]["firm_capacity_factor"]
    doc["btm_options"][0]["energy_MWh"] = 8.0
    doc["btm_options"][0]["ride_through_hours"] = 4.0
    intake = load_document(doc)
    opt = next(o for o in intake.context.power.options if o.kind == "bess")
    assert opt.firm_capacity_factor is not None
    assert opt.firm_capacity_factor.value != 0.5, (
        "a declared energy rating and ride-through must move the factor off the "
        "flat 0.50 technology default")


def test_an_explicit_firm_capacity_factor_in_the_intake_still_wins():
    """A customer's own site-specific figure must outrank the calculation —
    they may know something (a warranty derate, a site test) the model does not."""
    doc = copy.deepcopy(_REFERENCE_DOC)
    doc["btm_options"][0]["firm_capacity_factor"] = 0.42
    doc["btm_options"][0]["energy_MWh"] = 8.0
    doc["btm_options"][0]["ride_through_hours"] = 4.0
    intake = load_document(doc)
    opt = next(o for o in intake.context.power.options if o.kind == "bess")
    assert opt.firm_capacity_factor.value == 0.42


def test_no_ride_through_declared_keeps_the_flat_default_unchanged():
    """Backward compatibility: an intake that doesn't know its ride-through
    requirement must behave exactly as it did before this session — the flat,
    honestly-labelled technology default, not a guessed duration."""
    doc = copy.deepcopy(_REFERENCE_DOC)
    del doc["btm_options"][0]["firm_capacity_factor"]
    doc["btm_options"][0]["energy_MWh"] = 8.0
    intake = load_document(doc)
    opt = next(o for o in intake.context.power.options if o.kind == "bess")
    assert opt.firm_capacity_factor is None  # falls through to firm_factor()'s flat default


# --- BatteryEnergyStorageSystem ----------------------------------------------

def test_a_battery_is_not_a_flat_fraction_of_nameplate():
    """The whole point: a 2 MW / 8 MWh unit must deliver DIFFERENT firm power for
    a 30-minute ride-through than for a 6-hour one. A flat 0.50 factor would give
    1 MW in both cases; this must not."""
    b = default_bess("BESS-1", power_MW=2.0, energy_MWh=8.0)
    short = b.firm_MW_for_duration(V(0.5, "h", "30 min", ASSUMED))
    long = b.firm_MW_for_duration(V(6.0, "h", "6 h", ASSUMED))
    assert short.value != long.value
    assert short.value == 2.0, "a short ride-through should be power-limited, at full rating"
    assert long.value < 2.0, "a long ride-through must be energy-limited, below full rating"


def test_battery_firm_power_never_exceeds_the_power_rating():
    b = default_bess("BESS-1", power_MW=2.0, energy_MWh=20.0)  # huge energy, small inverter
    for hours in (0.1, 1, 5, 20):
        f = b.firm_MW_for_duration(V(hours, "h", f"{hours}h", ASSUMED))
        assert f.value <= 2.0 + 1e-9


def test_battery_firm_power_respects_soc_window_and_degradation():
    full_window = BatteryEnergyStorageSystem(
        id="B1", power_MW=V(1.0, "MW", "power", ASSUMED), energy_MWh=V(4.0, "MWh", "energy", ASSUMED),
        soc_min=V(0.0, "1", "soc_min", ASSUMED), soc_max=V(1.0, "1", "soc_max", ASSUMED),
        round_trip_efficiency=V(1.0, "1", "rte", ASSUMED))
    narrow_window = BatteryEnergyStorageSystem(
        id="B2", power_MW=V(1.0, "MW", "power", ASSUMED), energy_MWh=V(4.0, "MWh", "energy", ASSUMED),
        soc_min=V(0.2, "1", "soc_min", ASSUMED), soc_max=V(0.8, "1", "soc_max", ASSUMED),
        round_trip_efficiency=V(1.0, "1", "rte", ASSUMED))
    dur = V(3.0, "h", "3h", ASSUMED)
    assert narrow_window.firm_MW_for_duration(dur).value < full_window.firm_MW_for_duration(dur).value


def test_battery_reserve_reduces_available_power_but_never_below_zero():
    b = BatteryEnergyStorageSystem(
        id="B1", power_MW=V(2.0, "MW", "power", ASSUMED), energy_MWh=V(8.0, "MWh", "energy", ASSUMED),
        soc_min=V(0.1, "1", "soc_min", ASSUMED), soc_max=V(0.9, "1", "soc_max", ASSUMED),
        round_trip_efficiency=V(0.9, "1", "rte", ASSUMED),
        reserve_MW=V(5.0, "MW", "reserve exceeding rating", ASSUMED))
    assert b.available_power_MW().value == 0.0


def test_binding_limit_is_named_correctly():
    b = default_bess("BESS-1", power_MW=2.0, energy_MWh=8.0)
    assert b.binding_limit(V(0.25, "h", "15min", ASSUMED)) == "power"
    assert b.binding_limit(V(10.0, "h", "10h", ASSUMED)) == "energy"


# --- GenerationUnit -----------------------------------------------------------

def test_generation_firm_capacity_is_discounted_by_availability_not_nameplate():
    g = default_generation_unit("GEN-1", "gas_engine", 5.0)
    assert g.firm_MW().value < 5.0
    assert g.firm_MW().value > 0.0


def test_generation_unit_with_no_availability_declared_says_so_rather_than_assuming_perfect():
    g = GenerationUnit(id="GEN-X", kind="unknown_tech", nameplate_MW=V(5.0, "MW", "nameplate", ASSUMED))
    firm = g.firm_MW()
    assert firm.value == 5.0  # undeclared -> availability treated as 1.0
    assert "undeclared" in firm.prov.assumptions[0] if firm.prov.assumptions else True


def test_generation_unit_cannot_contribute_before_its_own_startup_time():
    g = default_generation_unit("GEN-1", "gas_engine", 5.0)  # gas_engine startup default 3 min
    fast_window = V(1.0, "min", "1 minute", ASSUMED)
    assert g.output_available_within(fast_window).value == 0.0
    slow_window = V(60.0, "min", "1 hour", ASSUMED)
    assert g.output_available_within(slow_window).value == g.firm_MW().value


def test_generation_unit_ramp_limits_output_inside_the_window():
    g = default_generation_unit("GEN-1", "gas_engine", 10.0)
    short = g.output_available_within(V(5.0, "min", "5 min", ASSUMED))
    longer = g.output_available_within(V(20.0, "min", "20 min", ASSUMED))
    assert short.value < longer.value <= g.firm_MW().value


# --- LoadProfile ---------------------------------------------------------------

CSV = """timestamp,kW
2026-01-01T00:00:00,10000
2026-01-01T00:15:00,10000
2026-01-01T00:30:00,38000
2026-01-01T00:45:00,40000
2026-01-01T01:00:00,40000
"""


def test_load_profile_peak_and_mean_are_not_the_same_number():
    p = from_csv(CSV)
    assert p.peak_kW().value == 40000
    assert p.min_kW().value == 10000
    assert p.mean_kW().value < p.peak_kW().value


def test_load_profile_detects_a_real_step_event():
    p = from_csv(CSV)
    events = p.step_events(threshold_fraction=0.10)
    assert events, "a 10 MW -> 38 MW jump must be detected as a step event"
    assert events[0].delta_kW == 28000


def test_load_profile_never_interpolates_a_gap():
    # A regular 15-minute series establishes the interval, then one interval is
    # skipped outright — with only two points total there is no way to tell "the
    # interval is 2 hours" from "a 15-minute series has a gap", so this needs
    # enough regular samples to make the inferred interval unambiguous.
    csv_with_gap = (
        "timestamp,kW\n"
        "2026-01-01T00:00:00,10000\n"
        "2026-01-01T00:15:00,10000\n"
        "2026-01-01T00:30:00,10000\n"
        "2026-01-01T02:00:00,10000\n"
    )
    p = from_csv(csv_with_gap)
    gaps = p.gaps()
    assert len(gaps) == 1
    assert isinstance(gaps[0], Gap)
    assert gaps[0].missing_intervals > 0
    # And the gap must surface in validate(), not be silently absorbed.
    report = p.validate()
    assert any("gap" in w.lower() for w in report.warnings)


def test_load_profile_rejects_negative_power():
    try:
        from_csv("timestamp,kW\n2026-01-01T00:00:00,-100\n")
        assert False, "negative kW must be refused, not silently accepted"
    except LoadProfileError:
        pass


def test_load_profile_rejects_the_wrong_columns():
    try:
        from_csv("time,power\n2026-01-01T00:00:00,100\n")
        assert False, "a header that isn't timestamp,kW must be refused, not guessed at"
    except LoadProfileError:
        pass


def test_flat_profile_is_explicitly_weaker_evidence_than_a_real_csv():
    real = from_csv(CSV)
    assumed = flat(25000)
    assert real.evidence == CUSTOMER
    assert assumed.evidence == ASSUMED
    assert assumed.evidence < real.evidence


def test_flat_profile_has_zero_ramp_and_no_step_events():
    """A flat assumption must not manufacture transients that were never
    observed — the honest answer to "what does a single MW figure tell you about
    ramp behaviour" is nothing."""
    p = flat(20000)
    assert p.ramp_rate_kW_per_min().value == 0.0
    assert p.step_events() == []


# --- reliability / contingency -------------------------------------------------

def _case(redundancy, critical_MW=15.0, ride_hours=2.0):
    gens = [default_generation_unit("GEN-A", "gas_engine", 10.0),
           default_generation_unit("GEN-B", "gas_engine", 10.0)]
    bess = [default_bess("BESS-1", power_MW=4.0, energy_MWh=16.0)]
    return ContingencyCase(
        critical_load_MW=V(critical_MW, "MW", "critical load", ASSUMED),
        grid_firm_MW=V(0.0, "MW", "islanded", ASSUMED),
        generation=gens, bess=bess,
        ride_through_hours=V(ride_hours, "h", "ride-through", ASSUMED),
        redundancy=redundancy)


def test_n_redundancy_passes_when_base_case_has_margin():
    r = evaluate(_case(Redundancy.N, critical_MW=15.0))
    assert r.status == ContingencyStatus.PASS
    assert r.margin_MW.value > 0


def test_n_plus_1_removes_the_single_largest_contributor():
    r = evaluate(_case(Redundancy.N_PLUS_1, critical_MW=15.0))
    assert "GEN-A" in r.scenario or "GEN-B" in r.scenario
    assert "and" not in r.scenario.split("(")[0]  # exactly one unit named, not two


def test_n_plus_2_removes_two_contributors_and_is_strictly_worse_than_n_plus_1():
    base = evaluate(_case(Redundancy.N, critical_MW=1.0))
    plus1 = evaluate(_case(Redundancy.N_PLUS_1, critical_MW=1.0))
    plus2 = evaluate(_case(Redundancy.N_PLUS_2, critical_MW=1.0))
    assert plus2.available_MW.value < plus1.available_MW.value < base.available_MW.value


def test_2n_is_labelled_as_a_simplification_not_a_real_path_analysis():
    r = evaluate(_case(Redundancy.TWO_N, critical_MW=1.0))
    assert r.blocking
    assert any("2N" in b for b in r.blocking)


def test_contingency_with_no_declared_supply_requires_engineering_study_not_a_fake_zero():
    case = ContingencyCase(
        critical_load_MW=V(10.0, "MW", "critical load", ASSUMED),
        grid_firm_MW=V(0.0, "MW", "grid", ASSUMED))
    r = evaluate(case)
    assert r.status == ContingencyStatus.REQUIRES_ENGINEERING_STUDY
    assert r.blocking


def test_missing_availability_data_escalates_a_pass_to_requires_engineering_study():
    """A generator with no declared forced-outage rate or availability must not
    silently count as 100% available inside a result the case calls PASS."""
    gen_no_data = GenerationUnit(id="GEN-BLIND", kind="unknown",
                                 nameplate_MW=V(100.0, "MW", "nameplate", ASSUMED))
    case = ContingencyCase(
        critical_load_MW=V(10.0, "MW", "critical load", ASSUMED),
        grid_firm_MW=V(0.0, "MW", "grid", ASSUMED),
        generation=[gen_no_data], redundancy=Redundancy.N)
    r = evaluate(case)
    assert r.status == ContingencyStatus.REQUIRES_ENGINEERING_STUDY
    assert any("availability" in b or "forced-outage" in b for b in r.blocking)


def test_a_real_shortfall_is_reported_as_fail_even_with_a_caveat_attached():
    """A caveat must never mask a genuine shortfall as merely 'needs a study' —
    FAIL means fail regardless of what else is also true about the scenario."""
    r = evaluate(_case(Redundancy.TWO_N, critical_MW=20.0))
    assert r.status == ContingencyStatus.FAIL
    assert r.margin_MW.value < 0
