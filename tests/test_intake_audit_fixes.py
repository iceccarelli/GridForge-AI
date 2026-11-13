"""Regression tests for the two independent audits of the intake loader (2026-11-13): each item below FAILS on the loader as it was before.

N5   a temperature with no lower bound: a sign slip (-26 for 26) silently passed the water gate.
N6   economics inputs with no ceiling: 1e308 EUR/kW/yr of fixed O&M made the annual cost `Infinity`, which is not JSON.
N7   a required figure declared an assumption (E0) still read as complete: `can_issue_a_study: true`, "no required inputs are missing".
N8   the assumptions behind the water gate were unlisted, and the dry-cooler approach could not be supplied.
N12  `scenarios: "rdhx"` was read as a list of letters.
N13  the command line read the LAST of two equal keys; the API refuses the document.
N2   a bank of zero units reached the arithmetic.
J1-2 the recommendation shown to buyers was written to the seller ("Sell the Density Screen instead", "1 required inputs missing").
J1-7 the refusal for a firm capacity DERIVED from the contract named a field the caller never sent.
J2-4 a typo'd top-level section was silently ignored.
J2-5 the command line solved a blank template.
"""
from __future__ import annotations

import copy
import inspect
import json
import re
from pathlib import Path

import pytest

from gridforge.api import server as S
from gridforge.api.tiers import Tier
from gridforge.intake.loader import IntakeError, load, load_document
from gridforge.scenario.run import run_all

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ROOT / "examples" / "intake"


def example(name: str) -> dict:
    return json.loads((EXAMPLES / f"{name}.json").read_text())


DUBLIN = example("dublin_hall")


def doc(**dotted) -> dict:
    """The Dublin hall with dotted-path edits (a value of `...` deletes the key)."""
    d = copy.deepcopy(DUBLIN)
    for path, value in dotted.items():
        parts = path.split(".")
        cur = d
        for p in parts[:-1]:
            cur = cur[int(p)] if isinstance(cur, list) else cur.setdefault(p, {})
        if value is ...:
            cur.pop(parts[-1], None)
        elif isinstance(cur, list):
            cur[int(parts[-1])] = value
        else:
            cur[parts[-1]] = value
    return d


def refusal(d: dict) -> str:
    with pytest.raises(IntakeError) as exc:
        load_document(d)
    return str(exc.value)


def racks_by_scenario(d: dict) -> dict[str, int]:
    it = load_document(d)
    return {r.spec.id: r.envelope.max_racks for r in run_all(it.context, it.scenarios)}


# ======================================================================================================================================== N5
_FLOORS = [("site.design_drybulb_C", 0, 60), ("site.design_wetbulb_C", 0, 45), ("thermal.plant.design_supply_C", -5, 40),
           ("thermal.plant.design_return_C", -5, 60), ("thermal.tcs_target_supply_C", 0, 80)]


@pytest.mark.parametrize("path,low,high,bad", [(p, lo, hi, bad) for p, lo, hi in _FLOORS for bad in (lo - 0.5, -26, -273.15, -500, -1e300) if bad < lo])
def test_n5_a_temperature_below_its_floor_is_refused_by_field_name_with_the_allowed_range(path, low, high, bad):
    """Before: -26 for a summer dry bulb of 26 loaded, and -1e300 too. A refusal names the field the caller sent and the range that is allowed."""
    text = refusal(doc(**{path: bad}))
    assert path in text and f"{low:g} to {high:g}" in text


@pytest.mark.parametrize("path,floor", [("site.design_drybulb_C", 0), ("site.design_wetbulb_C", 0), ("thermal.plant.design_supply_C", -5),
                                        ("thermal.tcs_target_supply_C", 0)])
def test_n5_a_temperature_exactly_at_its_floor_is_accepted(path, floor):
    load_document(doc(**{path: floor}))


def test_n5_the_sign_slip_that_passed_the_water_gate_is_refused():
    """Dublin on full DLC: dry bulb 26 binds the water gate (0 racks). With the sign lost it was 13 racks, and -1e300 was accepted."""
    assert racks_by_scenario(doc(**{"site.design_drybulb_C": 26}))["full_dlc"] == 0
    assert "site.design_drybulb_C" in refusal(doc(**{"site.design_drybulb_C": -26}))


def test_n5_no_temperature_is_below_absolute_zero():
    from gridforge.intake.loader import _floor
    with pytest.raises(IntakeError, match="absolute zero"):
        _floor(-300.0, "some.temperature_C", "some temperature", "degC")
    assert _floor(-273.15, "some.temperature_C", "some temperature", "degC") == -273.15
    assert _floor(-300.0, "some.length_m", "some length", "m") == -300.0        # only a temperature has absolute zero


