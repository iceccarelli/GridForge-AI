"""The BTM Power Deployment Assessment (gridforge/reporting/btm_assessment.py).

This is the composition layer that turns LoadProfile + GenerationUnit + BESS +
ContingencyCase from orphaned-but-correct modules into one object a customer
actually asks for: "what architecture gets me to my target, what does it cost,
and what do I do next." No new physics — every assertion here checks that the
composition reads the underlying modules correctly, exactly like
test_power_readiness.py does for the headroom ladder.
"""
import json
import subprocess
import sys
from pathlib import Path

from gridforge.common import ASSUMED, V
from gridforge.power.generation import default_generation_unit
from gridforge.power.load_profile import flat, from_csv
from gridforge.power.reliability import ContingencyStatus, Redundancy
from gridforge.power.storage import default_bess
from gridforge.reporting.btm_assessment import assess_deployment, candidate_architectures

CSV = """timestamp,kW
2026-01-01T00:00:00,30000
2026-01-01T00:15:00,30000
2026-01-01T00:30:00,30000
2026-01-01T00:45:00,30000
2026-01-01T01:00:00,30000
"""


def _units():
    gen = default_generation_unit("GEN-A", "gas_engine", 20.0)
    gen.capex_eur = V(16_000_000, "EUR", "GEN-A capex", ASSUMED)
    gen.lead_time_weeks = V(44, "weeks", "GEN-A lead time", ASSUMED)
    gen.fuel_type = "natural gas"
    gen2 = default_generation_unit("GEN-B", "gas_engine", 20.0)
    gen2.capex_eur = V(16_000_000, "EUR", "GEN-B capex", ASSUMED)
    gen2.lead_time_weeks = V(44, "weeks", "GEN-B lead time", ASSUMED)
    gen2.fuel_type = "natural gas"
    bess = default_bess("BESS-1", power_MW=8.0, energy_MWh=32.0)
    bess.capex_eur = V(7_200_000, "EUR", "BESS-1 capex", ASSUMED)
    bess.lead_time_weeks = V(30, "weeks", "BESS-1 lead time", ASSUMED)
    return [gen, gen2], [bess]


INTERCONNECTION = {"utility": "TenneT", "pcc_voltage_kV": 20, "import_capacity_MW": 15}
PERMITTING = {"emissions_status": "application submitted"}


def _assess(**overrides):
    gens, bess = _units()
    kwargs = dict(
        load_profile=from_csv(CSV, source="test-hall.csv"),
        grid_firm_MW=V(10.0, "MW", "grid firm", ASSUMED),
        generation=gens, bess=bess,
        target_MW=V(35.0, "MW", "target", ASSUMED),
        interconnection=INTERCONNECTION, permitting=PERMITTING,
        ride_through_hours=V(3.0, "h", "ride-through", ASSUMED),
        redundancy=Redundancy.N_PLUS_1,
    )
    kwargs.update(overrides)
    return assess_deployment(**kwargs)


def test_candidate_architectures_only_include_declared_technology():
    gens, bess = _units()
    combos = candidate_architectures([], [])
    assert [c.label for c in combos] == ["GRID ONLY"]
    combos = candidate_architectures(gens, [])
    assert set(c.label for c in combos) == {"GRID ONLY", "GRID + GENERATION"}
    combos = candidate_architectures(gens, bess)
    assert set(c.label for c in combos) == {
        "GRID ONLY", "GRID + GENERATION", "GRID + BESS", "GRID + BESS + GENERATION"}


def test_grid_only_fails_when_grid_alone_cannot_meet_the_critical_load():
    result = _assess()
    grid_only = next(a for a in result["architectures"] if a["label"] == "GRID ONLY")
    assert grid_only["status"] == ContingencyStatus.FAIL.value
    assert "loss of" not in grid_only["scenario"] or "no generation or storage" in grid_only["scenario"]


def test_the_richest_declared_architecture_can_pass_where_thinner_ones_fail():
    result = _assess()
    combined = next(a for a in result["architectures"]
                   if a["label"] == "GRID + BESS + GENERATION")
    grid_only = next(a for a in result["architectures"] if a["label"] == "GRID ONLY")
    assert combined["status"] == ContingencyStatus.PASS.value
    assert grid_only["status"] == ContingencyStatus.FAIL.value


def test_capex_and_lead_time_are_read_from_the_declared_units_not_invented():
    result = _assess()
    gen_only = next(a for a in result["architectures"] if a["label"] == "GRID + GENERATION")
    assert gen_only["capex_eur"] == 32_000_000  # 16M + 16M, read from the two units
    assert gen_only["lead_time_weeks"] == 44    # both units agree; critical path is the max


def test_an_uncosted_unit_reports_unknown_capex_not_zero():
    gens, bess = _units()
    gens[0].capex_eur = None  # GEN-A never received a quote
    result = assess_deployment(
        load_profile=from_csv(CSV, source="test-hall.csv"),
        grid_firm_MW=V(10.0, "MW", "grid firm", ASSUMED),
        generation=gens, bess=bess, target_MW=V(35.0, "MW", "target", ASSUMED),
        ride_through_hours=V(3.0, "h", "ride-through", ASSUMED), redundancy=Redundancy.N)
    gen_only = next(a for a in result["architectures"] if a["label"] == "GRID + GENERATION")
    assert gen_only["capex_eur"] is None
    assert "GEN-A" in gen_only["capex_uncosted_units"]
    assert gen_only["buildable"] is False, "an uncosted architecture must never rank as buildable"


