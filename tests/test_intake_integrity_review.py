"""Four more defects from the independent review of the integrated engine (2026-11-13), in the area tests/test_intake_integrity.py covers.

  R2  a falsy non-list equipment value (0, false, "", {}) was recorded as supplied, read as an empty list and given no gap row.
  R4  an omitted CDU `units` / `redundancy` was a silent default (1 unit, N+1) and the specification then printed "supplied".
  R5  "The intake is complete" printed beside open optional gaps.
  R6  a "not less than" specification figure was rounded to NEAREST, so it could sit up to 0.5% under the engine's exact need.
"""
from __future__ import annotations

import copy
import glob
import json
import math
import os
from pathlib import Path

import pytest

from gridforge.intake.loader import IntakeError, load_document
from gridforge.scenario import run_all

ROOT = Path(__file__).resolve().parents[1]


def example(name: str) -> dict:
    return json.loads((ROOT / "examples" / "intake" / f"{name}.json").read_text(encoding="utf-8"))


DUBLIN, NORDIC, REFERENCE = example("dublin_hall"), example("nordic_hall"), example("reference_hall")


def gap_paths(intake) -> list[str]:
    return [g.path for g in intake.report.gaps]


def set_section(d: dict, section: str, value) -> dict:
    d = copy.deepcopy(d)
    if section == "thermal.cdus":
        d["thermal"]["cdus"] = value
    else:
        d[section] = value
    return d


# ============================================================================================================================ R2
SECTIONS = ("transformers", "ups", "btm_options", "thermal.cdus")


@pytest.mark.parametrize("section", SECTIONS)
@pytest.mark.parametrize("value", [0, False, True, "", "x", 0.0, 7, {}, {"a": 1}], ids=repr)
def test_r2_a_non_list_equipment_value_is_refused_naming_the_section(section, value):
    """Only an ABSENT key or an explicit null means "none declared". `ups: {}` was counted as supplied, read as an empty list and left can_issue True."""
    with pytest.raises(IntakeError) as e:
        load_document(set_section(REFERENCE, section, value))
    assert f"{section} must be a list of objects" in str(e.value) and "null" in str(e.value)


@pytest.mark.parametrize("section", SECTIONS)
def test_r2_null_and_absent_and_an_empty_list_behave_exactly_as_before(section):
    def view(d):
        it = load_document(d)
        return (it.report.can_issue, sorted(gap_paths(it)), round(it.report.completeness, 6), sorted(it.report.supplied))
    absent = copy.deepcopy(REFERENCE)
    if section == "thermal.cdus":
        absent["thermal"].pop("cdus", None)
    else:
        absent.pop(section, None)
    assert view(set_section(REFERENCE, section, None)) == view(set_section(REFERENCE, section, [])) == view(absent)


def test_r2_the_audit_cases():
    """falsy.py / falsy2.py / cdusfalsy.py: ups={} was issuable and the recommendation said complete while the report said UPPER BOUND."""
    for section in ("ups", "transformers"):
        assert not load_document(set_section(REFERENCE, section, [])).report.can_issue
        with pytest.raises(IntakeError):
            load_document(set_section(REFERENCE, section, {}))
    it = load_document(set_section(REFERENCE, "thermal.cdus", []))
    assert "thermal.cdus" in gap_paths(it)                       # the assumed-kit row is there, as for a null
    with pytest.raises(IntakeError):
        load_document(set_section(REFERENCE, "thermal.cdus", {}))


# ============================================================================================================================ R4
CDU = {"id": "CDU-A", "rated_capacity_kW": 700, "rated_approach_K": 5, "rated_flow_l_per_min": 1500, "units": 6, "redundancy": "2N"}


def with_cdu(**changes) -> dict:
    d = copy.deepcopy(DUBLIN)
    item = {**CDU, **changes}
    item = {k: v for k, v in item.items() if v is not None}
    d["thermal"]["cdus"] = [item]
    return d


