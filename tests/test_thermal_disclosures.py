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
from gridforge.envelope import solve
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
    assert f"({peak:g} kW) is used by no constraint" in basis
    assert "thermal constraint" not in basis


#: Where the engine may mention the rack peak at all: the library that defines it, the reference catalogue that lists it, and the one
#: disclosure that prints it. Anywhere else is a constraint (or anything else) that has started to depend on it.
#: compute/library.py::_require_rack_power only refuses a non-positive or non-finite peak at load; it limits no racks.
PEAK_READERS_ALLOWED = {("compute/library.py", "_require_rack_power"), ("reference/build.py", "platform_payload"),
                        ("thermal/constraints.py", "architecture_capability")}


def _peak_mentions() -> set[tuple[str, str]]:
    """Every place in gridforge/ that reads 'peak_rack_kW': attribute access, getattr(...)/.get(...)/x[...] with the string, or
    any string constant naming it that is not a dict-literal key or a keyword argument (those only write)."""
    found: set[tuple[str, str]] = set()
    for path in sorted(ROOT.rglob("*.py")):
        rel = str(path.relative_to(ROOT))
        tree = ast.parse(path.read_text(encoding="utf-8"))
        owner: dict[int, str] = {}
        for fn in ast.walk(tree):
            if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for n in ast.walk(fn):
                    owner[id(n)] = fn.name
        dict_keys = {id(k) for d in ast.walk(tree) if isinstance(d, ast.Dict) for k in d.keys if k is not None}
        for n in ast.walk(tree):
            hit = (isinstance(n, ast.Attribute) and n.attr == "peak_rack_kW" and isinstance(n.ctx, ast.Load)) or \
                  (isinstance(n, ast.Constant) and n.value == "peak_rack_kW" and id(n) not in dict_keys)
            if hit:
                found.add((rel, owner.get(id(n), "<module>")))
    return found


def test_the_gb300_peak_is_155_and_no_constraint_reads_it():
    assert PLATFORMS["gb300_nvl72"].peak_rack_kW.value == 155
    extra = _peak_mentions() - PEAK_READERS_ALLOWED
    assert not extra, f"something new reads peak_rack_kW: {sorted(extra)}"
    assert not any(rel.startswith(("power/", "site/", "envelope/", "economics/", "scenario/")) for rel, _ in _peak_mentions())


def _example_contexts():
    import json
    from gridforge.intake.loader import load_document
    out = [("reference_site", build_context())]
    for n in ("reference_hall", "dublin_hall", "london_hall", "nordic_hall"):
        doc = json.loads((ROOT.parent / "examples" / "intake" / f"{n}.json").read_text(encoding="utf-8"))
        out.append((n, load_document(doc).context))
    return out


@pytest.mark.parametrize("architecture", list(Architecture))
def test_changing_the_rack_peak_moves_no_constraint_in_any_hall_or_architecture(architecture):
    import dataclasses
    import re
    own = re.compile(r"\. Modelling limit: the platform's peak rack power \([\d.]+ kW\) is used by no constraint; every limit is "
                     r"sized on the rack power \(TDP\) figure")
    for name, base in _example_contexts():
        a, b = base.copy(), base.copy()
        a.architecture = b.architecture = architecture
        b.cluster.platform = dataclasses.replace(b.cluster.platform, peak_rack_kW=V(400, "kW", "perturbed peak", ESTIMATED))
        for fn in all_constraints():
            ra, rb = fn(a), fn(b)
            assert ra.racks == rb.racks, (name, architecture, fn.__name__)
            assert own.sub("", ra.basis) == own.sub("", rb.basis), (name, architecture, fn.__name__)
            assert ra.notes == rb.notes
        assert solve(a).max_racks == solve(b).max_racks, (name, architecture)


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
