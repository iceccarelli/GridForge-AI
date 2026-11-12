"""The procurement specification must agree with the engine's own physics.

A buyer sends this document to suppliers. A requirement that is lower than what the capacity model itself needs
for the same racks is an under-sized order: the supplier meets the specification, the hall still does not host
the racks. These tests compare the specification with the engine, not with a number typed into a test:

  T1  T-20 (additional plant capacity) is the load the engine charges the existing plant for the racks the
      programme reaches, less the plant headroom the engine computes, for EVERY cooling architecture. The oracle
      is the engine's own ``plant_capacity`` constraint: the smallest plant capacity at which it passes N racks.
      The specification is also built from the scenario it tenders, never from the intake's default context.
  T3  A requirement is never stated with an evidence class stronger than the quantities it was computed from
      (arithmetic carries the weakest input class, docs/01 section 6).
  T4  T-04 (available approach) is the figure the engine's CDU derate prints (TCS target less facility-water
      supply), and T-01 does not present the equipment survival rating as the operating condition.

Fixtures are the four SYNTHETIC example halls under examples/intake. Nothing here is calibration data.
"""
from __future__ import annotations

import dataclasses
import re
from pathlib import Path

import pytest

from gridforge.common import ASSUMED, V
from gridforge.intake.loader import load
from gridforge.procurement import build_spec, relief_steps
from gridforge.procurement.build import GENERATORS, scenario_context
from gridforge.scenario.run import run_all
from gridforge.thermal.constraints import cdu_capacity, plant_capacity
from gridforge.thermal.library import PUE_BY_ARCHITECTURE
from gridforge.thermal.schema import Architecture
from gridforge.validation import EvidenceClass

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = ("reference_hall", "dublin_hall", "london_hall", "nordic_hall")
ARCHITECTURES = tuple(Architecture)
#: Absolute and relative slack for the float arithmetic of two independent routes to the same kW.
ABS_TOL_KW = 1e-6


@pytest.fixture(scope="module")
def worlds():
    out = {}
    for name in EXAMPLES:
        intake = load(ROOT / "examples" / "intake" / f"{name}.json")
        out[name] = (intake, run_all(intake.context, intake.scenarios))
    return out


# --- the oracle: the engine's own plant constraint ----------------------------------------------------------------------

def _passes(ctx, capacity_kW: float, racks: int) -> bool:
    c = ctx.copy()
    c.thermal.plant.chilled_water_capacity_kW = V(capacity_kW, "kW", "probe plant capacity", ASSUMED)
    return plant_capacity(c).racks >= racks


def engine_min_capacity_kW(ctx, racks: int) -> float:
    """The smallest chilled-water plant capacity at which the engine's plant_capacity constraint passes ``racks``.

    Found by bisection on the real constraint, so it needs no knowledge of how the constraint is written: the
    per-rack load, the existing IT load and any other heat the hall puts on the plant are all the engine's."""
    hi = max(ctx.thermal.plant.chilled_water_capacity_kW.value, 1.0)
    while not _passes(ctx, hi, racks):
        hi *= 2.0
        assert hi < 1e12, "plant_capacity never passes: the oracle cannot bracket it"
    lo = 0.0
    for _ in range(200):
        mid = (lo + hi) / 2.0
        if _passes(ctx, mid, racks):
            hi = mid
        else:
            lo = mid
    return hi


def engine_additional_kW(ctx, racks: int) -> float:
    """What the engine needs ADDED to the installed plant to host ``racks`` (zero if the headroom already does)."""
    return max(0.0, engine_min_capacity_kW(ctx, racks) - ctx.thermal.plant.chilled_water_capacity_kW.value)


def engine_per_rack_plant_kW(ctx) -> float:
    """The load the engine charges the plant per rack: the capacity step between hosting 1 and 2 racks."""
    return engine_min_capacity_kW(ctx, 2) - engine_min_capacity_kW(ctx, 1)


def as_architecture(ctx, arch: Architecture):
    c = ctx.copy()
    c.architecture = arch
    c.pue = PUE_BY_ARCHITECTURE[arch]
    return c


