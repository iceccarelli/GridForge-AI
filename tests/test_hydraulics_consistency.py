"""The hydraulic_flow constraint's flow figure, checked from first principles, and the 1.45 l/min/kW constant that no constraint reads.

The constraint divides the plant's pumped flow by the PLATFORM's own library flow per rack (compute/library.py), not by the thermal
library's 1.45 l/min/kW (the water figure at a 10 K delta-T). This test does not change which figure is used. It checks, from
Q = P / (rho x cp x dT) with water at 0.997 kg/l and 4.19 kJ/kg.K, what delta-T each platform's flow implies, and that wherever that
differs from the 10 K reference the discrepancy is disclosed in the constraint's basis. It also pins that the unused constant is
marked reference-only, and that it really is unread (changing it moves no constraint).
"""
from __future__ import annotations

import ast
import pathlib

import pytest

from examples.reference_site import build_context
from gridforge.common import ESTIMATED, V
from gridforge.compute.library import PLATFORMS
from gridforge.constraints import all_constraints
from gridforge.thermal import library
from gridforge.thermal.constraints import hydraulic_flow
from gridforge.thermal.schema import Architecture

RHO_KG_PER_L = 0.997
CP_KJ_PER_KG_K = 4.19
SCREENING_DELTA_T_K = 10.0           # the 10 K behind the 1.45 l/min/kW reference
DISCLOSE_ABOVE_K = 1.0               # a flow that implies a delta-T more than this far from 10 K must say so
ROOT = pathlib.Path(__file__).resolve().parent.parent / "gridforge"


def implied_dT(power_kW: float, flow_l_per_min: float) -> float:
    """Q[l/min] = P[kW] x 60 / (rho x cp x dT)  =>  dT = P x 60 / (Q x rho x cp). Independent of the engine's own helper."""
    return power_kW * 60.0 / (flow_l_per_min * RHO_KG_PER_L * CP_KJ_PER_KG_K)


def _ctx(platform_id: str, *, existing_flow: float | None = None):
    ctx = build_context()
    ctx.cluster.platform = PLATFORMS[platform_id]
    if existing_flow is not None:
        ctx.thermal.plant.existing_flow_l_per_min = V(existing_flow, "l/min", "existing hall draw", ESTIMATED)
    return ctx


# ------------------------------------------------------------------------------------------------------ (a) the delta-T
def test_reference_constant_is_the_water_figure_at_ten_kelvin():
    per_kW = 60.0 / (RHO_KG_PER_L * CP_KJ_PER_KG_K * SCREENING_DELTA_T_K)        # 1.4364 l/min per kW
    assert per_kW == pytest.approx(1.436, abs=0.001)
    assert library.FLOW_L_PER_MIN_PER_KW.value == pytest.approx(per_kW, rel=0.02)


@pytest.mark.parametrize("platform_id", sorted(PLATFORMS))
def test_each_platform_flow_implies_a_physical_delta_T(platform_id):
    p = PLATFORMS[platform_id]
    on_liquid = implied_dT(p.rack_kW.value * p.liquid_fraction.value, p.flow_l_per_min_per_rack.value)
    on_rack = implied_dT(p.rack_kW.value, p.flow_l_per_min_per_rack.value)
    assert 5.0 <= on_liquid <= on_rack <= 20.0, (platform_id, on_liquid, on_rack)


def test_the_gb300_per_kW_figures_are_printed_in_the_unit_notation_a_reader_searches_for():
    basis = hydraulic_flow(_ctx("gb300_nvl72")).basis
    assert "0.963 l/min/kW of rack power (1.07 l/min/kW of the liquid-captured heat)" in basis


def test_the_gb300_numbers_the_owner_asked_about():
    p = PLATFORMS["gb300_nvl72"]
    assert p.flow_l_per_min_per_rack.value / p.rack_kW.value == pytest.approx(0.963, abs=0.001)     # not 1.45
    assert implied_dT(p.rack_kW.value * p.liquid_fraction.value, 130) == pytest.approx(13.4, abs=0.05)
    assert implied_dT(p.rack_kW.value, 130) == pytest.approx(14.9, abs=0.05)
    assert 135 * 60.0 / (RHO_KG_PER_L * CP_KJ_PER_KG_K * SCREENING_DELTA_T_K) == pytest.approx(193.9, abs=0.2)   # l/min at 10 K