# ======================================================================================================================================== N6
def _engine(**kw) -> dict:
    """The Dublin gas engine on the fuel route (fuel price and efficiency, not the all-in opex), with edits."""
    base = {"id": "GEN-8MW", "kind": "gas_engine", "capacity_MW": 8, "capex_eur_per_kW": 820, "lead_time_weeks": 56, "firm": True,
            "fuel_price_eur_per_MWh": 40, "electrical_efficiency": 0.4, "variable_om_eur_per_MWh": 5, "annual_run_hours": 6000,
            "fixed_om_eur_per_kW_year": 18, "units": 3, "redundancy": "N+1"}
    base.update(kw)
    d = copy.deepcopy(DUBLIN)
    d["btm_options"] = [base]
    return d


@pytest.mark.parametrize("key,ceiling", [("fuel_price_eur_per_MWh", 5000), ("variable_om_eur_per_MWh", 5000), ("fixed_om_eur_per_kW_year", 5000)])
@pytest.mark.parametrize("excess", ["just above", "1e9", "1e308"])
def test_n6_an_economics_input_above_its_ceiling_is_refused_by_option_and_field(key, ceiling, excess):
    """Before: fixed O&M of 1e9 EUR/kW/yr gave an annual cost of 8e12 EUR, and 1e308 made it infinite."""
    text = refusal(_engine(**{key: {"just above": ceiling * 1.0001, "1e9": 1e9, "1e308": 1e308}[excess]}))
    assert f"btm_options[GEN-8MW].{key}" in text and f"{ceiling:g}" in text


@pytest.mark.parametrize("key,ceiling", [("fuel_price_eur_per_MWh", 5000), ("variable_om_eur_per_MWh", 5000), ("fixed_om_eur_per_kW_year", 5000)])
def test_n6_an_economics_input_at_its_ceiling_is_accepted(key, ceiling):
    load_document(_engine(**{key: ceiling}))


@pytest.mark.parametrize("value", [5000.5, 1e12, 1e308])
def test_n6_the_grid_tariff_has_a_ceiling_too(value):
    text = refusal(doc(**{"economics.electricity_eur_per_MWh": value}))
    assert "economics.electricity_eur_per_MWh" in text and "5000" in text
    load_document(doc(**{"economics.electricity_eur_per_MWh": 5000}))


@pytest.mark.parametrize("value", [1e-300, 0.01, 0.049])
def test_n6_a_generator_efficiency_that_is_no_generator_is_refused_because_the_fuel_cost_divides_by_it(value):
    """A tiny positive fraction passed `0 < x <= 1` and made the annual cost infinite (`Infinity` in the answer)."""
    text = refusal(_engine(electrical_efficiency=value))
    assert "btm_options[GEN-8MW].electrical_efficiency" in text and "0.05 to 1" in text
    load_document(_engine(electrical_efficiency=0.05))


def test_n6_every_economics_input_at_its_ceiling_still_answers_in_valid_json():
    d = _engine(fuel_price_eur_per_MWh=5000, variable_om_eur_per_MWh=5000, fixed_om_eur_per_kW_year=5000, electrical_efficiency=0.05)
    d["economics"] = {"electricity_eur_per_MWh": 5000, "horizon_years": 50, "discount_rate": 0.0}
    out = S.handle_screen({"intake": d}, Tier.CLIENT)
    json.dumps(out, allow_nan=False)                  # raises on Infinity / NaN


# ======================================================================================================================================== N7
def _annotate(d: dict, path: str, evidence: str) -> bool:
    cur = d
    parts = path.split(".")
    for p in parts[:-1]:
        cur = cur.get(p) if isinstance(cur, dict) else None
        if cur is None:
            return False
    v = cur.get(parts[-1])
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        cur[parts[-1]] = {"value": v, "evidence": evidence, "note": "template value"}
        return True
    return False


def _required_numeric_paths() -> list[str]:
    from gridforge.intake.schema import INTAKE_FIELDS
    return [f.path for f in INTAKE_FIELDS if f.required and _annotate(copy.deepcopy(DUBLIN), f.path, "E0")]


