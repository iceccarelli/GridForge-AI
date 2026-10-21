"""The economics of the paid product: what each cost rests on, what is missing, and whether the total can be trusted.

Every expected figure below is calculated independently in the test (plain arithmetic on the stated inputs), never read
back from the code under test. Tests that need a private cost library write one to a temporary directory and restore
the shipped library afterwards: a confidential quotation is never committed.
"""
import copy
import json
import math
from pathlib import Path

import pytest

from gridforge.constraints import EnvelopeContext
from gridforge.costs import (BASIS_LABEL, CAPACITY_SCALED_KEYS, COST_EVIDENCE, CostEntry, CostLibrary,
                             PUBLISHABLE_BASES, BUNDLED_PATH, basis_of, declared_unit, reload_library, scaled_cost)
from gridforge.envelope.solver import ladder, solve
from gridforge.intake.loader import IntakeError, load_document
from gridforge.power.constraints import busway_ampacity, transformer_capacity, ups_capacity
from gridforge.scenario.run import run_all
from gridforge.serialize import csv_bundle, economics_dict, model_pack
from gridforge.site.constraints import floor_loading
from gridforge.thermal.constraints import architecture_capability, cdu_capacity, plant_capacity, tcs_supply_achievable
from gridforge.thermal.schema import Architecture
from gridforge.validation import EvidenceClass

ROOT = Path(__file__).resolve().parents[1]


def doc(name="dublin_hall"):
    return json.loads((ROOT / "examples" / "intake" / f"{name}.json").read_text())


def scenario(d, scenario_id):
    intake = load_document(copy.deepcopy(d))
    return intake, {r.spec.id: r for r in run_all(intake.context, intake.scenarios)}[scenario_id]


@pytest.fixture
def private_library(tmp_path, monkeypatch):
    """Install a private cost library for one test; the shipped library is restored afterwards."""
    path = tmp_path / "cost_library.local.json"

    def install(entries: list[dict]):
        path.write_text(json.dumps({"entries": entries}))
        monkeypatch.setenv("GRIDFORGE_COST_LIBRARY", str(path))
        return reload_library()

    yield install
    monkeypatch.delenv("GRIDFORGE_COST_LIBRARY", raising=False)
    reload_library()


def quote(key, unit, value, basis="firm_quote", **kw):
    return {"key": key, "label": key, "unit": unit, "value": value, "basis": basis, "supplier": "Test Supplier",
            "quoted_on": "2026-09-01", "valid_until": "2099-12-31", "region": "IE", **kw}


# === 1. cost evidence ===============================================================================================

def test_the_six_kinds_of_cost_evidence_are_distinct_and_ordered():
    wanted = ["library_default", "published_benchmark", "engineering_estimate", "budgetary_quote", "firm_quote",
              "contracted"]
    assert set(wanted) == set(COST_EVIDENCE) == set(BASIS_LABEL)
    assert COST_EVIDENCE["library_default"] < COST_EVIDENCE["published_benchmark"] <= COST_EVIDENCE["engineering_estimate"]
    assert COST_EVIDENCE["budgetary_quote"] < COST_EVIDENCE["firm_quote"] < COST_EVIDENCE["contracted"]
    assert len({BASIS_LABEL[b] for b in wanted}) == 6


def test_the_public_seed_holds_only_what_may_be_published_and_invents_nothing():
    """The shipped library is empty because no figure has been found that names a source, date, region and unit.
    When someone does add one it must be a traceable benchmark; a quotation can never be committed."""
    seed = CostLibrary.load(BUNDLED_PATH)
    assert seed.publishable_violations() == []
    for e in seed.entries.values():
        assert e.basis in PUBLISHABLE_BASES
        if e.basis == "published_benchmark":
            assert e.source and e.quoted_on and e.region
    assert seed.entries == {}, "a seed entry needs a traceable source; none has been established"


@pytest.mark.parametrize("bad", [
    dict(basis="published_benchmark"),                                                  # no source, date or region
    dict(basis="published_benchmark", source="Some Survey", quoted_on="2025-01-01"),   # no geography
    dict(basis="engineering_estimate"),                                                 # no stated basis
    dict(basis="firm_quote", value=0),                                                  # a zero quotation is not a price
    dict(basis="firm_quote", value=float("nan")),
    dict(basis="made_up"),
])
def test_a_cost_entry_that_cannot_name_its_basis_is_refused(bad):
    kw = dict(key="x.y", label="x", unit="EUR", value=10.0)
    kw.update(bad)
    with pytest.raises(ValueError):
        CostEntry(**kw)


def test_a_traceable_benchmark_and_a_reasoned_estimate_are_accepted_and_carry_their_class():
    b = CostEntry(key="x.y", label="x", unit="EUR", value=10.0, basis="published_benchmark",
                  source="Named Survey 2025", quoted_on="2025-06-01", region="EU")
    e = CostEntry(key="x.z", label="x", unit="EUR", value=10.0, basis="engineering_estimate",
                  note="3 days of two engineers at the stated day rate")
    assert b.evidence == COST_EVIDENCE["published_benchmark"] and e.evidence == COST_EVIDENCE["engineering_estimate"]
    assert "Named Survey 2025" in " ".join(str(s) for s in b.quantity().prov.sources)