def test_next_action_picks_the_cheapest_passing_fully_costed_architecture():
    result = _assess()
    assert result["next_action"]["action"].startswith("Proceed to RFQ")
    assert "GRID + BESS + GENERATION" in result["next_action"]["action"]


def test_next_action_asks_for_a_quote_when_the_only_passing_option_is_uncosted():
    gens, bess = _units()
    gens[0].capex_eur = None
    gens[1].capex_eur = None
    result = assess_deployment(
        load_profile=from_csv(CSV, source="test-hall.csv"),
        grid_firm_MW=V(10.0, "MW", "grid firm", ASSUMED),
        generation=gens, bess=bess, target_MW=V(35.0, "MW", "target", ASSUMED),
        ride_through_hours=V(3.0, "h", "ride-through", ASSUMED), redundancy=Redundancy.N_PLUS_1)
    assert result["next_action"]["action"].startswith("Obtain a budgetary or firm quote")


def test_next_action_says_nothing_passes_when_every_architecture_fails():
    result = assess_deployment(
        load_profile=from_csv(CSV, source="test-hall.csv"),
        grid_firm_MW=V(1.0, "MW", "grid firm", ASSUMED),
        generation=[], bess=[], target_MW=V(35.0, "MW", "target", ASSUMED),
        redundancy=Redundancy.N)
    assert "No declared architecture passes" in result["next_action"]["action"]


def test_gap_is_measured_against_grid_only_not_the_best_architecture():
    result = _assess()
    assert result["capacity"]["gap_MW"] == 25.0  # target 35 - grid-only 10


def test_a_flat_assumed_load_profile_still_produces_a_usable_assessment():
    """The free-tier / screening path (no real CSV yet) must not crash the
    assessment — it must run, and it must visibly carry the weaker evidence
    class rather than silently look as strong as a real load export."""
    gens, bess = _units()
    result = assess_deployment(
        load_profile=flat(25000), grid_firm_MW=V(10.0, "MW", "grid firm", ASSUMED),
        generation=gens, bess=bess, target_MW=V(35.0, "MW", "target", ASSUMED),
        redundancy=Redundancy.N)
    assert result["load_profile"]["evidence"] == "E0_ASSUMPTION"
    assert result["architectures"]


def test_load_profile_warnings_surface_into_the_assessment():
    result = _assess()  # CSV has only 5 samples
    assert result["load_profile"]["warnings"]


# --- rfq_ready vs. execution_ready: the semantic bug this session fixed ------
#
# An earlier version of this code had a single field, `ready_for_procurement`,
# that only excluded MISSING_DATA gates -- so an architecture with protection
# at REQUIRES_LICENSED_REVIEW (which is EVERY architecture with any on-site
# generation or storage, by design) could read as "ready for procurement" in a
# way a customer or another engineer would reasonably parse as "cleared to
# build". These tests exist so that conflation cannot silently return.

def test_rfq_ready_is_true_once_data_is_complete_even_though_licensed_review_is_still_required():
    result = _assess()  # full fixture: fuel_type, interconnection, permitting all declared
    winner = next(a for a in result["architectures"] if a["label"] == "GRID + BESS + GENERATION")
    assert winner["rfq_ready"] is True
    assert winner["execution_ready"] is False, (
        "execution_ready must never be true while protection sits at "
        "REQUIRES_LICENSED_REVIEW -- that is exactly the bug this field exists to prevent")


def test_execution_ready_requires_every_gate_to_be_pass_or_not_applicable():
    result = _assess()
    for a in result["architectures"]:
        gates_by_status = {g["status"] for g in a["readiness_gates"]}
        all_clear = gates_by_status <= {"pass", "not_applicable"}
        assert a["execution_ready"] == (a["rfq_ready"] and all_clear)


def test_external_clearances_required_always_names_protection_for_a_hybrid_architecture():
    result = _assess()
    winner = next(a for a in result["architectures"] if a["label"] == "GRID + BESS + GENERATION")
    gates = {c["gate"] for c in winner["external_clearances_required"]}
    assert "protection" in gates
    protection = next(c for c in winner["external_clearances_required"] if c["gate"] == "protection")
    assert protection["review_requirement"] == "Licensed protection engineer"


