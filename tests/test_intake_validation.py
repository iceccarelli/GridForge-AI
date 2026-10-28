"""An invalid intake must be refused by name, never ranked, never a traceback."""
import copy
import json
from pathlib import Path

import pytest

from gridforge.intake.loader import IntakeError, load_document

ROOT = Path(__file__).resolve().parents[1]
BASE = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())


def mutated(path, value):
    d = copy.deepcopy(BASE)
    cur = d
    parts = path.split(".")
    for p in parts[:-1]:
        cur = cur[int(p)] if p.isdigit() else cur[p]
    last = parts[-1]
    if last.isdigit():
        cur[int(last)] = value
    else:
        cur[last] = value
    return d


@pytest.mark.parametrize("path,value,fragment", [
    ("grid.power_factor", 1.5, "at most 1"),
    ("grid.power_factor", 0, "above 0"),
    ("grid.firm_capacity_MVA", float("nan"), "finite"),
    ("grid.firm_capacity_MVA", float("inf"), "finite"),
    ("grid.contracted_MW", "abc", "not a number"),
    ("grid.contracted_MW", -5, "negative"),
    ("thermal.plant.chilled_water_capacity_kW", float("nan"), "finite"),
    ("transformers.0.derating_factor", 5, "at most 1"),
    ("transformers.0.replacement_lead_time_weeks", None, "not a number"),
    ("lv.busway_ampacity_A", True, "not a number"),
])
def test_invalid_values_are_refused_with_the_field_named(path, value, fragment):
    with pytest.raises(IntakeError, match=fragment):
        load_document(mutated(path, value))


def test_the_reference_intake_still_loads():
    load_document(copy.deepcopy(BASE))


def test_a_client_cannot_self_declare_field_validation():
    d = copy.deepcopy(BASE)
    d["grid"]["firm_capacity_MVA"] = {"value": 14, "evidence": "E7"}
    intake = load_document(d)
    from gridforge.validation import EvidenceClass
    assert intake.context.power.grid.firm_capacity_MVA.evidence <= EvidenceClass.E5_CUSTOMER_DATA
    assert any("capped at E5" in w for w in intake.report.warnings)


def test_structural_garbage_is_an_intake_error_not_a_traceback():
    d = copy.deepcopy(BASE)
    del d["transformers"][0]["unit_rating_MVA"]
    with pytest.raises(IntakeError, match="unit_rating_MVA"):
        load_document(d)
    d = copy.deepcopy(BASE)
    d["hall"]["floor_type"] = "marble"
    with pytest.raises(IntakeError, match="malformed|floor"):
        load_document(d)
    d = copy.deepcopy(BASE)
    d["compute"] = {"platform": "gb300_nvl72", "default_architecture": "teleporter"}
    with pytest.raises(IntakeError, match="default_architecture"):
        load_document(d)
    d = copy.deepcopy(BASE)
    d["scenarios"] = []
    with pytest.raises(IntakeError, match="empty list"):
        load_document(d)
    with pytest.raises(IntakeError):
        load_document([])


def test_btm_kind_is_case_insensitive():
    d = copy.deepcopy(BASE)
    d["btm_options"][0]["kind"] = "GAS_ENGINE"
    i = load_document(d)
    assert i.context.power.options[0].kind == "gas_engine"


