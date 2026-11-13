"""Warmer facility water can never leave a hall better off, and the CDU row cannot win a tie against the water gate it cannot help.

Under full DLC the CDU row used to answer "not assessed" only when the available approach was <= 0. A few tenths of a kelvin BELOW the TCS target
the approach is positive but the derated duty rounds to zero racks: the CDU row came to 0, tied with the water-temperature gate at 0, the tie
was broken by evaluation order, the CDU won, adding CDU units cannot help (0 x n = 0), and the ladder stopped at zero racks with the trim chiller
that relieves both never reached. Dublin at a design dry-bulb of 19.9 degC (dry-cooler water 29.9 against a 30 degC TCS target) went from 24 racks
after the works to 0, and back to 24 at 20.0. The independent review found it (R1); the old engine had no such window.
"""
import copy
import json
from pathlib import Path

import pytest

from gridforge.intake.loader import load_document
from gridforge.scenario import run_all

ROOT = Path(__file__).resolve().parents[1]
HALLS = ("reference_hall", "dublin_hall", "london_hall", "nordic_hall")


def after_ladder(name: str, drybulb: float, scenario: str = "full_dlc") -> tuple[int, str]:
    doc = json.loads((ROOT / "examples" / "intake" / f"{name}.json").read_text(encoding="utf-8"))
    doc = copy.deepcopy(doc)
    doc["scenarios"] = [scenario]
    doc["site"]["design_drybulb_C"] = drybulb
    intake = load_document(doc)
    res = run_all(intake.context, intake.scenarios)[0]
    return res.unlocked_racks, res.envelope.binding.id


def grid():
    coarse = [18.5 + 0.25 * i for i in range(0, 13)]                       # 18.5 .. 21.5
    fine = [19.60 + 0.02 * i for i in range(0, 26)]                        # 19.60 .. 20.10, through the window below the target
    return sorted(set(round(x, 3) for x in coarse + fine))


@pytest.mark.parametrize("name", HALLS)
def test_a_warmer_site_never_leaves_the_hall_better_off_under_full_dlc(name):
    pts = grid()
    got = [after_ladder(name, db)[0] for db in pts]
    for (db_a, a), (db_b, b) in zip(zip(pts, got), zip(pts[1:], got[1:])):
        assert a >= b, f"{name}: {a} racks after the works at {db_a} degC but {b} at the warmer {db_b} degC"


@pytest.mark.parametrize("name", HALLS)
def test_the_window_just_below_the_target_does_not_stop_the_ladder_at_zero(name):
    """Every point of the fine grid must reach the same post-works count as the point a degree cooler, unless the hall genuinely loses racks
    there: it must never be ZERO when the hall one degree cooler is not."""
    cool = after_ladder(name, 18.5)[0]
    if cool == 0:
        pytest.skip(f"{name} has no racks after the works even when cool: the window cannot be seen on it")
    for db in (19.7, 19.8, 19.9, 19.99, 19.999999, 20.0):
        racks, binding = after_ladder(name, db)
        assert racks > 0, f"{name}: the ladder ends at zero racks at {db} degC (binding {binding}) though {cool} are reachable at 18.5 degC"


def test_the_gate_not_the_cdu_binds_in_the_window_so_the_trim_chiller_is_reached():
    racks, binding = after_ladder("dublin_hall", 19.9)
    assert binding == "tcs_supply_achievable", binding
    assert racks == after_ladder("dublin_hall", 20.5)[0]
