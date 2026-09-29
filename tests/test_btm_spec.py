"""The BTM equipment spec — a chosen architecture's units, as a tender.

Same claim as gridforge/procurement/build.py, for a different domain: "every
numeric requirement is derived from a limit/unit in your architecture." If a
requirement can appear with no unit behind it, this is a wish list with a
traceability story bolted on, exactly the failure test_procurement.py guards
against on the hall side.
"""
import pytest

from gridforge.common import ASSUMED, V
from gridforge.power.generation import GenerationUnit, default_generation_unit
from gridforge.power.storage import default_bess
from gridforge.procurement.schema import MANDATORY, ProcurementError
from gridforge.reporting.btm_spec import BTMEquipmentSpec, build_equipment_spec
from gridforge.reporting.btm_spec_report import build as build_report
from gridforge.reporting import to_markdown


def test_every_mandatory_numeric_requirement_names_the_unit_it_came_from():
    gen = default_generation_unit("GEN-A", "gas_engine", 20.0)
    bess = default_bess("BESS-1", power_MW=8.0, energy_MWh=32.0)
    spec = build_equipment_spec("GRID + BESS + GENERATION", project="North Campus",
                               generation=[gen], bess=[bess])
    for q in spec.requirements:
        if q.value is not None and q.obligation == MANDATORY:
            assert q.derived_from, f"{q.id} has no unit behind it"


def test_a_specification_with_an_untraceable_requirement_is_refused():
    from gridforge.procurement.schema import Requirement
    from gridforge.validation import EvidenceClass, Quantity
    spec = BTMEquipmentSpec(project="P", architecture_label="X", units=["U-1"])
    spec.requirements = [Requirement(
        id="X-1", clause="Invented", statement="Shall be 400 MW.",
        value=Quantity.given(400, "MW", "invented", EvidenceClass.E0_ASSUMPTION))]
    with pytest.raises(ProcurementError, match="invented"):
        spec.validate()


def test_evaluation_weights_must_total_one_hundred():
    gen = default_generation_unit("GEN-A", "gas_engine", 20.0)
    spec = build_equipment_spec("GRID + GENERATION", project="P", generation=[gen])
    assert sum(c.weight for c in spec.criteria) == 100
    from gridforge.procurement.schema import EvaluationCriterion
    spec.criteria = list(spec.criteria) + [EvaluationCriterion("C9", "Extra", 5, "x")]
    with pytest.raises(ProcurementError, match="total 105"):
        spec.validate()


def test_an_architecture_with_no_units_is_refused_not_silently_empty():
    with pytest.raises(ProcurementError, match="nothing to tender"):
        build_equipment_spec("GRID ONLY", project="P")


def test_generation_only_architecture_has_no_bess_requirements():
    gen = default_generation_unit("GEN-A", "gas_engine", 20.0)
    spec = build_equipment_spec("GRID + GENERATION", project="P", generation=[gen])
    assert all(r.id.startswith(("G", "C")) for r in spec.requirements)


def test_bess_only_architecture_has_no_generation_requirements():
    bess = default_bess("BESS-1", power_MW=8.0, energy_MWh=32.0)
    spec = build_equipment_spec("GRID + BESS", project="P", bess=[bess])
    assert all(r.id.startswith(("B", "C")) for r in spec.requirements)


def test_a_unit_with_no_availability_data_still_produces_a_valid_spec_without_that_clause():
    """A bare GenerationUnit (no forced_outage_rate/availability/startup/ramp
    declared) must not crash the generator or invent a value for a field the
    unit does not carry — it simply omits the requirement clause for that
    field, same discipline as the deployment assessment's own escalation."""
    bare = GenerationUnit(id="GEN-BLIND", kind="unknown", nameplate_MW=V(5.0, "MW", "p", ASSUMED))
    spec = build_equipment_spec("GRID + GENERATION", project="P", generation=[bare])
    ids = {r.id for r in spec.requirements}
    assert "G1-01" in ids  # nameplate always present
    assert "G1-02" not in ids  # no forced-outage-rate clause invented
    assert "G1-03" not in ids  # no startup-time clause invented


def test_multiple_units_of_the_same_kind_get_distinct_requirement_ids():
    gens = [default_generation_unit("GEN-A", "gas_engine", 20.0),
           default_generation_unit("GEN-B", "gas_engine", 20.0)]
    spec = build_equipment_spec("GRID + GENERATION", project="P", generation=gens)
    ids = [r.id for r in spec.requirements]
    assert len(ids) == len(set(ids)), "duplicate requirement ids across two units"
    assert any(r.id.startswith("G1-") for r in spec.requirements)
    assert any(r.id.startswith("G2-") for r in spec.requirements)


def test_the_rendered_document_names_every_covered_unit():
    gen = default_generation_unit("GEN-A", "gas_engine", 20.0)
    bess = default_bess("BESS-1", power_MW=8.0, energy_MWh=32.0)
    spec = build_equipment_spec("GRID + BESS + GENERATION", project="North Campus",
                               generation=[gen], bess=[bess])
    md = to_markdown(build_report(spec, reference="RFQ-001"))
    assert "GEN-A" in md and "BESS-1" in md
    assert "North Campus" in md
    assert "RFQ-001" in md


def test_the_rendered_document_never_claims_measurement_or_certification():
    gen = default_generation_unit("GEN-A", "gas_engine", 20.0)
    spec = build_equipment_spec("GRID + GENERATION", project="P", generation=[gen])
    md = to_markdown(build_report(spec)).lower()
    for banned in ("certified", "as-built", "guaranteed", "bankable"):
        assert banned not in md