def t20(reqs):
    return next(r for r in reqs if r.id == "T-20")


# --- T1: T-20 is the engine's plant need ------------------------------------------------------------------------------

@pytest.mark.parametrize("example", EXAMPLES)
@pytest.mark.parametrize("arch", ARCHITECTURES, ids=lambda a: a.value)
def test_t20_equals_the_engines_plant_need_for_every_architecture(worlds, example, arch):
    """Four architectures x four halls x several rack counts. The engine charges the FULL rack load to the existing
    plant under hybrid DLC, rear-door and retained air, and the residual air load only under full DLC. T-20 used the
    residual share for all four, which for hybrid DLC is a tenth of what the engine needs."""
    intake, _ = worlds[example]
    ctx = as_architecture(intake.context, arch)
    for racks in (1, 7, 26, 60):
        v = t20(GENERATORS["plant_capacity"](ctx, racks)).value
        need = engine_additional_kW(ctx, racks)
        assert v.value >= need - ABS_TOL_KW, (
            f"{example}/{arch.value}/{racks} racks: T-20 {v.value:.1f} kW is LOWER than the {need:.1f} kW the engine needs")
        assert v.value == pytest.approx(need, abs=1e-3), (
            f"{example}/{arch.value}/{racks} racks: T-20 {v.value:.1f} kW is not the engine's {need:.1f} kW")


def test_the_reference_hall_hybrid_t20_is_the_full_rack_load_less_the_headroom(worlds):
    """The lead-verified case: 26 GB300 racks, 135 kW each, 1,900 kW of headroom (6,800 kW plant less 4.9 MW of IT).
    T-20 printed 351 kW (26 x the 13.5 kW residual air load); the plant needs 26 x 135 = 3,510 kW, so at least
    1,610 kW more than it has."""
    intake, results = worlds["reference_hall"]
    res = next(r for r in results if r.spec.id == "hybrid_dlc")
    pkg = build_spec(intake, res, constraint_id="plant_capacity")
    assert pkg.sized_for_racks == 26
    req = t20(pkg.requirements)
    assert req.value.value == pytest.approx(26 * 135.0 - 1900.0, abs=1e-6)       # 1,610 kW
    assert req.value.value > 1600.0
    for number in ("3,510 kW", "1,900 kW", "1,610 kW"):
        assert number in req.basis, f"the basis must let a supplier check the arithmetic: {number!r} missing from {req.basis!r}"
    assert "26 racks" in req.basis and "full rack load" in req.basis
    for number in ("26 racks", "3,510 kW", "1,900 kW"):                     # the sentence a supplier reads carries the arithmetic too
        assert number in req.statement, req.statement


def test_a_full_dlc_plant_requirement_says_the_liquid_share_is_not_in_it(worlds):
    """Under full DLC the liquid goes to a dedicated high-temperature loop, so T-20 is the residual air share only, and a
    supplier must be told that the loop's heat rejection is not in this figure."""
    intake, _ = worlds["reference_hall"]
    ctx = as_architecture(intake.context, Architecture.FULL_DLC)
    req = t20(GENERATORS["plant_capacity"](ctx, 200))
    assert "residual air" in req.basis
    assert "dedicated high-temperature loop" in req.basis
    assert "not" in req.basis.lower()


def test_the_load_rule_in_the_spec_agrees_with_the_engine_for_all_four_architectures(worlds):
    """build.py replicates the engine's choice of per-rack plant load (thermal/constraints.py `_liquid_load_to_plant`)
    rather than importing a private helper. If the two ever diverge, this fails: once against the engine's behaviour
    (the per-rack load the constraint really charges) and once against the predicate itself."""
    from gridforge.procurement.build import plant_load_per_rack
    from gridforge.thermal.constraints import _liquid_load_to_plant
    intake, _ = worlds["reference_hall"]
    for arch in ARCHITECTURES:
        ctx = as_architecture(intake.context, arch)
        plat = ctx.cluster.platform
        load, full = plant_load_per_rack(ctx)
        assert full == _liquid_load_to_plant(ctx), arch
        assert load.value == pytest.approx(engine_per_rack_plant_kW(ctx), abs=1e-6), arch
        assert load.value == pytest.approx(plat.rack_kW.value if full else plat.residual_air_kW().value), arch


