"""`thermal.plant.existing_flow_l_per_min`: the flow the existing hall already draws on the plant (optional).

Hand-worked on the reference hall (GB300 platform, 130 l/min per rack, pumped flow 9,000 l/min, pump uprate x1.8,
placeholder 420,000 / 7,200 = 58.333 EUR per l/min added). The expected numbers are written out here from those
figures, not read back from the engine.
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
from gridforge.thermal.constraints import hydraulic_flow
from gridforge.thermal.schema import Architecture

ROOT = Path(__file__).resolve().parents[1]
PATH = "thermal.plant.existing_flow_l_per_min"
REFERENCE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text(encoding="utf-8"))
PER_RACK = 130.0
PUMP = 9000.0
UPRATE = 1.8


def _ctx(existing=None):
    ctx = build_context()
    ctx.power.options = []
    if existing is not None:
        ctx.thermal.plant.existing_flow_l_per_min = V(existing, "l/min", "existing hall flow", CUSTOMER)
    return ctx


def _doc(existing=None, pump=None):
    d = copy.deepcopy(REFERENCE)
    if existing is not None:
        d["thermal"]["plant"]["existing_flow_l_per_min"] = existing
    if pump is not None:
        d["thermal"]["plant"]["pump_flow_capacity_l_per_min"] = pump
    return d


def _hydraulic(doc, scenario="hybrid_dlc"):
    intake = load_document(doc)
    res = next(r for r in run_all(intake.context, intake.scenarios) if r.spec.id == scenario)
    return intake, next(c for c in res.envelope.constraints if c.id == "hydraulic_flow")


# --- unit: subtraction and clamping ------------------------------------------------------------------------------
def test_subtracts_the_existing_draw_before_dividing_by_the_rack_flow():
    # (9,000 - 3,000) / 130 = 46.15 -> 46 racks; unsupplied it is 9,000 / 130 = 69.2 -> 69.
    assert hydraulic_flow(_ctx()).racks == 69
    assert hydraulic_flow(_ctx(3000)).racks == 46


def test_basis_states_both_numbers_and_the_subtraction():
    basis = hydraulic_flow(_ctx(3000)).basis
    # The pumped flow carries a band in this context, so compare the leading numbers, not the band text.
    assert basis.startswith("9,000 ") and " less 3,000 l/min" in basis and "= 6,000 " in basis
    assert "less" in basis and "already drawn by the existing hall" in basis
    assert "overstates if the figure is the plant's total" not in basis


def test_existing_flow_equal_to_the_pump_flow_leaves_zero_racks():
    assert hydraulic_flow(_ctx(PUMP)).racks == 0


def test_existing_flow_above_the_pump_flow_is_clamped_at_zero_never_negative():
    # Reachable only by building a context directly (the loader refuses it): the constraint still fails closed.
    res = hydraulic_flow(_ctx(12000))
    assert res.racks == 0
    assert "= 0 l/min" in res.basis


def test_retained_air_ignores_the_existing_flow():
    ctx = _ctx(3000)
    ctx.architecture = Architecture.RETAINED_AIR
    assert hydraulic_flow(ctx).racks == math.inf


# --- relief: the uprate scales the pump, not the existing draw ----------------------------------------------------
def test_pump_uprate_relief_arithmetic_with_a_non_zero_existing_flow():
    ctx = _ctx(3000)
    res = hydraulic_flow(ctx)
    # Hand: uprated pump = 9,000 x 1.8 = 16,200; less the unchanged 3,000 = 13,200; / 130 = 101.5 -> 101 racks.
    # (Had the uprate been applied to the net flow it would be (9,000-3,000) x 1.8 / 130 = 83.)
    relieved = res.relief.apply(ctx)
    assert relieved.thermal.plant.pump_flow_capacity_l_per_min.value == pytest.approx(16200.0)
    assert relieved.thermal.plant.existing_flow_l_per_min.value == 3000.0
    assert hydraulic_flow(relieved).racks == math.floor((PUMP * UPRATE - 3000) / PER_RACK) == 101
    # Price: flow ADDED is 80% of the pump capacity = 7,200 l/min whatever the existing draw; 7,200 x 58.333 = 420,000 EUR.
    assert res.relief.capex_eur.value == pytest.approx(7200 * (420_000 / 7200.0))
    assert res.relief.capex_eur.value == pytest.approx(hydraulic_flow(_ctx()).relief.capex_eur.value)
    assert res.relief.quantity == pytest.approx(PUMP * (UPRATE - 1))


# --- independent recomputation, through the loader ---------------------------------------------------------------
@pytest.mark.parametrize("existing", [0, 1500, 4000, 8999])
def test_independent_recomputation_of_the_hydraulic_count_from_the_raw_intake(existing):
    pump = REFERENCE["thermal"]["plant"]["pump_flow_capacity_l_per_min"]
    pump = pump["value"] if isinstance(pump, dict) else pump
    platforms = json.loads((ROOT / "public" / "reference" / "platforms.json").read_text(encoding="utf-8"))["platforms"]
    flow = next(p for p in platforms if p["id"] == REFERENCE["compute"]["platform"])["flow_l_per_min_per_rack"]
    _, c = _hydraulic(_doc(existing))
    assert c.racks == math.floor((pump - existing) / flow + 1e-9)


# --- metamorphic -------------------------------------------------------------------------------------------------
def test_more_existing_flow_never_increases_racks_and_zero_equals_unsupplied():
    rng = random.Random(20261105)
    for _ in range(25):
        pump = rng.uniform(2000, 40000)
        a, b = sorted(rng.uniform(0, pump) for _ in range(2))
        _, unsupplied = _hydraulic(_doc(pump=pump))
        _, zero = _hydraulic(_doc(0, pump=pump))
        _, low = _hydraulic(_doc(a, pump=pump))
        _, high = _hydraulic(_doc(b, pump=pump))
        assert zero.racks == unsupplied.racks
        assert high.racks <= low.racks <= unsupplied.racks


# --- loader ------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("bad, msg", [
    (-1, "cannot be negative"),
    ("lots", "number"),
    (True, "number"),
    (6_000_000, "plausib|exceed|above|ceiling|implausib"),
    (9001, "more than the pumped flow"),
])
def test_loader_refuses_nonsense_with_a_precise_message(bad, msg):
    with pytest.raises(IntakeError, match=msg) as e:
        load_document(_doc(bad))
    assert PATH in str(e.value)


@pytest.mark.parametrize("bad", [float("nan"), float("inf")])
def test_non_finite_is_refused(bad):
    with pytest.raises(IntakeError):
        load_document(_doc(bad))


def test_loader_refuses_existing_flow_above_a_placeholder_pump_flow_and_says_so():
    d = copy.deepcopy(REFERENCE)
    del d["thermal"]["plant"]["pump_flow_capacity_l_per_min"]
    d["thermal"]["plant"]["existing_flow_l_per_min"] = 20000
    with pytest.raises(IntakeError, match="not supplied"):
        load_document(d)


def test_supplied_figure_carries_the_pump_flow_evidence_class_and_its_provenance():
    spec = FIELD_BY_PATH[PATH]
    assert spec.supplied_evidence == FIELD_BY_PATH["thermal.plant.pump_flow_capacity_l_per_min"].supplied_evidence
    d = _doc({"value": 2500, "source": "BMS flow trend, March", "note": "all loops"})
    intake = load_document(d)
    flow = intake.context.thermal.plant.existing_flow_l_per_min
    assert flow.value == 2500 and flow.evidence == spec.supplied_evidence
    assert PATH in intake.report.supplied
    assert PATH not in [g.path for g in intake.report.gaps]
    assert any(s.path == PATH and s.source == "BMS flow trend, March" for s in intake.report.sourced)
    d["thermal"]["plant"]["existing_flow_l_per_min"]["evidence"] = "E9"
    with pytest.raises(IntakeError, match="not an evidence class"):
        load_document(d)


# --- unsupplied: nothing moves, and the field is asked for ---------------------------------------------------------
def test_unsupplied_hydraulic_result_and_completeness_are_the_long_standing_ones():
    intake, c = _hydraulic(_doc())
    assert intake.context.thermal.plant.existing_flow_l_per_min is None
    assert c.racks == 69
    assert c.basis.endswith("so this overstates if the figure is the plant's total")
    assert c.basis.startswith("9,000 l/min (E3) available against 130 [120–140] l/min (E0) per rack")
    # Completeness is counted over the fields it always was; the new optional one is neither numerator nor denominator.
    assert not FIELD_BY_PATH[PATH].counts_toward_completeness
    counted = [f.path for f in INTAKE_FIELDS if f.counts_toward_completeness]
    missing = {g.path for g in intake.report.gaps if g.path in counted}
    assert intake.report.completeness == pytest.approx((len(counted) - len(missing)) / len(counted))
    with_field = load_document(_doc(2000))
    assert with_field.report.completeness == pytest.approx(intake.report.completeness)


def test_data_request_lists_the_field_as_optional_with_why_it_matters(tmp_path, capsys):
    intake = load_document(_doc())
    gap = next(g for g in intake.report.gaps if g.path == PATH)
    assert not gap.required and gap.unit == "l/min"
    assert "TOTAL" in gap.why_it_binds and gap.how_to_get_it and gap.fallback_description
    p = tmp_path / "intake.json"
    p.write_text(json.dumps(_doc()), encoding="utf-8")
    cli_main(["gaps", str(p)])
    out = capsys.readouterr().out
    assert "[optional] Flow the existing hall already draws on the plant (l/min)" in out


def test_template_carries_the_field():
    assert blank_intake()["thermal"]["plant"]["existing_flow_l_per_min"] is None
