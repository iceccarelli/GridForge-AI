"""A missing or unrecognised equipment declaration never becomes a complete, favourable-looking result.

The founder's rule: the engine refuses to report a complete or bankable result when a critical equipment declaration is missing, and no missing
input silently becomes zero or a favourable assumption. Found by the independent electrical audit of 2026-11-12 (each defect below was
reproduced on main before it was fixed here; the audit scripts are the evidence). Groups, by audit id:

  E1  an omitted transformer/UPS `units`, `redundancy`, `derating_factor` or `step_load_capability` took a default and the intake was 100%
      complete; they are now per-item NAMED gaps (units and redundancy REQUIRED, the other two optional).
  E2  an unknown key on an equipment item (a typo, `in_service`, `status`, `modules_out`) was silently ignored; an annotated figure's `unit`
      was ignored (30 kVA read as 30 MVA).
  E3  /v1/qualify derived the firm connection capacity from the contract and read it as customer data.
  E4  an omitted `lv.phases` was three-phase without a word.
  E5  a declared redundancy that leaves no usable capacity gave 0 racks with no warning.
  E6  an undeclared transformer/UPS bank (the most favourable assumption: no limit) was mislabelled `[]` and not marked as an upper bound.
  E7  a zero BTM capex was priced as free with no word.   E8  an omitted BTM `kind` was a battery.
  E9  `lv.voltage_V` accepted 11,000 V as the LOW-voltage busway voltage.   E10 the CDU gap text described what the engine does not do.
  P2-4 /v1/power/deploy/assess accepted nan/inf and 1e300 kW and answered with literal NaN/Infinity.
"""
from __future__ import annotations

import copy
import itertools
import json
import math
import random
from pathlib import Path

import pytest

from gridforge.api import server as S
from gridforge.api.server import handle_compare, handle_qualify, handle_screen, handle_study, qualify_to_intake
from gridforge.api.tiers import Tier
from gridforge.envelope import solve
from gridforge.intake.loader import EQUIPMENT_KEYS, IntakeError, blank_intake, load_document
from gridforge.intake.schema import FIELD_BY_PATH, INTAKE_FIELDS
from gridforge.scenario import run_all
from gridforge.serialize import scenario_dict
from gridforge.validation import EvidenceClass

ROOT = Path(__file__).resolve().parents[1]


def example(name: str) -> dict:
    return json.loads((ROOT / "examples" / "intake" / f"{name}.json").read_text(encoding="utf-8"))


DUBLIN, NORDIC, REFERENCE, LONDON = (example(n) for n in ("dublin_hall", "nordic_hall", "reference_hall", "london_hall"))


def doc(base: dict = DUBLIN, **sections) -> dict:
    d = copy.deepcopy(base)
    d.update(copy.deepcopy(sections))
    return d


def gap_paths(intake) -> list[str]:
    return [g.path for g in intake.report.gaps]


def gap(intake, path: str):
    return next(g for g in intake.report.gaps if g.path == path)


def constraint_racks(d: dict, cid: str) -> float:
    ctx = load_document(d).context
    return next(c.racks for c in solve(ctx).constraints if c.id == cid)


# ============================================================================================================================ E1
TX_BARE = {"id": "TX-1", "unit_rating_MVA": 5.0, "replacement_lead_time_weeks": 160}
UPS_BARE = {"id": "UPS-1", "unit_rating_kW": 1200}


def test_e1_the_control_hall_is_issuable_so_every_change_below_is_attributable_to_the_banks():
    for name, d in (("dublin", DUBLIN), ("nordic", NORDIC), ("reference", REFERENCE)):
        r = load_document(d).report
        assert r.can_issue and not r.required_gaps, name
        assert not [g for g in r.gaps if g.path.startswith(("transformers[", "ups["))], name


def test_e1_an_omitted_units_and_redundancy_are_required_named_gaps_per_item_and_block_issue():
    intake = load_document(doc(transformers=[TX_BARE], ups=[UPS_BARE]))
    required = {g.path for g in intake.report.required_gaps}
    assert {"transformers[TX-1].units", "transformers[TX-1].redundancy", "ups[UPS-1].units", "ups[UPS-1].redundancy"} <= required
    assert intake.report.can_issue is False
    assert "The intake is complete" not in intake.report.engagement_recommendation


def test_e1_an_omitted_derating_and_step_load_are_optional_named_gaps():
    intake = load_document(doc(transformers=[{**TX_BARE, "units": 3, "redundancy": "N+1"}], ups=[{**UPS_BARE, "units": 4, "redundancy": "N+1"}]))
    for path in ("transformers[TX-1].derating_factor", "ups[UPS-1].step_load_capability"):
        assert path in gap_paths(intake) and not gap(intake, path).required
    assert intake.report.can_issue is True            # an optional gap does not block issue; units and redundancy were declared


def test_e1_the_gap_text_says_nobody_declared_it_and_what_was_assumed():
    intake = load_document(doc(transformers=[TX_BARE], ups=[UPS_BARE]))
    for path, assumed in (("transformers[TX-1].units", "2"), ("transformers[TX-1].redundancy", "N+1"),
                          ("ups[UPS-1].units", "2"), ("ups[UPS-1].redundancy", "N+1"),
                          ("transformers[TX-1].derating_factor", "0.9"), ("ups[UPS-1].step_load_capability", "0.5")):
        g = gap(intake, path)
        assert "nobody declared" in g.fallback_description and assumed in g.fallback_description and "(E0)" in g.fallback_description, path
        assert g.why_it_binds and g.how_to_get_it, path


