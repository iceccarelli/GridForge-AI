"""Response keys that arrive with later engine changes are documented with the rest, and an engine returns all of them or none.

lib/openapi-honesty.json lists, per route, `top_level` (what every engine of this contract returns) and `additive_top_level` (keys added by
engine changes merged after it: the derived firm-capacity list on /v1/qualify, the `calibration` accuracy block on the comparison and
document routes, the comparable totals on /v1/portfolio, material_reasons / not_compared on /v1/diff). An engine that has the change returns
every one of a route's additive keys for the example request; one that does not returns none. Anything in between means the documentation
and the engine have drifted half-way apart, which is what this fails on. It imports only the server and the two data files, so it runs
against any engine checkout (PYTHONPATH).
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from openapi_example_support import EXAMPLES, resolve

from gridforge.api import server as S
from gridforge.api.tiers import Tier

ROOT = Path(__file__).resolve().parents[1]
HONESTY = json.loads((ROOT / "lib" / "openapi-honesty.json").read_text())
HALL = json.loads((ROOT / "public" / "reference" / "examples" / "qualify-request.json").read_text())


ADDITIVE = [(path, name, e) for path, spec in HONESTY["responses"].items() if spec.get("additive_top_level")
            for name, e in EXAMPLES["requests"][path].items()]


@pytest.mark.parametrize("path,name,example", ADDITIVE, ids=[f"{p}:{n}" for p, n, _ in ADDITIVE])
def test_an_engine_returns_all_of_a_routes_additive_keys_for_the_example_or_none(path, name, example):
    tier = Tier.PUBLIC if path in ("/v1/qualify", "/v1/estimate") else Tier.CLIENT
    out = S._invoke(path, S.ROUTES[path][0], resolve(example["value"]), tier)
    additive = HONESTY["responses"][path]["additive_top_level"]
    present = [k for k in additive if k in out]
    assert present in ([], additive), f"{path} returns only {present} of the additive keys {additive}"
    for k in HONESTY["responses"][path]["top_level"]:
        assert k in out, f"{path} does not return {k}"


def qualify(extra=None, drop=()):
    body = {k: v for k, v in HALL.items() if k not in drop}
    return S.handle_qualify({**body, **(extra or {})}, Tier.PUBLIC)


def test_inputs_derived_assumed_is_the_firm_capacity_the_qualifier_derived_and_nothing_the_caller_declared():
    plain = qualify()
    has_it = "inputs_derived_assumed" in plain
    if not has_it:
        # an engine without the change: no variant of the request returns it either
        assert "inputs_derived_assumed" not in qualify({"assumed_fields": ["contracted_MW"]})
        return
    (row,) = plain["inputs_derived_assumed"]
    assert set(row) == {"path", "input", "unit", "value", "evidence", "note"}
    assert row["path"] == "grid.firm_capacity_MVA" and row["evidence"] == "E0" and row["unit"] == "MVA"
    assert "no firm_capacity_MVA was given" in row["note"]
    # a required gap row says it was assumed
    assert [g["required"] for g in plain["intake"]["gaps"] if g["path"] == "grid.firm_capacity_MVA"] == [True]
    # sent by the caller, or no contract to derive it from: nothing derived
    assert "inputs_derived_assumed" not in qualify({"firm_capacity_MVA": 13})
    assert "inputs_derived_assumed" not in qualify(drop=("contracted_MW",))
    # it is not in the declared list, which holds only what the caller declared
    declared = qualify({"assumed_fields": ["contracted_MW", "tapoff_max_A"]})
    assert [r["path"] for r in declared["inputs_declared_assumed"]] == ["grid.contracted_MW", "lv.tapoff_max_A"]
    assert [r["path"] for r in declared["inputs_derived_assumed"]] == ["grid.firm_capacity_MVA"]
    assert "inputs_declared_assumed" not in plain
