"""gridforge/power/readiness_gates.py — the checklist between an architecture
and a purchase order.

This is deliberately a checklist engine, not a second engineering discipline:
it must never return PASS for protection, fuel or permitting from its own
authority (those require a licensed engineer, a fuel contract, a permit — this
tool can at most say the data needed to start that process is present). The
one gate it CAN return a real PASS/FAIL for is reliability, because that comes
straight from the contingency analysis already built and tested elsewhere.
"""
from gridforge.common import ASSUMED, V
from gridforge.power.generation import GenerationUnit, default_generation_unit
from gridforge.power.reliability import ContingencyCase, ContingencyStatus, Redundancy, evaluate
from gridforge.power.readiness_gates import GateStatus, evaluate_gates
from gridforge.power.storage import default_bess


def test_no_declared_supply_is_all_not_applicable_or_missing_never_a_fake_pass():
    gates = evaluate_gates()
    for g in gates:
        assert g.status not in (GateStatus.PASS,), (
            f"{g.gate} returned PASS with nothing declared — a gate must earn a pass, "
            f"never default to one")


def test_protection_never_resolves_to_pass_or_fail_on_its_own_authority():
    """The one rule this whole module exists to enforce: GridForge is not a
    licensed protection engineer and must never claim to be one, however
    complete the declared architecture is."""
    gens = [default_generation_unit("GEN-A", "gas_engine", 20.0)]
    bess = [default_bess("BESS-1", power_MW=8.0, energy_MWh=32.0)]
    gates = evaluate_gates(generation=gens, bess=bess,
                          interconnection={"utility": "X", "pcc_voltage_kV": 20,
                                          "import_capacity_MW": 10},
                          permitting={"emissions_status": "granted"})
    protection = next(g for g in gates if g.gate == "protection")
    assert protection.status == GateStatus.REQUIRES_LICENSED_REVIEW
    assert protection.review_requirement == "Licensed protection engineer"


def test_protection_is_not_applicable_for_a_grid_only_architecture():
    gates = evaluate_gates()
    protection = next(g for g in gates if g.gate == "protection")
    assert protection.status == GateStatus.NOT_APPLICABLE


def test_fuel_gate_tracks_declared_fuel_type_per_unit():
    undeclared = evaluate_gates(generation=[default_generation_unit("GEN-A", "gas_engine", 20.0)])
    fuel = next(g for g in undeclared if g.gate == "fuel")
    assert fuel.status == GateStatus.MISSING_DATA
    assert "GEN-A.fuel_type" in fuel.missing

    gen = default_generation_unit("GEN-A", "gas_engine", 20.0)
    gen.fuel_type = "natural gas"
    declared = evaluate_gates(generation=[gen])
    fuel2 = next(g for g in declared if g.gate == "fuel")
    assert fuel2.status == GateStatus.REQUIRES_ENGINEERING_STUDY
    assert fuel2.status != GateStatus.PASS  # a fuel type is not a supply contract


def test_fuel_gate_not_applicable_for_battery_only_architecture():
    gates = evaluate_gates(bess=[default_bess("BESS-1", power_MW=8.0, energy_MWh=32.0)])
    fuel = next(g for g in gates if g.gate == "fuel")
    assert fuel.status == GateStatus.NOT_APPLICABLE


def test_interconnection_gate_distinguishes_none_partial_and_complete():
    none = evaluate_gates()
    assert next(g for g in none if g.gate == "interconnection").status == GateStatus.MISSING_DATA

    partial = evaluate_gates(interconnection={"utility": "TenneT"})
    p = next(g for g in partial if g.gate == "interconnection")
    assert p.status == GateStatus.MISSING_DATA
    assert "interconnection.pcc_voltage_kV" in p.missing

    complete = evaluate_gates(interconnection={"utility": "TenneT", "pcc_voltage_kV": 20,
                                              "import_capacity_MW": 15})
    c = next(g for g in complete if g.gate == "interconnection")
    assert c.status == GateStatus.REQUIRES_ENGINEERING_STUDY  # never PASS from this tool alone


def test_electrical_gate_flags_multiple_grid_forming_sources():
    b1 = default_bess("BESS-1", power_MW=4.0, energy_MWh=16.0)
    b1.grid_forming = True
    b2 = default_bess("BESS-2", power_MW=4.0, energy_MWh=16.0)
    b2.grid_forming = True
    gates = evaluate_gates(bess=[b1, b2])
    electrical = next(g for g in gates if g.gate == "electrical")
    assert electrical.status == GateStatus.REQUIRES_ENGINEERING_STUDY
    assert "BESS-1" in electrical.evidence and "BESS-2" in electrical.evidence


def test_electrical_gate_passes_with_at_most_one_grid_forming_source():
    b1 = default_bess("BESS-1", power_MW=4.0, energy_MWh=16.0)
    b1.grid_forming = True
    gates = evaluate_gates(bess=[b1])
    electrical = next(g for g in gates if g.gate == "electrical")
    assert electrical.status == GateStatus.PASS


def test_reliability_gate_mirrors_the_real_contingency_result_exactly():
    """This gate must not compute a second opinion — it reads the same
    ContingencyResult the deployment assessment already produced."""
    gens = [default_generation_unit("GEN-A", "gas_engine", 20.0),
           default_generation_unit("GEN-B", "gas_engine", 20.0)]
    case = ContingencyCase(critical_load_MW=V(15.0, "MW", "critical", ASSUMED),
                          grid_firm_MW=V(0.0, "MW", "grid", ASSUMED),
                          generation=gens, redundancy=Redundancy.N_PLUS_1)
    result = evaluate(case)
    gates = evaluate_gates(generation=gens, contingency=result)
    reliability = next(g for g in gates if g.gate == "reliability")
    assert reliability.reason == result.basis
    assert reliability.status.value == result.status.value


def test_reliability_gate_is_unknown_without_a_contingency_result():
    gates = evaluate_gates()
    reliability = next(g for g in gates if g.gate == "reliability")
    assert reliability.status == GateStatus.UNKNOWN


def test_missing_data_and_unknown_and_requires_review_all_block():
    """Every non-PASS, non-NOT_APPLICABLE status must count as blocking — an
    unscreened gate is not a cleared one, whatever its label."""
    gates = evaluate_gates(generation=[default_generation_unit("GEN-A", "gas_engine", 20.0)])
    for g in gates:
        if g.status in (GateStatus.PASS, GateStatus.NOT_APPLICABLE):
            assert not g.blocking
        else:
            assert g.blocking


def test_permitting_not_applicable_for_battery_only_with_no_data():
    gates = evaluate_gates(bess=[default_bess("BESS-1", power_MW=4.0, energy_MWh=16.0)])
    permitting = next(g for g in gates if g.gate == "permitting")
    assert permitting.status == GateStatus.NOT_APPLICABLE


def test_permitting_missing_data_for_combustion_with_no_permitting_declared():
    gen = default_generation_unit("GEN-A", "gas_engine", 20.0)
    gates = evaluate_gates(generation=[gen])
    permitting = next(g for g in gates if g.gate == "permitting")
    assert permitting.status == GateStatus.MISSING_DATA
