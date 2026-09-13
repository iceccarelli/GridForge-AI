import math

from examples.reference_site import SCENARIOS, build_context
from gridforge.compute.library import get_platform
from gridforge.envelope import ladder, solve
from gridforge.scenario import run, run_all
from gridforge.thermal.schema import Architecture


def test_air_architecture_cannot_host_a_gb300_rack():
    ctx = build_context()
    ctx.architecture = Architecture.RETAINED_AIR
    res = solve(ctx)
    assert res.max_racks == 0
    lad = ladder(ctx)
    assert lad.final.binding.id == "architecture_capability"
    assert lad.final.binding.relief is None, "no capex relieves a wrong architecture choice"


def test_hybrid_dlc_unlocks_racks_through_the_ladder():
    ctx = build_context()
    res = run(ctx, SCENARIOS[2])
    assert res.headline_racks == 0
    assert res.unlocked_racks > 0
    ids = [s.binding_id for s in res.ladder.steps]
    assert "residual_air_removal" in ids, "residual air load must appear as a binding constraint"


def test_better_cooling_releases_grid_capacity_for_compute():
    """The coupling that is the whole product: a lower PUE turns the same grid
    connection into more compute."""
    ctx = build_context()
    results = {r.spec.id: r for r in run_all(ctx, SCENARIOS)}
    assert results["s4_full"].unlocked_racks >= results["s3_hybrid"].unlocked_racks


def test_grid_capacity_is_the_terminal_constraint():
    ctx = build_context()
    res = run(ctx, SCENARIOS[3])
    assert res.ladder.final.binding.id == "grid_firm_capacity"


def test_grid_relief_is_a_noop_where_no_capacity_exists():
    ctx = build_context()
    res = run(ctx, SCENARIOS[3])
    grid = [c for c in res.ladder.final.constraints if c.id == "grid_firm_capacity"][0]
    assert grid.relief is not None
    assert grid.relief.apply(ctx) is ctx, "we must not model capacity that cannot be bought"


def test_floor_loading_screens_a_raised_floor():
    ctx = build_context()
    res = solve(ctx)
    fl = [c for c in res.constraints if c.id == "floor_loading"][0]
    assert fl.gate
    assert "1,220" in fl.basis or "1223" in fl.basis or "kg/m2" in fl.basis


def test_unpublished_platform_is_refused():
    import pytest
    with pytest.raises(ValueError, match="Refusing"):
        get_platform("vr200_nvl144")


def test_residual_air_is_material_at_high_density():
    p = get_platform("gb300_nvl72")
    assert 10.0 < p.residual_air_kW().value < 25.0


def test_racks_are_whole_numbers():
    ctx = build_context()
    for c in solve(ctx).constraints:
        v = c.max_racks.value
        assert math.isinf(v) or v == int(v)