def test_an_expired_quotation_is_downgraded_to_a_model_figure():
    e = CostEntry(key="x.y", label="x", unit="EUR", value=100.0, basis="firm_quote", supplier="S",
                  quoted_on="2020-01-01", valid_until="2020-06-30")
    assert e.stale and e.quantity().evidence == EvidenceClass.E1_MODEL


def test_every_priced_line_of_a_study_is_a_placeholder_when_the_library_is_empty():
    _, r = scenario(doc("dublin_hall"), "full_dlc_btm")
    assert set(r.economics.cost_basis_mix) == {"library_default"}
    assert r.economics.rests_on_placeholders == sum(r.economics.cost_basis_mix.values()) > 0
    assert not r.economics.decision_grade
    assert any("library placeholders" in x for x in r.economics.limitations)


def test_a_firm_quote_replaces_the_placeholder_and_raises_the_evidence_of_the_total(private_library):
    _, before = scenario(doc("dublin_hall"), "full_dlc_btm")
    private_library([quote("transformer.replacement", "EUR", 700_000.0), quote("ups.per_kW", "EUR/kW", 250.0)])
    _, after = scenario(doc("dublin_hall"), "full_dlc_btm")
    assert basis_of("transformer.replacement") == "firm_quote"
    assert after.economics.cost_basis_mix.get("firm_quote", 0) >= 1
    assert after.economics.rests_on_placeholders < before.economics.rests_on_placeholders


# === 2. capacity-scaled relief prices ===============================================================================

def _ctx(d, arch=Architecture.FULL_DLC) -> EnvelopeContext:
    ctx = load_document(copy.deepcopy(d)).context
    ctx.architecture = arch
    return ctx


def test_transformer_relief_is_priced_per_mva_added_and_scales_with_the_hall():
    small = transformer_capacity(_ctx(doc())).relief
    d = doc()
    d["transformers"][0]["units"] = 6                        # twice the installed MVA
    large = transformer_capacity(_ctx(d)).relief
    # +60% of 3 x 5 MVA = 9 MVA, and of 6 x 5 MVA = 18 MVA; the placeholder is 1.2 MEUR / 9 MVA
    assert small.capex_eur.value == pytest.approx(9 * 1_200_000 / 9)
    assert large.capex_eur.value == pytest.approx(18 * 1_200_000 / 9)
    assert small.cost_kind == large.cost_kind == "per_unit" and "9 MVA added" in small.scope


def test_ups_relief_is_priced_on_the_kw_the_step_actually_adds():
    r = ups_capacity(_ctx(doc())).relief
    assert r.capex_eur.value == pytest.approx(320 * 2 * 1200)       # two 1,200 kW modules to the one block
    d = doc()
    d["ups"][0]["unit_rating_kW"] = 2400
    assert ups_capacity(_ctx(d)).relief.capex_eur.value == pytest.approx(320 * 2 * 2400)


def test_busway_relief_prices_the_runs_it_buys_in_either_form():
    d = doc()
    d["lv"]["busway_ampacity_A"] = 400                         # legacy: every run is replaced
    legacy = busway_ampacity(_ctx(d)).relief
    d["lv"]["busway_ampacity_A"] = 1000                        # modern: the relief adds two runs
    modern = busway_ampacity(_ctx(d)).relief
    runs = d["lv"]["busway_runs"]
    assert legacy.capex_eur.value == pytest.approx(runs * 450_000 / 8)
    assert modern.capex_eur.value == pytest.approx(2 * 450_000 / 8)
    assert "run" in legacy.scope and "run" in modern.scope


def test_plant_and_floor_reliefs_scale_and_the_trim_chiller_is_a_declared_fixed_lump():
    c = _ctx(doc())
    plant = plant_capacity(c).relief
    kW = c.thermal.plant.chilled_water_capacity_kW.value
    assert plant.capex_eur.value == pytest.approx(0.5 * kW * 900_000 / 3400)
    d = doc()
    d["thermal"]["plant"]["chilled_water_capacity_kW"] = 2 * kW
    assert plant_capacity(_ctx(d)).relief.capex_eur.value == pytest.approx(2 * plant.capex_eur.value)

    d = doc()
    d["hall"]["net_white_space_m2"] = 4800
    d["hall"]["floor_loading_kPa"] = 5          # make the floor bind so a relief is offered
    d["hall"]["floor_type"] = "raised_floor"
    floor = floor_loading(_ctx(d)).relief
    assert floor.capex_eur.value == pytest.approx(4800 * 260_000 / 2400)

    c = _ctx(doc())
    c.thermal.tcs_target_supply_C = c.thermal.tcs_target_supply_C.__class__.given(
        20.0, "degC", "target", EvidenceClass.E5_CUSTOMER_DATA)
    trim = tcs_supply_achievable(c).relief
    assert trim.cost_kind == "fixed_site" and "not scaled" in trim.basis_note
    assert trim.capex_eur.value == pytest.approx(350_000)