@pytest.mark.parametrize("other_heat_kW", [0.0, 600.0, 4000.0])
def test_t20_uses_the_engines_headroom_with_and_without_other_heat(worlds, other_heat_kW):
    """With ``existing_non_it_heat_kW`` supplied the engine's headroom is plant capacity less IT load less that heat.
    When that heat exceeds the headroom the engine floors the DISPLAYED headroom at zero, but hosting N racks still
    needs the shortfall made good first, so the specification must not be lower than the engine's requirement."""
    intake, _ = worlds["reference_hall"]
    ctx = as_architecture(intake.context, Architecture.HYBRID_DLC)
    ctx.thermal.plant.existing_non_it_heat_kW = V(other_heat_kW, "kW", "other heat on the plant", ASSUMED)
    for racks in (5, 26):
        v = t20(GENERATORS["plant_capacity"](ctx, racks)).value
        need = engine_additional_kW(ctx, racks)
        assert v.value >= need - ABS_TOL_KW
        assert v.value == pytest.approx(need, abs=1e-3)


def test_the_spec_is_never_lower_than_the_engine_for_any_purchasable_plant_relief(worlds):
    """End to end over the four halls and every scenario: wherever the ladder buys plant, T-20 (sized for the end state
    the programme reaches) covers what the engine needs for the racks that relief unlocks, and for the end state."""
    cases = 0
    for example, (intake, results) in worlds.items():
        for res in results:
            plant_steps = [s for s in relief_steps(res) if s.binding_id == "plant_capacity"]
            if not plant_steps:
                continue
            pkg = build_spec(intake, res, constraint_id="plant_capacity")
            ctx = res.ladder.initial_context
            v = t20(pkg.requirements).value.value
            unlocked_to = max(s.racks_after for s in plant_steps)
            assert pkg.sized_for_racks >= unlocked_to
            assert v >= engine_additional_kW(ctx, unlocked_to) - ABS_TOL_KW, (example, res.spec.id)
            assert v >= engine_additional_kW(ctx, pkg.sized_for_racks) - ABS_TOL_KW, (example, res.spec.id)
            cases += 1
    assert cases >= 3, "the invariant must be exercised on real halls, not pass vacuously"


# --- T1: the specification is built from the scenario it tenders ---------------------------------------------------------

class _Poison:
    """Stands in for the intake's default context: any use of it is a test failure."""

    def __getattr__(self, name):                                   # pragma: no cover - only reached on failure
        raise AssertionError(f"build_spec read intake.context.{name}: it fell back to the intake's DEFAULT context")


def _purchasable(worlds):
    for example, (intake, results) in worlds.items():
        for res in results:
            for cid in sorted({s.binding_id for s in relief_steps(res)}):
                yield example, intake, res, cid


def test_build_spec_never_falls_back_to_the_intake_default_context(worlds):
    """`result.envelope.context` does not exist, so the old code silently used `intake.context` (hybrid DLC, no assumed
    CDU kit) for EVERY scenario. Every spec for every scenario must come from the scenario's own context."""
    built = 0
    for _, intake, res, cid in _purchasable(worlds):
        poisoned = dataclasses.replace(intake, context=_Poison())
        build_spec(poisoned, res, constraint_id=cid)
        built += 1
    assert built >= 30