def test_n7_every_required_numeric_figure_declared_assumed_is_open():
    from gridforge.intake.schema import INTAKE_FIELDS
    plain = load_document(DUBLIN).report
    d = copy.deepcopy(DUBLIN)
    paths = [f.path for f in INTAKE_FIELDS if f.required and _annotate(d, f.path, "E0")]
    assert len(paths) == 10
    rep = load_document(d).report
    assert plain.can_issue and not rep.can_issue
    assert [g.path for g in rep.declared_assumed_gaps] == paths or sorted(g.path for g in rep.declared_assumed_gaps) == sorted(paths)
    assert rep.completeness == plain.completeness            # the ratio counts what was SENT, and is unchanged
    assert rep.required_gaps == plain.required_gaps == []      # none is MISSING: the count of missing inputs is unchanged too
    text = rep.engagement_recommendation
    assert "No required inputs are missing" not in text and "supports a full" not in text
    assert "declared as assumptions (class E0)" in text and "10 required inputs" in text


def test_n7_each_declared_figure_is_a_named_gap_row_in_the_data_request():
    d = doc()
    _annotate(d, "grid.contracted_MW", "E0")
    rep = load_document(d).report
    (row,) = rep.declared_assumed_gaps
    assert row.path == "grid.contracted_MW" and row.required and row.declared_assumption
    assert "declared as an assumption (E0)" in row.fallback_description and row.how_to_get_it and row.why_it_binds
    assert row in rep.gaps
    assert "1 required input was sent but declared as an assumption" in rep.engagement_recommendation and "(Contracted capacity)" in rep.engagement_recommendation


def test_n7_the_integer_figure_read_through_raw_counts_too():
    d = doc()
    _annotate(d, "hall.positions_available", "E0")
    rep = load_document(d).report
    assert [g.path for g in rep.declared_assumed_gaps] == ["hall.positions_available"] and not rep.can_issue


@pytest.mark.parametrize("evidence", ["E1", "E2", "E3", "E4", "E5"])
def test_n7_a_required_figure_declared_above_an_assumption_is_not_open(evidence):
    d = doc()
    _annotate(d, "grid.contracted_MW", evidence)
    rep = load_document(d).report
    assert rep.can_issue and rep.declared_assumed_gaps == []


def test_n7_an_optional_figure_declared_assumed_is_not_a_required_input():
    d = doc()
    _annotate(d, "grid.power_factor", "E0")
    rep = load_document(d).report
    assert rep.can_issue and rep.declared_assumed_gaps == []


def test_n7_a_figure_the_route_derived_is_not_the_callers_declaration():
    """The qualifier derives the firm capacity from the contract and annotates it E0 with a note that says so; the route records its own gap row for it."""
    d = doc()
    d["grid"]["firm_capacity_MVA"] = {"value": 10.3, "evidence": "E0", "note": "Derived by the qualifier as contracted_MW / 0.97 ..."}
    assert load_document(d).report.declared_assumed_gaps == []


def test_n7_the_screen_and_the_model_pack_say_the_same():
    d = copy.deepcopy(DUBLIN)
    for p in ("grid.contracted_MW", "lv.tapoff_max_A"):
        _annotate(d, p, "E0")
    out = S.handle_screen({"intake": d}, Tier.CLIENT)["intake"]
    assert out["can_issue_a_study"] is False
    assert "declared as" in out["recommended_engagement"] and "No required inputs are missing" not in out["recommended_engagement"]
    declared = [g for g in out["gaps"] if "declared as an assumption" in g["assumed"]]
    assert sorted(g["input"] for g in declared) == ["Contracted capacity", "Installed tap-off rating"]
    from gridforge.serialize import model_pack
    it = load_document(d)
    assert model_pack(it, run_all(it.context, it.scenarios))["intake"]["can_issue"] is False


def test_n7_the_free_qualifier_with_every_figure_declared_assumed_is_open_but_counts_what_it_counted():
    """completeness and required_inputs_missing are pinned (tests/test_qualify_assumed.py); can_issue_a_study and the recommendation are not."""
    body = json.loads((ROOT / "public" / "reference" / "examples" / "qualify-request.json").read_text())
    plain = S.handle_qualify(dict(body), Tier.PUBLIC)["intake"]
    declared = S.handle_qualify({**body, "assumed_fields": list(S.QUALIFY_FIELDS)}, Tier.PUBLIC)["intake"]
    assert declared["completeness"] == plain["completeness"] and declared["required_inputs_missing"] == plain["required_inputs_missing"]
    assert declared["can_issue_a_study"] is False and "declared as" in declared["recommended_engagement"]


# ======================================================================================================================================== N8
def _gap(rep, path: str):
    return next((g for g in rep.gaps if g.path == path), None)