def test_e1_a_bank_without_an_id_is_named_by_its_position_not_merged_with_another():
    two = [{"unit_rating_MVA": 5.0}, {"unit_rating_MVA": 5.0, "units": 3, "redundancy": "N"}]
    intake = load_document(doc(transformers=two))
    paths = gap_paths(intake)
    assert "transformers[0].units" in paths and "transformers[0].redundancy" in paths
    assert not any(p.startswith("transformers[1].units") or p.startswith("transformers[1].redundancy") for p in paths)


def test_e1_completeness_does_not_move_per_item_gaps_are_outside_the_ratio():
    """The scalar ratio is unchanged (EXECUTION_STATE 2026-11-02: completeness counts only scalar-field gaps)."""
    declared = load_document(doc(transformers=[{**TX_BARE, "units": 2, "redundancy": "N+1", "derating_factor": 0.9}],
                                 ups=[{**UPS_BARE, "units": 2, "redundancy": "N+1", "step_load_capability": 0.5}]))
    omitted = load_document(doc(transformers=[TX_BARE], ups=[UPS_BARE]))
    assert omitted.report.completeness == declared.report.completeness
    assert round(load_document(REFERENCE).report.completeness, 3) == 0.839


def test_e1_the_default_is_unchanged_the_engine_still_computes_with_it_but_says_so():
    """No result moves: the same default is used. What changes is that it is labelled (E0, in a required gap)."""
    omitted = constraint_racks(doc(transformers=[TX_BARE]), "transformer_capacity")
    spelled = constraint_racks(doc(transformers=[{**TX_BARE, "units": 2, "redundancy": "N+1", "derating_factor": 0.9}]), "transformer_capacity")
    assert omitted == spelled


def test_e1_two_n_gives_no_more_racks_than_n_plus_1_for_the_same_bank():
    for units in (2, 3, 4, 6, 8):
        rack = lambda scheme: constraint_racks(doc(NORDIC, transformers=[{**TX_BARE, "units": units, "redundancy": scheme, "derating_factor": 0.9}]),
                                                "transformer_capacity")
        assert rack("2N") <= rack("N+1") <= rack("N"), units


def test_e1_a_two_n_bank_with_redundancy_left_out_is_never_reported_complete():
    """The audit case: a real 2N bank, redundancy omitted: 29 transformer racks vs 4 declared. The number may still be computed (with the labelled
    default) but the intake is not complete, the screen does not say it is, and the required input is named."""
    d = doc(NORDIC, transformers=[{**TX_BARE, "units": 4, "derating_factor": 0.9}])
    intake = load_document(d)
    assert "transformers[TX-1].redundancy" in {g.path for g in intake.report.required_gaps}
    assert intake.report.can_issue is False
    md = handle_screen({"intake": d, "format": "md"}, Tier.CLIENT)["document"]
    assert "Intake is complete" not in md and "supplied by the client rather than assumed" not in md
    assert "Transformer bank TX-1: redundancy scheme" in md           # the data request row


def _full_dublin() -> dict:
    """Every optional field supplied (the audit's FULL document): the only document for which the screen may say the intake is complete."""
    d = copy.deepcopy(DUBLIN)
    # rated_approach_K and rated_flow_l_per_min are optional CDU inputs the engine names as gaps when omitted (thermal track), so the one
    # document that must carry NO gap declares them too.
    d["thermal"]["cdus"] = [dict(id="C", rated_capacity_kW=1350, units=3, redundancy="N+1", rated_approach_K=5, rated_flow_l_per_min=2000)]
    d["thermal"]["plant"]["existing_flow_l_per_min"] = 3000
    d["thermal"]["plant"]["existing_non_it_heat_kW"] = 500
    d["thermal"]["rdhx"] = {"capacity_kW_per_rack": 60}
    d["thermal"]["tcs_target_supply_C"] = 32
    d["hall"]["occupied_positions"] = 140
    d["lv"]["existing_busway_load_kW"] = 1000
    d["economics"] = {"electricity_eur_per_MWh": 120, "horizon_years": 10, "discount_rate": 0.08}
    d["btm_options"][0].update(units=4, redundancy="N+1")
    return d


def test_e1_the_complete_sentence_is_printed_only_for_a_document_with_no_gap_at_all():
    full = _full_dublin()
    assert gap_paths(load_document(full)) == []
    md = handle_screen({"intake": full, "format": "md"}, Tier.CLIENT)["document"]
    assert "Intake is complete: every site input requested was supplied by the client rather than assumed." in md       # the control
    defaulted = doc(full, transformers=[TX_BARE], ups=[UPS_BARE])
    md = handle_screen({"intake": defaulted, "format": "md"}, Tier.CLIENT)["document"]
    assert "Intake is complete" not in md and "rather than assumed" not in md
    assert "nobody declared it" in md


def test_e1_an_optional_gap_alone_also_withdraws_the_every_input_supplied_sentence():
    full = _full_dublin()
    full["transformers"][0].pop("derating_factor")
    only = gap_paths(load_document(full))
    assert len(only) == 1 and only[0].startswith("transformers[") and only[0].endswith("].derating_factor")
    md = handle_screen({"intake": full, "format": "md"}, Tier.CLIENT)["document"]
    assert "supplied by the client rather than assumed" not in md and "Intake is complete: every" not in md
    deck = S.handle_deck({"intake": full}, Tier.CLIENT)["document"]
    assert "Every site input requested was supplied by the client" not in deck


