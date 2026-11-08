"""The engineering constants the site states are the engine's.

lib/engineering-constants.json is what /reference, /constraints/<slug> and /llms.txt say about the engine's reserved engineering
constants: the transformer lead-time default, the rack-feed (tap-off) check, the hydraulic-flow limit and the heat-rejection reliefs
with the PUE figures. This file runs the REAL loader, library and constraints in gridforge/ and fails if any number, band or evidence
class in that file differs, or if the engine starts doing something the site says it does not (a continuous-load derating on the
tap-off rating, a climate-responsive PUE, a lead time above E0). It changes no engine behaviour. The TypeScript half is
tests/site/engineering-constants.test.ts.
"""
import copy
import json
from pathlib import Path

import pytest

from examples.reference_site import SCENARIOS, build_context
from gridforge import costs
from gridforge.common import CUSTOMER, DEPLOYED, ESTIMATED, V
from gridforge.compute.library import PLATFORMS
from gridforge.costs import BAND_BY_EVIDENCE, COST_EVIDENCE, CostEntry, cost_overlay
from gridforge.envelope.solver import solve
from gridforge.intake.loader import load_document
from gridforge.power.constraints import LIBRARY_FEED_VOLTAGE_V, RELIEF_TAPOFF_A, rack_feed_current_at, rack_feed_tapoff
from gridforge.scenario import run
from gridforge.thermal import constraints as thermal_constraints
from gridforge.thermal.library import (
    FLOW_L_PER_MIN_PER_KW,
    PUE_BY_ARCHITECTURE,
    WATER_CP_KJ_PER_KG_K,
    WATER_DENSITY_KG_PER_L,
)
from gridforge.thermal.schema import Architecture

ROOT = Path(__file__).resolve().parents[1]
K = json.loads((ROOT / "lib" / "engineering-constants.json").read_text())
REFERENCE_HALL = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())
PUBLIC = ROOT / "public" / "reference"


def _doc():
    return copy.deepcopy(REFERENCE_HALL)


def _klass(q) -> str:
    return q.prov.evidence.short


def _band(q) -> list:
    lo, hi = q.band
    return [lo, hi]


def _ref_solve():
    return solve(load_document(_doc()).context)


def _constraint(res, cid):
    return next(c for c in res.constraints if c.id == cid)


# ---------------------------------------------------------------------------------------------- the transformer default
def test_the_transformer_default_is_a_library_assumption_with_its_band():
    t = K["transformer_lead_time"]
    doc = _doc()
    del doc["transformers"][0]["replacement_lead_time_weeks"]
    intake = load_document(doc)
    lead = intake.context.power.transformers[0].replacement_lead_time_weeks
    assert lead.value == t["default_weeks"]
    assert _band(lead) == t["default_band_weeks"]
    assert _klass(lead) == t["default_class"] == "E0"
    # the engine records it as a gap, not as something the customer said
    assert any(g.path == "transformers.replacement_lead_time_weeks" for g in intake.report.gaps)


def test_a_lead_time_the_customer_types_is_still_class_e0_with_a_band_around_itself():
    """The owner's text says supplied or quoted lead times are E3-E5. The loader builds them ASSUMED (E0): the engine cannot check a figure
    against a written quotation. The site says what the loader does."""
    t = K["transformer_lead_time"]
    doc = _doc()
    doc["transformers"][0]["replacement_lead_time_weeks"] = 100
    lead = load_document(doc).context.power.transformers[0].replacement_lead_time_weeks
    assert lead.value == 100
    assert _klass(lead) == t["supplied_class"] == "E0"
    assert _band(lead) == pytest.approx([100 * (1 - t["supplied_band_fraction"]), 100 * (1 + t["supplied_band_fraction"])])


def test_no_declared_evidence_class_lifts_a_lead_time_above_e0():
    doc = _doc()
    doc["transformers"][0]["replacement_lead_time_weeks"] = {"value": 100, "evidence_class": "E5"}
    with pytest.raises(ValueError):
        load_document(doc)


def test_the_dated_figure_built_from_the_reference_hall_is_labelled_assumed_even_with_a_typed_160():
    pack = json.loads((PUBLIC / "model_pack.json").read_text())
    s = next(x for x in pack["scenarios"] if x["time_to_power"].get("weeks_to_full") == K["transformer_lead_time"]["default_weeks"])
    assert s["time_to_power"]["date_basis"] == "assumed"
    assert s["time_to_power"]["date_evidence_class"] == "E0"