def test_a_lump_quote_with_a_stated_quantity_is_used_in_proportion_not_charged_again_per_step(private_library):
    """Found by running it: a 2.0 MEUR lump for transformers was charged in full on a 9 MVA step AND on a 14.4 MVA step
    (4.0 MEUR for one quote, and the larger step priced the same as the smaller)."""
    private_library([quote("transformer.replacement", "EUR", 2_340_000.0, quoted_quantity=23.4, quoted_quantity_unit="MVA")])
    _, r = scenario(doc("dublin_hall"), "full_dlc_btm")
    tr = [s for s in r.ladder.taken_steps if s.binding_id == "transformer_capacity"]
    assert [round(s.quantity, 3) for s in tr] == [9.0, 14.4]
    assert [round(s.capex_eur.value) for s in tr] == [round(2_340_000 * 9 / 23.4), round(2_340_000 * 14.4 / 23.4)]
    assert sum(s.capex_eur.value for s in tr) == pytest.approx(2_340_000)        # the quote, once
    # the two steps together are exactly the 23.4 MVA the supplier priced: an allocation of the quote, not a guess
    assert all(s.cost_kind == "quoted_allocation" and not s.limited for s in tr)
    assert not any("limited comparability" in x for x in r.economics.limitations)
    # a hall that needs a different total is NOT covered by that quote: it is scaled, flagged and weaker
    d = doc()
    d["transformers"][0]["unit_rating_MVA"] = 4.0
    _, other = scenario(d, "full_dlc_btm")
    tr2 = [s for s in other.ladder.taken_steps if s.binding_id == "transformer_capacity"]
    assert tr2 and all(s.cost_kind == "quoted_scaled" and s.limited for s in tr2)
    assert any("limited comparability" in x for x in other.economics.limitations)
    assert declared_unit("transformer.replacement") == "EUR"


def test_a_quote_for_exactly_the_quantity_a_step_needs_is_used_as_quoted_and_not_limited(private_library):
    private_library([quote("transformer.replacement", "EUR", 1_800_000.0, quoted_quantity=9.0, quoted_quantity_unit="MVA")])
    small = transformer_capacity(_ctx(doc())).relief
    assert small.capex_eur.value == pytest.approx(1_800_000) and small.cost_kind == "quoted_job_lump"
    assert not small.limited
    d = doc()
    d["transformers"][0]["units"] = 6                                  # a step twice the size: scaled, and flagged
    large = transformer_capacity(_ctx(d)).relief
    assert large.capex_eur.value == pytest.approx(3_600_000) and large.cost_kind == "quoted_scaled" and large.limited
    notes = " ".join(a for n in large.capex_eur.prov.walk() for a in n.assumptions)
    assert "supplier did not quote this size" in notes


def test_a_lump_quote_that_states_no_quantity_is_used_once_per_step_and_is_visibly_limited(private_library):
    private_library([quote("transformer.replacement", "EUR", 2_000_000.0)])
    _, r = scenario(doc("dublin_hall"), "full_dlc_btm")
    tr = [s for s in r.ladder.taken_steps if s.binding_id == "transformer_capacity"]
    assert all(s.cost_kind == "quoted_lump_unstated_quantity" and s.limited for s in tr)
    assert any("limited comparability" in x for x in r.economics.limitations)
    assert not r.economics.decision_grade


def test_a_quote_for_a_different_unit_of_scope_is_refused_not_misapplied(private_library):
    private_library([quote("transformer.replacement", "EUR", 2_000_000.0, quoted_quantity=5.0, quoted_quantity_unit="kW")])
    with pytest.raises(ValueError, match="Re-enter the quotation"):
        transformer_capacity(_ctx(doc()))


def test_a_scaled_quote_is_weaker_than_the_quote_it_came_from(private_library):
    private_library([quote("transformer.replacement", "EUR", 1_800_000.0, quoted_quantity=9.0, quoted_quantity_unit="MVA")])
    d = doc()
    d["transformers"][0]["units"] = 6
    scaled = transformer_capacity(_ctx(d)).relief.capex_eur
    exact = transformer_capacity(_ctx(doc())).relief.capex_eur
    assert exact.evidence == COST_EVIDENCE["firm_quote"] and scaled.evidence < exact.evidence


def test_the_initial_cdu_kit_and_the_ladder_share_one_quotation_in_proportion(private_library):
    """Found by running it: a 540 kEUR quote for 3 CDUs was applied unscaled to the 3-unit kit and to each of five
    1-unit steps, pricing eight CDUs at six times the quoted lump."""
    private_library([quote("cdu.addition", "EUR", 1_440_000.0, quoted_quantity=8.0, quoted_quantity_unit="unit")])
    _, r = scenario(doc("dublin_hall"), "full_dlc_btm")
    steps = [s for s in r.ladder.taken_steps if s.binding_id == "cdu_capacity"]
    assert len(steps) == 5 and r.economics.capex_cdu_kit_eur is not None
    total = sum(s.capex_eur.value for s in steps) + r.economics.capex_cdu_kit_eur.value
    # eight units at 1.44 MEUR / 8 = 180 kEUR each: exactly the quote, once (components still unpriced, so excluded)
    assert total == pytest.approx(1_440_000)


def test_a_cdu_quote_that_includes_commissioning_stops_it_being_reported_unpriced(private_library):
    private_library([quote("cdu.addition", "EUR", 1_440_000.0, quoted_quantity=8.0, quoted_quantity_unit="unit",
                           includes_keys=["cdu.commissioning"])])
    _, r = scenario(doc("dublin_hall"), "full_dlc_btm")
    assert {g["key"] for g in r.economics.unpriced_summary()} == {"cdu.integration"}


