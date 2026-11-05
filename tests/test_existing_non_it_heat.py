"""`thermal.plant.existing_non_it_heat_kW`: other heat the existing hall already puts on the chilled-water plant (optional).

Hand-worked on the reference hall (GB300 platform, 135 kW per rack, plant 6,800 kW, IT load 4,900 kW, plant uprate x1.5,
placeholder 900,000 / 3,400 = 264.7 EUR per kW added). The expected numbers are written out here from those figures,
not read back from the engine.
"""
from __future__ import annotations

import copy
import json
import math
import random
from pathlib import Path

import pytest

from examples.reference_site import build_context
from gridforge.cli import main as cli_main
from gridforge.common import CUSTOMER, V
from gridforge.intake.loader import IntakeError, blank_intake, load_document
from gridforge.intake.schema import FIELD_BY_PATH, INTAKE_FIELDS
from gridforge.scenario import run_all
from gridforge.thermal.constraints import plant_capacity
from gridforge.thermal.schema import Architecture

ROOT = Path(__file__).resolve().parents[1]
PATH = "thermal.plant.existing_non_it_heat_kW"
REFERENCE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text(encoding="utf-8"))
PLANT = 6800.0
IT = 4900.0
PER_RACK = 135.0
UPRATE = 1.5


def _ctx(non_it=None):
    ctx = build_context()
    ctx.power.options = []
    if non_it is not None:
        ctx.thermal.plant.existing_non_it_heat_kW = V(non_it, "kW", "other heat on the plant", CUSTOMER)
    return ctx


def _doc(non_it=None, plant=None, it=None):
    d = copy.deepcopy(REFERENCE)
    if non_it is not None:
        d["thermal"]["plant"]["existing_non_it_heat_kW"] = non_it
    if plant is not None:
        d["thermal"]["plant"]["chilled_water_capacity_kW"] = plant
    if it is not None:
        d["grid"]["current_it_load_MW"] = it
    return d


def _plant(doc, scenario="hybrid_dlc"):
    intake = load_document(doc)
    res = next(r for r in run_all(intake.context, intake.scenarios) if r.spec.id == scenario)
    return intake, next(c for c in res.envelope.constraints if c.id == "plant_capacity")


# --- unit: subtraction and clamping ------------------------------------------------------------------------------
def test_subtracts_the_other_heat_after_the_it_load():
    # (6,800 - 4,900) / 135 = 14.07 -> 14 racks; 500 kW more: 1,400 / 135 = 10.37 -> 10; 1,500 kW: 400 / 135 = 2.96 -> 2.
    assert plant_capacity(_ctx()).racks == 14
    assert plant_capacity(_ctx(500)).racks == 10
    assert plant_capacity(_ctx(1500)).racks == 2


def test_basis_states_every_number_and_the_subtraction():
    basis = plant_capacity(_ctx(500)).basis
    assert basis.startswith("1,400 kW") and "6,800 kW" in basis and "4,900 kW" in basis and "500 kW" in basis
    assert "less" in basis and "other heat the existing hall already puts on the plant" in basis
    assert "plant capacity less the IT load only" not in basis


def test_other_heat_that_uses_up_the_headroom_leaves_zero_racks_never_negative():
    assert plant_capacity(_ctx(1900)).racks == 0
    res = plant_capacity(_ctx(4000))   # reachable only by building a context directly (the loader refuses a figure above the plant)
    assert res.racks == 0
    assert "0 kW" in res.basis


def test_retained_air_uses_the_same_subtraction_against_the_whole_rack_load():
    ctx = _ctx(500)
    ctx.architecture = Architecture.RETAINED_AIR
    assert plant_capacity(ctx).racks == math.floor((PLANT - IT - 500) / PER_RACK)


