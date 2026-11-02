"""Operating mode of a generation unit: the customer says whether it runs continuously or is held on standby.

The contract these tests pin:
  * a unit that is not declared, or is declared `continuous`, behaves exactly as before: no number and no status changes;
  * a unit declared `standby` is checked for whether declared storage can carry the load it is relied on for until it starts;
  * the check only ever ADDS a caveat (PASS -> REQUIRES_ENGINEERING_STUDY); it never changes a number and never produces FAIL;
  * the wire shape validates the new fields instead of ignoring them.
"""
import pytest

from gridforge.common import ASSUMED, V
from gridforge.power.generation import OPERATING_MODES, default_generation_unit
from gridforge.power.reliability import ContingencyCase, ContingencyStatus, Redundancy, evaluate
from gridforge.power.storage import default_bess
from gridforge.reporting.btm_assessment import DeploymentRequestError, _generation_from_request


def case(mode=None, *, startup=None, load=15.0, grid=0.0, bess_power=4.0, bess_energy=16.0, gens=2, gen_MW=10.0):
    units = []
    for i in range(gens):
        g = default_generation_unit(f"GEN-{i}", "gas_engine", gen_MW)      # library start-up default: 3 min
        g.operating_mode = mode
        if startup is not None:
            g.startup_time_min = V(startup, "min", "declared start-up", ASSUMED)
        units.append(g)
    bess = [default_bess("BESS-1", power_MW=bess_power, energy_MWh=bess_energy)] if bess_power else []
    return ContingencyCase(
        critical_load_MW=V(load, "MW", "critical load", ASSUMED), grid_firm_MW=V(grid, "MW", "grid", ASSUMED),
        generation=units, bess=bess, ride_through_hours=V(2.0, "h", "ride-through", ASSUMED), redundancy=Redundancy.N)


def test_the_two_modes_are_exactly_these():
    assert OPERATING_MODES == ("continuous", "standby")


@pytest.mark.parametrize("load", [5.0, 15.0, 18.0, 25.0, 60.0])
def test_undeclared_and_continuous_change_nothing(load):
    base = evaluate(case(None, load=load))
    cont = evaluate(case("continuous", load=load))
    assert (cont.status, cont.available_MW.value, cont.margin_MW.value, cont.blocking) == (
        base.status, base.available_MW.value, base.margin_MW.value, base.blocking)
    assert not any("standby" in b or "start" in b for b in base.blocking)


def test_a_standby_unit_the_storage_cannot_bridge_is_flagged_for_study_not_failed():
    r = evaluate(case("standby"))              # 15 MW load, 4 MW of storage, 3 min start-up: the power cannot be carried
    assert r.status == ContingencyStatus.REQUIRES_ENGINEERING_STUDY
    assert any("GEN-0" in b and "standby" in b and "3 min" in b for b in r.blocking)
    assert r.margin_MW.value > 0, "the capacity itself is adequate; only the start is unchecked"


def test_the_caveat_changes_no_number():
    a, b = evaluate(case(None)), evaluate(case("standby"))
    assert (a.available_MW.value, a.required_MW.value, a.margin_MW.value) == (b.available_MW.value, b.required_MW.value, b.margin_MW.value)


def test_storage_that_can_carry_the_load_through_the_start_keeps_the_pass():
    # Load 15 MW, generation 2 x 10 MW; storage 20 MW / 40 MWh carries the 2 h ride-through share and the 3 min start.
    r = evaluate(case("standby", bess_power=20.0, bess_energy=40.0))
    assert not any("standby" in b for b in r.blocking)


def test_a_zero_second_start_has_nothing_to_bridge():
    assert not any("standby" in b for b in evaluate(case("standby", startup=0.0)).blocking)


def test_standby_without_a_start_time_asks_for_one():
    c = case("standby")
    for g in c.generation:
        g.startup_time_min = None
    assert any("no start-up time" in b for b in evaluate(c).blocking)


def test_when_the_load_is_carried_without_the_generation_its_start_is_not_on_the_critical_path():
    r = evaluate(case("standby", load=3.0, grid=10.0))
    assert not any("standby" in b for b in r.blocking)


def test_an_unrelated_defect_is_never_hidden_by_the_new_caveat():
    r = evaluate(case("standby", load=90.0))                   # far more load than supply: still a FAIL, as before
    assert r.status == ContingencyStatus.FAIL


def test_an_undeclared_mode_is_named_in_the_basis_and_a_declared_one_is_not():
    assert "Operating mode not declared" in evaluate(case(None)).basis
    assert "Operating mode not declared" not in evaluate(case("continuous")).basis
    assert "Operating mode not declared" not in evaluate(case("standby")).basis


# ---- the wire shape -------------------------------------------------------------------------------

def test_the_request_parser_accepts_both_modes_and_a_declared_start_time():
    g = _generation_from_request({"id": "G", "nameplate_MW": 5, "operating_mode": "standby", "startup_time_min": 12})
    assert g.operating_mode == "standby" and g.startup_time_min.value == 12.0
    assert _generation_from_request({"id": "G", "nameplate_MW": 5, "operating_mode": "continuous"}).operating_mode == "continuous"
    assert _generation_from_request({"id": "G", "nameplate_MW": 5}).operating_mode is None


@pytest.mark.parametrize("bad", ["Standby", "hot", "", 1, True, ["standby"], {}])
def test_an_unknown_mode_is_refused_not_ignored(bad):
    with pytest.raises(DeploymentRequestError, match="operating_mode"):
        _generation_from_request({"id": "G", "nameplate_MW": 5, "operating_mode": bad})


@pytest.mark.parametrize("bad", [-1, 1441, float("nan"), float("inf"), "3", True, None.__class__])
def test_a_hostile_start_time_is_refused(bad):
    with pytest.raises(DeploymentRequestError, match="startup_time_min"):
        _generation_from_request({"id": "G", "nameplate_MW": 5, "startup_time_min": bad})


def test_the_tool_schema_documents_the_field_for_agents():
    from gridforge.api.tools import TOOLS_BY_NAME
    schema = TOOLS_BY_NAME["gridforge_power_deploy_assess"]["inputSchema"]
    props = schema["properties"]["generation"]["items"]["properties"]
    assert props["operating_mode"]["enum"] == list(OPERATING_MODES)
    assert props["startup_time_min"]["maximum"] == 1440
