"""A generation unit with operating behaviour, not a nameplate number with a
firm-capacity discount applied to it.

`btm.DEFAULT_FIRM_FACTOR` already discounts nameplate by a forced-outage
allowance (0.92 for a gas engine, for instance) — that half of the old model was
reasonable. What it never captured is that a generator has to actually be
started before it contributes anything: a unit with a five-minute start on standby
is a very different asset from one with a thirty-minute start from cold, and
"can this architecture ride through a grid loss" depends on which one is on site.
This module is the operating envelope that answers that.
"""
from __future__ import annotations

from dataclasses import dataclass

from ..common import ASSUMED, V
from ..validation import EvidenceClass, Quantity


@dataclass
class GenerationUnit:
    id: str
    kind: str                                  # "gas_engine" | "chp" | "fuel_cell" | "diesel" | ...
    nameplate_MW: Quantity
    minimum_output_MW: Quantity | None = None  # turndown floor; None -> no declared minimum
    ramp_MW_per_min: Quantity | None = None
    startup_time_min: Quantity | None = None   # from a stop/cold state to minimum load
    shutdown_time_min: Quantity | None = None
    minimum_up_time_min: Quantity | None = None
    minimum_down_time_min: Quantity | None = None
    availability: Quantity | None = None       # fraction; overrides forced_outage_rate if given
    forced_outage_rate: Quantity | None = None
    fuel_type: str = ""
    fuel_capacity_hours: Quantity | None = None  # on-site fuel, at full output
    heat_rate_kJ_per_kWh: Quantity | None = None
    reactive_power_capability_MVAR: Quantity | None = None
    operating_cost_eur_per_MWh: Quantity | None = None
    black_start: bool = False
    #: Commercial fields, optional and additive. None means "not costed yet" —
    #: an architecture comparison that includes this unit reports its CAPEX/lead
    #: time as UNKNOWN rather than silently pricing it at zero.
    capex_eur: Quantity | None = None
    lead_time_weeks: Quantity | None = None

    def _availability(self) -> Quantity:
        if self.availability is not None:
            return self.availability
        if self.forced_outage_rate is not None:
            one = V(1.0, "1", "unity", self.forced_outage_rate.evidence)
            return (one - self.forced_outage_rate).relabel(
                f"{self.id} availability (1 - forced outage rate)", "power.gen_availability")
        return V(1.0, "1", f"{self.id} availability (undeclared — treated as 1.0, "
                           f"which overstates firm capacity)", ASSUMED)

    def firm_MW(self) -> Quantity:
        """Nameplate discounted by availability. This is the steady-state
        contribution once the unit is running — it says nothing about whether the
        unit can be running in time, which is `time_to_available_MW` below."""
        return (self.nameplate_MW * self._availability()).relabel(
            f"{self.id} firm capacity", "power.gen_firm_capacity")

    def is_available_within(self, window_min: Quantity) -> bool:
        """Can this unit contribute anything within a given response window — the
        question that actually matters for "does the load survive the first N
        minutes of a grid loss", which nameplate and even firm_MW are silent on."""
        if self.startup_time_min is None:
            return True  # undeclared start time — assumed already running / instant-start
        return self.startup_time_min.value <= window_min.value

    def output_available_within(self, window_min: Quantity) -> Quantity:
        """Firm MW available inside the stated response window: zero if the unit
        cannot start in time, otherwise limited by ramp rate from the minimum
        output up toward nameplate, whichever the window allows."""
        if not self.is_available_within(window_min):
            return V(0.0, "MW", f"{self.id} output within {window_min.render()} "
                              f"(cannot start in time)",
                     min(self.nameplate_MW.evidence,
                        self.startup_time_min.evidence if self.startup_time_min else ASSUMED))
        firm = self.firm_MW()
        if self.ramp_MW_per_min is None or self.startup_time_min is None:
            return firm
        ramp_window = max(window_min.value - self.startup_time_min.value, 0.0)
        floor = self.minimum_output_MW.value if self.minimum_output_MW is not None else 0.0
        rampable = floor + self.ramp_MW_per_min.value * ramp_window
        if rampable >= firm.value:
            return firm
        return V(rampable, "MW", f"{self.id} output within {window_min.render()} "
                              f"(ramp-limited)", firm.evidence)


#: Technology defaults. E0/E1 by construction — a real project replaces these
#: field by field from a supplier's datasheet or a test report, exactly like the
#: cost library and the accelerator platform library.
_DEFAULTS: dict[str, dict[str, float]] = {
    "gas_engine": dict(forced_outage_rate=0.08, startup_time_min=3, ramp_MW_per_min=0.5),
    "chp": dict(forced_outage_rate=0.10, startup_time_min=10, ramp_MW_per_min=0.3),
    "fuel_cell": dict(forced_outage_rate=0.10, startup_time_min=0, ramp_MW_per_min=0.2),
    "diesel": dict(forced_outage_rate=0.05, startup_time_min=1, ramp_MW_per_min=1.0),
}

GENERATION_DEFAULT_ASSUMPTION = (
    "Startup time, ramp rate and forced-outage rate are technology defaults from "
    "published fleet statistics, not this unit's own factory acceptance test. "
    "Replace with supplier-declared and, later, commissioning-measured values."
)


def default_generation_unit(id: str, kind: str, nameplate_MW: float, *,
                            evidence: EvidenceClass = ASSUMED) -> GenerationUnit:
    d = _DEFAULTS.get(kind, {})
    mk = lambda key, unit, label: (
        V(d[key], unit, f"{id} {label} (library default)", ASSUMED,
          assumptions=[GENERATION_DEFAULT_ASSUMPTION])
        if key in d else None)
    return GenerationUnit(
        id=id, kind=kind,
        nameplate_MW=V(nameplate_MW, "MW", f"{id} nameplate rating", evidence),
        forced_outage_rate=mk("forced_outage_rate", "1", "forced outage rate"),
        startup_time_min=mk("startup_time_min", "min", "start-up time"),
        ramp_MW_per_min=mk("ramp_MW_per_min", "MW/min", "ramp rate"),
    )
