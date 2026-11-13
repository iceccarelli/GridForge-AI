from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from ..validation import Quantity


class Architecture(str, Enum):
    RETAINED_AIR = "retained_air"
    RDHX = "rdhx"
    HYBRID_DLC = "hybrid_dlc"      # DLC for the chip load, existing air plant for residual
    FULL_DLC = "full_dlc"          # DLC + dedicated high-temperature loop + new air handling


@dataclass
class PlantSpec:
    id: str
    chilled_water_capacity_kW: Quantity
    design_supply_C: Quantity
    design_return_C: Quantity
    pump_flow_capacity_l_per_min: Quantity
    available_head_kPa: Quantity
    free_cooling_hours_per_year: Quantity
    #: Heat the dry coolers on the DEDICATED high-temperature loop can reject (kW), as the client declared it (nameplate: the conditions it
    #: is rated at are not known). None = not declared: full DLC then has no heat-rejection limit and the loop is an unpriced component.
    #: Read only under full DLC, and only when above zero (zero means none installed: the loop is what the scenario buys).
    dry_cooler_capacity_kW: Quantity | None = None
    dry_cooler_approach_K: Quantity | None = None
    #: Flow the existing hall already draws on this plant (l/min). None = not supplied: the pump flow is then read as flow available
    #: to the new load, exactly as before.
    existing_flow_l_per_min: Quantity | None = None
    #: Heat the plant already carries in the existing hall beyond the IT load (UPS and distribution losses, fan-wall and pump power
    #: rejected to the plant, lighting), kW. None = not supplied: headroom is then plant capacity less the IT load only, as before.
    existing_non_it_heat_kW: Quantity | None = None


@dataclass
class CDUSpec:
    id: str
    rated_capacity_kW: Quantity
    rated_approach_K: Quantity
    rated_flow_l_per_min: Quantity
    units: int
    redundancy: str = "N+1"
    #: False for a CDU the engine ASSUMES so that a liquid scenario can be solved when the client supplied no CDU
    #: schedule. It is not in the hall; it has to be bought, and the economics must say so.
    installed: bool = True
    #: True only when the client DECLARED ``rated_flow_l_per_min`` for this CDU. Then the bank's flow is a limit (usable units x rated flow
    #: over the platform's flow per rack, ``cdu_capacity``); otherwise ``rated_flow_l_per_min`` is a library placeholder that no constraint
    #: reads, so an undeclared flow can never refuse a rack.
    rated_flow_declared: bool = False
    #: False when the client left ``units`` / ``redundancy`` out and the loader read the library default (1 unit, N+1). The engine still computes with
    #: the default, but the specification must not print it as "supplied" (procurement.build site conditions). True for every other construction.
    units_declared: bool = True
    redundancy_declared: bool = True


@dataclass
class RDHxSpec:
    id: str
    capacity_kW_per_rack: Quantity
    requires_water_supply_C: Quantity | None = None


@dataclass
class ThermalInput:
    plant: PlantSpec
    tcs_target_supply_C: Quantity
    cdu_approach_K: Quantity
    residual_air_capacity_kW_per_rack: Quantity
    #: Reference only: no constraint reads this (hydraulic_flow uses the platform's own flow per rack); see thermal/library.py.
    flow_l_per_min_per_kW: Quantity
    cdus: list[CDUSpec] = field(default_factory=list)
    rdhx: RDHxSpec | None = None
    tcs_delta_T_K: Quantity | None = None
    trim_chiller_installed: bool = False