def test_e1_the_percentage_line_says_what_the_percentage_does_not_count_while_a_required_item_input_is_open():
    """Completeness stays where it was (the lead's rule), so "Intake completeness is 100%" above four open required rows would read as a
    contradiction. The line says what the percentage counts, and only when such a row exists."""
    d = doc(transformers=[TX_BARE], ups=[UPS_BARE])
    for md in (handle_screen({"intake": d, "format": "md"}, Tier.CLIENT)["document"],
               S.handle_proposal({"intake": d, "format": "md"}, Tier.CLIENT)["document"]):
        assert "counts the single-value inputs only; 4 required inputs on individual equipment items (listed below) are not in it" in md
    assert "single-value inputs only" in S.handle_deck({"intake": d}, Tier.CLIENT)["document"]
    ok = handle_screen({"intake": DUBLIN, "format": "md"}, Tier.CLIENT)["document"]
    assert "single-value inputs only" not in ok                # an optional per-item gap (a generator's unit count) does not trigger it
    one = doc(transformers=[{**TX_BARE, "redundancy": "N+1", "units": 3}], ups=[{**UPS_BARE, "units": 3, "redundancy": "N+1"}])
    assert load_document(one).report.item_gaps_note == ""


def test_e1_the_proposal_does_not_say_nothing_further_is_required_while_a_gap_exists():
    full = _full_dublin()
    full["ups"][0].pop("redundancy")
    out = S.handle_proposal({"intake": full, "format": "md"}, Tier.CLIENT)["document"]
    assert "Nothing further is required to begin" not in out
    assert "UPS block" in out and "redundancy scheme" in out


def test_e1_required_inputs_missing_counts_the_new_gaps_in_the_screen_payload():
    d = doc(transformers=[TX_BARE], ups=[UPS_BARE])
    intake_payload = handle_screen({"intake": d}, Tier.CLIENT)["intake"]
    assert intake_payload["can_issue_a_study"] is False
    paths = {g["path"] for g in intake_payload["gaps"] if g["required"]}
    assert {"transformers[TX-1].units", "transformers[TX-1].redundancy"} <= paths


def test_e1_the_procurement_specification_says_the_same_about_the_same_bank():
    from gridforge.procurement.build import assumed_inputs, site_conditions
    intake = load_document(doc(transformers=[TX_BARE], ups=[UPS_BARE]))
    rows = {r.label: r for r in site_conditions(intake, intake.context)}
    assert "not supplied: assumed N+1 (E0)" in rows["Redundancy, transformer bank TX-1"].statement
    paths = {a.path for a in assumed_inputs(intake)}
    assert {"transformers[TX-1].redundancy", "ups[UPS-1].redundancy"} <= paths


# ============================================================================================================================ E2
SECTIONS = ("transformers", "ups", "btm_options", "thermal.cdus")


def _item(d: dict, section: str) -> dict:
    return d["thermal"]["cdus"][0] if section == "thermal.cdus" else d[section][0]


def _with_cdu(base: dict) -> dict:
    d = copy.deepcopy(base)
    d["thermal"]["cdus"] = [dict(id="CDU-1", rated_capacity_kW=1350, rated_approach_K=5, rated_flow_l_per_min=2000, units=3, redundancy="N+1")]
    return d


E2_BASE = _with_cdu(DUBLIN)


@pytest.mark.parametrize("section,key", [
    ("transformers", "in_service"), ("transformers", "status"), ("transformers", "unit"), ("transformers", "derating"),
    ("transformers", "redundancy_scheme"), ("transformers", "units_out"), ("transformers", "impedance_pct"),
    ("ups", "modules_out"), ("ups", "derating_factor"), ("ups", "efficiency"), ("ups", "unit"), ("ups", "modules"),
    ("btm_options", "capacity_mw"), ("btm_options", "unit"), ("btm_options", "status"), ("btm_options", "fuel"),
    ("thermal.cdus", "unit"), ("thermal.cdus", "in_service"), ("thermal.cdus", "rated_capacity_kw"),
])
def test_e2_an_unknown_key_on_an_equipment_item_is_refused_by_section_index_and_key(section, key):
    d = copy.deepcopy(E2_BASE)
    _item(d, section)[key] = 1
    with pytest.raises(IntakeError) as e:
        load_document(d)
    msg = str(e.value)
    assert f"{section}[0].{key}" in msg and "refused rather than ignored" in msg
    for allowed in EQUIPMENT_KEYS[section]:
        assert allowed in msg                                    # the message lists what IS allowed


def test_e2_the_typo_that_used_to_become_two_default_units_is_now_refused():
    """`unit` for `units`: units fell back to 2 and the 4-unit bank's racks went 28 -> 0 without a word (audit e2)."""
    d = doc(NORDIC, transformers=[{"id": "TX", "unit_rating_MVA": 5.0, "unit": 4, "redundancy": "N", "replacement_lead_time_weeks": 160}])
    with pytest.raises(IntakeError, match=r"transformers\[0\]\.unit is not an input"):
        load_document(d)


