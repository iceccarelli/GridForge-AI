"""Thermal intake checks that need no loader state: physical bounds, the warnings for declared figures nothing reads, the plant heat
balance, and the wording of the optional thermal gaps.

Kept out of ``loader.py`` so the loader's thermal section changes by a handful of calls. Every function here returns text or a list and
raises nothing: the loader decides whether a message is a refusal (``IntakeError``) or a warning.
"""
from __future__ import annotations

from typing import Any

from ..numerics import leq
from ..thermal.library import (COOLING_KEY_WORDS, KNOWN_THERMAL_KEYS, MIN_APPROACH_K, UNREAD_THERMAL_INPUTS,
                               WATER_CP_KJ_PER_KG_K, WATER_DENSITY_KG_PER_L, heat_carried_kW)
from .schema import DataGap, IntakeReport


#: The dry-cooler approach to the design dry bulb that the full-DLC scenarios assume when the intake gives none (an assumption, E0, band 8-12 K).
#: The facility water the dedicated loop can hold is the design dry bulb plus this, so it is a figure the water gate turns on; it is stated in
#: the data request beside the dry bulb it is added to, and `thermal.plant.dry_cooler_approach_K` replaces it.
DEFAULT_DRY_COOLER_APPROACH_K = 10
DEFAULT_DRY_COOLER_APPROACH_BAND_K = (8, 12)


def tcs_target_problem(tcs_C: float, platform) -> str | None:
    """Why a TCS supply target cannot be delivered to this platform's racks, or None. The bound is the platform's own maximum inlet liquid
    temperature (``max_inlet_liquid_C``): ASHRAE W45 for the NVL72 racks, an equipment SURVIVAL limit, not an operating point."""
    limit = platform.max_inlet_liquid_C.value
    if leq(tcs_C, limit):
        return None
    return (f"thermal.tcs_target_supply_C is {tcs_C:g} degC, above the {limit:g} degC maximum inlet liquid temperature of {platform.id} "
            f"(max_inlet_liquid_C). For these racks W45 is the equipment limit: the temperature they survive, never an operating point, so "
            f"coolant hotter than that cannot be delivered to them. Operators specify 27-32 degC for 500-700 W parts; leave the field out "
            f"to use the library 30 degC, or check the unit")


def approach_problem(path: str, value: float) -> str | None:
    """Why an approach temperature is not plausible, or None. A liquid-to-liquid heat exchanger moves heat only across a temperature
    difference: a zero approach is not a rating (vendor figures are 4-5 K, docs/02 §4), and the facility-water requirement would equal the
    TCS target."""
    if value >= MIN_APPROACH_K:
        return None
    return (f"{path} is {value:g} K, below the {MIN_APPROACH_K:g} K this tool will model. A liquid-to-liquid heat exchanger needs a finite "
            f"temperature difference to move heat (vendor ratings are 4-5 K, docs/02 section 4); a zero or sub-kelvin approach would make "
            f"the facility water required equal to the TCS target itself. Check the unit and for a missing digit, or leave it out to use "
            f"the library figure")


def _declared(doc: dict, path: str) -> bool:
    cur: Any = doc
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return False
        cur = cur[part]
    if isinstance(cur, dict) and "value" in cur:
        cur = cur["value"]
    return cur is not None


def unread_input_warnings(doc: dict) -> list[str]:
    """One warning per declared thermal figure that no constraint limit reads, and one per key under the thermal sections that is not an
    input of this engine at all (a pump-redundancy key, a hot-day derate, a water-availability flag). An input that changes no answer
    must not look as if it did."""
    out: list[str] = []
    for path, why in UNREAD_THERMAL_INPUTS.items():
        if _declared(doc, path):
            out.append(f"{path} was declared, but no constraint reads it: it changes no rack count, cost or date. {why[0].upper()}{why[1:]}.")
    thermal = doc.get("thermal")
    if isinstance(thermal, dict):
        sections: list[tuple[str, dict]] = [("thermal", thermal)]
        for name in ("plant", "rdhx"):
            if isinstance(thermal.get(name), dict):
                sections.append((f"thermal.{name}", thermal[name]))
        cdus = thermal.get("cdus")
        if isinstance(cdus, list):
            for n, item in enumerate(cdus):
                if isinstance(item, dict):
                    ident = item.get("id", n)
                    sections.append((f"thermal.cdus[{ident}]", item))
        for label, node in sections:
            known = KNOWN_THERMAL_KEYS["thermal.cdus" if label.startswith("thermal.cdus[") else label]
            for key in node:
                if key not in known:
                    out.append(f"{label}.{key} is not an input this engine reads (it models no such figure), so it was ignored and "
                               f"changes no result. If it describes equipment or a limit that matters, tell us: it is not counted.")
    for section in ("site", "hall"):
        node = doc.get(section)
        if isinstance(node, dict):
            known_ = _KNOWN_SITE_HALL[section]
            for key in node:
                if key not in known_ and any(w in str(key).lower() for w in COOLING_KEY_WORDS):
                    out.append(f"{section}.{key} is not an input this engine reads (it models no such cooling or water figure), so it was "
                               f"ignored and changes no result.")
    return out


#: The keys the loader reads under ``site`` and ``hall`` (a cooling-sounding key outside them is reported as ignored).
_KNOWN_SITE_HALL: dict[str, frozenset[str]] = {
    "site": frozenset({"id", "name", "country", "metro", "design_drybulb_C", "design_wetbulb_C"}),
    "hall": frozenset({"id", "build_year", "floor_type", "net_white_space_m2", "floor_loading_kPa", "clear_height_m", "aisle_pitch_m",
                       "rack_positions", "positions_available", "occupied_positions", "design_density_kW_per_rack", "containment"}),
}


