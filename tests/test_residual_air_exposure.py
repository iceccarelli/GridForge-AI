"""Guardrail for docs/08_RESIDUAL_AIR_EXPOSURE_ANALYSIS.md (HANDOFF.md §6d #16).

`residual_air_removal` is a screening-level gate with no CFD behind it. The open
question was whether that scope-out is safe on the halls we actually ship as
examples, or whether it is quietly moving the headline answer. The analysis
document found that, at today's library defaults, it is not: something else always
binds first, with margin, across the whole plausible range of the one input this
constraint depends on.

That finding is only true until it isn't. If a future change to the ladder, the
library, the platform, or a newly added example hall makes `residual_air_removal`
newly binding, this test fails — which is the point: the document's honest
narrowness ("on THESE four halls") stops being a favour to nobody and starts being
a guardrail, because the failure surfaces here instead of in a client's document.
"""
from pathlib import Path

import pytest

from gridforge.constraints import all_constraints
from gridforge.envelope.solver import solve
from gridforge.intake.loader import load
from gridforge.scenario.knobs import _set_air
from gridforge.scenario.objective import Objective, pick_recommended
from gridforge.scenario.run import run_all

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = sorted((ROOT / "examples" / "intake").glob("*.json"))

# The band the analysis swept: the library default, the in-row/RDHx relief's own
# post-augmentation assumption (20-30 kW), and margin either side.
SWEEP_KW = (15.0, 18.0, 20.0, 22.0, 25.0, 28.0, 30.0, 35.0, 40.0)


def _residual_air_constraint():
    for c in all_constraints():
        if c.__name__ == "residual_air_removal":
            return c
    raise AssertionError("residual_air_removal constraint was removed or renamed; "
                          "docs/08_RESIDUAL_AIR_EXPOSURE_ANALYSIS.md needs revisiting, "
                          "not silent deletion of its guardrail")


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.stem)
def test_reference_halls_are_insensitive_to_air_capacity_assumption(path):
    """The core finding: sweeping the one input this gate depends on, across the
    whole plausible range, does not move the final deployable rack count on any
    bundled example hall. If this starts failing, the exposure the analysis
    document describes as theoretical has become real, and the document's
    conclusion needs updating before any customer sees it."""
    intake = load(path)
    results = run_all(intake.context, intake.scenarios)
    rec = pick_recommended(results, Objective.MAX_COMPUTE)
    base = solve(rec.context.copy()).max_racks
    for kw in SWEEP_KW:
        swept = solve(_set_air(kw)(rec.context.copy())).max_racks
        assert swept == base, (
            f"{path.stem}: residual air capacity assumption of {kw} kW changed the "
            f"recommended scenario's deployable racks from {base} to {swept}. "
            f"docs/08_RESIDUAL_AIR_EXPOSURE_ANALYSIS.md's conclusion no longer holds "
            f"for this hall and must be revised, not silenced.")


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.stem)
def test_air_only_architectures_are_gated_by_something_at_this_platforms_density(path):
    """RETAINED_AIR and RDHX ask residual_air_removal for the FULL rack power, not
    the residual fraction — there is no liquid loop to have captured the rest. On
    every bundled hall that gates the architecture to zero racks, one way or
    another. This does not have to stay `residual_air_removal` itself (a tied
    constraint reporting first is fine and is what the analysis describes) — but a
    platform this dense must not silently become deployable air-only because a
    library change loosened every other constraint at once without anyone
    revisiting this gate."""
    intake = load(path)
    results = run_all(intake.context, intake.scenarios)
    air_only = [r for r in results if r.spec.architecture.value in ("retained_air", "rdhx")]
    assert air_only, f"{path.stem}: no air-only scenario in this hall's scenario list"
    for r in air_only:
        assert r.envelope.max_racks == 0, (
            f"{path.stem}/{r.spec.architecture.value}: air-only architecture now "
            f"deploys {r.envelope.max_racks} racks at this platform's density. "
            f"docs/08_RESIDUAL_AIR_EXPOSURE_ANALYSIS.md's Result 1 assumed this was "
            f"always gated to zero on the bundled examples; re-verify before trusting it.")


def test_residual_air_removal_still_distinguishes_dlc_from_air_only():
    """The constraint's whole design rests on one branch: DLC architectures are
    checked against the residual fraction, air-only architectures against the full
    load. If that branch is ever collapsed to one formula, both results above stop
    meaning what this test says they mean."""
    import inspect
    from gridforge.thermal import constraints as thermal_constraints
    source = inspect.getsource(thermal_constraints.residual_air_removal)
    assert "HYBRID_DLC" in source and "FULL_DLC" in source, (
        "residual_air_removal no longer branches on architecture — "
        "docs/08_RESIDUAL_AIR_EXPOSURE_ANALYSIS.md's Result 1 and Result 2 describe "
        "two different code paths that may no longer exist")


def test_exists():
    _residual_air_constraint()
