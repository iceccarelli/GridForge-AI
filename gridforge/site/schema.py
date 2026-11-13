from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from ..validation import Quantity


class FloorType(str, Enum):
    RAISED = "raised_floor"
    SLAB = "slab"


@dataclass
class HallSpec:
    id: str
    build_year: int
    floor_type: FloorType
    net_white_space_m2: Quantity
    floor_loading_kPa: Quantity
    clear_height_m: Quantity
    aisle_pitch_m: Quantity
    rack_positions: int
    positions_available: int
    design_density_kW_per_rack: Quantity
    containment: str = "cold_aisle"
    notes: str = ""
    #: Occupied rack positions as the CLIENT declared them (class E5 at most), or None when they did not: the engine then derives no
    #: occupied count as a fact. Optional and read only by the busway check against the load already in the hall; it moves no rack count.
    occupied_positions: Quantity | None = None
    #: Intake paths of the hall figures (build year, floor type, containment) the client did NOT supply and the library filled in, so a report that
    #: prints them can say they are assumed. Set by the intake loader; empty for a context built by hand.
    assumed_fields: tuple[str, ...] = ()

    @property
    def deployable_positions(self) -> int:
        return min(self.rack_positions, self.positions_available)


@dataclass
class SiteSpec:
    id: str
    name: str
    country: str
    metro: str
    design_drybulb_C: Quantity
    design_wetbulb_C: Quantity
    halls: list[HallSpec] = field(default_factory=list)
    water_available: bool = True
    notes: str = ""

    def hall(self, hall_id: str) -> HallSpec:
        for h in self.halls:
            if h.id == hall_id:
                return h
        raise KeyError(hall_id)