def test_objective_changes_which_architecture_wins():
    """A cheaper-but-smaller battery-only architecture and a bigger-but-pricier
    hybrid one must rank differently depending on what the customer is
    optimising -- the exact silent-lowest-cost-wins bug this test guards
    against. Uses assess_deployment directly (not the _assess() fixture) so
    every objective is exercised against the same declared units."""
    from gridforge.power.load_profile import flat
    from gridforge.scenario.objective import Objective
    from gridforge.reporting.btm_assessment import assess_deployment

    gen = default_generation_unit("GEN-A", "gas_engine", 30.0)
    gen.capex_eur = V(20_000_000, "EUR", "capex", ASSUMED)
    gen.lead_time_weeks = V(50, "weeks", "lead", ASSUMED)
    bess = default_bess("BESS-1", power_MW=10.0, energy_MWh=40.0)
    bess.capex_eur = V(9_000_000, "EUR", "capex", ASSUMED)
    bess.lead_time_weeks = V(20, "weeks", "lead", ASSUMED)

    def winner_label(objective):
        r = assess_deployment(load_profile=flat(15000), grid_firm_MW=V(5.0, "MW", "g", ASSUMED),
                              generation=[gen], bess=[bess], target_MW=V(30.0, "MW", "t", ASSUMED),
                              redundancy=Redundancy.N, objective=objective)
        # both winners land on the missing-data branch (no interconnection/fuel/
        # permitting declared) -- the architecture NAME in the action is what
        # this test is checking, not the RFQ/procurement wording.
        return r["next_action"]["action"]

    max_compute_action = winner_label(Objective.MAX_COMPUTE)
    min_cost_action = winner_label(Objective.MIN_COST_PER_RACK)
    assert "GRID + BESS + GENERATION" in max_compute_action
    assert "GRID + BESS + GENERATION" not in min_cost_action
    assert "GRID + BESS" in min_cost_action


def test_result_states_the_objective_and_its_rationale():
    result = _assess()
    assert result["capacity"]["objective"] == "max_compute"
    assert result["next_action"]["objective"] == "max_compute"
    assert result["next_action"]["objective_rationale"]


def test_trade_offs_name_the_runner_up_not_a_hidden_second_ranking():
    from gridforge.power.load_profile import flat
    from gridforge.scenario.objective import Objective
    from gridforge.reporting.btm_assessment import assess_deployment

    gen = default_generation_unit("GEN-A", "gas_engine", 30.0)
    gen.capex_eur = V(20_000_000, "EUR", "capex", ASSUMED)
    gen.lead_time_weeks = V(50, "weeks", "lead", ASSUMED)
    gen.fuel_type = "natural gas"
    bess = default_bess("BESS-1", power_MW=10.0, energy_MWh=40.0)
    bess.capex_eur = V(9_000_000, "EUR", "capex", ASSUMED)
    bess.lead_time_weeks = V(20, "weeks", "lead", ASSUMED)
    r = assess_deployment(load_profile=flat(15000), grid_firm_MW=V(5.0, "MW", "g", ASSUMED),
                          generation=[gen], bess=[bess], target_MW=V(30.0, "MW", "t", ASSUMED),
                          redundancy=Redundancy.N, objective=Objective.MAX_COMPUTE,
                          interconnection=INTERCONNECTION, permitting=PERMITTING)
    assert r["next_action"]["action"].startswith("Proceed to RFQ"), r["next_action"]["action"]
    trade_offs = r["next_action"].get("trade_offs", [])
    assert trade_offs, "choosing the max-capacity winner over a cheaper alternative must name the trade-off"
    assert any("max_compute" in t and "costs less" in t for t in trade_offs), trade_offs


def test_next_action_never_says_proceed_to_rfq_without_naming_outstanding_clearances():
    result = _assess()
    action = result["next_action"]["action"]
    why = result["next_action"]["why"]
    assert action.startswith("Proceed to RFQ")
    assert "NOT a green light to build" in why
    assert "Licensed protection engineer" in why


DEPLOY_REQUEST = {
    "load_profile": {"csv": CSV, "source": "synthetic-hall.csv"},
    "grid_firm_MW": 10.0,
    "target_MW": 35.0,
    "ride_through_hours": 3.0,
    "redundancy": "N+1",
    "generation": [
        {"id": "GEN-A", "kind": "gas_engine", "nameplate_MW": 20.0,
         "capex_eur": 16_000_000, "lead_time_weeks": 44, "fuel_type": "natural gas"},
        {"id": "GEN-B", "kind": "gas_engine", "nameplate_MW": 20.0,
         "capex_eur": 16_000_000, "lead_time_weeks": 44, "fuel_type": "natural gas"},
    ],
    "bess": [{"id": "BESS-1", "power_MW": 8.0, "energy_MWh": 32.0,
             "capex_eur": 7_200_000, "lead_time_weeks": 30}],
    "interconnection": {"utility": "TenneT", "pcc_voltage_kV": 20, "import_capacity_MW": 15},
    "permitting": {"emissions_status": "application submitted"},
}


def test_cli_power_deploy_assess_runs_end_to_end(tmp_path):
    req_path = tmp_path / "request.json"
    req_path.write_text(json.dumps(DEPLOY_REQUEST))
    out_path = tmp_path / "result.json"
    root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [sys.executable, "-m", "gridforge", "power-deploy-assess", str(req_path),
        "-o", str(out_path)],
        cwd=root, capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert "Next action" in result.stdout
    assert "GRID + BESS + GENERATION" in result.stdout
    saved = json.loads(out_path.read_text())
    assert saved["next_action"]["action"].startswith("Proceed to RFQ")