def test_e2_the_allowed_sets_are_exactly_what_the_loader_reads_and_what_every_example_uses():
    assert EQUIPMENT_KEYS["transformers"] == {"id", "unit_rating_MVA", "units", "redundancy", "derating_factor", "replacement_lead_time_weeks"}
    assert EQUIPMENT_KEYS["ups"] == {"id", "unit_rating_kW", "units", "redundancy", "step_load_capability"}
    assert EQUIPMENT_KEYS["thermal.cdus"] == {"id", "rated_capacity_kW", "rated_approach_K", "rated_flow_l_per_min", "units", "redundancy"}
    assert EQUIPMENT_KEYS["btm_options"] == {
        "id", "kind", "capacity_MW", "capex_eur_per_kW", "lead_time_weeks", "firm", "firm_capacity_factor", "opex_eur_per_MWh", "permitting_note",
        "energy_MWh", "annual_run_hours", "fuel_price_eur_per_MWh", "electrical_efficiency", "variable_om_eur_per_MWh", "fixed_om_eur_per_kW_year",
        "units", "redundancy", "ride_through_hours"}
    for name in ("dublin_hall", "london_hall", "nordic_hall", "reference_hall"):
        d = example(name)
        for section in ("transformers", "ups", "btm_options"):
            for item in d.get(section, []):
                assert set(item) <= EQUIPMENT_KEYS[section], (name, section, set(item) - EQUIPMENT_KEYS[section])
        load_document(d)


@pytest.mark.parametrize("block,key,did_you_mean", [
    ("compute", "rack_kW", None), ("lv", "busway_amps", None), ("lv", "rack_feed_limit_kW", None), ("grid", "firm_capacity_mva", "firm_capacity_MVA"),
    ("hall", "rack_count", None), ("site", "address", None), ("thermal", "plant_capacity_kW", None), ("economics", "tariff", None),
    ("thermal.plant", "pump_flow", None), ("thermal.rdhx", "capacity_kw_per_rack", "capacity_kW_per_rack"),
])
def test_e2_an_unknown_key_in_an_object_block_is_refused_by_path_not_ignored(block, key, did_you_mean):
    """`compute.rack_kW: 40` was dropped and the platform's 135 kW used; `lv.busway_amps` was dropped and the library's 400 A used (audit e2, p5)."""
    d = copy.deepcopy(NORDIC)
    cur = d
    for part in block.split("."):
        cur = cur.setdefault(part, {})
    cur[key] = 40
    with pytest.raises(IntakeError) as e:
        load_document(d)
    msg = str(e.value)
    assert f"{block}.{key} is not an input the engine reads" in msg and "refused rather than ignored" in msg
    if did_you_mean:
        assert f"Did you mean `{did_you_mean}`?" in msg


def test_e2_every_field_of_the_data_request_and_the_blank_template_is_inside_the_block_allow_lists():
    from gridforge.intake.loader import BLOCK_KEYS, EQUIPMENT_KEYS
    for f in INTAKE_FIELDS:
        parts = f.path.split(".")
        block = ".".join(parts[:-1])
        if block in EQUIPMENT_KEYS:
            # a per-item row of an equipment list (e.g. thermal.cdus.rated_approach_K): the key must be one that list accepts
            assert parts[-1] in EQUIPMENT_KEYS[block], f.path
            continue
        if len(parts) == 1 or parts[0] in ("transformers", "ups") or f.path == "thermal.cdus":
            continue                                         # the equipment lists have their own sets
        assert block in BLOCK_KEYS and parts[-1] in BLOCK_KEYS[block], f.path
    assert load_document(blank_intake()).report.gaps


def test_e2_the_project_block_and_request_options_at_the_top_level_are_not_restricted():
    d = copy.deepcopy(NORDIC)
    d["project"]["anything"] = "free text"
    d["format"], d["objective"] = "json", "max_compute"
    load_document(d)


def test_e2_a_nested_block_that_is_not_an_object_is_refused_not_replaced_by_defaults():
    d = copy.deepcopy(NORDIC)
    d["thermal"]["plant"] = "oops"
    with pytest.raises(IntakeError, match=r"thermal\.plant must be an object"):
        load_document(d)


def test_e2_installed_is_still_refused_with_its_own_reason_first():
    d = copy.deepcopy(E2_BASE)
    d["transformers"][0]["installed"] = False
    with pytest.raises(IntakeError, match=r"transformers\[0\]\.installed is not an input"):
        load_document(d)


def test_e2_the_annotated_unit_must_be_the_field_s_own_unit_never_converted_silently():
    d = copy.deepcopy(NORDIC)
    d["grid"]["firm_capacity_MVA"] = {"value": 30.0, "unit": "kVA"}
    with pytest.raises(IntakeError) as e:
        load_document(d)
    msg = str(e.value)
    assert "grid.firm_capacity_MVA" in msg and "kVA" in msg and "MVA" in msg and "not converted" in msg
    d["grid"]["firm_capacity_MVA"] = {"value": 30.0, "unit": "MVA"}
    assert load_document(d).context.power.grid.firm_capacity_MVA.value == 30.0
    d["grid"]["firm_capacity_MVA"] = {"value": 30.0}
    assert load_document(d).context.power.grid.firm_capacity_MVA.value == 30.0