@pytest.mark.parametrize("omit", ["units", "redundancy"])
def test_r4_an_omitted_cdu_units_or_redundancy_is_a_required_named_gap(omit):
    it = load_document(with_cdu(**{omit: None}))
    path = f"thermal.cdus[CDU-A].{omit}"
    assert path in {g.path for g in it.report.required_gaps}
    assert it.report.can_issue is False
    g = next(g for g in it.report.gaps if g.path == path)
    assert "nobody declared" in g.fallback_description and "(E0)" in g.fallback_description and g.why_it_binds and g.how_to_get_it


def test_r4_declared_cdus_have_no_per_item_gap_and_stay_issuable():
    it = load_document(with_cdu())
    assert not [p for p in gap_paths(it) if p.startswith("thermal.cdus[")]
    assert it.report.can_issue is True


def test_r4_the_default_is_unchanged_and_completeness_does_not_move():
    declared, omitted = load_document(with_cdu(units=1, redundancy="N+1")), load_document(with_cdu(units=None, redundancy=None))
    assert omitted.report.completeness == declared.report.completeness
    a, b = declared.context.thermal.cdus[0], omitted.context.thermal.cdus[0]
    assert (a.units, a.redundancy) == (b.units, b.redundancy) == (1, "N+1")


def test_r4_an_id_less_cdu_is_named_by_position():
    d = with_cdu(units=None, redundancy=None, id=None)
    assert {"thermal.cdus[0].units", "thermal.cdus[0].redundancy"} <= {g.path for g in load_document(d).report.required_gaps}


def test_r4_the_long_standing_optional_cdu_gaps_still_work():
    it = load_document(with_cdu(rated_approach_K=None, rated_flow_l_per_min=None))
    assert {"thermal.cdus.rated_approach_K", "thermal.cdus.rated_flow_l_per_min"} <= set(gap_paths(it))
    assert it.report.can_issue is True


def _cdu_row(d: dict):
    from gridforge.procurement import build_spec
    it = load_document(d)
    pkg = build_spec(it, next(x for x in run_all(it.context, it.scenarios) if x.spec.id == "hybrid_dlc"), constraint_id="ups_capacity")
    return next(c for c in pkg.site_conditions if c.label == "Redundancy, CDU bank CDU-A")


def test_r4_the_specification_says_supplied_only_for_what_was_declared():
    from gridforge.procurement.schema import SC_ASSUMED, SC_SUPPLIED
    row = _cdu_row(with_cdu())
    assert row.status == SC_SUPPLIED and "as declared in the CDU schedule" in row.statement
    row = _cdu_row(with_cdu(redundancy=None))
    assert row.status == SC_ASSUMED and "not supplied: assumed N+1 (E0)" in row.statement
    row = _cdu_row(with_cdu(units=None))
    assert row.status == SC_ASSUMED and "not supplied: assumed 1 unit(s) (E0)" in row.statement
    both = _cdu_row(with_cdu(units=None, redundancy=None))
    assert both.status == SC_ASSUMED and "assumed 1 unit(s)" in both.statement and "assumed N+1" in both.statement


def test_r4_with_no_cdu_schedule_the_assumed_kit_row_is_as_before():
    from gridforge.procurement import build_spec
    from gridforge.procurement.schema import SC_ASSUMED
    it = load_document(DUBLIN)
    r = next(x for x in run_all(it.context, it.scenarios) if x.spec.id == "hybrid_dlc")
    row = next(c for c in build_spec(it, r, constraint_id="ups_capacity").site_conditions if c.label.startswith("Redundancy, CDU bank"))
    assert row.status == SC_ASSUMED and "no CDU schedule" in row.statement


# ============================================================================================================================ R5
COMPLETE = "The intake is complete"