def test_a_lump_with_no_quantity_prices_a_cdu_per_step_and_says_so(private_library):
    private_library([quote("cdu.addition", "EUR", 180_000.0)])
    _, r = scenario(doc("dublin_hall"), "full_dlc_btm")
    assert r.economics.limited and any("CDU" in x["where"] or "kit" in x["where"] for x in r.economics.limited)


def test_a_per_unit_library_line_is_multiplied_by_the_quantity_added(private_library):
    private_library([quote("transformer.replacement", "EUR/MVA", 100_000.0, basis="budgetary_quote")])
    r = transformer_capacity(_ctx(doc())).relief
    assert r.capex_eur.value == pytest.approx(900_000)
    assert r.cost_kind == "per_unit"


def test_a_library_line_in_the_wrong_unit_is_refused_not_silently_misapplied(private_library):
    private_library([quote("transformer.replacement", "EUR/kW", 100.0)])
    with pytest.raises(ValueError, match="held in"):
        transformer_capacity(_ctx(doc()))


@pytest.mark.parametrize("qty", [float("nan"), float("inf"), -1.0])
def test_a_nonsense_quantity_cannot_be_priced(qty):
    with pytest.raises(ValueError):
        scaled_cost("transformer.replacement", 1.0, "EUR/MVA", qty, "MVA", "x")


def test_a_zero_quantity_prices_at_zero_because_nothing_is_bought():
    sp = scaled_cost("transformer.replacement", 100.0, "EUR/MVA", 0.0, "MVA", "x")
    assert sp.capex.value == 0.0 and "0 MVA added" in sp.scope


def test_capacity_scaled_keys_are_exactly_the_ones_priced_per_unit_added():
    assert CAPACITY_SCALED_KEYS == {"transformer.replacement", "plant.uprate", "pump.uprate", "busway.replacement",
                                    "floor.load_spreading", "cdu.addition", "ups.per_kW"}


def test_the_ladder_total_is_the_sum_of_its_taken_steps_and_never_double_counts():
    for scen in ("hybrid_dlc", "full_dlc", "full_dlc_btm"):
        _, r = scenario(doc("dublin_hall"), scen)
        steps = sum(s.capex_eur.value for s in r.ladder.taken_steps)
        assert r.economics.capex_relief_eur.value == pytest.approx(steps)
        kit = r.economics.capex_cdu_kit_eur.value if r.economics.capex_cdu_kit_eur is not None else 0.0
        assert r.economics.capex_total_eur.value == pytest.approx(
            r.economics.capex_relief_eur.value + r.economics.capex_conversion_eur.value + kit)


def test_a_relief_that_adds_no_capacity_and_is_not_followed_by_one_that_does_is_not_costed():
    d = doc()
    d["hall"]["positions_available"] = 5          # floor space caps the hall at 5 racks whatever else is relieved
    d["ups"][0]["units"] = 4
    d["transformers"][0]["units"] = 2
    _, r = scenario(d, "full_dlc")
    assert r.unlocked_racks == 5
    trailing = [s for s in r.ladder.steps if not s.taken and s.not_taken_reason.startswith("adds no deployable")]
    assert trailing and all(s.racks_after == s.racks_before for s in trailing)
    assert all(s.taken for s in r.ladder.steps if s.racks_after > s.racks_before)
    assert r.economics.capex_relief_eur.value == pytest.approx(sum(s.capex_eur.value for s in r.ladder.taken_steps))
    last_gain = max(s.step for s in r.ladder.steps if s.taken and s.racks_after > s.racks_before)
    assert all(s.step > last_gain for s in trailing)


def test_a_tied_constraint_before_a_gaining_step_is_kept_and_costed():
    _, r = scenario(doc("reference_hall"), "full_dlc")
    zero = [s for s in r.ladder.taken_steps if s.racks_after == s.racks_before]
    later_gain = max(s.step for s in r.ladder.taken_steps if s.racks_after > s.racks_before)
    assert zero and all(s.step < later_gain for s in zero)


# === 3. CDUs: priced completely or reported incomplete =============================================================

def test_without_a_cdu_schedule_the_assumed_kit_is_capex_not_a_free_gift():
    intake, r = scenario(doc("dublin_hall"), "full_dlc")
    e = r.economics
    assert [c.installed for c in r.ladder.initial_context.thermal.cdus] == [False]
    assert e.capex_cdu_kit_eur is not None
    assert e.capex_cdu_kit_eur.value == pytest.approx(3 * 180_000)          # 3 x 1,350 kW N+1 units, placeholder
    assert "3 CDU unit(s)" in e.cdu_kit_scope
    assert "thermal.cdus" in [g.path for g in intake.report.gaps]


def test_cdu_units_are_counted_once_across_the_kit_and_the_ladder():
    _, r = scenario(doc("dublin_hall"), "full_dlc_btm")
    added = sum(1 for s in r.ladder.taken_steps if s.binding_id == "cdu_capacity")
    kit_units = 3
    summary = {g["key"]: g for g in r.economics.unpriced_summary()}
    assert summary["cdu.commissioning"]["quantity"] == pytest.approx(kit_units + added)
    placeholder_cdu_cost = (kit_units + added) * 180_000
    ladder_cdu = sum(s.capex_eur.value for s in r.ladder.taken_steps if s.binding_id == "cdu_capacity")
    assert ladder_cdu + r.economics.capex_cdu_kit_eur.value == pytest.approx(placeholder_cdu_cost)


