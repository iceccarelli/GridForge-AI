"""GridOS adapter — the first real extraction, and the only one the audit justified.

The repository audit (docs/06) found that GridOS, not ThermalForge, holds the
reusable engineering: ~13k lines of tested Python including a value-stacked
battery dispatch MILP, a recency-weighted seasonal forecaster, a receding-horizon
controller and a baseline-versus-optimised ROI backtest. GridOS is MIT licensed,
so it can be consumed directly with attribution.

This adapter is a PORT IMPLEMENTATION, not a migration. GridOS is imported
lazily, inside the call, so:

  * `gridforge` keeps its zero-dependency guarantee and still runs in an
    air-gapped customer review;
  * a study that never asks an economics question never touches GridOS;
  * the absence of GridOS is an explicit `NotWired`, never a silent zero.

Evidence: results from this adapter are E1 (modelled) at best, and no higher than
the weakest input handed to it. A dispatch optimum is not a measurement of a
battery's earnings.
"""
from __future__ import annotations

from dataclasses import dataclass

from ...common import ASSUMED, MODELLED, V
from ...validation import Quantity, Source
from ..ports import NotWired

GRIDOS_SOURCE = Source("GridOS economics engine (MIT), iceccarelli/GridOS", 2026)

INSTALL_HINT = (
    "GridOS is not importable. Install it alongside GridForge to enable "
    "behind-the-meter economics:\n"
    "    pip install 'gridos[optimization] @ git+https://github.com/iceccarelli/GridOS'\n"
    "The envelope engine itself has no dependencies and runs without it; only the "
    "energy-value sections of a study require it."
)


def gridos_available() -> bool:
    try:
        import gridos.economics  # noqa: F401
    except Exception:
        return False
    return True


@dataclass
class SiteEnergyProfile:
    """Minimal inputs the dispatch engine needs, expressed in GridForge terms."""
    load_kW: list[float]
    solar_kW: list[float]
    energy_price_eur_per_kWh: list[float] | float
    demand_charge_eur_per_kW: float
    interval_hours: float = 0.25


@dataclass
class GridOSEnergyValue:
    """Implements the EnergyValueModel port using the GridOS economics engine."""

    profile: SiteEnergyProfile
    battery_capacity_kWh: float
    battery_power_kW: float
    battery_capex_eur: float

    def _backtest(self):
        try:
            import numpy as np
            from gridos.economics import BatterySpec, Tariff, backtest_roi
        except Exception as exc:  # pragma: no cover - exercised only without GridOS
            raise NotWired(INSTALL_HINT) from exc

        tariff = Tariff(
            energy_price=np.asarray(self.profile.energy_price_eur_per_kWh, dtype=float)
            if isinstance(self.profile.energy_price_eur_per_kWh, list)
            else float(self.profile.energy_price_eur_per_kWh),
            demand_charge_per_kw=self.profile.demand_charge_eur_per_kW,
            currency="EUR",
        )
        battery = BatterySpec(
            capacity_kwh=self.battery_capacity_kWh,
            max_charge_kw=self.battery_power_kW,
            max_discharge_kw=self.battery_power_kW,
            capex=self.battery_capex_eur,
        )
        return backtest_roi(
            load=np.asarray(self.profile.load_kW, dtype=float),
            solar=np.asarray(self.profile.solar_kW, dtype=float),
            tariff=tariff,
            battery=battery,
            interval_hours=self.profile.interval_hours,
        )

    def annual_net_value_eur(self, scenario_id: str) -> Quantity:
        r = self._backtest()
        value = getattr(r, "annual_savings", None)
        if value is None:
            value = getattr(r, "total_savings_year", 0.0)
        return V(float(value), "EUR", f"{scenario_id}: modelled annual net value of storage",
                 MODELLED, band=0.35, sources=[GRIDOS_SOURCE],
                 assumptions=[
                     "Dispatch optimum against a modelled tariff and load profile. "
                     "An optimiser result is what the asset COULD earn under those inputs, "
                     "not what it has earned.",
                     "Replace the tariff and load profile with the site's own before issue.",
                 ])

    def payback_years(self, scenario_id: str) -> Quantity:
        r = self._backtest()
        value = getattr(r, "payback_years", None)
        if value is None or value != value:  # None or NaN
            return V(float("inf"), "years", f"{scenario_id}: payback (no positive value)", MODELLED)
        return V(float(value), "years", f"{scenario_id}: modelled payback period", MODELLED,
                 band=0.4, sources=[GRIDOS_SOURCE])


def firm_capacity_from_duration(capacity_kWh: float, power_kW: float,
                                ride_through_hours: float) -> Quantity:
    """Firm capacity a battery can actually hold for the required window.

    A 4 MWh / 2 MW battery is not 2 MW of firm capacity against an eight-hour
    outage; it is 0.5 MW. This is the arithmetic that stops a study over-crediting
    storage, and it needs no GridOS import.
    """
    if ride_through_hours <= 0:
        sustained = power_kW
    else:
        sustained = min(power_kW, capacity_kWh / ride_through_hours)
    return V(sustained, "kW",
             f"battery firm capacity over a {ride_through_hours:g} h window", MODELLED,
             band=0.1,
             assumptions=[f"Usable energy {capacity_kWh:g} kWh sustained over "
                          f"{ride_through_hours:g} h, capped by {power_kW:g} kW inverter rating. "
                          "Excludes depth-of-discharge limits and auxiliary loads."])