def test_n8_the_cdu_approach_is_a_named_optional_gap_and_the_default_is_labelled():
    rep = load_document(DUBLIN).report
    g = _gap(rep, "thermal.cdu_approach_K")
    assert g is not None and not g.required and g.how_to_get_it and g.why_it_binds
    assert g.fallback_description == "5 K assumed (library, E0)"
    given = load_document(doc(**{"thermal.cdu_approach_K": 4})).report
    assert _gap(given, "thermal.cdu_approach_K") is None and "thermal.cdu_approach_K" in given.supplied


def test_n8_the_dry_cooler_approach_is_a_named_optional_gap_that_prints_the_sum_it_makes():
    rep = load_document(DUBLIN).report
    g = _gap(rep, "thermal.plant.dry_cooler_approach_K")
    assert g is not None and not g.required and g.how_to_get_it and g.why_it_binds
    assert "dry bulb 26 + assumed 10 K approach (E0)" in g.fallback_description and "36 degC" in g.fallback_description


def test_n8_the_water_gate_assumptions_reach_the_report_that_is_printed():
    md = S.handle_screen({"intake": DUBLIN, "format": "md"}, Tier.CLIENT)["document"]
    assert "dry bulb 26 + assumed 10 K approach (E0)" in md and "CDU approach temperature" in md


def test_n8_neither_new_row_moves_the_completeness_ratio_or_the_first_gaps():
    from gridforge.intake.schema import FIELD_BY_PATH
    for path in ("thermal.cdu_approach_K", "thermal.plant.dry_cooler_approach_K"):
        assert not FIELD_BY_PATH[path].required and not FIELD_BY_PATH[path].counts_toward_completeness
    a = load_document(doc(**{"thermal.cdu_approach_K": 4, "thermal.plant.dry_cooler_approach_K": 8}))
    b = load_document(DUBLIN)
    assert a.report.completeness == b.report.completeness
    old = [g.path for g in b.report.gaps if g.path not in ("thermal.cdu_approach_K", "thermal.plant.dry_cooler_approach_K")]
    assert [g.path for g in b.report.gaps][:len(old) - 5] == old[:len(old) - 5]          # the long-standing rows keep their places


def test_n8_a_supplied_dry_cooler_approach_is_read_kept_and_used_by_the_water_gate_instead_of_ten():
    """Dry bulb 20 degC, TCS 30 - CDU approach 5: the facility water must be at or below 25. The hard-coded 10 K gives 30 (binds, 0 racks); the
    client's own 4 K gives 24 (passes), and their 6 K gives 26 (binds again). Before, the key was refused as unknown."""
    base = {"site.design_drybulb_C": 20}
    assert racks_by_scenario(doc(**base))["full_dlc"] == 0
    assert racks_by_scenario(doc(**base, **{"thermal.plant.dry_cooler_approach_K": 4}))["full_dlc"] > 0
    assert racks_by_scenario(doc(**base, **{"thermal.plant.dry_cooler_approach_K": 6}))["full_dlc"] == 0
    it = load_document(doc(**{"thermal.plant.dry_cooler_approach_K": 4}))
    q = it.context.thermal.plant.dry_cooler_approach_K
    assert (q.value, q.evidence.short) == (4, "E3") and "thermal.plant.dry_cooler_approach_K" in it.report.supplied
    assert not [w for w in it.report.warnings if "dry_cooler_approach_K" in w]                 # a key the engine reads is not reported as ignored


def test_n8_the_default_is_still_ten_kelvin_labelled_an_assumption():
    from gridforge.intake.loader import _high_temp_loop
    q = _high_temp_loop(load_document(DUBLIN).context).thermal.plant.dry_cooler_approach_K
    assert (q.value, q.evidence.short, q.band) == (10, "E0", (8, 12))
    given = load_document(doc(**{"thermal.plant.dry_cooler_approach_K": 7}))
    assert _high_temp_loop(given.context).thermal.plant.dry_cooler_approach_K.value == 7


@pytest.mark.parametrize("bad,fragment", [(0, "below the 1 K"), (0.4, "below the 1 K"), (-3, "cannot be negative"), (51, "above 50")])
def test_n8_an_implausible_dry_cooler_approach_is_refused_by_name(bad, fragment):
    text = refusal(doc(**{"thermal.plant.dry_cooler_approach_K": bad}))
    assert "thermal.plant.dry_cooler_approach_K" in text and fragment in text