@pytest.mark.parametrize("path,section,key,bad_unit", [
    ("grid.contracted_MW", "grid", "contracted_MW", "kW"), ("hall.floor_loading_kPa", "hall", "floor_loading_kPa", "kg/m2"),
    ("lv.busway_ampacity_A", "lv", "busway_ampacity_A", "kA"), ("hall.positions_available", "hall", "positions_available", "racks"),
])
def test_e2_a_wrong_annotated_unit_is_refused_on_scalar_and_integer_fields_alike(path, section, key, bad_unit):
    d = copy.deepcopy(NORDIC)
    d[section][key] = {"value": d[section][key], "unit": bad_unit}
    with pytest.raises(IntakeError) as e:
        load_document(d)
    assert path in str(e.value) and bad_unit in str(e.value)


def test_e2_an_unknown_key_in_the_annotated_form_is_refused_and_the_known_ones_still_work():
    d = copy.deepcopy(NORDIC)
    d["grid"]["contracted_MW"] = {"value": 26.0, "note": "n", "source": "s", "evidence": "E3", "unit": "MW"}
    load_document(d)
    d["grid"]["contracted_MW"] = {"value": 26.0, "uncertainty": 0.1}
    with pytest.raises(IntakeError, match=r"grid\.contracted_MW.*uncertainty"):
        load_document(d)
    d["grid"]["contracted_MW"] = {"v": 26.0}
    with pytest.raises(IntakeError, match="without a \"value\""):             # the long-standing refusal keeps its words
        load_document(d)


# ============================================================================================================================ E3
HALL = {"contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9, "busway_ampacity_A": 1000, "tapoff_max_A": 400,
        "plant_supply_C": 20, "positions_available": 180}


def test_e3_a_firm_capacity_derived_from_the_contract_is_assumed_and_a_required_gap():
    derived = handle_qualify(dict(HALL), Tier.PUBLIC)
    given = handle_qualify({**HALL, "firm_capacity_MVA": 12 / 0.97}, Tier.PUBLIC)
    paths = {g["path"]: g for g in derived["intake"]["gaps"]}
    assert "grid.firm_capacity_MVA" in paths and paths["grid.firm_capacity_MVA"]["required"] is True
    assert "contracted_MW / 0.97" in paths["grid.firm_capacity_MVA"]["assumed"] and "(E0)" in paths["grid.firm_capacity_MVA"]["assumed"]
    assert "grid.firm_capacity_MVA" not in {g["path"] for g in given["intake"]["gaps"]}
    assert derived["intake"]["required_inputs_missing"] == given["intake"]["required_inputs_missing"] + 1
    assert derived["intake"]["completeness"] < given["intake"]["completeness"]
    assert derived["intake"]["can_issue_a_study"] is False


def test_e3_the_number_is_unchanged_only_its_label_and_the_gap_are_new():
    derived = handle_qualify(dict(HALL), Tier.PUBLIC)
    given = handle_qualify({**HALL, "firm_capacity_MVA": 12 / 0.97}, Tier.PUBLIC)
    assert derived["as_found"]["racks"] == given["as_found"]["racks"] and derived["after_relief"]["racks"] == given["after_relief"]["racks"]


def test_e3_the_derived_figure_is_class_e0_in_the_loader_and_listed_apart_from_what_the_caller_declared():
    intake = load_document(qualify_to_intake(dict(HALL)))
    assert intake.context.power.grid.firm_capacity_MVA.evidence is EvidenceClass.E0_ASSUMPTION
    own = load_document(qualify_to_intake({**HALL, "firm_capacity_MVA": 13}))
    assert own.context.power.grid.firm_capacity_MVA.evidence is EvidenceClass.E5_CUSTOMER_DATA
    out = handle_qualify(dict(HALL), Tier.PUBLIC)
    assert [r["path"] for r in out["inputs_derived_assumed"]] == ["grid.firm_capacity_MVA"]
    assert out["inputs_derived_assumed"][0]["evidence"] == "E0" and "contracted_MW / 0.97" in out["inputs_derived_assumed"][0]["note"]
    # the site reads `inputs_declared_assumed` as EXACTLY what the caller declared (lib/qualify-assumed.ts): a derived figure must not appear there
    assert "inputs_declared_assumed" not in out
    declared = handle_qualify({**HALL, "assumed_fields": ["contracted_MW"]}, Tier.PUBLIC)
    assert [r["path"] for r in declared["inputs_declared_assumed"]] == ["grid.contracted_MW"]


def test_e3_a_caller_who_gives_the_firm_capacity_gets_no_derived_label():
    out = handle_qualify({**HALL, "firm_capacity_MVA": 13}, Tier.PUBLIC)
    assert "inputs_derived_assumed" not in out and "grid.firm_capacity_MVA" not in {g["path"] for g in out["intake"]["gaps"]}



# ============================================================================================================================ E4
def test_e4_an_omitted_phase_count_is_a_named_optional_gap_outside_the_completeness_ratio():
    spec = FIELD_BY_PATH["lv.phases"]
    assert spec.required is False and spec.counts_toward_completeness is False
    d = copy.deepcopy(NORDIC)
    d["lv"].pop("phases")
    intake = load_document(d)
    g = gap(intake, "lv.phases")
    assert not g.required and "three-phase" in g.fallback_description and "assumed" in g.fallback_description
    assert intake.report.completeness == load_document(NORDIC).report.completeness
    assert intake.context.power.lv.phases == 3                       # the number is unchanged


