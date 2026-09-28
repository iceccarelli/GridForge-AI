"""Behind-the-meter supply.

Where a European grid connection cannot be enlarged inside the decision horizon
- Frankfurt has no new large connections before the 2030s, Amsterdam's queue runs
about a decade, and Ireland will not raise a site's load without matching
connected generation - on-site supply is the only lever that moves the answer.

This module answers one question for the envelope solver: **how much FIRM
capacity does a set of behind-the-meter options actually contribute?** Nameplate
is not firm. A PV array contributes nothing to a capacity envelope that must hold
at 03:00; a duration-limited battery contributes only what it can sustain for the
relevant window; a gas engine contributes close to nameplate less its forced
outage rate.

Getting this wrong in the optimistic direction is the single easiest way to
produce a study that gets a customer's project stopped at the utility's desk.
"""
from __future__ import annotations

from ..common import ASSUMED, ESTIMATED, V
from ..validation import Quantity
from .schema import GenerationOption, PowerInput

# Default firm-capacity factors by technology. Every one of these is E0 and must
# be replaced by a site-specific figure before an issued deliverable.
DEFAULT_FIRM_FACTOR: dict[str, float] = {
    "gas_engine": 0.92,     # nameplate less forced-outage allowance
    "chp": 0.90,
    "fuel_cell": 0.90,
    "bess": 0.50,           # duration-limited; only firm for the discharge window
    "pv": 0.00,             # contributes energy, not firm capacity
    "wind": 0.00,
    "grid_reinforcement": 1.00,
}

FIRM_FACTOR_ASSUMPTION = (
    "Firm-capacity factor is a technology default, not a site figure. A battery's "
    "firm contribution depends on its duration against the outage window the site "
    "must ride through; a generator's depends on its forced-outage rate and fuel "
    "security. Replace with site-specific values before an issued deliverable."
)


def firm_factor(option: GenerationOption) -> Quantity:
    if option.firm_capacity_factor is not None:
        return option.firm_capacity_factor
    f = DEFAULT_FIRM_FACTOR.get(option.kind, 0.0)
    return V(f, "1", f"{option.kind} firm-capacity factor (library default)", ASSUMED,
             band=(max(f - 0.15, 0.0), min(f + 0.05, 1.0)),
             assumptions=[FIRM_FACTOR_ASSUMPTION])


def bess_firm_factor_for_duration(option: GenerationOption,
                                  ride_through_hours: Quantity) -> Quantity:
    """The duration-aware replacement for `DEFAULT_FIRM_FACTOR["bess"] = 0.50`.

    That flat factor was wrong in both directions: a battery asked to ride through
    a short utility trip is close to fully firm at its power rating regardless of
    size, and a battery asked to ride through hours is limited by its usable
    energy, not by an assumed half of nameplate. This builds a
    `BatteryEnergyStorageSystem` from the option's own declared power
    (`capacity_MW`) and energy (`energy_MWh`, added alongside this function) and
    returns the ratio of duration-aware firm power to nameplate, in the same
    `Quantity` shape `option.firm_capacity_factor` already expects — a caller with
    a known ride-through requirement can set
    `option.firm_capacity_factor = bess_firm_factor_for_duration(option, hours)`
    to override the flat default, with no change to `GenerationOption`'s shape
    or to `firm_factor()` above for options that do not use this.

    Raises rather than guessing when the option has no declared `energy_MWh` —
    a caller that does not know the battery's energy rating should keep using
    `firm_factor()`'s flat, honestly-labelled technology default instead of a
    silent fallback here that would look identical to a real calculation.
    """
    if option.kind != "bess":
        raise ValueError(f"{option.id}: not a BESS option (kind={option.kind!r})")
    if option.energy_MWh is None:
        raise ValueError(
            f"{option.id}: no energy_MWh declared — cannot compute a duration-aware firm "
            f"factor without it. Use firm_factor() for the flat technology default instead.")
    from .storage import (DEFAULT_ROUND_TRIP_EFFICIENCY, DEFAULT_SOC_MAX, DEFAULT_SOC_MIN,
                         BatteryEnergyStorageSystem)
    bess = BatteryEnergyStorageSystem(
        id=option.id,
        power_MW=option.capacity_MW,
        energy_MWh=option.energy_MWh,
        soc_min=V(DEFAULT_SOC_MIN, "1", f"{option.id} minimum SOC (library default)",
                  ASSUMED, assumptions=[FIRM_FACTOR_ASSUMPTION]),
        soc_max=V(DEFAULT_SOC_MAX, "1", f"{option.id} maximum SOC (library default)",
                  ASSUMED, assumptions=[FIRM_FACTOR_ASSUMPTION]),
        round_trip_efficiency=V(DEFAULT_ROUND_TRIP_EFFICIENCY, "1",
                                f"{option.id} round-trip efficiency (library default)",
                                ASSUMED, assumptions=[FIRM_FACTOR_ASSUMPTION]),
    )
    firm_MW = bess.firm_MW_for_duration(ride_through_hours)
    factor = firm_MW.value / option.capacity_MW.value if option.capacity_MW.value else 0.0
    return V(factor, "1",
             f"{option.id} firm-capacity factor for {ride_through_hours.render()} "
             f"ride-through (power-vs-energy calculation, binding on "
             f"{bess.binding_limit(ride_through_hours)})",
             min(firm_MW.evidence, option.capacity_MW.evidence, option.energy_MWh.evidence))


def firm_contribution_kW(option: GenerationOption) -> Quantity:
    """Firm capacity this option contributes, in kW."""
    if not option.firm:
        return V(0.0, "kW", f"{option.id} firm contribution (not firm-rated)", ESTIMATED)
    return (option.capacity_MW * firm_factor(option)).convert(
        1000.0, "kW", f"{option.id} firm capacity contribution")


def installed_firm_kW(power: PowerInput) -> Quantity:
    """Total firm capacity from options already taken."""
    total = V(0.0, "kW", "installed behind-the-meter firm capacity", ESTIMATED)
    for o in power.options:
        if o.installed:
            total = total + firm_contribution_kW(o)
    return total.relabel("installed behind-the-meter firm capacity", "power.btm_installed",
                         step_evidence=ESTIMATED)


def option_capex(option: GenerationOption) -> Quantity:
    return (option.capacity_MW.convert(1000.0, "kW", f"{option.id} capacity in kW")
            * option.capex_eur_per_kW).relabel(
        f"{option.id} installed capex", "power.btm_capex", step_evidence=ESTIMATED)


def next_option(power: PowerInput) -> GenerationOption | None:
    """The next behind-the-meter option to take.

    Ordered by time first, then money: in this market the binding scarcity is
    weeks, not euros. An option that contributes no firm capacity is never taken
    to relieve a capacity constraint, whatever it does for energy cost.
    """
    candidates = [o for o in power.options
                  if not o.installed and o.firm and firm_contribution_kW(o).value > 0]
    if not candidates:
        return None
    return sorted(candidates, key=lambda o: (o.lead_time_weeks.value, option_capex(o).value))[0]