# ---------------------------------------------------------------------------------------------------------------------
# Magnitudes. The loader refused negative numbers and NaN but accepted ANY positive finite one, so a typo, a unit slip or an
# overflow was not a refused document but an answer: a transformer lead time of 1e308 weeks came back as a "dated" scenario, and
# a bank of a million transformer units moved the date from 160 weeks to 44. Both are 200 responses that flatter or garble the
# decision. A value above a plausibility ceiling is refused by name, like a power factor of 1.5.
# ---------------------------------------------------------------------------------------------------------------------
ABSURD = [
    ("transformers.0.replacement_lead_time_weeks", 1e6, "lead time"),
    ("transformers.0.replacement_lead_time_weeks", 1e308, "lead time"),
    ("transformers.0.units", 10**6, "units"),
    ("transformers.0.units", 10**30, "units"),
    ("transformers.0.unit_rating_MVA", 1e9, "unit_rating_MVA"),
    ("ups.0.units", 10**6, "units"),
    ("ups.0.unit_rating_kW", 1e12, "unit_rating_kW"),
    ("grid.firm_capacity_MVA", 1e9, "firm connection capacity"),
    ("grid.contracted_MW", 1e12, "contracted capacity"),
    ("grid.current_it_load_MW", 1e9, "current protected IT load"),
    ("lv.busway_runs", 10**6, "busway_runs"),
    ("lv.busway_ampacity_A", 1e9, "busway ampacity"),
    ("hall.rack_positions", 10**9, "rack_positions"),
    ("hall.net_white_space_m2", 1e308, "net white space"),
    ("hall.design_density_kW_per_rack", 1e6, "design density"),
    ("thermal.plant.chilled_water_capacity_kW", 1e308, "chilled-water plant capacity"),
    ("thermal.plant.free_cooling_hours_per_year", 9000, "free cooling hours"),
    ("btm_options.0.capacity_MW", 1e9, "capacity_MW"),
    ("btm_options.0.lead_time_weeks", 1e9, "lead_time_weeks"),
]


@pytest.mark.parametrize("path,value,fragment", ABSURD)
def test_an_absurd_magnitude_is_refused_by_name_not_solved(path, value, fragment):
    with pytest.raises(IntakeError, match=fragment) as exc:
        load_document(mutated(path, value))
    assert "above" in str(exc.value) or "cannot exceed" in str(exc.value)


def test_the_ceilings_sit_above_every_shipped_intake_and_the_reference_hall():
    """A ceiling is a typo guard, not a product claim: every intake the repository ships must still load."""
    for f in sorted((ROOT / "examples" / "intake").glob("*.json")):
        load_document(json.loads(f.read_text()))


@pytest.mark.parametrize("path,value", [
    ("transformers.0.replacement_lead_time_weeks", 520),   # ten years: a long, real transformer or connection programme
    ("transformers.0.units", 12),
    ("grid.firm_capacity_MVA", 1000),                      # a 1 GW campus
    ("hall.rack_positions", 5000),
])
def test_large_but_real_values_are_not_refused(path, value):
    load_document(mutated(path, value))


def test_one_unit_over_the_lead_time_ceiling_is_refused():
    load_document(mutated("transformers.0.replacement_lead_time_weeks", 520))
    with pytest.raises(IntakeError, match="lead time"):
        load_document(mutated("transformers.0.replacement_lead_time_weeks", 521))


# Contradictions that cannot be true of one hall are refused, not silently solved.
def test_more_positions_available_than_positions_exist_is_refused():
    d = mutated("hall.positions_available", 5000)
    with pytest.raises(IntakeError, match="positions_available"):
        load_document(d)


def test_a_chilled_water_return_at_or_below_supply_is_refused():
    d = mutated("thermal.plant.design_supply_C", 12)
    d["thermal"]["plant"]["design_return_C"] = 3
    with pytest.raises(IntakeError, match="return"):
        load_document(d)
    d["thermal"]["plant"]["design_return_C"] = 12
    with pytest.raises(IntakeError, match="return"):
        load_document(d)


@pytest.mark.parametrize("key,value,fragment", [
    ("capex_eur_per_kW", 1e9, "capex_eur_per_kW"),
    ("energy_MWh", 1e9, "energy_MWh"),
    ("opex_eur_per_MWh", 1e9, "opex_eur_per_MWh"),
])
def test_the_remaining_btm_ceilings_are_enforced(key, value, fragment):
    d = copy.deepcopy(BASE)
    d["btm_options"] = [{"id": "X", "kind": "bess", "capacity_MW": 2, key: value}]
    with pytest.raises(IntakeError, match=fragment):
        load_document(d)