# ======================================================================================================================================= N12
@pytest.mark.parametrize("value,fragment", [
    ("rdhx", 'Did you mean ["rdhx"]?'), ("hybrid_dlc", 'Did you mean ["hybrid_dlc"]?'), ("", "not the text ''"), (5, "not int"),
    ({}, "not dict"), (0, "not int"), (False, "not bool"), (3.5, "not float"),
])
def test_n12_scenarios_that_is_not_a_list_is_refused_by_name_and_says_what_to_send(value, fragment):
    """Before: 'rdhx' -> 'unknown scenario(s): r, d, h, x'; 'hybrid_dlc' -> 'scenarios names d twice'; 5 -> "'int' object is not iterable"."""
    text = refusal(doc(scenarios=value))
    assert text.startswith("scenarios must be a list of scenario ids") and fragment in text and "Available:" in text
    assert "twice" not in text and "iterable" not in text and ", r, " not in text


@pytest.mark.parametrize("items,fragment", [([1], "scenarios[0] must be a scenario id (text), not int"), (["rdhx", None], "scenarios[1] must be a scenario id (text), not null"),
                                            ([["a"]], "scenarios[0] must be a scenario id (text), not list")])
def test_n12_an_element_that_is_not_a_scenario_id_is_refused_by_position(items, fragment):
    assert fragment in refusal(doc(scenarios=items))


def test_n12_a_misspelt_scenario_in_a_list_gets_a_did_you_mean_and_the_valid_forms_still_load():
    assert "Did you mean `rdhx`?" in refusal(doc(scenarios=["rdhxx"]))
    assert [s.id for s in load_document(doc(scenarios=["rdhx", "full_dlc"])).scenarios] == ["rdhx", "full_dlc"]
    assert len(load_document(doc(scenarios=None)).scenarios) == 5
    assert "empty list" in refusal(doc(scenarios=[]))
    assert "twice" in refusal(doc(scenarios=["rdhx", "rdhx"]))


# ======================================================================================================================================= N13
DUP_TEXT = json.dumps(DUBLIN).replace('"contracted_MW": 10.0', '"contracted_MW": 3, "contracted_MW": 10.0', 1)


def test_n13_the_file_loader_refuses_a_repeated_key_by_name(tmp_path):
    """Before: the LAST of two equal keys was read and the other vanished; the API refused the same document with a 422."""
    assert DUP_TEXT != json.dumps(DUBLIN)
    p = tmp_path / "dup.json"
    p.write_text(DUP_TEXT)
    with pytest.raises(IntakeError, match=r"dup\.json: the object repeats the key 'contracted_MW'"):
        load(p)
    p.write_text(json.dumps(DUBLIN))
    assert load(p).context.power.grid.contracted_MW.value == 10.0


@pytest.mark.parametrize("command", ["screen", "study", "gaps", "deck", "proposal"])
def test_n13_the_command_line_exits_2_on_a_repeated_key(command, tmp_path, capsys):
    from gridforge.cli import main
    p = tmp_path / "dup.json"
    p.write_text(DUP_TEXT)
    args = [command, str(p)] + ([] if command == "gaps" else ["-o", str(tmp_path / "out")])
    assert main(args) == 2
    err = capsys.readouterr().err
    assert "repeats the key 'contracted_MW'" in err and not (tmp_path / "out").exists()


def test_n13_diff_reads_its_two_files_strictly_too(tmp_path, capsys):
    from gridforge.cli import main
    a, b = tmp_path / "a.json", tmp_path / "b.json"
    a.write_text(json.dumps(DUBLIN))
    b.write_text(DUP_TEXT)
    assert main(["diff", str(a), str(b), "-o", str(tmp_path / "out")]) == 2
    assert "b.json" in capsys.readouterr().err


def test_n13_the_api_and_the_command_line_share_one_helper():
    from gridforge.intake import strict_json
    assert S._refuse_duplicate_keys is strict_json.refuse_duplicate_keys
    with pytest.raises(ValueError, match="repeats the key"):
        strict_json.loads('{"a": 1, "a": 2}')
    assert strict_json.loads('{"a": {"b": 1}, "c": {"b": 2}}') == {"a": {"b": 1}, "c": {"b": 2}}      # the same key in different objects is fine


# ====================================================================================================================================== N2-load
def test_n2_a_ups_block_of_zero_units_is_ignored_with_a_named_warning():
    d = doc()
    d["ups"].append({"id": "UPS-EMPTY", "unit_rating_kW": 800, "units": 0, "redundancy": "N+1"})
    it = load_document(d)
    assert "ups[1] (UPS-EMPTY): units is 0, ignored" in " | ".join(it.report.warnings)
    assert [u.id for u in it.context.power.ups] == ["UPS-1"] and all(u.units >= 1 for u in it.context.power.ups)
    assert racks_by_scenario(d) == racks_by_scenario(DUBLIN)                                  # ignored: it changes no answer
    assert not [g for g in it.report.gaps if "UPS-EMPTY" in g.path]                          # and asks for nothing about the ignored bank