def test_the_generic_platform_states_ten_kelvin_and_its_flow_matches_it():
    """The only platform whose library label states a per-kW flow (1.44 l/min/kW, i.e. 10 K on the whole rack power)."""
    p = PLATFORMS["generic_dlc_50"]
    assert "1.44 l/min/kW" in p.flow_l_per_min_per_rack.prov.label
    assert implied_dT(p.rack_kW.value, p.flow_l_per_min_per_rack.value) == pytest.approx(SCREENING_DELTA_T_K, abs=0.5)


@pytest.mark.parametrize("existing_flow", [None, 1000.0])
@pytest.mark.parametrize("platform_id", sorted(PLATFORMS))
def test_a_flow_that_departs_from_ten_kelvin_is_disclosed_in_the_basis(platform_id, existing_flow):
    p = PLATFORMS[platform_id]
    liquid = implied_dT(p.rack_kW.value * p.liquid_fraction.value, p.flow_l_per_min_per_rack.value)
    rack = implied_dT(p.rack_kW.value, p.flow_l_per_min_per_rack.value)
    basis = hydraulic_flow(_ctx(platform_id, existing_flow=existing_flow)).basis
    assert basis.count("Flow basis:") == 1, basis                       # once, never duplicated
    assert f"{liquid:.1f} K" in basis and f"{rack:.1f} K" in basis, basis
    # the per-kW flow is stated as a number next to l/min/kW, for both readings, recomputed here from the platform's own figures
    per_rack_kW = p.flow_l_per_min_per_rack.value / p.rack_kW.value
    per_liquid_kW = p.flow_l_per_min_per_rack.value / (p.rack_kW.value * p.liquid_fraction.value)
    assert f"{per_rack_kW:.3f} l/min/kW of rack power" in basis, basis
    assert f"({per_liquid_kW:.2f} l/min/kW of the liquid-captured heat)" in basis, basis
    assert "is not used by any constraint" in basis or "not itself used by any constraint" in basis   # the reference is named unused
    assert "without converting" in basis                                  # facility vs rack-side loop, named
    if abs(liquid - SCREENING_DELTA_T_K) > DISCLOSE_ABOVE_K:
        # the departure from the 10 K reference is stated as a difference, in one string with the per-kW unit and "flow"
        assert ("the platform figure and the 10 K / 1.45 l/min/kW screening reference in the thermal library differ, and the "
                "screening reference is not used by any constraint") in basis
        assert "flow" in basis and "l/min/kW" in basis


@pytest.mark.parametrize("platform_id", sorted(PLATFORMS))
def test_the_direction_of_the_plant_versus_rack_side_delta_T_is_stated_from_the_heat_balance(platform_id):
    """flow = heat / (rho cp dT): a plant delta-T smaller than the rack-side one needs MORE flow per rack than the platform figure,
    so dividing the pumped flow by the platform figure can overstate the racks; a larger plant delta-T can understate them."""
    for supply, ret in ((6.0, 12.0), (18.0, 26.0), (20.0, 30.0), (10.0, 30.0)):          # the example halls' 6/8/10 K, and 20 K
        ctx = _ctx(platform_id)
        ctx.thermal.plant.design_supply_C = V(supply, "degC", "plant supply", ESTIMATED)
        ctx.thermal.plant.design_return_C = V(ret, "degC", "plant return", ESTIMATED)
        p = PLATFORMS[platform_id]
        liquid = implied_dT(p.rack_kW.value * p.liquid_fraction.value, p.flow_l_per_min_per_rack.value)
        basis = hydraulic_flow(ctx).basis
        plant_flow_needed = p.rack_kW.value * p.liquid_fraction.value * 60.0 / (RHO_KG_PER_L * CP_KJ_PER_KG_K * (ret - supply))
        if ret - supply < liquid:
            assert plant_flow_needed > p.flow_l_per_min_per_rack.value               # the physics behind the sentence
            assert "can overstate the racks it supports" in basis and "can understate" not in basis
        else:
            assert plant_flow_needed < p.flow_l_per_min_per_rack.value
            assert "can understate the racks it supports" in basis and "can overstate" not in basis


