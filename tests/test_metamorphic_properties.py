"""Metamorphic properties of the qualifier over plausible halls, from a fixed seed (a failure reproduces).

No oracle is needed for these: they say how the answer must MOVE when one input moves. A capacity input made larger can only help; a
load input made larger can only hurt; colder facility water can only help; relief never reduces racks; racks are whole, non-negative and
never exceed the free positions or the contracted power; the same input gives the same answer. A violation is a defect in the model or
in the property, and either is worth knowing. The sweep is how the free-positions defect (a hall with 401+ positions refused) was found.
"""
import random

import pytest

from gridforge.api.server import handle_qualify
from gridforge.api.tiers import Tier

SAMPLES = 80
HELPS = ["contracted_MW", "busway_ampacity_A", "tapoff_max_A", "positions_available"]
HURTS = ["current_site_peak_MW", "current_it_load_MW"]


def halls():
    r = random.Random(20261102)
    out = []
    for _ in range(SAMPLES):
        contracted = r.choice([3, 5, 8, 12, 20, 30, 50, 80])
        peak = round(contracted * r.uniform(0.3, 0.9), 2)
        out.append(dict(
            contracted_MW=contracted, current_site_peak_MW=peak, current_it_load_MW=round(peak * r.uniform(0.4, 0.8), 2),
            busway_ampacity_A=r.choice([250, 400, 630, 800, 1000, 1600, 2000, 3200]),
            tapoff_max_A=r.choice([32, 63, 125, 160, 250, 400, 630]),
            plant_supply_C=r.choice([5, 6, 7, 8, 10, 12, 15, 18]),
            positions_available=r.choice([20, 60, 100, 180, 300, 600, 1000])))
    return out


HALLS = halls()
_cache: dict = {}


def run(b):
    key = tuple(sorted(b.items()))
    if key not in _cache:
        o = handle_qualify(b, Tier.PUBLIC)
        _cache[key] = (o["as_found"]["racks"], o["after_relief"]["racks"], o["as_found"]["it_load_kW"]["value"])
    return _cache[key]


def test_the_sweep_actually_exercises_the_model():
    """A property that holds because every answer is zero proves nothing: at least half the halls must end with racks after relief, and a spread of values."""
    after = [run(b)[1] for b in HALLS]
    assert sum(1 for x in after if x > 0) >= SAMPLES * 0.5
    assert len(set(after)) >= 10


def test_answers_are_whole_non_negative_bounded_and_repeatable():
    for b in HALLS:
        found, after, it_kw = run(b)
        assert isinstance(found, int) and isinstance(after, int) and found >= 0
        assert found <= b["positions_available"], b
        assert after >= found, b
        assert it_kw <= b["contracted_MW"] * 1000 + 1e-6, b
        assert run(b) == (found, after, it_kw)


@pytest.mark.parametrize("key", HELPS)
def test_more_capacity_never_means_fewer_racks(key):
    for b in HALLS:
        bigger = {**b, key: b[key] * 1.5}
        f0, a0, _ = run(b)
        f1, a1, _ = run(bigger)
        assert f1 >= f0 and a1 >= a0, (key, b, f0, f1, a0, a1)


@pytest.mark.parametrize("key", HURTS)
def test_more_existing_load_never_means_more_racks(key):
    for b in HALLS:
        bigger = {**b, key: round(b[key] * 1.3, 3)}
        if key == "current_it_load_MW" and bigger[key] > b["current_site_peak_MW"]:
            continue
        f0, a0, _ = run(b)
        f1, a1, _ = run(bigger)
        assert f1 <= f0 and a1 <= a0, (key, b, f0, f1, a0, a1)


def test_colder_facility_water_never_means_fewer_racks():
    for b in HALLS:
        f0, a0, _ = run(b)
        f1, a1, _ = run({**b, "plant_supply_C": b["plant_supply_C"] - 2})
        assert f1 >= f0 and a1 >= a0, (b, f0, f1, a0, a1)


@pytest.mark.parametrize("pos", [399, 400, 401, 1000, 5000])
def test_no_number_of_free_positions_is_refused(pos):
    assert run({**HALLS[0], "positions_available": pos})[0] >= 0