def test_n2_a_transformer_bank_and_a_cdu_bank_of_zero_units_are_ignored_the_same_way():
    d = doc()
    d["transformers"].insert(0, {"id": "TX-OLD", "unit_rating_MVA": 5, "units": 0, "redundancy": "N+1"})
    d["thermal"]["cdus"] = [{"id": "CDU-GONE", "rated_capacity_kW": 1350, "units": 0, "redundancy": "N+1"},
                            {"id": "CDU-2", "rated_capacity_kW": 1350, "units": 3, "redundancy": "N+1"}]
    it = load_document(d)
    warnings = " | ".join(it.report.warnings)
    assert "transformers[0] (TX-OLD): units is 0, ignored" in warnings and "thermal.cdus[0] (CDU-GONE): units is 0, ignored" in warnings
    assert [t.id for t in it.context.power.transformers] == ["TX-A/B"] and [c.id for c in it.context.thermal.cdus] == ["CDU-2"]


def test_n2_a_schedule_whose_every_bank_is_ignored_is_a_missing_schedule_not_a_supplied_one():
    d = doc(**{"ups.0.units": 0})
    it = load_document(d)
    assert it.context.power.ups == [] and "ups" not in it.report.supplied
    assert "ups" in [g.path for g in it.report.required_gaps] and not it.report.can_issue
    assert "No UPS schedule supplied" in " | ".join(it.report.warnings)


@pytest.mark.parametrize("units", [-1, 1.5, "2", None])
def test_n2_a_units_figure_that_is_not_a_whole_number_of_zero_or_more_is_still_refused(units):
    d = doc(**{"ups.0.units": units})
    assert "units" in refusal(d)


# ====================================================================================================================================== J1-2
def test_j12_one_missing_required_input_is_said_in_the_singular_in_the_buyers_voice():
    text = load_document(example("london_hall")).report.engagement_recommendation
    assert text.startswith("1 required input is missing (UPS schedule). Please send it as the hall's own data")
    assert "required inputs missing" not in text and "Request them" not in text and "Sell the" not in text


def test_j12_two_and_three_missing_inputs_agree_in_number_and_name_them():
    d = doc(ups=..., transformers=...)
    text = load_document(d).report.engagement_recommendation
    assert text.startswith("2 required inputs are missing (Transformer schedule, UPS schedule). Please send them")


def test_j12_a_thin_intake_is_pointed_to_the_screen_by_name_from_the_catalogue_and_carries_no_money_or_duration():
    from gridforge.commercial import ENGAGEMENTS, engagement
    screen = ENGAGEMENTS["density_screen"]
    study = engagement(screen.credits_against)
    text = load_document({"project": {"client": "Thin"}, "compute": {"platform": "gb300_nvl72"}}).report.engagement_recommendation
    assert f"The next step is the {screen.name}" in text and f"full {study.name}" in text and "credited in full against the Study" in text
    assert "Sell the" not in text and "Intake too thin" not in text
    # the free qualifier's answer carries no money and no duration (tests/test_free_qualifier_no_duration_or_money.py), and this text is in it
    assert not re.search(r"EUR|€|\d[\d,.]*\s?(working )?(days?|weeks?|months?)\b", text)


def test_j12_the_priced_variant_takes_its_figures_from_the_catalogue_and_only_when_the_intake_is_too_thin():
    from gridforge.commercial import ENGAGEMENTS
    screen = ENGAGEMENTS["density_screen"]
    thin = load_document({"project": {"client": "Thin"}}).report
    assert thin.engagement_recommendation_with_fee.startswith(thin.engagement_recommendation)
    assert f"EUR {screen.price_eur:,}" in thin.engagement_recommendation_with_fee and f"{screen.turnaround_days} working days" in thin.engagement_recommendation_with_fee
    london = load_document(example("london_hall")).report
    assert london.engagement_recommendation_with_fee == london.engagement_recommendation
    assert load_document(DUBLIN).report.engagement_recommendation_with_fee == load_document(DUBLIN).report.engagement_recommendation


def test_j12_the_text_the_free_qualifier_returns_is_in_the_buyers_voice():
    out = S.handle_qualify({"contracted_MW": 12, "current_site_peak_MW": 7.4, "busway_ampacity_A": 400, "tapoff_max_A": 63}, Tier.PUBLIC)
    text = out["intake"]["recommended_engagement"]
    assert "Sell the" not in text and "required inputs missing" not in text and "The next step is the Density Screen" in text