@pytest.mark.parametrize("item,fragment", [
    ({"id": "CDU-1", "rated_capacity_kW": 1e9}, "rated_capacity_kW"),
    ({"id": "CDU-1", "rated_capacity_kW": 1000, "units": 10**6}, "CDU units"),
])
def test_the_cdu_ceilings_are_enforced(item, fragment):
    d = copy.deepcopy(BASE)
    d.setdefault("thermal", {})["cdus"] = [item]
    with pytest.raises(IntakeError, match=fragment):
        load_document(d)


def test_a_scenario_named_twice_in_the_intake_is_refused_not_compared_with_itself():
    """The API's own `scenarios` list already refused a repeat; the intake document's list did not, so /v1/compare ranked a scenario against
    itself (a 'tie') and /v1/screen reported it twice."""
    d = copy.deepcopy(BASE)
    d["scenarios"] = ["hybrid_dlc", "full_dlc", "hybrid_dlc"]
    with pytest.raises(IntakeError, match="hybrid_dlc.*twice|twice.*hybrid_dlc"):
        load_document(d)
    d["scenarios"] = ["hybrid_dlc", "full_dlc"]
    assert [s.id for s in load_document(d).scenarios] == ["hybrid_dlc", "full_dlc"]


@pytest.mark.parametrize("section", ["transformers", "ups", "btm_options"])
def test_an_equipment_id_listed_twice_is_refused_not_counted_twice(section):
    """Found by the stress harness: a repeated BESS entry (same id) raised full_dlc_btm from 62 to 69 racks with no caveat. The same
    equipment listed twice must not create capacity, and two items sharing a name are ambiguous in a ranking and a diff."""
    d = copy.deepcopy(BASE)
    d[section].append(copy.deepcopy(d[section][0]))
    repeated = d[section][0]["id"]
    with pytest.raises(IntakeError, match=f"{section} names {repeated}.*twice"):
        load_document(d)


@pytest.mark.parametrize("section", ["transformers", "ups", "btm_options"])
def test_distinct_ids_and_unnamed_entries_are_not_a_repeat(section):
    d = copy.deepcopy(BASE)
    second = copy.deepcopy(d[section][0])
    second["id"] = "SECOND-UNIT"
    d[section].append(second)
    load_document(d)  # distinct explicit ids
    for item in d[section]:
        item.pop("id")  # two entries that never named themselves take defaults; that is not a repeat
    load_document(d)


def test_a_declared_evidence_class_that_does_not_exist_is_refused_not_silently_dropped():
    path = "thermal.residual_air_capacity_kW_per_rack"
    d = copy.deepcopy(BASE)
    d["thermal"]["residual_air_capacity_kW_per_rack"]["evidence"] = "E9"
    with pytest.raises(IntakeError, match=f"{path}.*'E9'.*not an evidence class"):
        load_document(d)
    d["thermal"]["residual_air_capacity_kW_per_rack"]["evidence"] = "E3 derived from design density"
    load_document(d)  # a valid class with trailing words is still read as before
    d["thermal"]["residual_air_capacity_kW_per_rack"]["evidence"] = "E7"
    assert any("capped at E5" in w for w in load_document(d).report.warnings)  # E6/E7 are capped, not refused


def test_a_default_return_temperature_below_a_supplied_supply_warns_instead_of_refusing():
    """Found by the full suite: a customer who states only design_supply_C (18 degC) was refused because the library's default return (13 degC)
    sat below it. Only a contradiction between two figures the customer actually gave is a refusal."""
    d = copy.deepcopy(BASE)
    d["thermal"]["plant"].pop("design_return_C", None)
    d["thermal"]["plant"]["design_supply_C"] = 18
    intake = load_document(d)
    assert any("design_return_C" in w and "library default" in w for w in intake.report.warnings)


@pytest.mark.parametrize("path", ["grid.firm_capacity_MVA", "transformers.0.units", "transformers.0.replacement_lead_time_weeks"])
@pytest.mark.parametrize("sign", [1, -1])
def test_an_integer_too_large_for_a_float_is_an_intake_error_not_a_python_overflow(path, sign):
    with pytest.raises(IntakeError, match="too large"):
        load_document(mutated(path, sign * 10**400))