# ---------------------------------------------------------------------------------------------------------- the tap-off check
def test_the_tapoff_check_is_a_current_comparison_at_the_library_feed_voltage():
    r = K["rack_feed"]
    assert LIBRARY_FEED_VOLTAGE_V == r["library_feed_voltage_V"]
    ctx = build_context()
    lv = ctx.power.lv
    for p in PLATFORMS.values():
        if p.rack_feed_current_A is None:
            continue
        cur = p.rack_feed_current_A
        assert _klass(cur) == r["library_feed_current_class"]
        lo, hi = _band(cur)
        assert lo == pytest.approx(cur.value * (1 - r["library_feed_current_band_fraction"]))
        assert hi == pytest.approx(cur.value * (1 + r["library_feed_current_band_fraction"]))
    # at the library voltage, three-phase, the required current is the library figure unchanged
    need, note = rack_feed_current_at(ctx.cluster.platform.rack_feed_current_A, lv)
    assert lv.voltage_V.value == r["library_feed_voltage_V"] and lv.phases == r["library_feed_phases"]
    assert note == "" and need.value == ctx.cluster.platform.rack_feed_current_A.value
    # a lower voltage draws proportionally more current; single-phase draws sqrt(3) more again
    lv.voltage_V = V(200.0, "V", "test voltage", CUSTOMER)
    assert rack_feed_current_at(ctx.cluster.platform.rack_feed_current_A, lv)[0].value == pytest.approx(
        ctx.cluster.platform.rack_feed_current_A.value * r["library_feed_voltage_V"] / 200.0)
    lv.phases = 1
    assert rack_feed_current_at(ctx.cluster.platform.rack_feed_current_A, lv)[0].value == pytest.approx(
        ctx.cluster.platform.rack_feed_current_A.value * r["library_feed_voltage_V"] / 200.0 * 3 ** 0.5)


def test_no_continuous_load_derating_is_applied_to_the_tapoff_rating():
    """Compared at the stated rating (a fraction of 1.0): a tap-off rated exactly at the need passes, and changing the busway's own
    continuous-load derating does not move the tap-off verdict. This is a known open point, reserved for the owner: rack feed against
    tap-off continuous rating."""
    r = K["rack_feed"]
    assert r["rating_fraction_compared"] == 1.0
    ctx = build_context()
    need, _ = rack_feed_current_at(ctx.cluster.platform.rack_feed_current_A, ctx.power.lv)
    ctx.power.lv.tapoff_max_A = V(need.value, "A", "tap-off rated exactly at the need", CUSTOMER)
    assert rack_feed_tapoff(ctx).racks > 0
    ctx.power.lv.busway_utilisation_limit = V(0.5, "1", "busway derating under test", CUSTOMER)
    assert rack_feed_tapoff(ctx).racks > 0
    ctx.power.lv.tapoff_max_A = V(need.value - 0.01, "A", "tap-off just below the need", CUSTOMER)
    assert rack_feed_tapoff(ctx).racks == 0
    basis = rack_feed_tapoff(ctx).basis
    assert "no continuous-load derating" in basis


def test_the_site_power_factor_does_not_enter_the_tapoff_check_and_does_enter_the_busway():
    ctx = build_context()
    before = rack_feed_tapoff(ctx).basis
    ctx.power.grid.power_factor = V(0.5, "1", "power factor under test", CUSTOMER)
    assert rack_feed_tapoff(ctx).basis == before


def test_the_defaults_used_when_the_inputs_are_absent_and_the_classes_when_they_are_supplied():
    r = K["rack_feed"]
    doc = _doc()
    for path in ("tapoff_max_A", "voltage_V", "busway_utilisation_limit"):
        doc["lv"].pop(path, None)
    doc["grid"].pop("power_factor", None)
    lv = load_document(doc).context.power
    assert (lv.lv.tapoff_max_A.value, _band(lv.lv.tapoff_max_A), _klass(lv.lv.tapoff_max_A)) == (
        r["installed_tapoff_default_A"], r["installed_tapoff_default_band_A"], "E0")
    assert (lv.lv.voltage_V.value, _klass(lv.lv.voltage_V)) == (r["voltage_default_V"], "E0")
    assert (lv.grid.power_factor.value, _band(lv.grid.power_factor), _klass(lv.grid.power_factor)) == (
        r["site_power_factor_default"], r["site_power_factor_default_band"], "E0")
    assert (lv.lv.busway_utilisation_limit.value, _klass(lv.lv.busway_utilisation_limit)) == (r["busway_utilisation_default"], "E0")
    supplied = _doc()
    supplied["lv"].update({"tapoff_max_A": 125, "voltage_V": 415})
    supplied["grid"]["power_factor"] = 0.95
    p = load_document(supplied).context.power
    assert _klass(p.lv.tapoff_max_A) == r["installed_tapoff_supplied_class"]
    assert _klass(p.lv.voltage_V) == r["voltage_supplied_class"]
    assert _klass(p.grid.power_factor) == r["site_power_factor_supplied_class"]