def test_a_supplied_cdu_schedule_means_no_kit_is_bought():
    d = doc("dublin_hall")
    d["thermal"]["cdus"] = [{"id": "CDU-A", "rated_capacity_kW": 1350, "units": 3, "redundancy": "N+1"}]
    intake, r = scenario(d, "full_dlc")
    assert r.economics.capex_cdu_kit_eur is None and r.economics.cdu_kit_scope == ""
    assert all(c.installed for c in r.ladder.initial_context.thermal.cdus)
    assert "thermal.cdus" not in [g.path for g in intake.report.gaps]


def test_without_installation_and_commissioning_prices_the_total_says_it_is_a_lower_bound():
    _, r = scenario(doc("dublin_hall"), "full_dlc")
    e = r.economics
    assert not e.capex_complete and not e.decision_grade
    keys = {g["key"] for g in e.unpriced_summary()}
    assert keys == {"cdu.integration", "cdu.commissioning"}
    assert any("LOWER BOUND" in x and "CDU commissioning" in x for x in e.limitations)
    assert all(s.unpriced for s in r.ladder.taken_steps if s.binding_id == "cdu_capacity")


def test_pricing_the_components_completes_the_capex_exactly_and_counts_nothing_twice(private_library):
    _, bare = scenario(doc("dublin_hall"), "full_dlc")
    units = sum(g["quantity"] for g in bare.economics.unpriced_summary() if g["key"] == "cdu.commissioning")
    private_library([quote("cdu.integration", "EUR/unit", 20_000.0, basis="budgetary_quote"),
                     quote("cdu.commissioning", "EUR/unit", 8_000.0, basis="budgetary_quote")])
    _, full = scenario(doc("dublin_hall"), "full_dlc")
    e = full.economics
    assert e.unpriced == [] and e.capex_complete
    assert e.capex_total_eur.value == pytest.approx(bare.economics.capex_total_eur.value + units * 28_000)
    assert all(not s.unpriced for s in full.ladder.taken_steps)


def test_a_lump_quote_for_cdu_installation_is_used_as_the_price_of_the_job(private_library):
    private_library([quote("cdu.integration", "EUR", 50_000.0), quote("cdu.commissioning", "EUR", 30_000.0)])
    _, r = scenario(doc("dublin_hall"), "full_dlc")
    assert r.economics.capex_complete
    cdu_steps = [s for s in r.ladder.taken_steps if s.binding_id == "cdu_capacity"]
    assert cdu_steps and all(s.capex_eur.value == pytest.approx(180_000 * 1 + 80_000) for s in cdu_steps)


def test_liquid_scenarios_that_host_nothing_buy_no_cdus():
    d = doc("dublin_hall")
    d["hall"]["positions_available"] = 0
    _, r = scenario(d, "full_dlc")
    assert r.unlocked_racks == 0 and r.economics.capex_cdu_kit_eur is None and r.economics.unpriced == []


# === 4. behind-the-meter operating economics =======================================================================

def test_btm_operating_cost_matches_an_independent_calculation():
    intake, r = scenario(doc("dublin_hall"), "full_dlc_btm")
    e = r.economics
    assert e.btm.applied and e.opex_complete
    site_MWh = e.annual_energy_MWh.value
    generated = 8.0 * 6000                                   # MW x equivalent full-load hours
    used = min(generated, site_MWh)
    variable = used * 110
    fixed = 8000 * 18
    grid = (site_MWh - used) * 125
    assert e.btm.generated_MWh.value == pytest.approx(generated)
    assert e.btm.variable_eur.value == pytest.approx(variable)
    assert e.btm.fixed_eur.value == pytest.approx(fixed)
    assert e.annual_grid_energy_cost_eur.value == pytest.approx(grid)
    assert e.annual_energy_cost_eur.value == pytest.approx(grid + variable + fixed)
    assert e.tariff_declared and e.tariff_eur_per_MWh.value == 125


def test_lifecycle_cost_states_its_horizon_discounting_and_matches_the_annuity_formula():
    _, r = scenario(doc("dublin_hall"), "full_dlc_btm")
    e = r.economics
    annual, capex, n, rate = e.annual_energy_cost_eur.value, e.capex_total_eur.value, 10, 0.08
    assert e.lifecycle_cost_eur.value == pytest.approx(capex + annual * (1 - (1 + rate) ** -n) / rate)
    assert "discounted at 8.0%" in e.lifecycle_basis and "no escalation" in e.lifecycle_basis
    assert not e.lifecycle_complete                 # capex still has unpriced CDU components

    d = doc("dublin_hall")
    del d["economics"]["discount_rate"]
    _, und = scenario(d, "full_dlc_btm")
    assert und.economics.lifecycle_cost_eur.value == pytest.approx(
        und.economics.capex_total_eur.value + 10 * und.economics.annual_energy_cost_eur.value)
    assert "undiscounted" in und.economics.lifecycle_basis


def test_no_declared_horizon_means_no_lifecycle_value_never_an_invented_one():
    d = doc("dublin_hall")
    del d["economics"]["horizon_years"]
    _, r = scenario(d, "full_dlc_btm")
    assert r.economics.lifecycle_cost_eur is None and r.economics.horizon_years is None
    assert any(x.startswith("no lifecycle horizon") for x in r.economics.limitations)
    assert "economics.horizon_years" in [g.path for g in load_document(d).report.gaps]