def test_a_non_default_scenario_is_specified_at_its_own_pue_and_plant_state(worlds):
    """The reference hall defaults to hybrid DLC. The full-DLC scenario is solved at PUE 1.20, and its transformer
    requirement must be sized at that PUE (the engine's), not at the hybrid 1.30 the default context carries. And the
    installed plant a hybrid spec quotes is the plant as found (6,800 kW), not the plant after the ladder's own uprate."""
    intake, results = worlds["reference_hall"]
    assert intake.context.architecture is Architecture.HYBRID_DLC
    full = next(r for r in results if r.spec.id == "full_dlc")
    pkg = build_spec(intake, full, constraint_id="transformer_capacity")
    e20 = next(r for r in pkg.requirements if r.id == "E-20").value.value
    expected = 135.0 * pkg.sized_for_racks * PUE_BY_ARCHITECTURE[Architecture.FULL_DLC].value / 1000.0 / 0.95
    assert e20 == pytest.approx(expected)
    assert e20 != pytest.approx(135.0 * pkg.sized_for_racks * PUE_BY_ARCHITECTURE[Architecture.HYBRID_DLC].value / 1000.0 / 0.95)

    hybrid = next(r for r in results if r.spec.id == "hybrid_dlc")
    assert hybrid.context.thermal.plant.chilled_water_capacity_kW.value > 6800.0      # the post-ladder plant is not what is installed
    basis = t20(build_spec(intake, hybrid, constraint_id="plant_capacity").requirements).basis
    assert "6,800 kW" in basis and "10,200" not in basis


# --- T3: no requirement is stronger than the quantities it was computed from --------------------------------------------

_TAG = re.compile(r"\(E([0-7])\)")


def _numeric_requirements(worlds):
    for example, intake, res, cid in _purchasable(worlds):
        pkg = build_spec(intake, res, constraint_id=cid)
        for r in pkg.requirements:
            if r.value is not None:
                yield f"{example}/{res.spec.id}/{cid}/{r.id}", r


def test_no_requirement_is_stronger_than_the_quantities_named_in_its_basis(worlds):
    """The basis prints every quantity a figure was computed from, each with its class tag. The requirement's own class
    may not exceed the weakest of them. The old `_q` made a fresh E3 leaf for every value, so 'racks x liquid kW'
    (E0 vendor platform data) was printed as E3."""
    tagged_ids = set()
    for where, r in _numeric_requirements(worlds):
        tags = [int(t) for t in _TAG.findall(r.basis)]
        if not tags:
            continue
        tagged_ids.add(r.id)
        assert int(r.value.evidence) <= min(tags), (
            f"{where}: value {r.value.render()} is stronger than the weakest quantity in its basis (E{min(tags)}): {r.basis}")
    # the rows this defect is about must actually have been walked (a basis with no class tag would pass vacuously)
    assert {"T-01", "T-03", "T-04", "T-20", "E-10", "E-20", "E-30"} <= tagged_ids, tagged_ids


def test_every_generator_on_every_scenario_context_is_no_stronger_than_its_named_inputs(worlds):
    """The same walk, driving each generator directly on each scenario's as-found context, so a generator whose relief is
    not purchasable in the example halls (the pumped flow T-40 is one) is checked too."""
    seen = set()
    for example, (intake, results) in worlds.items():
        for res in results:
            ctx = scenario_context(intake, res)
            for cid, gen in GENERATORS.items():
                for r in gen(ctx, 20):
                    if r.value is None:
                        continue
                    seen.add(r.id)
                    tags = [int(t) for t in _TAG.findall(r.basis)]
                    if tags:
                        assert int(r.value.evidence) <= min(tags), (example, res.spec.id, cid, r.id, r.value.render(), r.basis)
                    assert int(r.value.evidence) <= int(EvidenceClass.E5_CUSTOMER_DATA)
    assert {"T-01", "T-03", "T-04", "T-20", "T-40", "E-02", "E-10", "E-20", "E-30"} <= seen
    intake, results = worlds["reference_hall"]
    t40 = next(r for r in GENERATORS["hydraulic_flow"](scenario_context(intake, results[2]), 20) if r.id == "T-40")
    assert t40.value.evidence is EvidenceClass.E0_ASSUMPTION            # 20 x the platform's flow per rack (E0), not a fresh E3


def test_no_requirement_value_is_a_fresh_leaf_the_specification_made_up(worlds):
    """A figure the specification computes must carry its inputs' provenance. A fresh leaf with the requirement's own
    label is an evidence class asserted from nothing."""
    computed = 0
    for where, r in _numeric_requirements(worlds):
        prov = r.value.prov
        if not prov.model_id.startswith("spec."):
            continue                       # the client's own figure passed through untouched (T-02, T-41, E-01): not computed here
        computed += 1
        fresh = [p for p in prov.walk() if not p.inputs and p.label == prov.label]
        assert prov.inputs and not fresh, f"{where}: {r.value.render()} rests on an asserted leaf {fresh[:1]!r}"
    assert computed >= 60