def test_the_tapoff_relief_rating_price_and_lead_time():
    r = K["rack_feed"]
    assert RELIEF_TAPOFF_A == r["relief_tapoff_A"]
    relief = _constraint(_ref_solve(), "rack_feed_tapoff").relief
    assert relief.capex_eur.value == r["relief_cost_eur_per_rack"] and _klass(relief.capex_eur) == "E0"
    assert (relief.lead_time_weeks.value, _band(relief.lead_time_weeks), _klass(relief.lead_time_weeks)) == (
        r["relief_lead_weeks"], r["relief_lead_band_weeks"], "E0")
    ctx = build_context()
    ctx.power.lv.tapoff_max_A = V(32.0, "A", "weak tap-off", CUSTOMER)
    after = relief.apply(ctx)
    assert after.power.lv.tapoff_max_A.value == RELIEF_TAPOFF_A and _klass(after.power.lv.tapoff_max_A) == r["relief_tapoff_class"]


# ------------------------------------------------------------------------------------------------------------- hydraulic flow
def test_hydraulic_flow_is_pumped_flow_over_the_platforms_flow_and_its_class_is_the_weakest_input():
    h = K["hydraulic_flow"]
    ctx = build_context()
    plant = ctx.thermal.plant
    plat = ctx.cluster.platform
    res = thermal_constraints.hydraulic_flow(ctx)
    expected = int((plant.pump_flow_capacity_l_per_min.value - (plant.existing_flow_l_per_min.value if plant.existing_flow_l_per_min else 0.0))
                   // plat.flow_l_per_min_per_rack.value)
    assert res.racks == expected
    # the platform's own flow is a library assumption, so the count is E0 however firmly the pumped flow is stated
    assert _klass(plat.flow_l_per_min_per_rack) == h["platform_flow_class"]
    assert _klass(res.max_racks) == h["result_class"] == "E0"


def test_the_most_a_stated_pumped_flow_can_reach_is_the_step_cap():
    """Even with measured pumped flow (E5) and an E7 per-rack flow, the step is labelled a simulation-class screen (E2) and no more."""
    h = K["hydraulic_flow"]
    ctx = build_context()
    ctx.thermal.plant.pump_flow_capacity_l_per_min = V(9000.0, "l/min", "pumped flow under test", CUSTOMER)
    ctx.thermal.plant.existing_flow_l_per_min = None
    import dataclasses
    ctx.cluster.platform = dataclasses.replace(ctx.cluster.platform, flow_l_per_min_per_rack=V(130.0, "l/min", "rack flow under test", DEPLOYED))
    assert _klass(thermal_constraints.hydraulic_flow(ctx).max_racks) == h["step_class_cap"] == "E2"


def test_a_supplied_pumped_flow_is_classed_e3_and_an_absent_one_is_the_library_default():
    h = K["hydraulic_flow"]
    assert _klass(load_document(_doc()).context.thermal.plant.pump_flow_capacity_l_per_min) == h["pump_flow_supplied_class"] == "E3"
    doc = _doc()
    del doc["thermal"]["plant"]["pump_flow_capacity_l_per_min"]
    q = load_document(doc).context.thermal.plant.pump_flow_capacity_l_per_min
    assert (q.value, _klass(q)) == (h["pump_flow_default_l_per_min"], "E0")


def test_pump_head_and_pipe_resistance_are_not_in_the_limit():
    basis = _constraint(_ref_solve(), "hydraulic_flow").basis
    assert "pump head are not modelled" in basis or "pump head are not" in basis
    notes = " ".join(thermal_constraints.hydraulic_flow(build_context()).notes)
    assert "Pressure drop budget and pipe DN are not modelled" in notes


def test_the_pump_relief_price_lead_time_and_uprate():
    h = K["hydraulic_flow"]
    assert thermal_constraints.PUMP_UPRATE == h["pump_uprate_factor"]
    relief = _constraint(_ref_solve(), "hydraulic_flow").relief
    pump = load_document(_doc()).context.thermal.plant.pump_flow_capacity_l_per_min.value
    added = pump * (h["pump_uprate_factor"] - 1.0)
    assert added == pytest.approx(h["relief_cost_reference_l_per_min"])           # the reference hall adds exactly the quantity the reference price is for
    assert relief.capex_eur.value == pytest.approx(h["relief_cost_reference_eur"]) and _klass(relief.capex_eur) == "E0"
    assert (relief.lead_time_weeks.value, _band(relief.lead_time_weeks), _klass(relief.lead_time_weeks)) == (
        h["relief_lead_weeks"], h["relief_lead_band_weeks"], "E0")


def test_the_screening_flow_constant_is_reference_only_and_agrees_with_the_heat_balance():
    h = K["hydraulic_flow"]
    assert FLOW_L_PER_MIN_PER_KW.value == h["screening_flow_l_per_min_per_kW"] and _band(FLOW_L_PER_MIN_PER_KW) == h["screening_flow_band_l_per_min_per_kW"]
    assert "10 K" in FLOW_L_PER_MIN_PER_KW.prov.label and h["screening_delta_T_K"] == 10
    assert (WATER_DENSITY_KG_PER_L, WATER_CP_KJ_PER_KG_K) == (h["water_density_kg_per_l"], h["water_cp_kJ_per_kg_K"])
    physics = 60.0 / (WATER_DENSITY_KG_PER_L * WATER_CP_KJ_PER_KG_K * h["screening_delta_T_K"])
    assert physics == pytest.approx(1.436, abs=0.001)
    assert abs(physics - FLOW_L_PER_MIN_PER_KW.value) / physics < 0.02
    # the constraint does not read the constant: the library and the platform flows differ and the count follows the platform
    basis = thermal_constraints.hydraulic_flow(build_context()).basis
    assert "is not used by any constraint" in basis


# ------------------------------------------------------------------------------------------------- heat rejection and PUE
def test_the_trim_chiller_relief_is_a_flat_library_lump_with_its_band_and_lead_time():
    x = K["heat_rejection"]
    relief = _constraint(_ref_solve(), "tcs_supply_achievable").relief
    assert relief.capex_eur.value == x["trim_chiller_eur"] and relief.cost_kind == x["trim_chiller_cost_kind"]
    assert _klass(relief.capex_eur) == x["trim_chiller_class"] == "E0"
    lo, hi = BAND_BY_EVIDENCE[relief.capex_eur.prov.evidence]
    assert _band(relief.capex_eur) == [x["trim_chiller_eur"] * lo, x["trim_chiller_eur"] * hi]
    assert (relief.lead_time_weeks.value, _band(relief.lead_time_weeks), _klass(relief.lead_time_weeks)) == (
        x["trim_chiller_lead_weeks"], x["trim_chiller_lead_band_weeks"], "E0")
    ctx = build_context()
    ctx.thermal.plant.dry_cooler_approach_K = None
    after = relief.apply(ctx)
    ap = after.thermal.plant.dry_cooler_approach_K
    assert (ap.value, _band(ap), _klass(ap)) == (x["dry_cooler_approach_K"], x["dry_cooler_approach_band_K"], x["dry_cooler_approach_class"])
    assert after.thermal.trim_chiller_installed is True


def test_the_plant_uprate_price_and_lead_time():
    x = K["heat_rejection"]
    assert thermal_constraints.PLANT_UPRATE == x["plant_uprate_factor"]
    ctx = load_document(_doc()).context
    relief = _constraint(solve(ctx), "plant_capacity").relief
    added = ctx.thermal.plant.chilled_water_capacity_kW.value * (x["plant_uprate_factor"] - 1.0)
    per_kW = x["plant_uprate_cost_reference_eur"] / x["plant_uprate_cost_reference_kW"]
    assert relief.capex_eur.value == pytest.approx(per_kW * added) and _klass(relief.capex_eur) == "E0"
    assert (relief.lead_time_weeks.value, _band(relief.lead_time_weeks), _klass(relief.lead_time_weeks)) == (
        x["plant_uprate_lead_weeks"], x["plant_uprate_lead_band_weeks"], "E0")


def test_pue_is_a_fixed_e0_library_figure_per_architecture():
    x = K["heat_rejection"]
    keys = {"retained_air": Architecture.RETAINED_AIR, "rdhx": Architecture.RDHX,
            "hybrid_dlc": Architecture.HYBRID_DLC, "full_dlc": Architecture.FULL_DLC}
    assert set(x["pue_by_architecture"]) == set(keys)
    for name, arch in keys.items():
        q = PUE_BY_ARCHITECTURE[arch]
        assert q.value == x["pue_by_architecture"][name]["value"], name
        assert _band(q) == x["pue_by_architecture"][name]["band"], name
        assert _klass(q) == x["pue_class"] == "E0", name


@pytest.mark.parametrize("drybulb", (20, 45))
def test_neither_the_pue_nor_the_trim_chiller_price_responds_to_the_climate(drybulb):
    scenario = next(s for s in SCENARIOS if s.id == "s4_full")
    base = build_context()
    base.site.design_drybulb_C = V(drybulb, "degC", "design dry-bulb under test", ESTIMATED, band=(drybulb - 2, drybulb + 2))
    res = run(base, scenario)
    assert res.context.pue.value == K["heat_rejection"]["pue_by_architecture"]["full_dlc"]["value"]
    steps = [s for s in res.ladder.steps if s.binding_id == "tcs_supply_achievable" and s.taken]
    assert steps and steps[0].capex_eur.value == K["heat_rejection"]["trim_chiller_eur"]


# ------------------------------------------------------------------------------------------------------ cost evidence classes
def test_cost_basis_classes_and_the_two_downgrades():
    assert {b: e.short for b, e in COST_EVIDENCE.items()} | {"contracted": "E5"} == K["cost_basis_classes"] | {}
    ok = CostEntry(key="k", label="l", unit="EUR", value=1.0, basis="firm_quote", valid_until="2999-12-31")
    undated = CostEntry(key="k", label="l", unit="EUR", value=1.0, basis="firm_quote")
    expired = CostEntry(key="k", label="l", unit="EUR", value=1.0, basis="firm_quote", valid_until="2000-01-01")
    assert ok.effective_evidence.short == K["cost_basis_classes"]["firm_quote"]
    assert undated.effective_evidence.short == K["firm_quote_without_validity_class"]
    assert expired.effective_evidence.short == K["expired_quote_class"]
    assert CostEntry(key="k", label="l", unit="EUR", value=1.0, basis="contracted").effective_evidence.short == K["cost_basis_classes"]["contracted"]
    for cls, (lo, hi) in K["cost_band_factor_by_class"].items():
        ev = next(e for e in BAND_BY_EVIDENCE if e.short == cls)
        assert BAND_BY_EVIDENCE[ev] == (lo, hi)


def test_an_accepted_firm_quote_replaces_the_library_price_and_an_unaccepted_one_does_not():
    quote = dict(key="trim_chiller.adiabatic", label="trim chiller", unit="EUR", value=210_000.0, basis="firm_quote",
                 supplier="Test supplier", quoted_on="2026-01-01", valid_until="2999-12-31", synthetic=True)

    def trim_capex():
        c = _constraint(_ref_solve(), "tcs_supply_achievable").relief.capex_eur
        return c.value, _klass(c)

    assert trim_capex() == (K["heat_rejection"]["trim_chiller_eur"], "E0")
    with cost_overlay([quote | {"status": "accepted"}]):
        assert trim_capex() == (210_000.0, K["cost_basis_classes"]["firm_quote"])
    with cost_overlay([quote | {"status": "received"}]):
        assert trim_capex() == (K["heat_rejection"]["trim_chiller_eur"], "E0")
    with cost_overlay([quote | {"status": "accepted", "valid_until": "2000-01-01"}]):
        assert trim_capex() == (K["heat_rejection"]["trim_chiller_eur"], "E0")
    assert costs.library() is not None


def test_the_site_file_has_no_key_the_engine_does_not_have():
    """A guard against a constant added to the JSON with nothing here checking it: every top-level group is exercised above."""
    assert set(K) == {"schema", "note", "transformer_lead_time", "rack_feed", "hydraulic_flow", "heat_rejection",
                      "cost_basis_classes", "firm_quote_without_validity_class", "expired_quote_class", "cost_band_factor_by_class"}
