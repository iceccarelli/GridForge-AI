"""The published constraint reference says which constraints can have a Procurement Specification, and says it correctly.

Two constraint pages told visitors that the Procurement Specification "is written for its relief" although the engine refuses to produce one for
either constraint ("no purchasable relief for ..."): `floor_space` frees positions by commercial means (relief cost key "not-capital") and
`architecture_capability` has no relief at all. The site added the specification step to every constraint that has a lead time. The reference
now carries `specification_available`, and this derives the same fact from the constraints' own definitions so the published flag cannot drift.
"""
import json
from pathlib import Path

import pytest

from gridforge.constraints import all_constraints
from gridforge.intake.loader import load
from gridforge.procurement import ProcurementError, build_spec
from gridforge.reference.build import NO_SPECIFICATION_IDS, reference_payload
from gridforge.scenario.run import run_all

ROOT = Path(__file__).resolve().parents[1]


def _relief_by_constraint() -> dict[str, object]:
    """Each constraint's relief, evaluated on the context of a scenario that carries every kind of equipment (hybrid DLC: the assumed CDU kit
    is present, so the CDU row has its relief; a hall with no CDU schedule would show none and mislead)."""
    intake = load(ROOT / "examples" / "intake" / "reference_hall.json")
    res = next(r for r in run_all(intake.context, intake.scenarios) if r.spec.id == "hybrid_dlc")
    ctx = res.ladder.initial_context
    return {c.id: c.relief for c in (fn(ctx) for fn in all_constraints())}


def test_the_flag_is_exactly_the_constraints_whose_relief_is_not_a_purchase():
    reliefs = _relief_by_constraint()
    not_a_purchase = {cid for cid, rel in reliefs.items() if rel is None or getattr(rel, "cost_key", None) in (None, "", "not-capital")}
    assert not_a_purchase == set(NO_SPECIFICATION_IDS), (sorted(not_a_purchase), sorted(NO_SPECIFICATION_IDS))


def test_every_published_constraint_carries_the_flag_and_it_matches():
    payload = reference_payload()
    seen = {}
    for c in payload["constraints"]:
        assert isinstance(c["specification_available"], bool), c["id"]
        assert c["specification_available"] == (c["id"] not in NO_SPECIFICATION_IDS)
        seen[c["id"]] = c["specification_available"]
    assert seen["floor_space"] is False and seen["architecture_capability"] is False
    assert sum(seen.values()) == len(seen) - 2


def test_the_committed_reference_file_carries_it_too():
    committed = json.loads((ROOT / "public" / "reference" / "constraints.json").read_text(encoding="utf-8"))
    flags = {c["id"]: c.get("specification_available") for c in committed["constraints"]}
    assert flags["floor_space"] is False and flags["architecture_capability"] is False
    assert all(v is True for k, v in flags.items() if k not in NO_SPECIFICATION_IDS), flags


@pytest.mark.parametrize("constraint_id", sorted(NO_SPECIFICATION_IDS))
def test_the_engine_really_refuses_a_specification_for_them_in_every_scenario_of_every_example(constraint_id):
    refused = 0
    for name in ("reference_hall", "dublin_hall", "london_hall", "nordic_hall"):
        intake = load(ROOT / "examples" / "intake" / f"{name}.json")
        for res in run_all(intake.context, intake.scenarios):
            with pytest.raises(ProcurementError):
                build_spec(intake, res, constraint_id=constraint_id)
            refused += 1
    assert refused >= 8