def test_rdhx_is_not_described_as_having_a_cdu_or_tcs_loop():
    ctx = _ctx("gb300_nvl72")
    ctx.architecture = Architecture.RDHX
    basis = hydraulic_flow(ctx).basis
    flow_part = basis[basis.index("Flow basis:"):]
    assert "TCS" not in flow_part and "CDU" not in flow_part and "two loops" not in flow_part
    assert "Flow basis:" in basis and hydraulic_flow(ctx).racks == 69
    for arch in (Architecture.HYBRID_DLC, Architecture.FULL_DLC):
        ctx.architecture = arch
        assert "rack-side (TCS) delta-T" in hydraulic_flow(ctx).basis


def test_the_basis_names_the_plant_delta_T_so_the_two_loops_can_be_told_apart():
    ctx = _ctx("gb300_nvl72")
    plant_dT = ctx.thermal.plant.design_return_C.value - ctx.thermal.plant.design_supply_C.value        # 12 - 6 = 6 K
    assert plant_dT == 6.0
    assert "plant's own design delta-T is 6 K and" in hydraulic_flow(ctx).basis


def test_disclosure_changes_no_number():
    """hydraulic_flow still divides pumped flow by the platform's flow per rack: 9,000 / 130 = 69.2 -> 69 racks (reference hall)."""
    assert hydraulic_flow(_ctx("gb300_nvl72")).racks == 69
    assert hydraulic_flow(_ctx("gb300_nvl72", existing_flow=1000.0)).racks == 61          # (9,000 - 1,000) / 130 = 61.5


def test_retained_air_has_no_liquid_circuit_and_no_flow_disclosure():
    ctx = _ctx("gb300_nvl72")
    ctx.architecture = Architecture.RETAINED_AIR
    assert "Flow basis" not in hydraulic_flow(ctx).basis


# --------------------------------------------------------------------------- (b) the constant no constraint reads
def _reads_of_the_unused_constant() -> list[str]:
    """Every read of FLOW_L_PER_MIN_PER_KW, or of a ThermalInput's .flow_l_per_min_per_kW, anywhere in the engine."""
    hits = []
    for path in sorted(ROOT.rglob("*.py")):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and node.attr == "flow_l_per_min_per_kW" and isinstance(node.ctx, ast.Load):
                hits.append(f"{path.relative_to(ROOT)}:{node.lineno}")
            if isinstance(node, ast.Name) and node.id == "FLOW_L_PER_MIN_PER_KW" and isinstance(node.ctx, ast.Load):
                hits.append(f"{path.relative_to(ROOT)}:{node.lineno}")
            if isinstance(node, ast.ImportFrom) and any(a.name == "FLOW_L_PER_MIN_PER_KW" for a in node.names):
                hits.append(f"{path.relative_to(ROOT)}:{node.lineno} (import)")
    return hits


def test_the_unused_flow_constant_is_read_by_a_constraint_or_marked_reference_only():
    reads = _reads_of_the_unused_constant()
    read_by_a_constraint = [h for h in reads if "constraints" in h.split(":")[0]]
    if read_by_a_constraint:
        return                                                            # it is a live input: nothing more to assert
    source = (ROOT / "thermal" / "library.py").read_text(encoding="utf-8")
    comment_block = source[: source.index("FLOW_L_PER_MIN_PER_KW = V(")]
    assert "REFERENCE-ONLY" in comment_block.split("\n\n")[-1], "the unused constant needs a REFERENCE-ONLY comment directly above it"
    assert any("Reference only" in a for a in library.FLOW_L_PER_MIN_PER_KW.prov.assumptions)
    schema = (ROOT / "thermal" / "schema.py").read_text(encoding="utf-8")
    assert "reference only" in schema.split("flow_l_per_min_per_kW:")[0].rstrip().splitlines()[-1].lower()


def test_the_constant_really_is_unread_changing_it_moves_no_constraint():
    base = build_context()
    moved = build_context()
    moved.thermal.flow_l_per_min_per_kW = V(9.99, "l/min/kW", "perturbed reference flow", ESTIMATED)
    before = [(c.id, c.racks, c.basis) for c in (fn(base) for fn in all_constraints())]
    after = [(c.id, c.racks, c.basis) for c in (fn(moved) for fn in all_constraints())]
    assert before == after