def _full_dublin() -> dict:
    d = copy.deepcopy(DUBLIN)
    d["thermal"]["cdus"] = [dict(CDU)]
    d["thermal"]["plant"]["existing_flow_l_per_min"] = 3000
    d["thermal"]["plant"]["existing_non_it_heat_kW"] = 500
    d["thermal"]["rdhx"] = {"capacity_kW_per_rack": 60}
    d["thermal"]["tcs_target_supply_C"] = 32
    d["thermal"]["cdu_approach_K"] = 5                       # the water gate's two approaches are named optional gaps when omitted
    d["thermal"]["plant"]["dry_cooler_approach_K"] = 8
    d["hall"]["occupied_positions"] = 140
    d["lv"]["existing_busway_load_kW"] = 1000
    d["economics"] = {"electricity_eur_per_MWh": 120, "horizon_years": 10, "discount_rate": 0.08}
    d["btm_options"][0].update(units=4, redundancy="N+1")
    return d


def test_r5_the_complete_sentence_is_for_a_document_with_no_gap_at_all():
    it = load_document(_full_dublin())
    assert it.report.gaps == [] and it.report.engagement_recommendation.startswith(COMPLETE)


def test_r5_open_optional_gaps_are_said_plainly_not_called_complete():
    it = load_document(DUBLIN)
    assert it.report.can_issue and it.report.gaps
    text = it.report.engagement_recommendation
    assert COMPLETE not in text
    assert "No required inputs are missing" in text and f"{len(it.report.gaps)} optional inputs are still assumptions" in text
    one = _full_dublin()
    one["hall"].pop("occupied_positions")
    assert "1 optional input is still an assumption" in load_document(one).report.engagement_recommendation


def test_r5_required_gap_wording_is_in_the_buyers_voice_and_agrees_in_number():
    """The text is shown verbatim to buyers on the free qualifier: it used to read '1 required inputs missing. Request them before starting', which
    is written to the seller and wrong in number."""
    london = load_document(example("london_hall")).report.engagement_recommendation
    assert london.startswith("1 required input is missing (UPS schedule). Please send it")
    assert "required inputs missing" not in london and "Request them" not in london