def test_j12_the_gaps_command_prints_the_priced_recommendation(tmp_path, capsys):
    from gridforge.cli import main
    from gridforge.commercial import ENGAGEMENTS
    p = tmp_path / "thin.json"
    p.write_text(json.dumps({"project": {"client": "Thin"}, "grid": {"contracted_MW": 12}}))
    assert main(["gaps", str(p)]) == 0
    out = capsys.readouterr().out
    assert f"EUR {ENGAGEMENTS['density_screen'].price_eur:,}" in out and "The next step is the Density Screen" in out


# ====================================================================================================================================== J1-7
def test_j17_a_contract_whose_derived_firm_capacity_is_above_the_ceiling_is_refused_by_the_name_the_caller_sent():
    from gridforge.intake.loader import validate_contracted_MW
    for contracted in (4851, 4900, 4999.9):
        with pytest.raises(IntakeError) as exc:
            validate_contracted_MW(contracted)
        text = str(exc.value)          # within contracted_MW's own cap of 5000, but its derived firm capacity (/ 0.97) is above 5000 MVA
        assert text.startswith(f"contracted_MW is {contracted:g} MW. When firm_capacity_MVA is not sent") and "at most 4850 MW" in text
        assert f"{contracted / 0.97:,.1f} MVA" in text and "send firm_capacity_MVA" in text and "grid.firm_capacity_MVA" not in text
    with pytest.raises(IntakeError, match="contracted_MW is 12000 MW, above 5000 MW"):            # beyond its own cap: by its own name
        validate_contracted_MW(12000)
    assert validate_contracted_MW(4850) == 4850.0 and validate_contracted_MW(0) == 0.0


def test_j17_the_helper_applies_the_loaders_own_bounds_and_can_be_told_the_firm_capacity_is_sent():
    from gridforge.intake.loader import validate_contracted_MW
    with pytest.raises(IntakeError, match="contracted_MW is 6000 MW, above 5000 MW"):
        validate_contracted_MW(6000, derives_firm=False)
    assert validate_contracted_MW(4900, derives_firm=False) == 4900.0              # a firm capacity of its own is the caller's: nothing is derived
    with pytest.raises(IntakeError, match="my_field is -1; it cannot be negative"):
        validate_contracted_MW(-1, name="my_field")
    for bad in ("12", None, True, float("nan")):
        with pytest.raises(IntakeError, match="contracted_MW"):
            validate_contracted_MW(bad)


def test_j17_the_loader_itself_says_a_derived_firm_capacity_came_from_the_contract():
    """Before: 'firm connection capacity (grid.firm_capacity_MVA) is 12371.1 MVA, above 5000 MVA' for contracted_MW 12000."""
    from gridforge.api.server import ApiError, qualify_to_intake
    body = {"contracted_MW": 12000, "current_site_peak_MW": 7.4, "busway_ampacity_A": 400, "tapoff_max_A": 63}
    # At the HTTP boundary the API layer now refuses a figure BY ITS OWN NAME before anything is derived (journey audit J1-7), so the request never
    # reaches the loader with a derived firm capacity...
    with pytest.raises(ApiError) as e:
        qualify_to_intake(body)
    assert e.value.status == 422 and "contracted_MW is 12000 MW, above 5000 MW" in e.value.message
    # ...and the loader's own refusal, for a document whose firm capacity WAS derived from the contract (an older caller, the CLI), still says so:
    d = qualify_to_intake({**body, "contracted_MW": 4800})
    d["grid"]["contracted_MW"] = 12000.0
    d["grid"]["firm_capacity_MVA"]["value"] = 12000 / 0.97
    text = refusal(d)
    assert "grid.contracted_MW (12000 MW) divided by 0.97" in text and "at most 4850 MW" in text and "send firm_capacity_MVA" in text
    # a firm capacity that is NOT the contract over 0.97 keeps the ordinary refusal
    other = refusal(doc(**{"grid.firm_capacity_MVA": 6000}))
    assert "above 5000" in other and "divided by" not in other


# ====================================================================================================================================== J2-4
def test_j24_a_misspelt_top_level_section_is_refused_with_a_did_you_mean():
    d = copy.deepcopy(DUBLIN)
    d["gird"] = d.pop("grid")
    text = refusal(d)
    assert text.startswith("gird is not a section of the intake") and "Did you mean `grid`?" in text


@pytest.mark.parametrize("name", ["reference_hall", "dublin_hall", "london_hall", "nordic_hall"])
def test_j24_every_shipped_example_still_loads(name):
    load_document(example(name))


