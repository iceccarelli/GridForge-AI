"""The rack-feed gate compares the tap-off rating at 100% of its rating (continuous-load derating of tap-offs is the owner's open question,
not a number this change touches). The basis says so, next to the busway's own 0.8. Only the basis text may change: the rack count of the gate,
and every other constraint, are those of base b649b3e7."""
from __future__ import annotations

import json
from pathlib import Path

from gridforge.intake.loader import load
from gridforge.power.constraints import rack_feed_tapoff
from gridforge.scenario import run_all

ROOT = Path(__file__).resolve().parents[1]
GOLDEN = json.loads((ROOT / "tests" / "golden_busway_b649b3e.json").read_text(encoding="utf-8"))


def test_the_basis_discloses_that_the_tap_off_is_not_derated_unlike_the_busway():
    ctx = load(ROOT / "examples" / "intake" / "reference_hall.json").context
    basis = rack_feed_tapoff(ctx).basis
    assert "compared at 100% of its rating, with no continuous-load derating" in basis
    assert "the busway is derated to 0.8" in basis
    assert basis.startswith("platform needs ") and "installed tap-offs rated 63 A" in basis       # the earlier text is untouched


def test_no_rack_count_moves():
    """Every rung of every shipped intake (racks before and after, and which constraint bound) is the base's."""
    for name in ("dublin_hall", "london_hall", "nordic_hall", "reference_hall"):
        intake = load(ROOT / "examples" / "intake" / f"{name}.json")
        for r in run_all(intake.context, intake.scenarios):
            got = [[s.step, s.binding_id, s.racks_before, s.racks_after, s.taken] for s in r.ladder.steps]
            assert got == [x[:5] for x in GOLDEN[name][r.spec.id]["rungs"]], (name, r.spec.id)
