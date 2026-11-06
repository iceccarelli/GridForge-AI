"""Disclosure-only checks for the thermal engine assumptions the owner has reserved (docs/EXECUTION_STATE.md).

Nothing here asserts a changed engineering number. Each test pins either that a limit is DISCLOSED where a reader meets it (once,
never duplicated) or that the behaviour being disclosed is real (PUE does not respond to the climate, the rack peak is read by no
thermal constraint), so a future change to the behaviour cannot silently leave the disclosure stale.
"""
from __future__ import annotations

import ast
import pathlib

import pytest

from examples.reference_site import SCENARIOS, build_context
from gridforge.common import ESTIMATED, V
from gridforge.compute.library import PLATFORMS
from gridforge.constraints import all_constraints
from gridforge.envelope.time_to_power import SCHEDULE_LIMITATION
from gridforge.power.constraints import grid_firm_capacity
from gridforge.scenario import run
from gridforge.thermal import library
from gridforge.thermal.constraints import architecture_capability, plant_capacity
from gridforge.thermal.library import PUE_BY_ARCHITECTURE, PUE_FIXED_NOTE
from gridforge.thermal.schema import Architecture

ROOT = pathlib.Path(__file__).resolve().parent.parent / "gridforge"


# ------------------------------------------------------------------------------------ (i) plant_capacity: no redundancy
@pytest.mark.parametrize("other_heat", [None, 500.0])
def test_plant_capacity_says_plant_redundancy_is_not_modelled_once(other_heat):
    ctx = build_context()
    if other_heat is not None:
        ctx.thermal.plant.existing_non_it_heat_kW = V(other_heat, "kW", "other heat", ESTIMATED)
    basis = plant_capacity(ctx).basis
    assert basis.count("plant redundancy") == 1, basis
    assert "not modelled" in basis


def test_plant_capacity_without_other_heat_says_only_the_it_load_is_subtracted():
    basis = plant_capacity(build_context()).basis
    assert "plant capacity less the IT load only" in basis and "overstated" in basis


# ------------------------------------------------------------------------------------------- (ii) rack peak power unused
@pytest.mark.parametrize("platform_id", sorted(PLATFORMS))
@pytest.mark.parametrize("architecture", list(Architecture))
def test_architecture_capability_discloses_that_the_rack_peak_is_not_used(platform_id, architecture):
    ctx = build_context()
    ctx.cluster.platform = PLATFORMS[platform_id]
    ctx.architecture = architecture
    basis = architecture_capability(ctx).basis
    peak = PLATFORMS[platform_id].peak_rack_kW.value
    assert basis.count("peak rack power") == 1, basis
    assert f"({peak:g} kW) is not used in this or any other thermal constraint" in basis


def test_the_gb300_peak_is_155_and_the_only_thermal_read_is_the_disclosure_itself():
    assert PLATFORMS["gb300_nvl72"].peak_rack_kW.value == 155
    readers = []
    for path in sorted((ROOT / "thermal").rglob("*.py")):
        for fn in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if isinstance(fn, ast.FunctionDef):
                if any(isinstance(n, ast.Attribute) and n.attr == "peak_rack_kW" and isinstance(n.ctx, ast.Load)
                       for n in ast.walk(fn)):
                    readers.append(fn.name)
    assert readers == ["architecture_capability"]       # which only prints it; the next test shows it limits nothing


def test_changing_the_rack_peak_moves_no_constraint_but_its_own_disclosure():
    import dataclasses
    a, b = build_context(), build_context()
    b.cluster.platform = dataclasses.replace(b.cluster.platform, peak_rack_kW=V(400, "kW", "perturbed peak", ESTIMATED))
    for fn in all_constraints():
        ra, rb = fn(a), fn(b)
        assert ra.racks == rb.racks, fn.__name__
        if fn.__name__ != "architecture_capability":
            assert ra.basis == rb.basis, fn.__name__


# ------------------------------------------------------------------ (iii) a supplied lead time is E0: already disclosed
def test_the_date_limitation_already_says_a_supplied_lead_time_is_still_e0():
    text = " ".join(SCHEDULE_LIMITATION.split())
    assert "Every lead time here is an assumption (E0), whether a library placeholder or a figure the customer supplied" in text
    assert text.count("supplied") == 1                       # stated once, not repeated


# ----------------------------------------------------------------------------------------- PUE does not respond to climate
CLIMATES = [(20.0, 12.0, 0.0), (34.0, 21.0, 2600.0), (45.0, 30.0, 5000.0), (60.0, 45.0, 8760.0)]


@pytest.mark.parametrize("spec", SCENARIOS, ids=lambda s: s.id)
def test_pue_is_the_fixed_architecture_constant_whatever_the_climate(spec):
    seen = set()
    for dry, wet, free_h in CLIMATES:
        base = build_context()
        base.site.design_drybulb_C = V(dry, "degC", "dry bulb under test", ESTIMATED)
        base.site.design_wetbulb_C = V(wet, "degC", "wet bulb under test", ESTIMATED)
        base.thermal.plant.free_cooling_hours_per_year = V(free_h, "h", "free cooling hours under test", ESTIMATED)
        res = run(base, spec)
        assert res.context.pue.value == PUE_BY_ARCHITECTURE[spec.architecture].value
        seen.add(res.context.pue.value)
    assert len(seen) == 1


def test_the_pue_divides_peak_headroom_so_the_headroom_in_racks_is_climate_blind():
    results = set()
    for dry, wet, free_h in CLIMATES:
        ctx = build_context()
        ctx.site.design_drybulb_C = V(dry, "degC", "dry bulb under test", ESTIMATED)
        ctx.site.design_wetbulb_C = V(wet, "degC", "wet bulb under test", ESTIMATED)
        ctx.thermal.plant.free_cooling_hours_per_year = V(free_h, "h", "free cooling hours under test", ESTIMATED)
        results.add(grid_firm_capacity(ctx).racks)
    assert len(results) == 1


@pytest.mark.parametrize("architecture", list(Architecture))
def test_every_pue_figure_carries_the_fixed_figure_disclosure_exactly_once(architecture):
    pue = PUE_BY_ARCHITECTURE[architecture]
    assert list(pue.prov.assumptions).count(PUE_FIXED_NOTE) == 1
    assert "not recomputed for this site's climate" in PUE_FIXED_NOTE


def test_the_pue_disclosure_travels_with_the_headroom_it_divides_into():
    ctx = build_context()
    assert PUE_FIXED_NOTE in grid_firm_capacity(ctx).max_racks.prov.all_assumptions()


def test_the_library_comment_states_pue_does_not_respond_to_climate():
    source = (ROOT / "thermal" / "library.py").read_text(encoding="utf-8")
    block = source[source.index("# PUE by architecture."): source.index("PUE_BY_ARCHITECTURE: dict")]
    assert "do\n# not respond to the site's dry-bulb or wet-bulb design temperature, free-cooling hours" in block
    assert library.PUE_FIXED_NOTE in block or "PUE_FIXED_NOTE" in block
