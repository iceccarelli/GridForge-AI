"""Behind-the-meter supply, time to power, and the GridOS adapter.

These cover the claim the business is actually sold on: where the grid cannot
deliver, on-site firm supply can, and the difference is measurable in racks and
in weeks.
"""
import sys

import pytest

from examples.reference_site import SCENARIOS, build_context
from gridforge.common import ASSUMED, V
from gridforge.envelope.time_to_power import compare, schedule
from gridforge.integrations import NotWired
from gridforge.integrations.gridos import (GridOSEnergyValue, SiteEnergyProfile,
                                           firm_capacity_from_duration, gridos_available)
from gridforge.power.btm import firm_contribution_kW, installed_firm_kW, next_option
from gridforge.power.schema import GenerationOption
from gridforge.scenario import run


def _opt(kind, mw, weeks=30, firm=True, factor=None):
    return GenerationOption(
        id=f"{kind}-{mw}", kind=kind,
        capacity_MW=V(mw, "MW", "capacity", ASSUMED),
        capex_eur_per_kW=V(800, "EUR/kW", "capex", ASSUMED),
        lead_time_weeks=V(weeks, "weeks", "lead", ASSUMED),
        firm=firm, firm_capacity_factor=factor)


def test_pv_contributes_no_firm_capacity():
    assert firm_contribution_kW(_opt("pv", 5.0)).value == 0.0


def test_battery_firm_contribution_is_derated():
    q = firm_contribution_kW(_opt("bess", 2.0))
    assert 0 < q.value < 2000, "a battery's nameplate is not its firm capacity"


def test_gas_engine_is_nearly_firm():
    assert firm_contribution_kW(_opt("gas_engine", 5.0)).value == pytest.approx(4600, rel=0.01)


def test_firm_capacity_from_duration_is_energy_limited():
    assert firm_capacity_from_duration(8000, 2000, 8).value == pytest.approx(1000)
    assert firm_capacity_from_duration(8000, 2000, 2).value == pytest.approx(2000)


def test_next_option_prefers_the_fastest():
    ctx = build_context()
    opt = next_option(ctx.power)
    assert opt is not None and opt.kind == "bess", "weeks are scarcer than euros in this market"


def test_uninstalled_options_contribute_nothing():
    ctx = build_context()
    assert installed_firm_kW(ctx.power).value == 0.0


def test_grid_relief_is_behind_the_meter_when_options_exist():
    ctx = build_context()
    res = run(ctx, SCENARIOS[4])           # S5, options available
    grid = [c for c in res.envelope.constraints if c.id == "grid_firm_capacity"][0]
    assert grid.relief is not None
    assert "behind-the-meter" in grid.relief.description.lower()
    # and once every option is taken it reverts to the honest no-op
    final = [c for c in res.ladder.final.constraints if c.id == "grid_firm_capacity"][0]
    assert final.relief.apply(ctx) is ctx


def test_grid_relief_is_a_noop_without_options():
    ctx = build_context()
    res = run(ctx, SCENARIOS[3])           # S4, options stripped
    grid = [c for c in res.envelope.constraints if c.id == "grid_firm_capacity"][0]
    assert grid.relief.apply(ctx) is ctx, "we must not model capacity that cannot be bought"


def test_behind_the_meter_unlocks_materially_more_compute():
    ctx = build_context()
    grid_only = run(ctx, SCENARIOS[3])
    with_btm = run(ctx, SCENARIOS[4])
    assert with_btm.unlocked_racks > grid_only.unlocked_racks * 1.5


def test_time_to_power_is_the_longest_lead_not_the_sum():
    ctx = build_context()
    res = run(ctx, SCENARIOS[4])
    t = schedule(res.ladder)
    leads = [s.lead_time_weeks.value for s in res.ladder.taken_steps
             if s.lead_time_weeks is not None]
    assert t.weeks_to_full == pytest.approx(max(leads))
    assert t.weeks_to_full < sum(leads), "reliefs run in parallel"


def test_time_to_power_names_the_item_that_sets_the_date():
    ctx = build_context()
    t = schedule(run(ctx, SCENARIOS[4]).ladder)
    assert t.critical_item not in ("", "—")
    assert t.critical_weeks == t.weeks_to_full


def test_energisation_curve_is_monotonic():
    ctx = build_context()
    t = schedule(run(ctx, SCENARIOS[4]).ladder)
    weeks = [p.weeks for p in t.points]
    racks = [p.racks for p in t.points]
    assert weeks == sorted(weeks) and racks == sorted(racks)


def test_comparison_reports_racks_gained():
    ctx = build_context()
    c = compare("grid only", run(ctx, SCENARIOS[3]).ladder,
                "with behind-the-meter", run(ctx, SCENARIOS[4]).ladder)
    assert c.racks_gained > 0


def test_importing_gridforge_never_imports_gridos():
    assert "gridos" not in sys.modules, (
        "the envelope engine must stay importable with no third-party package present"
    )


@pytest.mark.skipif(gridos_available(), reason="GridOS is installed in this environment")
def test_gridos_adapter_fails_loudly_when_not_installed():
    model = GridOSEnergyValue(
        profile=SiteEnergyProfile(load_kW=[100] * 96, solar_kW=[0] * 96,
                                  energy_price_eur_per_kWh=0.14, demand_charge_eur_per_kW=12.0),
        battery_capacity_kWh=8000, battery_power_kW=2000, battery_capex_eur=1_800_000)
    with pytest.raises(NotWired, match="GridOS"):
        model.annual_net_value_eur("s5")