def test_the_thermal_and_electrical_figures_carry_the_class_of_the_platform_data_they_come_from(worlds):
    """Spot check with the class worked out independently: rack power, liquid fraction and flow per rack are library
    assumptions (E0), so racks x those is E0, and nothing may be above the E3 ceiling the generators claim."""
    intake, results = worlds["reference_hall"]
    plat = intake.context.cluster.platform
    assert plat.rack_kW.evidence is EvidenceClass.E0_ASSUMPTION
    by = {}
    for res in results:
        for cid in sorted({s.binding_id for s in relief_steps(res)}):
            for r in build_spec(intake, res, constraint_id=cid).requirements:
                if r.value is not None:
                    by.setdefault(r.id, set()).add(r.value.evidence)
    for rid in ("T-01", "T-03", "T-04", "T-20", "E-10", "E-20", "E-30"):
        assert by.get(rid) == {EvidenceClass.E0_ASSUMPTION}, (rid, by.get(rid))
    for rid, classes in by.items():
        assert max(classes) <= EvidenceClass.E5_CUSTOMER_DATA, rid
    # T-02 is the client's own facility-water figure passed through untouched: it keeps the class it was supplied at
    assert by["T-02"] == {intake.context.thermal.plant.design_supply_C.evidence}


# --- T4: the approach the spec states is the one the engine derates on ----------------------------------------------

_ENGINE_APPROACH = re.compile(r"(-?[\d,]+(?:\.\d+)?)(?: \[[^\]]*\])? degC \(E\d\) approach available")


def test_t04_is_the_available_approach_the_engines_cdu_derate_prints(worlds):
    """The engine's derate uses the TCS operating target less the facility-water supply (24 K on the reference hall).
    T-04 printed 39 K: the platform's 45 degC survival rating less the supply, labelled as the site's approach."""
    compared = 0
    for example, intake, res, cid in _purchasable(worlds):
        if cid != "cdu_capacity":
            continue
        pkg = build_spec(intake, res, constraint_id=cid)
        ctx = res.ladder.initial_context
        printed = _ENGINE_APPROACH.search(cdu_capacity(ctx).basis)
        assert printed, cdu_capacity(ctx).basis
        t04 = next(r for r in pkg.requirements if r.id == "T-04").value
        assert t04.unit == "K"
        assert t04.rounded() == pytest.approx(float(printed.group(1).replace(",", ""))), (example, res.spec.id)
        assert t04.value == pytest.approx(ctx.thermal.tcs_target_supply_C.value - ctx.thermal.plant.design_supply_C.value)
        compared += 1
    assert compared >= 8


def test_the_reference_hall_t04_is_24_k_not_the_survival_rating_less_the_supply(worlds):
    intake, results = worlds["reference_hall"]
    res = next(r for r in results if r.spec.id == "hybrid_dlc")
    t04 = next(r for r in build_spec(intake, res, constraint_id="cdu_capacity").requirements if r.id == "T-04")
    assert t04.value.value == pytest.approx(24.0)
    assert "30 [27–32] degC (E0)" in t04.basis and "6 degC (E5)" in t04.basis        # the two quantities it is the difference of


def test_t01_does_not_present_the_survival_rating_as_the_operating_condition(worlds):
    """The platform accepts liquid up to 45 degC, but that is an equipment survival rating (docs/02 section 4). The
    duty is quoted at the facility-water supply, and the operating point of the technology loop is the TCS target."""
    intake, results = worlds["reference_hall"]
    res = next(r for r in results if r.spec.id == "hybrid_dlc")
    t01 = next(r for r in build_spec(intake, res, constraint_id="cdu_capacity").requirements if r.id == "T-01")
    basis = t01.basis
    assert "45 degC" in basis                                   # the fact that the platform accepts it is kept
    assert "survival" in basis and "not an operating point" in basis
    assert "design operating point" in basis and "30 [27–32] degC (E0)" in basis
    assert "platform accepts up to 45 degC (E0) at the technology cooling loop" not in basis