def test_e4_a_declared_phase_count_has_no_gap_and_the_blank_template_asks_for_it():
    assert "lv.phases" not in gap_paths(load_document(NORDIC))
    assert "phases" in blank_intake()["lv"] and blank_intake()["lv"]["phases"] is None
    assert "lv.phases" in {f.path for f in INTAKE_FIELDS}


def test_e4_the_qualifier_lists_the_assumption():
    out = handle_qualify(dict(HALL), Tier.PUBLIC)
    assert "lv.phases" in {g["path"] for g in out["intake"]["gaps"]}


# ============================================================================================================================ E5
def _warnings(d: dict) -> list[str]:
    return load_document(d).report.warnings


@pytest.mark.parametrize("label,d,needle", [
    ("1 transformer unit N+1", doc(NORDIC, transformers=[{**TX_BARE, "unit_rating_MVA": 15.0, "units": 1, "redundancy": "N+1", "derating_factor": 0.9}]),
     "transformers[0]"),
    ("1 UPS module N+1", doc(NORDIC, ups=[{**UPS_BARE, "unit_rating_kW": 6000, "units": 1, "redundancy": "N+1", "step_load_capability": 0.5}]),
     "ups[0]"),
    ("2 transformer units N+2", doc(NORDIC, transformers=[{**TX_BARE, "units": 2, "redundancy": "N+2", "derating_factor": 0.9}]), "transformers[0]"),
    ("1 CDU N+1", _with_cdu(NORDIC) | {"thermal": {**_with_cdu(NORDIC)["thermal"], "cdus": [dict(id="CDU-1", rated_capacity_kW=1350, units=1, redundancy="N+1")]}},
     "thermal.cdus[0]"),
])
def test_e5_a_declared_redundancy_that_leaves_no_usable_unit_is_warned_by_name(label, d, needle):
    w = [x for x in _warnings(d) if needle in x]
    assert w and "no usable unit" in w[0], (label, _warnings(d))


def test_e5_usable_capacity_below_the_existing_load_is_warned_with_both_figures():
    ups = doc(NORDIC, ups=[{**UPS_BARE, "unit_rating_kW": 2000, "units": 3, "redundancy": "2N", "step_load_capability": 0.5}])
    w = [x for x in _warnings(ups) if "UPS" in x and "below" in x]
    assert w and "2,000 kW" in w[0].replace("2000 kW", "2,000 kW") and "existing" in w[0]
    tx = doc(NORDIC, transformers=[{**TX_BARE, "unit_rating_MVA": 1.0, "units": 2, "redundancy": "N+1", "derating_factor": 0.9}])
    w = [x for x in _warnings(tx) if "transformer" in x.lower() and "below" in x]
    assert w and "site peak" in w[0]


def test_e5_the_examples_and_a_healthy_bank_raise_none_of_these_warnings():
    for d in (DUBLIN, NORDIC, REFERENCE, LONDON):
        assert not [w for w in _warnings(d) if "no usable unit" in w or "below the existing" in w or "below the current" in w]


def test_e5_the_two_usable_unit_counts_are_one_rule():
    """The bank constraints carried their own copy of the arithmetic in power/redundancy.usable_units; they are now the same function."""
    from gridforge.power import constraints as pc
    from gridforge.power.redundancy import SCHEMES, usable_units
    for units, scheme in itertools.product(range(0, 41), (*SCHEMES, "N+0", "N+N", "n + 1", "2n")):
        assert pc._effective_units(units, scheme) == usable_units(units, scheme), (units, scheme)
    assert pc._effective_units is usable_units


# ============================================================================================================================ E6
BANKLESS = {k: v for k, v in DUBLIN.items() if k not in ("transformers", "ups")}


def test_e6_the_undeclared_bank_is_not_shown_as_an_empty_list():
    intake = load_document(BANKLESS)
    for path in ("transformers", "ups"):
        g = gap(intake, path)
        assert g.fallback_description != "[]"
        assert "not evaluated" in g.fallback_description and "no limit" in g.fallback_description and "upper bound" in g.fallback_description


def test_e6_the_scenario_payload_names_the_unassessed_banks():
    for omitted, expect in ((("transformers", "ups"), ["transformers", "UPS"]), (("transformers",), ["transformers"]), (("ups",), ["UPS"]), ((), [])):
        d = {k: v for k, v in DUBLIN.items() if k not in omitted}
        intake = load_document(d)
        assert [scenario_dict(r, d)["unassessed_banks"] for r in run_all(intake.context, intake.scenarios)] == [expect] * len(intake.scenarios)


def test_e6_every_report_marks_the_headline_rack_figure_an_upper_bound_when_a_bank_is_undeclared():
    for fn, body in ((handle_screen, {"intake": BANKLESS, "format": "md"}),
                     (handle_study, {"intake": BANKLESS, "format": "md"}),
                     (S.handle_proposal, {"intake": BANKLESS, "format": "md"}),
                     (handle_study, {"intake": BANKLESS, "format": "md", "view": "board"})):
        text = fn(body, Tier.CLIENT)["document"]
        assert "UPPER BOUND" in text, fn.__name__
        assert "not declared: transformers, UPS" in text
        control = fn({**body, "intake": DUBLIN}, Tier.CLIENT)["document"]
        assert "UPPER BOUND" not in control, fn.__name__


def test_e6_the_rack_count_itself_does_not_move():
    a = load_document(BANKLESS)
    assert [r.envelope.max_racks for r in run_all(a.context, a.scenarios)]          # computed, as before: a sparse screen still returns a figure