def test_missing_btm_inputs_withhold_the_figure_and_say_exactly_what_is_missing():
    d = doc("dublin_hall")
    for k in ("annual_run_hours", "fixed_om_eur_per_kW_year"):
        del d["btm_options"][0][k]
    _, r = scenario(d, "full_dlc_btm")
    e = r.economics
    assert not e.btm.applied and not e.opex_complete and not e.decision_grade
    assert any("annual_run_hours not declared" in m for m in e.btm.missing)
    assert any("fixed_om_eur_per_kW_year not declared" in m for m in e.btm.missing)
    # nothing partial is applied: the whole energy bill is priced at the tariff, and the report says so
    assert e.annual_energy_cost_eur.value == pytest.approx(e.annual_energy_MWh.value * 125)
    assert any("no usable operating cost" in x for x in e.limitations)


def test_the_fuel_route_computes_cost_per_mwh_as_price_over_efficiency_plus_variable_om():
    d = doc("dublin_hall")
    opt = d["btm_options"][0]
    del opt["opex_eur_per_MWh"]
    opt.update(fuel_price_eur_per_MWh=40.0, electrical_efficiency=0.4, variable_om_eur_per_MWh=10.0)
    _, r = scenario(d, "full_dlc_btm")
    b = r.economics.btm
    assert b.applied
    assert b.options[0]["cost_eur_per_MWh"] == pytest.approx(40 / 0.4 + 10)
    assert b.variable_eur.value == pytest.approx(min(48000, r.economics.annual_energy_MWh.value) * 110)


def test_fuel_route_without_variable_om_is_incomplete_not_assumed_zero():
    d = doc("dublin_hall")
    opt = d["btm_options"][0]
    del opt["opex_eur_per_MWh"]
    opt.update(fuel_price_eur_per_MWh=40.0, electrical_efficiency=0.4)
    _, r = scenario(d, "full_dlc_btm")
    assert not r.economics.btm.applied
    assert any("variable_om_eur_per_MWh not declared" in m for m in r.economics.btm.missing)


def test_declaring_both_an_all_in_cost_and_a_fuel_route_is_refused_because_the_fuel_would_be_counted_twice():
    d = doc("dublin_hall")
    d["btm_options"][0].update(fuel_price_eur_per_MWh=40.0, electrical_efficiency=0.4)
    with pytest.raises(IntakeError, match="counted twice"):
        load_document(d)
    d = doc("dublin_hall")
    del d["btm_options"][0]["opex_eur_per_MWh"]
    d["btm_options"][0]["fuel_price_eur_per_MWh"] = 40.0
    with pytest.raises(IntakeError, match="only meaningful together"):
        load_document(d)


@pytest.mark.parametrize("field,value", [
    ("annual_run_hours", 9000), ("annual_run_hours", -1), ("annual_run_hours", float("nan")),
    ("fixed_om_eur_per_kW_year", -5), ("electrical_efficiency", 0), ("electrical_efficiency", 1.2),
])
def test_btm_operating_inputs_are_validated(field, value):
    d = doc("dublin_hall")
    d["btm_options"][0][field] = value
    if field == "electrical_efficiency":
        del d["btm_options"][0]["opex_eur_per_MWh"]
        d["btm_options"][0]["fuel_price_eur_per_MWh"] = 40.0
    with pytest.raises(IntakeError):
        load_document(d)


def test_generation_above_site_demand_is_capped_and_not_valued():
    from gridforge.economics.model import _btm_opex
    from gridforge.common import ESTIMATED, V
    opt = load_document(doc("dublin_hall")).context.power.options[0]
    opt.installed = True                                       # 8 MW x 6,000 h = 48,000 MWh generated
    demand = V(30_000.0, "MWh", "site energy", ESTIMATED)
    b = _btm_opex([opt], demand)
    assert b.applied and b.curtailed
    assert b.generated_MWh.value == pytest.approx(48_000)
    assert b.used_MWh.value == pytest.approx(30_000)           # only what the hall consumes is valued
    assert b.variable_eur.value == pytest.approx(30_000 * 110)
    assert b.fixed_eur.value == pytest.approx(8000 * 18)       # the plant is owned in full either way


def test_grid_only_scenarios_have_no_btm_block_and_price_all_energy_at_the_tariff():
    _, r = scenario(doc("dublin_hall"), "full_dlc")
    assert r.economics.btm is None and r.economics.opex_complete
    assert r.economics.annual_energy_cost_eur.value == pytest.approx(r.economics.annual_energy_MWh.value * 125)


@pytest.mark.parametrize("bad", [0, -10, float("nan")])
def test_the_declared_tariff_must_be_positive_and_finite(bad):
    d = doc("dublin_hall")
    d["economics"]["electricity_eur_per_MWh"] = bad
    with pytest.raises(IntakeError):
        load_document(d)


@pytest.mark.parametrize("path,value", [("horizon_years", 0), ("horizon_years", 51), ("horizon_years", 2.5),
                                        ("discount_rate", -0.1), ("discount_rate", 0.5)])
def test_horizon_and_discount_rate_are_validated(path, value):
    d = doc("dublin_hall")
    d["economics"][path] = value
    with pytest.raises(IntakeError):
        load_document(d)


# === 5. rear-door heat exchanger capacity ============================================================================

def _arch_gate(ctx):
    return architecture_capability(ctx)


