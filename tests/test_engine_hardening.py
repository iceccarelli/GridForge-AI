"""Known-answer checks for defects found by executing the engine, not reading it."""
import copy
import json
from pathlib import Path

import pytest

from gridforge.common import ASSUMED, V
from gridforge.envelope.solver import LadderDidNotConverge, ladder
from gridforge.intake.loader import IntakeError, load_document
from gridforge.power.generation import GenerationUnit
from gridforge.power.reliability import (ContingencyCase, Redundancy, evaluate)
from gridforge.reporting import to_markdown
from gridforge.reporting.study import build as build_study
from gridforge.scenario.run import run_all

ROOT = Path(__file__).resolve().parents[1]


def doc(name="reference_hall"):
    return json.loads((ROOT / "examples" / "intake" / f"{name}.json").read_text())


def test_per_rack_reliefs_are_priced_on_the_racks_finally_fitted():
    intake = load_document(doc())
    results = {r.spec.id: r for r in run_all(intake.context, intake.scenarios)}
    r = results["full_dlc_btm"]
    final = r.ladder.final.max_racks
    assert final > 20
    tapoff = next(s for s in r.ladder.taken_steps if s.binding_id == "rack_feed_tapoff")
    assert tapoff.capex_eur.value == pytest.approx(6000 * final)      # library: 6,000 EUR per rack


def test_a_ladder_that_cannot_finish_raises_rather_than_publishing_a_partial_ceiling():
    ctx = load_document(doc("nordic_hall")).context
    with pytest.raises(LadderDidNotConverge):
        ladder(ctx, max_steps=2)
    assert ladder(ctx).final is not None


def test_a_path_that_hosts_no_rack_carries_no_capex_and_no_recommendation():
    d = doc()
    d["hall"]["positions_available"] = 0
    intake = load_document(d)
    results = run_all(intake.context, intake.scenarios)
    for r in results:
        assert r.unlocked_racks == 0
        assert not r.ladder.taken_steps
        assert r.economics.capex_total_eur.value == 0
    md = to_markdown(build_study(intake.context, results, client="t"))
    assert "Do not proceed to procurement" in md
    assert "Proceed with" not in md


def test_two_n_loses_the_larger_path_not_the_smaller():
    big = GenerationUnit(id="A", kind="gas_engine", nameplate_MW=V(10.0, "MW", "a", ASSUMED))
    small = GenerationUnit(id="B", kind="gas_engine", nameplate_MW=V(1.0, "MW", "b", ASSUMED))
    case = ContingencyCase(critical_load_MW=V(9.0, "MW", "load", ASSUMED),
                           grid_firm_MW=V(0.0, "MW", "grid", ASSUMED),
                           generation=[big, small], redundancy=Redundancy.TWO_N)
    res = evaluate(case)
    assert res.margin_MW.value < 0, "losing the 10 MW side leaves 1 MW against 9 MW"
    assert res.status.value == "fail"


@pytest.mark.parametrize("section", ["transformers", "ups"])
def test_an_unknown_redundancy_scheme_is_refused_not_treated_as_n(section):
    d = doc("dublin_hall")
    d[section][0]["redundancy"] = "2N+1"
    with pytest.raises(IntakeError, match="redundancy"):
        load_document(d)


def test_retained_air_puts_the_whole_rack_on_the_plant():
    from gridforge.thermal.constraints import plant_capacity
    from gridforge.thermal.schema import Architecture
    intake = load_document(doc("dublin_hall"))
    ctx = intake.context.copy()
    ctx.architecture = Architecture.RETAINED_AIR
    air = plant_capacity(ctx)
    ctx.architecture = Architecture.FULL_DLC
    dlc = plant_capacity(ctx)
    assert air.max_racks.value < dlc.max_racks.value
    assert "rack heat" in air.basis