# --- relief: the uprate scales capacity only ----------------------------------------------------------------------
def test_plant_uprate_relief_arithmetic_with_other_heat():
    ctx = _ctx(500)
    res = plant_capacity(ctx)
    # Hand: uprated capacity = 6,800 x 1.5 = 10,200; less IT 4,900; less other heat 500 (unchanged) = 4,800; / 135 = 35.6 -> 35 racks.
    # (Had the uprate scaled the net headroom it would be 1,400 x 1.5 / 135 = 15.)
    relieved = res.relief.apply(ctx)
    assert relieved.thermal.plant.chilled_water_capacity_kW.value == pytest.approx(10200.0)
    assert relieved.thermal.plant.existing_non_it_heat_kW.value == 500.0
    assert plant_capacity(relieved).racks == math.floor((PLANT * UPRATE - IT - 500) / PER_RACK) == 35
    # Price: kW ADDED is 50% of the plant = 3,400 kW whatever the other heat; 3,400 x (900,000 / 3,400) = 900,000 EUR.
    assert res.relief.capex_eur.value == pytest.approx(900_000.0)
    assert res.relief.capex_eur.value == pytest.approx(plant_capacity(_ctx()).relief.capex_eur.value)
    assert res.relief.quantity == pytest.approx(PLANT * (UPRATE - 1))
    assert res.relief.cost_key == "plant.uprate"


# --- independent recomputation, through the loader ---------------------------------------------------------------
@pytest.mark.parametrize("non_it", [0, 250, 900, 1899, 1900, 2500, 6800])
def test_independent_recomputation_of_the_plant_count_from_the_raw_intake(non_it):
    plant = REFERENCE["thermal"]["plant"]["chilled_water_capacity_kW"]
    plant = plant["value"] if isinstance(plant, dict) else plant
    it_kw = REFERENCE["grid"]["current_it_load_MW"] * 1000.0
    platforms = json.loads((ROOT / "public" / "reference" / "platforms.json").read_text(encoding="utf-8"))["platforms"]
    rack_kw = next(p for p in platforms if p["id"] == REFERENCE["compute"]["platform"])["rack_kW"]
    _, c = _plant(_doc(non_it))
    assert c.racks == math.floor(max(plant - it_kw - non_it, 0.0) / rack_kw + 1e-9)


@pytest.mark.parametrize("non_it", [0, 500, 1500])
def test_independent_recomputation_of_the_uprated_count_from_the_raw_intake(non_it):
    plant = REFERENCE["thermal"]["plant"]["chilled_water_capacity_kW"]
    it_kw = REFERENCE["grid"]["current_it_load_MW"] * 1000.0
    intake, c = _plant(_doc(non_it))
    relieved = plant_capacity(c.relief.apply(intake.context.copy()))
    assert relieved.racks == math.floor((plant * 1.5 - it_kw - non_it) / 135.0 + 1e-9)


# --- metamorphic -------------------------------------------------------------------------------------------------
def test_more_other_heat_never_increases_racks_and_zero_equals_unsupplied():
    rng = random.Random(20261105)
    for _ in range(25):
        plant = rng.uniform(3000, 60000)
        it = rng.uniform(0.5, plant / 1000.0 * 0.9)      # MW, below the plant so the unsupplied count is non-trivial
        a, b = sorted(rng.uniform(0, plant) for _ in range(2))
        _, unsupplied = _plant(_doc(plant=plant, it=it))
        _, zero = _plant(_doc(0, plant=plant, it=it))
        _, low = _plant(_doc(a, plant=plant, it=it))
        _, high = _plant(_doc(b, plant=plant, it=it))
        assert zero.racks == unsupplied.racks
        assert high.racks <= low.racks <= unsupplied.racks
        assert high.racks >= 0


def test_uprated_count_never_falls_below_the_base_count_for_any_other_heat():
    rng = random.Random(7)
    for _ in range(15):
        non_it = rng.uniform(0, 5000)
        ctx = _ctx(non_it)
        assert plant_capacity(plant_capacity(ctx).relief.apply(ctx)).racks >= plant_capacity(ctx).racks


# --- loader ------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("bad, msg", [
    (-1, "cannot be negative"),
    ("lots", "number"),
    (True, "number"),
    (3_000_000, "plausib|exceed|above|ceiling|implausib"),
    (6801, "more than the chilled-water plant capacity of 6800 kW"),
])
def test_loader_refuses_nonsense_with_a_precise_message(bad, msg):
    with pytest.raises(IntakeError, match=msg) as e:
        load_document(_doc(bad))
    assert PATH in str(e.value)


def test_the_refusal_for_a_figure_above_the_plant_names_both_numbers():
    with pytest.raises(IntakeError) as e:
        load_document(_doc(7000))
    assert "7000 kW" in str(e.value) and "6800 kW" in str(e.value)