# --- the guards on the helpers themselves -----------------------------------------------------------------------------

def test_scenario_context_rebuilds_the_scenario_when_the_ladder_kept_no_context(worlds):
    """The ladder keeps the as-found scenario context. A result built without it is rebuilt the way scenario.run.run() builds
    it (architecture, PUE, overrides), never replaced by the intake default."""
    intake, results = worlds["reference_hall"]
    res = next(r for r in results if r.spec.id == "full_dlc")
    kept = res.ladder.initial_context
    stripped = dataclasses.replace(res, ladder=dataclasses.replace(res.ladder, initial_context=None))
    ctx = scenario_context(dataclasses.replace(intake), stripped)
    assert ctx.architecture is Architecture.FULL_DLC
    assert ctx.pue.value == PUE_BY_ARCHITECTURE[Architecture.FULL_DLC].value
    assert [c.id for c in ctx.thermal.cdus] == [c.id for c in kept.thermal.cdus] != []
    assert ctx.thermal.plant.dry_cooler_approach_K is not None                   # the scenario's override was applied
    assert intake.context.thermal.plant.dry_cooler_approach_K is None            # and the intake default has none


def test_a_requirement_value_with_no_inputs_is_refused():
    from gridforge.procurement.build import _q
    from gridforge.procurement.schema import ProcurementError
    with pytest.raises(ProcurementError, match="computed from"):
        _q(1.0, "kW", "a figure from nowhere", "spec.test", [])


def test_a_requirement_is_never_given_a_class_above_its_weakest_input_or_the_estimate_ceiling():
    from gridforge.procurement.build import _q
    from gridforge.validation import Quantity
    weak = Quantity.given(10.0, "kW", "weak", EvidenceClass.E0_ASSUMPTION)
    strong = Quantity.given(10.0, "kW", "strong", EvidenceClass.E6_FIELD_VALIDATED)
    assert _q(1.0, "kW", "x", "spec.t", [weak, strong]).evidence is EvidenceClass.E0_ASSUMPTION
    assert _q(1.0, "kW", "x", "spec.t", [strong]).evidence is EvidenceClass.E3_ENGINEERING_ESTIMATE      # capped, never raised


# --- the public reference pages describe the same plant duty ------------------------------------------------------------

def test_the_plant_reference_page_does_not_describe_plant_duty_as_residual_only(worlds):
    """thermal/constraints.py charges the whole rack to the existing plant under hybrid DLC, rear-door and retained air, and the
    residual air load only under full DLC. The reference page said the plant limit was "the residual air load" for every
    architecture. Its worked example must also give the figures the engine really charges."""
    from gridforge.reference import reference_payload
    from gridforge.reference.catalogue import constraint_doc
    doc = constraint_doc("plant_capacity")
    assert "residual air load that liquid cooling does not capture" not in doc.limits
    for text in (doc.limits, doc.relation):
        assert "full DLC" in text or "full direct liquid cooling" in text, text
    for text in (doc.limits, doc.relation, doc.binds_when):
        assert "whole rack" in text or "full rack" in text, text                 # the route that is NOT residual-only
        assert "residual" in text or "capture fraction" in text, text            # and the route that is

    intake, _ = worlds["reference_hall"]
    plat = intake.context.cluster.platform
    hybrid = engine_per_rack_plant_kW(as_architecture(intake.context, Architecture.HYBRID_DLC))
    full = engine_per_rack_plant_kW(as_architecture(intake.context, Architecture.FULL_DLC))
    assert hybrid == pytest.approx(plat.rack_kW.value) and full == pytest.approx(plat.residual_air_kW().value)
    example = next(c for c in reference_payload()["constraints"] if c["id"] == "plant_capacity")["worked_example"]
    # formatted from the library figures (13.499999999999996 -> "13"); the engine's own charge is the same number to 1e-9
    assert f"{plat.rack_kW.value:.0f} kW per rack in hybrid DLC" in example["answer"]
    assert f"{plat.residual_air_kW().value:.0f} kW per rack, still to air, in full DLC" in example["answer"]