# ============================================================================================================================ E7 / E8
def _btm(**kw) -> dict:
    return {"id": "GEN-1", "kind": "gas_engine", "capacity_MW": 5.0, "capex_eur_per_kW": 800, "lead_time_weeks": 44, "units": 4, "redundancy": "N+1", **kw}


def test_e7_a_zero_capex_is_warned_by_option_id_and_a_positive_one_is_not():
    w = [x for x in _warnings(doc(btm_options=[_btm(capex_eur_per_kW=0)])) if "GEN-1" in x and "capex_eur_per_kW" in x]
    assert w and "free" in w[0]
    assert not [x for x in _warnings(doc(btm_options=[_btm()])) if "capex_eur_per_kW" in x]
    assert not [x for x in _warnings(doc(btm_options=[{k: v for k, v in _btm().items() if k != "capex_eur_per_kW"}])) if "priced as free" in x]


def test_e8_an_omitted_kind_is_an_unrecognised_technology_not_a_battery():
    d = doc(btm_options=[{k: v for k, v in _btm().items() if k not in ("kind", "units", "redundancy")}])
    intake = load_document(d)
    opt = intake.context.power.options[0]
    assert opt.kind != "bess"
    from gridforge.power.btm import firm_contribution_kW
    assert firm_contribution_kW(opt).value == 0.0
    assert [w for w in intake.report.warnings if "GEN-1" in w and "kind" in w and "not declared" in w]
    assert "btm_options[GEN-1].kind" in gap_paths(intake) and not gap(intake, "btm_options[GEN-1].kind").required


def test_e8_an_unknown_kind_keeps_its_existing_path():
    no_units = {k: v for k, v in _btm(kind="diesel").items() if k not in ("units", "redundancy")}
    intake = load_document(doc(btm_options=[no_units]))
    assert [w for w in intake.report.warnings if "diesel" in w and "0 MW as firm" in w]
    assert not [w for w in intake.report.warnings if "kind was not declared" in w]         # an unknown kind is not an undeclared one


# ============================================================================================================================ E9
@pytest.mark.parametrize("volts", [1001, 3300, 11000, 36000])
def test_e9_a_medium_voltage_figure_is_refused_as_the_lv_busway_voltage(volts):
    d = copy.deepcopy(DUBLIN)
    d["lv"]["voltage_V"] = volts
    with pytest.raises(IntakeError) as e:
        load_document(d)
    assert "lv.voltage_V" in str(e.value) and "1000 V" in str(e.value) and "low-voltage" in str(e.value).lower()


@pytest.mark.parametrize("volts", [208, 230, 400, 415, 480, 690, 1000])
def test_e9_the_voltages_of_real_lv_halls_including_the_limit_are_accepted(volts):
    d = copy.deepcopy(DUBLIN)
    d["lv"]["voltage_V"] = volts
    assert load_document(d).context.power.lv.voltage_V.value == volts


# ============================================================================================================================ E10
def test_e10_the_cdu_gap_describes_what_the_engine_does():
    intake = load_document(DUBLIN)
    g = gap(intake, "thermal.cdus")
    assert "no cost" not in g.why_it_binds and "free" not in g.why_it_binds
    assert "prices" in g.why_it_binds and "dates" in g.why_it_binds
    assert g.fallback_description != "[]" and "1,350" in g.fallback_description


def test_e10_the_text_matches_the_engine_behaviour_the_kit_is_priced_and_dated():
    intake = load_document(DUBLIN)
    r = next(x for x in run_all(intake.context, intake.scenarios) if x.spec.id == "hybrid_dlc")
    assert r.economics.capex_cdu_kit_eur.value > 0 and r.ladder.assumed_cdu_kit


# ============================================================================================================================ P2-4
from gridforge.power.load_profile import LoadProfileError, from_csv  # noqa: E402
from gridforge.reporting.btm_assessment import DeploymentRequestError, deployment_request  # noqa: E402

GOOD_DEPLOY = {"load_profile": {"flat_kW": 8000}, "grid_firm_MW": 10, "target_MW": 35,
               "generation": [{"id": "GEN-A", "kind": "gas_engine", "nameplate_MW": 10}],
               "bess": [{"id": "BESS-1", "power_MW": 10, "energy_MWh": 40}]}


@pytest.mark.parametrize("cell", ["nan", "NaN", "inf", "-inf", "Infinity", "1e999", "1e300"])
def test_p24_a_csv_row_that_is_not_a_plausible_finite_load_is_refused_naming_the_row(cell):
    csv = "timestamp,kW\n2026-01-01T00:00:00,100\n2026-01-01T00:15:00," + cell + "\n"
    with pytest.raises(LoadProfileError, match=r"row 3"):
        from_csv(csv)


def test_p24_a_nan_or_huge_kvar_is_refused_too():
    with pytest.raises(LoadProfileError, match=r"row 2.*kVAR"):
        from_csv("timestamp,kW,kVAR\n2026-01-01T00:00:00,100,nan\n")
    with pytest.raises(LoadProfileError, match=r"row 2.*kVAR"):
        from_csv("timestamp,kW,kVAR\n2026-01-01T00:00:00,100,1e300\n")