@pytest.mark.parametrize("bad", [float("nan"), float("inf")])
def test_non_finite_is_refused(bad):
    with pytest.raises(IntakeError):
        load_document(_doc(bad))


def test_a_figure_equal_to_the_plant_is_accepted_and_leaves_zero_racks():
    _, c = _plant(_doc(6800))
    assert c.racks == 0


def test_loader_refuses_other_heat_above_a_placeholder_plant_and_says_so():
    d = copy.deepcopy(REFERENCE)
    del d["thermal"]["plant"]["chilled_water_capacity_kW"]
    d["thermal"]["plant"]["existing_non_it_heat_kW"] = 20000
    with pytest.raises(IntakeError, match="not supplied"):
        load_document(d)


def test_supplied_figure_carries_the_neighbouring_plant_field_evidence_class_and_its_provenance():
    spec = FIELD_BY_PATH[PATH]
    assert spec.supplied_evidence == FIELD_BY_PATH["thermal.plant.pump_flow_capacity_l_per_min"].supplied_evidence
    d = _doc({"value": 600, "source": "BMS plant trend less metered IT, March", "note": "UPS losses, fan walls"})
    intake = load_document(d)
    q = intake.context.thermal.plant.existing_non_it_heat_kW
    assert q.value == 600 and q.evidence == spec.supplied_evidence
    assert PATH in intake.report.supplied
    assert PATH not in [g.path for g in intake.report.gaps]
    assert any(s.path == PATH and s.source == "BMS plant trend less metered IT, March" for s in intake.report.sourced)
    d["thermal"]["plant"]["existing_non_it_heat_kW"]["evidence"] = "E9"
    with pytest.raises(IntakeError, match="not an evidence class"):
        load_document(d)


# --- unsupplied: nothing moves, and the field is asked for ---------------------------------------------------------
def test_unsupplied_plant_result_and_completeness_are_the_long_standing_ones():
    intake, c = _plant(_doc())
    assert intake.context.thermal.plant.existing_non_it_heat_kW is None
    assert c.racks == 14
    assert c.basis == (
        "1,900 kW (E3) of plant headroom against 135 [132–142] kW (E0) per rack — full rack load (rack heat rejected into the existing "
        "plant). Modelling limit: the headroom is plant capacity less the IT load only; UPS, fan and pump heat, plant redundancy and "
        "condenser derating are not modelled, so headroom is overstated by their share")
    assert not FIELD_BY_PATH[PATH].counts_toward_completeness
    counted = [f.path for f in INTAKE_FIELDS if f.counts_toward_completeness]
    missing = {g.path for g in intake.report.gaps if g.path in counted}
    assert intake.report.completeness == pytest.approx((len(counted) - len(missing)) / len(counted))
    assert load_document(_doc(600)).report.completeness == pytest.approx(intake.report.completeness)


def test_a_supplied_figure_changes_no_other_constraint():
    base_intake = load_document(_doc())
    with_intake = load_document(_doc(500))
    for scen in ("hybrid_dlc", "full_dlc"):
        a = next(r for r in run_all(base_intake.context, base_intake.scenarios) if r.spec.id == scen)
        b = next(r for r in run_all(with_intake.context, with_intake.scenarios) if r.spec.id == scen)
        ca = {c.id: (c.racks, c.basis) for c in a.envelope.constraints if c.id != "plant_capacity"}
        cb = {c.id: (c.racks, c.basis) for c in b.envelope.constraints if c.id != "plant_capacity"}
        assert ca == cb


def test_data_request_lists_the_field_as_optional_with_why_it_matters(tmp_path, capsys):
    intake = load_document(_doc())
    gap = next(g for g in intake.report.gaps if g.path == PATH)
    assert not gap.required and gap.unit == "kW"
    assert "UPS" in gap.why_it_binds and gap.how_to_get_it and gap.fallback_description
    p = tmp_path / "intake.json"
    p.write_text(json.dumps(_doc()), encoding="utf-8")
    cli_main(["gaps", str(p)])
    out = capsys.readouterr().out
    assert "[optional] Other heat the existing hall already puts on the plant (kW)" in out


def test_template_carries_the_field():
    assert blank_intake()["thermal"]["plant"]["existing_non_it_heat_kW"] is None