def test_j24_the_free_qualifier_builds_a_document_the_loader_accepts():
    S.handle_qualify({"contracted_MW": 12, "current_site_peak_MW": 7.4, "busway_ampacity_A": 400, "tapoff_max_A": 63}, Tier.PUBLIC)


def test_j24_a_key_the_engine_does_not_read_is_named_in_a_warning_a_near_miss_of_a_section_is_refused_and_the_request_options_are_allowed():
    """The policy for an unknown top-level key (review E1; tests/test_template_roundtrip.py pins each branch): a metadata key such as `notes` is ignored
    with a named warning (it used to be refused, which also refused the template the engine itself sends), a misspelt section is still refused."""
    assert any(w.startswith("notes is not read by the engine") for w in load_document({**DUBLIN, "notes": "x"}).report.warnings)
    assert refusal({**DUBLIN, "halls": {}}).startswith("halls is not a section of the intake")               # a near miss of `hall`: refused, not ignored
    load_document({**DUBLIN, "format": "md", "objective": "max_compute", "return_by": "2027-01-31", "scenario": "full_dlc", "constraint": "x"})


def test_j24_the_qualifiers_short_form_sent_to_an_intake_route_is_told_so_in_the_apis_own_words():
    """A body with no section of the intake in it was refused as 'none of the intake fields' (tests/test_api_contract.py); it still is. The loader no longer
    refuses the keys (they are far from every section: ignored, with a named warning), so the refusal is the route's, and it names the keys sent."""
    short = {"contracted_MW": 12, "site_name": "x"}
    assert any(w.startswith("contracted_MW is not read by the engine") for w in load_document(short).report.warnings)
    with pytest.raises(S.ApiError) as e:
        S._run(short)
    assert e.value.status == 422 and "none of the intake fields, so there is nothing to solve" in e.value.message
    assert "contracted_MW" in e.value.message and "POST /v1/qualify" in e.value.message
    assert "none of the intake fields" not in refusal({**DUBLIN, "gird": {}})                    # a typo beside real sections is just a typo


def test_j24_every_option_a_route_reads_from_a_body_that_is_the_intake_is_allowed_at_the_top_level():
    """A route that reads a new option from `body` must add it to REQUEST_OPTION_KEYS, or the option is refused as a misspelt section."""
    from gridforge.intake.loader import TOP_LEVEL_KEYS
    pattern = re.compile(r'body\.get\("(\w+)"|body\["(\w+)"\]|"(\w+)" in body')
    for name in ("handle_screen", "handle_compare", "handle_study", "handle_deck", "handle_proposal", "handle_spec", "handle_power_assess"):
        keys = {a or b or c for a, b, c in pattern.findall(inspect.getsource(getattr(S, name)))}
        assert keys and keys <= TOP_LEVEL_KEYS, (name, sorted(keys - TOP_LEVEL_KEYS))


def test_j24_every_section_a_field_path_starts_with_is_a_section():
    from gridforge.intake.loader import INTAKE_SECTIONS
    from gridforge.intake.schema import INTAKE_FIELDS
    assert {f.path.split(".")[0] for f in INTAKE_FIELDS} <= set(INTAKE_SECTIONS)


# ====================================================================================================================================== J2-5
@pytest.mark.parametrize("command", ["screen", "study", "deck", "proposal", "spec", "portfolio"])
def test_j25_a_solving_command_refuses_the_blank_template_with_exit_2(command, tmp_path, capsys):
    from gridforge.cli import main
    blank = tmp_path / "blank.json"
    assert main(["init", "-o", str(blank)]) == 0
    capsys.readouterr()
    assert main([command, str(blank), "-o", str(tmp_path / "out")]) == 2
    err = capsys.readouterr().err
    assert "contains none of the intake fields, so there is nothing to solve" in err and "intake error" in err
    assert not (tmp_path / "out").exists()


def test_j25_gaps_still_prints_the_data_request_for_the_blank_template(tmp_path, capsys):
    from gridforge.cli import main
    blank = tmp_path / "blank.json"
    main(["init", "-o", str(blank)])
    capsys.readouterr()
    assert main(["gaps", str(blank)]) == 0
    assert "DATA REQUEST" in capsys.readouterr().out


def test_j25_an_intake_with_one_figure_is_solved(tmp_path, capsys):
    from gridforge.cli import main
    p = tmp_path / "one.json"
    p.write_text(json.dumps({"project": {"client": "One"}, "grid": {"contracted_MW": 12}}))
    assert main(["screen", str(p), "-o", str(tmp_path / "out")]) == 0
    assert (tmp_path / "out" / "density_screen.md").exists()