@pytest.mark.parametrize("path,value", [
    (("grid_firm_MW",), 1e999), (("grid_firm_MW",), float("nan")), (("grid_firm_MW",), 1e300), (("target_MW",), float("inf")), (("target_MW",), 6000),
    (("load_profile", "flat_kW"), 1e300), (("load_profile", "flat_kW"), float("nan")), (("load_profile", "flat_hours"), float("inf")),
    (("ride_through_hours",), float("nan")), (("ride_through_hours",), 1e9),
    (("generation", 0, "nameplate_MW"), float("inf")), (("generation", 0, "nameplate_MW"), 1e300), (("generation", 0, "capex_eur"), float("nan")),
    (("generation", 0, "lead_time_weeks"), float("inf")), (("bess", 0, "power_MW"), 1e300), (("bess", 0, "energy_MWh"), float("nan")),
    (("bess", 0, "capex_eur"), 1e300), (("bess", 0, "lead_time_weeks"), 1e9),
])
def test_p24_a_non_finite_or_implausible_figure_is_refused_by_field_at_input(path, value):
    req = copy.deepcopy(GOOD_DEPLOY)
    req["load_profile"].setdefault("flat_hours", 24)
    req["generation"][0].setdefault("capex_eur", 1e6)
    req["generation"][0].setdefault("lead_time_weeks", 40)
    req["bess"][0].setdefault("capex_eur", 1e6)
    req["bess"][0].setdefault("lead_time_weeks", 30)
    req["ride_through_hours"] = 2
    cur = req
    for p in path[:-1]:
        cur = cur[p]
    cur[path[-1]] = value
    with pytest.raises(DeploymentRequestError) as e:
        deployment_request(req)
    assert path[-1] in str(e.value)
    with pytest.raises(S.ApiError) as api:
        S._invoke("/v1/power/deploy/assess", S.handle_power_deploy_assess, req, Tier.CLIENT)
    assert api.value.status == 422


def test_p24_a_valid_request_still_answers_with_valid_json():
    out = S._invoke("/v1/power/deploy/assess", S.handle_power_deploy_assess, copy.deepcopy(GOOD_DEPLOY), Tier.CLIENT)
    json.dumps(out, allow_nan=False)           # raises on a literal NaN / Infinity
    parsed = deployment_request(GOOD_DEPLOY)
    assert parsed["grid_firm_MW"].value == 10 and parsed["target_MW"].value == 35


# ============================================================================================================================ the sweep
def _signature(d: dict):
    intake = load_document(d)
    return tuple((r.spec.id, r.envelope.max_racks, r.unlocked_racks, tuple((c.id, c.racks) for c in r.envelope.constraints))
                 for r in run_all(intake.context, intake.scenarios))


#: Where the loader's long-standing refusal names the QUANTITY and not the key (the message is pinned word for word by tests/test_engineering_constants.py).
HUMAN_LABEL = {"replacement_lead_time_weeks": "transformer lead time"}


def _typos(key: str, rng: random.Random) -> list[str]:
    cands = {key[:-1], key + "s", key.lower() if key.lower() != key else key.upper(), key.replace("_", ""), key + "_"}
    cands.discard(key)
    return sorted(cands)[:2] + [rng.choice(sorted(cands))]


@pytest.mark.parametrize("name", ["dublin_hall", "london_hall", "nordic_hall", "reference_hall"])
def test_sweep_no_single_key_mutation_of_an_equipment_item_changes_the_result_silently(name):
    """One equipment key at a time: renamed to a typo, dropped, or set to null. Each outcome is one of: refused with a reason that names the key
    or its item; or computed with a NEW named gap or warning; or computed with the SAME result as the unmutated hall (the key was inert). A
    mutation that moves a number and says nothing is the defect this file is about."""
    rng = random.Random(20261112)
    base = _with_cdu(example(name))
    base_intake = load_document(base)
    base_gaps, base_warn, base_sig = set(gap_paths(base_intake)), set(base_intake.report.warnings), _signature(base)
    silent: list[str] = []
    n_checked = 0
    for section in SECTIONS:
        items = base["thermal"]["cdus"] if section == "thermal.cdus" else base.get(section, [])
        for idx, item in enumerate(items):
            for key in sorted(item):
                variants = [("drop", None), ("null", None)] + [("typo", t) for t in _typos(key, rng)]
                for how, new_key in variants:
                    d = copy.deepcopy(base)
                    target = (d["thermal"]["cdus"] if section == "thermal.cdus" else d[section])[idx]
                    if how == "drop":
                        del target[key]
                    elif how == "null":
                        target[key] = None
                    else:
                        target[new_key] = target.pop(key)
                    n_checked += 1
                    try:
                        mutated = load_document(d)
                    except IntakeError as exc:
                        msg = str(exc)
                        if not (key in msg or (new_key and new_key in msg) or f"{section}[{idx}]" in msg or section in msg
                                or HUMAN_LABEL.get(key, "\0") in msg):
                            silent.append(f"{section}[{idx}].{key} {how}: refused without naming it: {msg[:100]}")
                        continue
                    new_gaps = set(gap_paths(mutated)) - base_gaps
                    new_warn = set(mutated.report.warnings) - base_warn
                    if new_gaps or new_warn:
                        continue
                    if _signature(d) != base_sig:
                        silent.append(f"{section}[{idx}].{key} {how}{(' -> ' + new_key) if new_key else ''}: the result moved with no gap, warning or refusal")
    assert n_checked > 40
    assert not silent, "\n".join(silent)
