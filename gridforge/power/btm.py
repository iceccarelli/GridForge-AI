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
from .redundancy import DEFAULT_GENERATION_REDUNDANCY, usable_units
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


def _library_bess(option: GenerationOption):
    """The option as a battery, with the library's SOC window and efficiency (every one E0): the one place an option becomes a
    `BatteryEnergyStorageSystem`, so the factor and the checks on it cannot disagree about what "usable" means."""
    from .storage import (DEFAULT_ROUND_TRIP_EFFICIENCY, DEFAULT_SOC_MAX, DEFAULT_SOC_MIN,
                         BatteryEnergyStorageSystem)
    return BatteryEnergyStorageSystem(
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


def bess_energy_limited_hours(option: GenerationOption, factor: float, *, usable: bool = True) -> float | None:
    """How many hours the option's DECLARED energy sustains `factor` x nameplate power, or None when that cannot be said (not a battery,
    no declared energy, or a zero factor or power). `usable=True` takes the library's SOC window (what a battery can really give);
    `usable=False` takes the full stored energy, the hard physical ceiling: no discharge schedule delivers more than is stored."""
    if option.kind != "bess" or option.energy_MWh is None:
        return None
    draw_MW = factor * option.capacity_MW.value
    if draw_MW <= 0:
        return None
    energy = _library_bess(option).usable_energy_MWh().value if usable else option.energy_MWh.value
    return energy / draw_MW


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
    bess = _library_bess(option)
    firm_MW = bess.firm_MW_for_duration(ride_through_hours)
    factor = firm_MW.value / option.capacity_MW.value if option.capacity_MW.value else 0.0
    # Carry the interval through: firm MW and nameplate MW each have a band, and the ratio's band is not a point.
    # (A factor above 1 is impossible, and below 0 is, so the band is clipped to [0, 1].)
    cap_lo, cap_hi = option.capacity_MW.band
    f_lo, f_hi = firm_MW.band
    lo = max(0.0, min(1.0, f_lo / cap_hi)) if cap_hi > 0 else 0.0
    hi = max(0.0, min(1.0, f_hi / cap_lo)) if cap_lo > 0 else 1.0
    return V(factor, "1",
             f"{option.id} firm-capacity factor for {ride_through_hours.render()} "
             f"ride-through (power-vs-energy calculation, binding on "
             f"{bess.binding_limit(ride_through_hours)})",
             min(firm_MW.evidence, option.capacity_MW.evidence, option.energy_MWh.evidence),
             band=(min(lo, factor), max(hi, factor)))


#: Technologies whose capacity is made of discrete, dispatchable units that can each be out of service. A battery's firm credit is bounded by
#: its energy (see `bess_firm_factor_for_duration`), PV and wind are firm for nothing, and a reinforcement is not a unit.
UNIT_BASED_KINDS = frozenset({"gas_engine", "chp", "fuel_cell"})


def unit_usable_fraction(option: GenerationOption) -> Quantity | None:
    """The share of the option's units that count once the redundancy scheme has taken its spares out, or None when the option declares no
    unit count (then nothing is assumed about its structure and the caller keeps the nameplate credit it always gave).

    4 units under N+1 is 3/4; 1 unit under N+1 is 0: a lone engine is not N+1 firm, it is the unit that is lost.
    """
    if option.units is None:
        return None
    scheme = option.redundancy or DEFAULT_GENERATION_REDUNDANCY
    n = usable_units(option.units, scheme)
    return V(n / option.units, "1", f"{option.id} usable units ({n} of {option.units}, {scheme})", ASSUMED)


def firm_contribution_kW(option: GenerationOption) -> Quantity:
    """Firm capacity this option contributes, in kW."""
    if not option.firm:
        return V(0.0, "kW", f"{option.id} firm contribution (not firm-rated)", ESTIMATED)
    firm = option.capacity_MW * firm_factor(option)
    usable = unit_usable_fraction(option)
    if usable is not None:
        firm = firm * usable
    return firm.convert(1000.0, "kW", f"{option.id} firm capacity contribution")


def installed_firm_kW(power: PowerInput) -> Quantity:
    """Total firm capacity from options already taken."""
    total = V(0.0, "kW", "installed behind-the-meter firm capacity", ESTIMATED)
    for o in power.options:
        if o.installed:
            total = total + firm_contribution_kW(o)
    return total.relabel("installed behind-the-meter firm capacity", "power.btm_installed",
                         step_evidence=ESTIMATED)


def option_capex(option: GenerationOption) -> Quantity | None:
    """Installed capex of the option, or None when the client declared no price (never zero)."""
    if option.capex_eur_per_kW is None:
        return None
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
    # An option with no declared lead time or price sorts after every one that has them, never as "0 weeks / free".
    inf = float("inf")

    def key(o: GenerationOption):
        capex = option_capex(o)
        return (o.lead_time_weeks is None, inf if o.lead_time_weeks is None else o.lead_time_weeks.value,
                capex is None, inf if capex is None else capex.value, o.id)
    return sorted(candidates, key=key)[0]