def heat_balance_warning(*, flow_l_per_min: float, supply_C: float, return_C: float, existing_it_kW: float,
                         existing_flow_declared: bool) -> str | None:
    """A warning (never a number change) when the pumped flow the client gave cannot carry the heat the existing hall already puts on the
    plant at the plant's own design delta-T.

    ``hydraulic_flow`` divides the pumped flow by the flow one rack needs and subtracts the existing hall's flow only when the client
    declares it. If the figure given is the plant's TOTAL flow, the existing hall already uses most of it and the limit overstates the racks
    the plant can serve; if it is flow available to the new load, the plant cannot be moving the existing load at all, which is worth
    checking. Either way the client is asked for the one field that settles it."""
    delta_T = return_C - supply_C
    if existing_flow_declared or delta_T <= 0 or flow_l_per_min <= 0:
        return None
    moved_kW = heat_carried_kW(flow_l_per_min, delta_T)
    if moved_kW >= existing_it_kW:
        return None
    return (f"thermal.plant.pump_flow_capacity_l_per_min ({flow_l_per_min:,.0f} l/min) moves about {moved_kW:,.0f} kW at the plant's design "
            f"delta-T of {delta_T:g} K (water, {WATER_DENSITY_KG_PER_L:g} kg/l x {WATER_CP_KJ_PER_KG_K:g} kJ/kg/K), less than the "
            f"{existing_it_kW:,.0f} kW of IT load the existing hall already puts on the plant. If {flow_l_per_min:,.0f} l/min is the plant's "
            f"TOTAL pumped flow, the existing hall already uses most of it, and the hydraulic_flow limit, which counts all of it for the new "
            f"racks, OVERSTATES the racks the pumps can serve. Give thermal.plant.existing_flow_l_per_min (the flow the existing hall "
            f"draws) and it is subtracted. No result has been changed by this warning")


#: How each optional thermal / hall input reads when it is not supplied: ``value`` renders the figure the library put in its place from the
#: loaded context. Every one is "<value> assumed (library, E0)", so a defaulted figure is never printed as a fact.
def _text(value: str) -> str:
    return f"{value} assumed (library, E0)"


OPTIONAL_ASSUMED_TEXT = {
    "thermal.cdu_approach_K": lambda ctx: _text(f"{ctx.thermal.cdu_approach_K.value:g} K"),
    # The full-DLC water gate's two assumed terms, said with the dry bulb they are added to: "dry bulb 26 + assumed 10 K approach (E0)".
    "thermal.plant.dry_cooler_approach_K": lambda ctx: (
        f"dry bulb {ctx.site.design_drybulb_C.value:g} + assumed {DEFAULT_DRY_COOLER_APPROACH_K:g} K approach (E0) = "
        f"{ctx.site.design_drybulb_C.value + DEFAULT_DRY_COOLER_APPROACH_K:g} degC facility water, the temperature the full-DLC water gate "
        f"compares with what the CDUs need"),
    "thermal.plant.available_head_kPa": lambda ctx: _text(f"{ctx.thermal.plant.available_head_kPa.value:g} kPa"),
    "thermal.plant.free_cooling_hours_per_year": lambda ctx: _text(f"{ctx.thermal.plant.free_cooling_hours_per_year.value:,.0f} h"),
    "hall.containment": lambda ctx: _text(str(ctx.hall.containment).replace("_", " ")),
    "hall.floor_type": lambda ctx: _text(ctx.hall.floor_type.value.replace("_", " ")),
    "hall.build_year": lambda ctx: _text(str(ctx.hall.build_year)),
}

#: The hall figures the study and the board summary print as plain text; one that was assumed says so beside the figure.
HALL_TEXT_PATHS = ("hall.build_year", "hall.floor_type", "hall.containment")

#: Optional gaps that go LAST in the ledger (after the long-standing rows, the busway-load row and the occupied-positions row): the deck's
#: "What nobody has measured yet" slide shows the first eight gaps, and a newer optional input must not displace the long-standing ones.
#: The two approach temperatures the full-DLC water gate adds to its inputs (named optional gaps since the water-gate assumptions were listed). They go
#: after the long-standing rows and BEFORE the tail rows above, so the rows already in the ledger keep their places and the tail stays last.
WATER_GATE_OPTIONAL_PATHS = frozenset({"thermal.plant.dry_cooler_approach_K", "thermal.cdu_approach_K"})
TAIL_OPTIONAL_PATHS = (frozenset(OPTIONAL_ASSUMED_TEXT) - WATER_GATE_OPTIONAL_PATHS) | {"thermal.cdus.rated_approach_K", "thermal.cdus.rated_flow_l_per_min"}


def _ledger_tier(path: str) -> int:
    """0 for the long-standing rows, 1 for the water gate's two approaches, 2 for the tail."""
    return 2 if path in TAIL_OPTIONAL_PATHS else 1 if path in WATER_GATE_OPTIONAL_PATHS else 0


def finish_optional_gaps(report: IntakeReport, ctx) -> None:
    """Word the optional thermal / hall gaps from the values actually loaded, record which hall figures were assumed, and move these rows
    to the end of the ledger (stable: nothing else moves). Called once, after every gap has been recorded."""
    by_path: dict[str, DataGap] = {g.path: g for g in report.gaps}
    for path, text in OPTIONAL_ASSUMED_TEXT.items():
        gap = by_path.get(path)
        if gap is not None:
            gap.fallback_description = text(ctx)
    ctx.hall.assumed_fields = tuple(p for p in HALL_TEXT_PATHS if p in by_path)
    report.gaps.sort(key=lambda g: _ledger_tier(g.path))