def test_r5_every_producer_agrees_the_screen_the_model_pack_the_payloads_and_the_cli(capsys):
    from gridforge.api import server as S
    from gridforge.api.tiers import Tier
    from gridforge.cli import cmd_gaps
    from gridforge.serialize import model_pack
    it = load_document(DUBLIN)
    md = S.handle_screen({"intake": DUBLIN, "format": "md"}, Tier.CLIENT)["document"]
    assert "Intake completeness is 90%" in md and COMPLETE not in md and "No required inputs are missing" in md
    assert COMPLETE not in model_pack(it, run_all(it.context, it.scenarios))["intake"]["engagement_recommendation"]
    assert COMPLETE not in S.handle_screen({"intake": DUBLIN}, Tier.CLIENT)["intake"]["recommended_engagement"]
    assert COMPLETE not in S.handle_qualify({"contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9}, Tier.PUBLIC)["intake"]["recommended_engagement"]

    class A:
        intake = str(ROOT / "examples" / "intake" / "dublin_hall.json")
    cmd_gaps(A())
    assert COMPLETE not in capsys.readouterr().out


# ============================================================================================================================ R6
FLOOR_IDS = ("E-01", "E-10", "E-20", "E-30", "T-01", "T-03", "T-20", "T-40")
CONDITION_IDS = ("E-02", "T-02", "T-04", "T-41", "G-01")


def _sig_unit(v: float, n: int) -> float:
    return 10 ** (math.floor(math.log10(abs(v))) - n + 1)


def _docs():
    for f in sorted(glob.glob(str(ROOT / "examples" / "intake" / "*.json"))):
        base = json.loads(Path(f).read_text(encoding="utf-8"))
        name = os.path.basename(f)
        yield name, base
        d = copy.deepcopy(base)
        d["thermal"]["plant"]["existing_non_it_heat_kW"] = 3000
        yield name + "+nonit3000", d


def _specs(d: dict):
    from gridforge.procurement import ProcurementError, build_spec, relief_steps
    it = load_document(d)
    for r in run_all(it.context, it.scenarios):
        for cid in sorted({s.binding_id for s in relief_steps(r)}):
            try:
                yield r.spec.id, cid, build_spec(it, r, constraint_id=cid)
            except ProcurementError:
                continue


def test_r6_a_minimum_is_rounded_up_to_its_printed_precision_never_below_the_exact_need(monkeypatch):
    from gridforge.procurement import build as B
    checked = {}
    for name, d in _docs():
        rounded = {(s, c): {q.id: q for q in pkg.requirements} for s, c, pkg in _specs(d)}
        monkeypatch.setattr(B, "_floor", lambda q: q)             # the exact, unrounded figures
        exact = {(s, c): {q.id: q for q in pkg.requirements} for s, c, pkg in _specs(d)}
        monkeypatch.undo()
        assert rounded.keys() == exact.keys()
        for key, reqs in rounded.items():
            for rid, q in reqs.items():
                e = exact[key][rid]
                if rid in CONDITION_IDS or q.value is None:
                    assert q.value == e.value or (q.value.value == e.value.value), (name, key, rid)      # untouched
                    continue
                if rid not in FLOOR_IDS:
                    continue
                n = q.value.sigfigs()
                assert q.value.value >= e.value.value * (1 - 1e-9), (name, key, rid, q.value.value, e.value.value)
                assert q.value.value - e.value.value <= _sig_unit(e.value.value, n) * (1 + 1e-9), (name, key, rid)
                assert q.value.value == q.value.rounded(), (name, key, rid)            # the printed figure and the value agree
                checked[rid] = checked.get(rid, 0) + 1
    assert {"E-20", "T-20", "T-01"} <= set(checked), checked


def test_r6_temperatures_approaches_and_counts_are_never_rounded_up():
    """Per generator, from what the clause says: a stated condition (a water temperature, an approach, a head, a count) is not a floor, and rounding an
    approach UP would overstate it. The values are compared with the unrounded run in the test above; here the definitions are checked directly."""
    from gridforge.procurement import build as B
    src = Path(B.__file__).read_text(encoding="utf-8")
    for rid in CONDITION_IDS:
        block = src.split(f'id="{rid}"', 1)[1].split("Requirement(", 1)[0]
        assert "_floor(" not in block, rid
    for rid in FLOOR_IDS:
        block = src.split(f'id="{rid}"', 1)[1].split("Requirement(", 1)[0]
        assert "_floor(" in block, rid


@pytest.mark.parametrize("name,hall", [("dublin", DUBLIN), ("nordic", NORDIC)])
def test_r6_the_plant_the_specification_asks_for_carries_the_racks_it_was_sized_for(name, hall):
    """Dublin full_dlc_btm with existing_non_it_heat_kW=3000 printed T-20 = 531 kW; the plant constraint then reached 68 racks, not the 69 it was sized for."""
    from gridforge.common import ASSUMED, V
    from gridforge.constraints import all_constraints
    from gridforge.procurement import ProcurementError, build_spec, relief_steps
    from gridforge.procurement.build import scenario_context
    plant = next(c for c in all_constraints() if c.__name__ == "plant_capacity")
    d = copy.deepcopy(hall)
    d["thermal"]["plant"]["existing_non_it_heat_kW"] = 3000
    it, n = load_document(d), 0
    for r in run_all(it.context, it.scenarios):
        if not any(s.binding_id == "plant_capacity" for s in relief_steps(r)):
            continue
        try:
            pkg = build_spec(it, r, constraint_id="plant_capacity")
        except ProcurementError:
            continue
        t20 = next(q for q in pkg.requirements if q.id == "T-20")
        c2 = scenario_context(it, r).copy()
        c2.thermal.plant.chilled_water_capacity_kW = V(c2.thermal.plant.chilled_water_capacity_kW.value + t20.value.rounded(), "kW", "cap+spec", ASSUMED)
        res = plant(c2)
        if "dry-cooler" in res.basis:
            continue
        assert res.racks >= pkg.sized_for_racks, (name, r.spec.id, res.racks, pkg.sized_for_racks, t20.value.rounded())
        n += 1
    assert n >= 1
