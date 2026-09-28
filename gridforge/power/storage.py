"""A battery is a duration-limited resource, not a firm-capacity multiplier.

The behind-the-meter model this replaces (`btm.DEFAULT_FIRM_FACTOR["bess"] = 0.50`)
treats every battery, of any size, as if it contributes half its nameplate power
indefinitely. That is wrong in both directions: a 2 MW / 8 MWh unit asked to ride
through a 30-minute utility trip can deliver close to its full 2 MW (16 MWh of
duration available in 30 minutes is not the binding limit — power is); the same
unit asked to ride through 6 hours can deliver at most 8 MWh / 6 h ≈ 1.33 MW,
whatever its inverters are rated for. "Firm for how long" is the whole question,
and a single scalar cannot answer it.

This module answers it properly: firm power is the lesser of the power limit
(nameplate minus whatever is reserved for other duty) and the energy limit
(usable energy divided by the duration it must be sustained for).
"""
from __future__ import annotations

from dataclasses import dataclass

from ..common import ASSUMED, V
from ..validation import EvidenceClass, Quantity


def _floor0(q: Quantity) -> Quantity:
    if q.value >= 0:
        return q
    return Quantity(0.0, q.unit, q.prov, 0.0, 0.0)


@dataclass
class BatteryEnergyStorageSystem:
    """One battery block. Duration-aware by construction — there is no path in
    this object that produces a firm-power answer without a duration to check it
    against."""
    id: str
    power_MW: Quantity                       # inverter/PCS rating
    energy_MWh: Quantity                     # nameplate energy
    soc_min: Quantity                        # fraction, e.g. 0.10
    soc_max: Quantity                        # fraction, e.g. 0.95
    round_trip_efficiency: Quantity          # fraction, e.g. 0.88
    reserve_MW: Quantity | None = None       # power held back for a separate duty (e.g. FFR)
    degradation_factor: Quantity | None = None  # fraction of nameplate energy still usable
    grid_forming: bool = False
    grid_following: bool = True
    black_start: bool = False

    def usable_energy_MWh(self) -> Quantity:
        """Energy actually available between the operating SOC bounds, after
        degradation. A unit run 0-100% on a datasheet number that ignores the
        manufacturer's own SOC window is a unit that will trip on low voltage
        the first time it is actually asked for its nameplate duration."""
        window = self.soc_max - self.soc_min
        usable = self.energy_MWh * window
        if self.degradation_factor is not None:
            usable = usable * self.degradation_factor
        return usable.relabel(f"{self.id} usable energy", "power.bess_usable_energy")

    def available_power_MW(self) -> Quantity:
        """Power actually available for the duty being sized, after whatever is
        reserved for something else. Never negative — a reserve that exceeds the
        rating means zero is available for this duty, not a negative number
        nobody downstream should have to floor themselves."""
        if self.reserve_MW is None:
            return self.power_MW
        return _floor0((self.power_MW - self.reserve_MW).relabel(
            f"{self.id} power available after reserve", "power.bess_available_power"))

    def firm_MW_for_duration(self, duration_hours: Quantity) -> Quantity:
        """The real answer to "how much firm power does this battery contribute
        for a ride-through of this long": the lesser of the power limit and the
        energy limit. Both are checked; neither is assumed to dominate."""
        if duration_hours.value <= 0:
            return V(0.0, "MW", f"{self.id} firm power (zero duration requested)",
                     min(self.power_MW.evidence, duration_hours.evidence))
        power_limit = self.available_power_MW()
        energy_limit = (self.usable_energy_MWh() / duration_hours).convert(
            1.0, "MW", f"{self.id} energy-limited power over {duration_hours.render()}")
        winner = power_limit if power_limit.value <= energy_limit.value else energy_limit
        return winner.relabel(
            f"{self.id} firm power for {duration_hours.render()} ride-through",
            "power.bess_firm_capacity")

    def binding_limit(self, duration_hours: Quantity) -> str:
        """Which limit actually governs, so a client can see whether more power
        electronics or more energy is what buys them margin — the single most
        common thing a battery RFP gets wrong by guessing."""
        if duration_hours.value <= 0:
            return "duration"
        power_limit = self.available_power_MW().value
        energy_limit = self.usable_energy_MWh().value / duration_hours.value
        return "power" if power_limit <= energy_limit else "energy"


#: Duration-agnostic defaults, used only when a customer or supplier figure is not
#: yet available. Every one is E0 and must be replaced before an issued
#: deliverable — the same discipline the cost library and platform library apply.
DEFAULT_SOC_MIN = 0.10
DEFAULT_SOC_MAX = 0.95
DEFAULT_ROUND_TRIP_EFFICIENCY = 0.88
DEFAULT_DEGRADATION_FACTOR = 0.92  # year-10 capacity fade, a conservative mid-life figure

BESS_DEFAULT_ASSUMPTION = (
    "SOC window, round-trip efficiency and degradation are technology defaults, not "
    "this unit's own datasheet or a measured capacity test. Replace with the "
    "supplier's warranted values before sizing a firm-capacity commitment on them."
)


def default_bess(id: str, power_MW: float, energy_MWh: float, *,
                 evidence: EvidenceClass = ASSUMED) -> BatteryEnergyStorageSystem:
    """A BESS block from nameplate power and energy alone, filled from library
    defaults. This is the E0 starting point a customer's supplier quote or
    commissioning test result is meant to replace field by field — never the
    number an issued deliverable rests on."""
    return BatteryEnergyStorageSystem(
        id=id,
        power_MW=V(power_MW, "MW", f"{id} nameplate power", evidence),
        energy_MWh=V(energy_MWh, "MWh", f"{id} nameplate energy", evidence),
        soc_min=V(DEFAULT_SOC_MIN, "1", f"{id} minimum SOC (library default)", ASSUMED,
                  assumptions=[BESS_DEFAULT_ASSUMPTION]),
        soc_max=V(DEFAULT_SOC_MAX, "1", f"{id} maximum SOC (library default)", ASSUMED,
                  assumptions=[BESS_DEFAULT_ASSUMPTION]),
        round_trip_efficiency=V(DEFAULT_ROUND_TRIP_EFFICIENCY, "1",
                                f"{id} round-trip efficiency (library default)", ASSUMED,
                                assumptions=[BESS_DEFAULT_ASSUMPTION]),
        degradation_factor=V(DEFAULT_DEGRADATION_FACTOR, "1",
                             f"{id} degradation factor (library default, year-10)", ASSUMED,
                             assumptions=[BESS_DEFAULT_ASSUMPTION]),
    )