def test_the_rdhx_default_is_a_labelled_assumption_in_the_gap_ledger():
    d = doc("reference_hall")
    intake = load_document(d)
    assert intake.context.thermal.rdhx is None
    assert "thermal.rdhx.capacity_kW_per_rack" in [g.path for g in intake.report.gaps]
    ctx = intake.context
    ctx.architecture = Architecture.RDHX
    res = _arch_gate(ctx)
    assert "library default" in res.basis and "not a manufacturer's rating" in res.basis
    assert res.max_racks.value == 0                      # 60 kW does not carry a 135 kW rack


def test_a_declared_rdhx_rating_changes_what_the_rear_door_scenario_can_host():
    d = doc("reference_hall")
    d["thermal"]["rdhx"] = {"capacity_kW_per_rack": {"value": 150, "evidence": "E5",
                                                      "note": "datasheet rating at the site's water temperature"}}
    intake = load_document(d)
    assert intake.context.thermal.rdhx.capacity_kW_per_rack.value == 150
    assert "thermal.rdhx.capacity_kW_per_rack" not in [g.path for g in intake.report.gaps]
    ctx = intake.context
    ctx.architecture = Architecture.RDHX
    res = _arch_gate(ctx)
    assert math.isinf(res.max_racks.value) and "client's declared rear-door rating" in res.basis
    # and it flows through the whole scenario: the gate no longer binds the rdhx scenario
    result = {r.spec.id: r for r in run_all(intake.context, intake.scenarios)}["rdhx"]
    assert result.envelope.binding.id != "architecture_capability"


def test_a_declared_rating_below_the_rack_still_fails_the_gate_honestly():
    d = doc("reference_hall")
    d["thermal"]["rdhx"] = {"capacity_kW_per_rack": 90}
    ctx = load_document(d).context
    ctx.architecture = Architecture.RDHX
    assert _arch_gate(ctx).max_racks.value == 0


@pytest.mark.parametrize("bad", [0, -20, float("nan"), float("inf"), 250, "abc"])
def test_rdhx_capacity_is_validated(bad):
    d = doc("reference_hall")
    d["thermal"]["rdhx"] = {"capacity_kW_per_rack": bad}
    with pytest.raises(IntakeError):
        load_document(d)


def test_the_rdhx_rating_applies_only_to_the_rdhx_architecture():
    d = doc("reference_hall")
    d["thermal"]["rdhx"] = {"capacity_kW_per_rack": 150}
    ctx = load_document(d).context
    ctx.architecture = Architecture.FULL_DLC
    assert "rear-door" not in _arch_gate(ctx).basis


# === 6. consistency across every consumer ===========================================================================

def test_the_model_pack_the_csvs_and_the_reports_tell_the_same_economic_story():
    intake, results = load_document(doc("dublin_hall")), None
    results = run_all(intake.context, intake.scenarios)
    pack = model_pack(intake, results)
    bundle = csv_bundle(intake, results)
    import csv, io
    econ_rows = list(csv.DictReader(io.StringIO(bundle["economics.csv"])))
    for r in results:
        d = next(s for s in pack["scenarios"] if s["id"] == r.spec.id)["economics"]
        assert d["capex_complete"] == r.economics.capex_complete
        assert d["decision_grade"] == r.economics.decision_grade
        assert d["limitations"] == r.economics.limitations
        total = next(x for x in econ_rows if x["scenario_id"] == r.spec.id and x["item"] == "capex: total")
        assert float(total["value"]) == pytest.approx(r.economics.capex_total_eur.rounded())
        comp = [x for x in econ_rows if x["scenario_id"] == r.spec.id and x["item"].startswith("capex:")
                and x["item"] != "capex: total"]
        assert sum(float(x["value"]) for x in comp) == pytest.approx(float(total["value"]), rel=1.5e-2)  # components are printed to three significant figures
        assert d["unpriced_components"] == r.economics.unpriced
    unpriced_csv = list(csv.DictReader(io.StringIO(bundle["unpriced_components.csv"])))
    assert {u["library_key"] for u in unpriced_csv if u["library_key"]} >= {"cdu.integration", "cdu.commissioning"}
    ladder_rows = list(csv.DictReader(io.StringIO(bundle["headroom_ladder.csv"])))
    assert {"cost_kind", "scope", "cost_basis", "unpriced_components", "not_taken_reason"} <= set(ladder_rows[0])


def test_the_study_says_lower_bound_exactly_when_the_capex_is_incomplete(tmp_path):
    import subprocess, sys
    for name, expect_lb in (("dublin_hall", True),):
        out = tmp_path / name
        r = subprocess.run([sys.executable, "-m", "gridforge", "study", str(ROOT / "examples" / "intake" / f"{name}.json"),
                            "-o", str(out)], capture_output=True, text=True, cwd=ROOT)
        assert r.returncode == 0, r.stderr
        md = (out / "envelope_study.md").read_text()
        board = (out / "board_summary.md").read_text()
        assert ("LOWER BOUND" in md) == expect_lb and ("LOWER BOUND" in board) == expect_lb
        assert "NOT PRICED — CDU commissioning" in md
        assert "Recurring cost (recommended architecture)" in md
        assert "not decision-grade" in md


def test_a_fully_priced_estimate_is_not_called_a_lower_bound(private_library, tmp_path):
    private_library([quote("cdu.integration", "EUR/unit", 20_000.0), quote("cdu.commissioning", "EUR/unit", 8_000.0)])
    intake = load_document(doc("dublin_hall"))
    results = run_all(intake.context, intake.scenarios)
    rec = {r.spec.id: r for r in results}["full_dlc"]
    assert rec.economics.capex_complete and not any("LOWER BOUND" in x for x in rec.economics.limitations)
    from gridforge.reporting import to_markdown
    from gridforge.reporting.study import build
    md = to_markdown(build(intake.context, results, client="t"))
    assert "NOT PRICED" not in md.split("## 10.")[0].split("## 9.")[1]


def test_the_api_screen_payload_carries_the_same_economics(monkeypatch):
    from gridforge.api.server import handle_screen
    from gridforge.api.tiers import Tier
    out = handle_screen({"intake": doc("dublin_hall")}, Tier.CLIENT)
    sc = {s["id"]: s for s in out["scenarios"]}["full_dlc_btm"]
    assert sc["economics"]["capex_complete"] is False
    assert sc["economics"]["btm_operating_cost"]["applied"] is True
    assert sc["economics"]["lifecycle"]["horizon_years"] == 10
    assert any(s["cost_kind"] == "per_unit" and s["scope"] for s in sc["ladder"] if s["taken"])


def test_the_public_qualifier_discloses_no_economics_and_no_economics_questions():
    from gridforge.api.server import handle_qualify
    from gridforge.api.tiers import Tier
    out = handle_qualify({"site_name": "T", "metro": "X", "contracted_MW": 12, "current_site_peak_MW": 7.4,
                          "current_it_load_MW": 4.9, "busway_ampacity_A": 400, "tapoff_max_A": 63,
                          "plant_supply_C": 6, "positions_available": 180}, Tier.PUBLIC)
    blob = json.dumps(out)
    assert "EUR" not in blob and "economics." not in blob


def test_the_published_reference_never_carries_a_confidential_basis():
    pack = json.loads((ROOT / "public" / "reference" / "model_pack.json").read_text())
    for sc in pack["scenarios"]:
        assert set(sc["economics"]["cost_basis_mix"]) <= PUBLISHABLE_BASES
    assert "decision_grade" in pack["scenarios"][0]["economics"]


@pytest.mark.parametrize("name", ["reference_hall", "dublin_hall", "nordic_hall", "london_hall"])
def test_every_reference_scenario_still_solves_and_reconciles(name):
    intake = load_document(doc(name))
    for r in run_all(intake.context, intake.scenarios):
        e = r.economics
        assert math.isfinite(e.capex_total_eur.value) and e.capex_total_eur.value >= 0
        if r.unlocked_racks == 0:
            assert not r.ladder.taken_steps and e.capex_cdu_kit_eur is None
        lo, hi = e.capex_total_eur.band
        assert lo <= e.capex_total_eur.value <= hi
        # A scenario that deploys nothing has no capex to state (n/a), so it is never 'complete' at 0 EUR.
        assert e.capex_complete == (not e.unpriced and all(s.capex_eur is not None for s in r.ladder.taken_steps)
                                    and not e.nothing_deployable)


def test_the_cli_never_reads_cleaner_than_the_report():
    import subprocess, sys, tempfile
    with tempfile.TemporaryDirectory() as d:
        r = subprocess.run([sys.executable, "-m", "gridforge", "study", str(ROOT / "examples" / "intake" / "dublin_hall.json"),
                            "-o", d], capture_output=True, text=True, cwd=ROOT)
        assert r.returncode == 0 and "ECONOMICS: not decision-grade" in r.stdout and "LOWER BOUND" in r.stdout
        r = subprocess.run([sys.executable, "-m", "gridforge", "screen", str(ROOT / "examples" / "intake" / "dublin_hall.json"),
                            "-o", d], capture_output=True, text=True, cwd=ROOT)
        assert "ECONOMICS: not decision-grade" in r.stdout


def test_the_cost_cli_enforces_what_each_basis_must_name(tmp_path):
    import subprocess, sys
    lib = tmp_path / "lib.json"

    def add(*a):
        return subprocess.run([sys.executable, "-m", "gridforge", "cost", "add", "--library", str(lib), "--key", "k.x",
                               "--unit", "EUR", "--value", "100", *a], capture_output=True, text=True, cwd=ROOT)

    assert add("--basis", "published_benchmark").returncode == 2
    assert add("--basis", "published_benchmark", "--source", "S", "--quoted-on", "2025-01-01").returncode == 2
    assert add("--basis", "engineering_estimate").returncode == 2
    assert add("--basis", "firm_quote", "--supplier", "S").returncode == 2
    ok = add("--basis", "published_benchmark", "--source", "Named Survey", "--quoted-on", "2025-01-01",
             "--region", "EU")
    assert ok.returncode == 0, ok.stderr
    assert add("--basis", "engineering_estimate", "--note", "two engineers, three days").returncode == 0
    refused = subprocess.run([sys.executable, "-m", "gridforge", "cost", "add", "--bundled", "--key", "k.y",
                              "--unit", "EUR", "--value", "5", "--basis", "engineering_estimate", "--note", "n"],
                             capture_output=True, text=True, cwd=ROOT)
    assert refused.returncode == 2, "an estimate is not publishable; only placeholders and benchmarks reach the seed"
