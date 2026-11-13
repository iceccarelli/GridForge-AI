"""Load a customer intake document into an engineering context.

One JSON file in, one study out. Everything the customer did not supply is filled
from the library, recorded as a gap, and rendered in the report as an assumption
with the question that would close it.
"""
from __future__ import annotations

import difflib
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..clock import report_date
from ..common import ASSUMED, CUSTOMER, ESTIMATED, V
from ..compute.library import PLATFORMS, get_platform
from ..compute.schema import ClusterSpec
from ..constraints import EconomicsInput, EnvelopeContext
from ..power.schema import (GenerationOption, GridConnection, LVDistribution, PowerInput,
                            TransformerBank, UPSBlock)
from ..scenario.schema import ScenarioSpec
from ..site.schema import FloorType, HallSpec, SiteSpec
from ..thermal.library import (CDU_L2L_APPROACH_K, PUE_BY_ARCHITECTURE,
                               RESIDUAL_AIR_CAPACITY_LEGACY_kW, TCS_SUPPLY_DESIGN_C)
from ..thermal.schema import Architecture, CDUSpec, PlantSpec, RDHxSpec, ThermalInput
from ..validation import EvidenceClass, Quantity, Source
from .schema import FIELD_BY_PATH, INTAKE_FIELDS, DataGap, IntakeReport, SuppliedSource
from . import thermal_inputs
from .strict_json import DuplicateKeyError, read_json

#: The keys of the annotated form of a figure ({"value": 7.4, "note": ..., "source": ..., "evidence": "E3", "unit": "MW"}). `unit` is checked, not read.
_ANNOTATION_KEYS = frozenset({"value", "note", "source", "evidence", "unit"})
#: How the note of a figure that a ROUTE derived (the qualifier's firm connection capacity, from the contract) begins. Such a figure is annotated
#: E0 like a declared assumption but is not the caller's declaration, so the loader does not record a "declared as an assumption" row for it.
DERIVED_FIGURE_NOTE_PREFIX = "Derived by"
_EVIDENCE_BY_NAME = {e.short: e for e in EvidenceClass}
#: The canonical enum names (E0_ASSUMPTION ... E7_DEPLOYED), read from the enum: our own model pack and reference files carry them, so a client who
#: re-submits a value from them must be understood.
_EVIDENCE_BY_CANONICAL = {e.name: e for e in EvidenceClass}


class IntakeError(ValueError):
    """The intake document cannot be turned into a context at all."""


def _num(raw: Any, what: str = "value") -> float:
    """A JSON number, and nothing else: float() lets through NaN, infinity, null, booleans and numeric strings.
    A non-finite number does not fail later with a traceback; it silently drops a constraint or ranks a hall first.
    A numeric string is refused for the same reason a boolean is: this is a quantity with a unit, and "14" is text, so
    accepting it would mean that whatever sent it never checked what it was sending (a unit label, a locale comma, a
    thousands separator). The website's form converts to numbers before it sends, so nothing legitimate is lost."""
    if isinstance(raw, bool) or raw is None:
        raise IntakeError(f"{what} is {raw!r}, which is not a number")
    if isinstance(raw, str):
        raise IntakeError(f"{what} is the text {raw!r}, which is not a number; send a JSON number, not a string")
    if not isinstance(raw, (int, float)):
        raise IntakeError(f"{what} is a {type(raw).__name__}, which is not a number")
    try:
        v = float(raw)
    except OverflowError:
        raise IntakeError(f"{what} is too large to be a number this tool can model") from None
    if not math.isfinite(v):
        raise IntakeError(f"{what} is {raw!r}; it must be a finite number")
    return v


def declared_evidence_class(path: str, raw: Any) -> EvidenceClass:
    """The evidence class a client declares for a figure: a bare code E0..E7 or exactly one of the eight canonical enum names (E0_ASSUMPTION ...
    E7_DEPLOYED, the spelling our own model pack emits), case-insensitive, surrounding whitespace ignored; nothing else.

    Reading only the first two characters made "E10" an E1, "E39" an E3 and "E1 (measured)" an E1, so a client could attest to a class it
    never named; a bare 0, false or [] was dropped as "nothing declared". Anything that is not exactly a class is refused by field.

    The ONE parser of a declared class: ``change.declared_evidence`` (the diff's evidence fingerprint) calls it too, so the loader and the diff
    cannot disagree about what a class is."""
    if isinstance(raw, str):
        key = raw.strip().upper()
        found = _EVIDENCE_BY_NAME.get(key)
        if found is None:                       # (EvidenceClass is an IntEnum and E0 is 0: test for None, never for truth)
            found = _EVIDENCE_BY_CANONICAL.get(key)
        if found is not None:
            return found
    raise IntakeError(f"{path}: declared evidence {raw!r} is not an evidence class; "
                      f"use exactly one of {', '.join(_EVIDENCE_BY_NAME)} or a canonical name ({', '.join(_EVIDENCE_BY_CANONICAL)}); nothing else is read "
                      f"as a class, and null means not declared")


def _int(raw: Any, what: str = "value") -> int:
    v = _num(raw, what)
    if v != int(v) or v < 0:
        raise IntakeError(f"{what} is {raw!r}; it must be a whole number, zero or more")
    return int(v)


#: Plausibility ceilings, by intake path or by list-item key. Input sanity in the manner of RDHX_MAX_CREDIBLE_kW: they catch a typo, a
#: unit slip or an overflow, they are not a product claim, and each sits far above any single data-centre hall or site (a real asset
#: above one needs a conversation, not an API call). Without them any positive finite number was an answer: a transformer lead time of
#: 1e308 weeks came back as a "dated" scenario, and a million transformer units moved a 160-week date to 44.
PLAUSIBLE_MAX: dict[str, float] = {
    "hall.net_white_space_m2": 200_000, "hall.floor_loading_kPa": 100, "hall.clear_height_m": 30, "hall.aisle_pitch_m": 10,
    "hall.design_density_kW_per_rack": 300, "hall.rack_positions": 50_000, "hall.positions_available": 50_000, "hall.occupied_positions": 50_000,
    "site.design_drybulb_C": 60, "site.design_wetbulb_C": 45,
    "grid.firm_capacity_MVA": 5_000, "grid.contracted_MW": 5_000, "grid.current_site_peak_MW": 5_000, "grid.current_it_load_MW": 5_000,
    "lv.voltage_V": 1_000, "lv.busway_ampacity_A": 10_000, "lv.busway_runs": 1_000, "lv.tapoff_max_A": 5_000,
    "lv.existing_busway_load_kW": 5_000_000,
    "thermal.plant.chilled_water_capacity_kW": 2_000_000, "thermal.plant.pump_flow_capacity_l_per_min": 5_000_000,
    "thermal.plant.existing_flow_l_per_min": 5_000_000, "thermal.plant.existing_non_it_heat_kW": 2_000_000,
    "thermal.plant.available_head_kPa": 2_000, "thermal.plant.free_cooling_hours_per_year": 8_760,
    "thermal.plant.design_supply_C": 40, "thermal.plant.design_return_C": 60,
    "thermal.residual_air_capacity_kW_per_rack": 100,
    # TCS supply target and approaches: a typo or a unit slip, not a product claim (the platform's own W45 bound is checked after this one)
    "thermal.tcs_target_supply_C": 80, "thermal.cdu_approach_K": 50, "thermal.cdus.rated_approach_K": 50,
    "thermal.cdus.rated_flow_l_per_min": 100_000, "thermal.plant.dry_cooler_capacity_kW": 2_000_000,
    # list items, by key
    "transformers.units": 50, "transformers.unit_rating_MVA": 1_000, "transformers.replacement_lead_time_weeks": 520,
    "ups.units": 200, "ups.unit_rating_kW": 20_000,
    "btm_options.capacity_MW": 5_000, "btm_options.lead_time_weeks": 520, "btm_options.capex_eur_per_kW": 50_000,
    "btm_options.energy_MWh": 100_000, "btm_options.opex_eur_per_MWh": 5_000, "btm_options.units": 100,
    "thermal.cdus.rated_capacity_kW": 20_000, "thermal.cdus.units": 500,
    # The dry coolers' approach to the design dry bulb, in kelvin: the same sanity bound as the CDU approach (a typo, not a product claim).
    "thermal.plant.dry_cooler_approach_K": 50,
    # Economics inputs. Generous on purpose: each is a ceiling a typo or a unit slip crosses, not a claim about any market. Without them a
    # fixed O&M of 1e308 EUR/kW/yr made the annual energy cost infinite (`Infinity` in the answer, which is not JSON) and 1e9 gave 8e12 EUR.
    #   energy prices, EUR per MWh (fuel, variable O&M, the grid tariff): the same 5,000 as the all-in `opex_eur_per_MWh` above, about fifteen
    #   times the 2022 gas crisis peak and well above any metered tariff;
    #   fixed O&M, EUR per kW per year: a tenth of the 50,000 EUR/kW capex ceiling above, the most a year of upkeep can plausibly be of the plant
    #   it keeps (real figures are 10-60 EUR/kW/yr for engines and storage).
    "btm_options.fuel_price_eur_per_MWh": 5_000, "btm_options.variable_om_eur_per_MWh": 5_000, "btm_options.fixed_om_eur_per_kW_year": 5_000,
    "economics.electricity_eur_per_MWh": 5_000,
    "btm_options.electrical_efficiency": 1,
}

#: Plausibility FLOORS for a quantity that may legitimately be negative in its unit (a temperature in degC), by intake path. A sign slip
#: (-26 for 26) used to pass: `site.design_drybulb_C` of -26 degC read as an easy site and a full-DLC hall went from 0 racks (the water gate
#: binds at 26 degC dry bulb) to 13, and -1e300 was accepted. A floor names the field and the allowed range, never a product claim.
#:   summer design dry bulb / wet bulb: the design temperature of the WARM season (ASHRAE 0.4% cooling), which is above freezing at every
#:   inhabited site on earth: 0 degC, and below it the figure is the winter one or has lost its sign;
#:   plant chilled-water supply / return: the model carries water properties, and a chilled-water plant is a water or glycol-water loop that
#:   does not run below about -5 degC (the web forms refuse below -5 too, lib/qualify.ts and lib/engagement-intake.ts);
#:   TCS target supply: the loop that feeds the cold plates is water and sits above its freezing point (and well above the hall's dew point).
PLAUSIBLE_MIN: dict[str, float] = {
    "site.design_drybulb_C": 0, "site.design_wetbulb_C": 0,
    "thermal.plant.design_supply_C": -5, "thermal.plant.design_return_C": -5,
    "thermal.tcs_target_supply_C": 0,
    #   a generator's electrical efficiency (fuel to electricity): engines, turbines and fuel cells convert 25-60%; below 5% is a slip, and the
    #   fuel cost per MWh generated is fuel price / efficiency, so a tiny positive fraction made the annual cost infinite.
    "btm_options.electrical_efficiency": 0.05,
}
#: No temperature, anywhere, is below absolute zero: the floor for any figure in degC that has no entry above.
ABSOLUTE_ZERO_C = -273.15

#: What each floor protects, appended to the refusal.
_FLOOR_HINT: dict[str, str] = {
    "site.design_drybulb_C": "This is the SUMMER design dry-bulb (the warm-season design temperature, never a winter one); check the sign and that the unit is degC.",
    "site.design_wetbulb_C": "This is the SUMMER design wet-bulb (the warm-season design temperature, never a winter one); check the sign and that the unit is degC.",
    "thermal.plant.design_supply_C": "A chilled-water plant does not supply colder than about -5 degC; check the sign and that the unit is degC (not K or degF).",
    "thermal.plant.design_return_C": "A chilled-water plant does not return colder than about -5 degC; check the sign and that the unit is degC (not K or degF).",
    "btm_options.electrical_efficiency": "A fuel-fired generator converts roughly 25-60% of its fuel to electricity (engines, turbines, fuel cells); "
                                         "send the fraction (0.4 for 40%), not a percentage, and check for a missing digit.",
    "thermal.tcs_target_supply_C": "The coolant that feeds the cold plates is water and cannot be colder than its freezing point; operators specify 27-32 degC for "
                                   "500-700 W parts. Check the sign and that the unit is degC.",
}


#: Why a ceiling is where it is, when the number is a definition and not just a sanity bound. Appended to the refusal.
_CEILING_HINT: dict[str, str] = {
    "lv.voltage_V": "That is the IEC low-voltage limit (1000 V a.c.): this is the LOW-voltage busway voltage the racks are fed from. A medium-voltage "
                    "figure (3.3, 6.6, 11, 20 kV) belongs to the transformer's primary, which this intake does not take; "
                    "11000 V read as a busway voltage would multiply the busway's capacity by 27.",
}


def _ceil(num: float, key: str, what: str, unit: str = "") -> float:
    """Refuse a value above its plausibility ceiling, by name. Returns the value unchanged otherwise."""
    high = PLAUSIBLE_MAX.get(key)
    if high is not None and num > high:
        hint = _CEILING_HINT.get(key)
        raise IntakeError(
            f"{what} is {num:g}{(' ' + unit) if unit else ''}, above {high:g}{(' ' + unit) if unit else ''}"
            + (f". {hint}" if hint else ", the most this tool will model for one hall. Check the unit and for a stray digit."))
    return num


def plausible_floor(key: str, unit: str = "") -> tuple[float | None, str]:
    """The lowest figure the loader accepts for the intake path `key` and the hint that goes with its refusal: (None, "") when the figure has no floor.
    A temperature with no floor of its own is bounded by absolute zero. For the free route, which refuses a figure by the name the caller sent it
    under and not by the intake path (`/v1/qualify` with `plant_supply_C: -6`), from the same table the loader refuses from."""
    low = PLAUSIBLE_MIN.get(key)
    if low is not None:
        return low, _FLOOR_HINT.get(key, "")
    if unit in _TEMPERATURE_UNITS:
        return ABSOLUTE_ZERO_C, "No temperature can be below absolute zero; check the sign and the unit (degC, not K)."
    return None, ""


def _floor(num: float, key: str, what: str, unit: str = "") -> float:
    """Refuse a value below its plausibility floor (or, for a temperature, below absolute zero), by name and with the allowed range. Returns the
    value unchanged otherwise."""
    low = PLAUSIBLE_MIN.get(key)
    if low is not None and num < low:
        high = PLAUSIBLE_MAX.get(key)
        rng = f"{low:g} to {high:g}" if high is not None else f"{low:g} or more"
        hint = _FLOOR_HINT.get(key)
        raise IntakeError(f"{what} is {num:g}{(' ' + unit) if unit else ''}, below {low:g}{(' ' + unit) if unit else ''}. The allowed range is "
                          f"{rng}{(' ' + unit) if unit else ''}." + (f" {hint}" if hint else ""))
    if unit in _TEMPERATURE_UNITS and num < ABSOLUTE_ZERO_C:
        raise IntakeError(f"{what} is {num:g} {unit}, below absolute zero ({ABSOLUTE_ZERO_C:g} {unit}), which no temperature can be. "
                          f"Check the sign and the unit (degC, not K).")
    return num


#: The free qualifier derives the firm connection capacity as `contracted_MW / DERIVED_FIRM_POWER_FACTOR` (an assumption, E0) when a contract is
#: given and the connection's own figure is not. The factor is named here so the loader and the HTTP layer share it.
DERIVED_FIRM_POWER_FACTOR = 0.97
FIRM_CAPACITY_PATH = "grid.firm_capacity_MVA"
CONTRACTED_PATH = "grid.contracted_MW"


def derived_firm_capacity_MVA(contracted_MW: float) -> float:
    """The firm connection capacity the qualifier derives from a contract: `contracted_MW / 0.97`."""
    return float(contracted_MW) / DERIVED_FIRM_POWER_FACTOR


def _firm_ceiling() -> float:
    """The firm-capacity ceiling, read where it lives (PLAUSIBLE_MAX); infinite when the ceilings are lifted (a test lifts them to reach the solver)."""
    return PLAUSIBLE_MAX.get(FIRM_CAPACITY_PATH, math.inf)


def max_contracted_MW_for_derived_firm() -> float:
    """The largest contract whose derived firm capacity stays within the firm-capacity ceiling (5,000 MVA x 0.97 = 4,850 MW)."""
    return _firm_ceiling() * DERIVED_FIRM_POWER_FACTOR


def _derived_firm_sentence(contracted_MW: float) -> str:
    cap = _firm_ceiling()
    return (f"When firm_capacity_MVA is not sent the qualifier derives it as contracted_MW / {DERIVED_FIRM_POWER_FACTOR:g}, so {contracted_MW:g} MW "
            f"becomes {derived_firm_capacity_MVA(contracted_MW):,.1f} MVA, above the {cap:g} MVA this tool will model. Send contracted_MW of at most "
            f"{max_contracted_MW_for_derived_firm():g} MW, or send firm_capacity_MVA yourself")


def validate_contracted_MW(value: Any, *, name: str = "contracted_MW", derives_firm: bool = True) -> float:
    """Check a contracted capacity BY THE NAME THE CALLER SENT against the plausibility bounds the loader applies to it, and (`derives_firm`) against
    the derivation of the firm connection capacity, so the refusal names `contracted_MW` and what to send. For the HTTP layer: the free qualifier
    builds the firm capacity from the contract, and the loader's own refusal then named `grid.firm_capacity_MVA`, a field the caller never sent
    ('is 12371.1 MVA, above 5000 MVA' for contracted_MW 12000, and 'is 5001.03' for 4851, which is within contracted_MW's own cap).

    Returns the figure as a float, or raises `IntakeError` (a `ValueError`). Never refuses anything the loader accepted: its bounds are the loader's."""
    v = _pos(value, name)
    _ceil(v, CONTRACTED_PATH, name, "MW")
    if derives_firm and derived_firm_capacity_MVA(v) > _firm_ceiling():
        raise IntakeError(f"{name} is {v:g} MW. {_derived_firm_sentence(v)}")
    return v


def _refuse_derived_firm_above_ceiling(firm: float, contracted_raw: Any, what: str) -> None:
    """A firm capacity above its ceiling that is exactly the contract over the derivation factor was DERIVED from `grid.contracted_MW`, not sent:
    say which figure to change, instead of naming a field the caller never wrote. Anything else falls through to the ordinary ceiling refusal."""
    if firm <= _firm_ceiling():
        return
    if isinstance(contracted_raw, dict):
        contracted_raw = contracted_raw.get("value")
    if isinstance(contracted_raw, bool) or not isinstance(contracted_raw, (int, float)) or not math.isfinite(contracted_raw) or contracted_raw < 0:
        return
    if abs(derived_firm_capacity_MVA(contracted_raw) - firm) <= 1e-9 * max(1.0, firm):
        raise IntakeError(f"{what} is {firm:,.1f} MVA, which is {CONTRACTED_PATH} ({contracted_raw:g} MW) divided by {DERIVED_FIRM_POWER_FACTOR:g}: "
                          f"the firm capacity derived from the contract. {_derived_firm_sentence(float(contracted_raw))}")


def _int_max(raw: Any, key: str, what: str) -> int:
    return int(_ceil(float(_int(raw, what)), key, what))


def _pos_max(raw: Any, key: str, what: str, unit: str = "") -> float:
    return _ceil(_pos(raw, what), key, what, unit)


#: Physical range per field. Anything outside is an unconditional refusal: a power
#: factor of 1.5 or a derating factor of 5 does not make a hall exceptional, it
#: makes the document wrong, and a wrong document must not rank.
_FRACTION_PATHS = {            # (0, 1]
    "grid.power_factor", "lv.busway_utilisation_limit", "compute.utilisation",
}
_TEMPERATURE_UNITS = {"degC"}


def _build_year(raw: Any) -> int:
    """A hall that is being assessed already stands: a build year after the report date is a typo (2099 for 2009),
    and the age-dependent assumptions downstream must not run on it."""
    year = _int(raw, "hall.build_year")
    today = report_date().year
    if year > today:
        raise IntakeError(f"hall.build_year is {year}, after the report year {today}; it is the year the hall was built")
    return year


def _frac(raw: Any, what: str) -> float:
    v = _num(raw, what)
    if not 0 < v <= 1:
        raise IntakeError(f"{what} is {v:g}; it must be above 0 and at most 1")
    return v


def _rack_feed_topology(raw: Any) -> str | None:
    """lv.rack_feed_topology: how a rack takes its load from the busway. Absent = not declared (None). Anything else that is not one of
    the two words is refused, never defaulted."""
    if raw is None:
        return None
    if not isinstance(raw, str) or raw not in ("pooled", "single_run"):
        raise IntakeError(f"lv.rack_feed_topology is {raw!r}; use \"pooled\" (a rack's load can be shared across busway runs, e.g. "
                          "A and B feeds) or \"single_run\" (each rack is fed from one run)")
    return raw


def _phases(raw: Any) -> int:
    n = _int(raw, "lv.phases")
    if n not in (1, 3):
        raise IntakeError(f"lv.phases is {n}; busway distribution is modelled as single-phase (1) or three-phase (3)")
    return n


_REDUNDANCY = {"N", "N+0", "N+1", "N+2", "2N", "N+N"}


def _redundancy(raw: Any, what: str) -> str:
    """An unrecognised scheme used to fall back to N (every unit usable): '2N+1' gave 22 racks
    where N+1 gives 13. Refuse it by name instead."""
    r = str(raw).upper().replace(" ", "")
    if r not in _REDUNDANCY:
        raise IntakeError(f"{what} redundancy {raw!r} is not one of N, N+1, N+2 or 2N")
    return str(raw)


def _opt(o: dict, key: str, unit: str, evidence, *, band: float, high: float | None = None):
    """An optional non-negative declared number on a list item, or None. Never defaulted."""
    if o.get(key) is None:
        return None
    v = _pos(o[key], key)
    if high is not None and v > high:
        raise IntakeError(f"{key} is {v:g}; it cannot exceed {high:g}")
    # The plausibility ceiling of the figure (PLAUSIBLE_MAX["btm_options.<key>"]), named by the option it is on: an economics input with no ceiling
    # priced a gigawatt plant at 1e9 EUR/kW/yr of upkeep, and at 1e308 made the annual cost infinite.
    _ceil(v, f"btm_options.{key}", f"btm_options[{o.get('id', o.get('kind', 'BTM'))}].{key}", unit.split("_")[0])
    return V(v, unit, f"{o.get('id', 'BTM')} {key}", evidence, band=band)


def _efficiency(o: dict, v: float) -> float:
    """A generator's electrical efficiency, within its plausibility floor. The fuel cost per MWh generated is the fuel price DIVIDED by it, so an
    efficiency of 1e-300 (above 0, so a valid fraction) made the annual cost infinite: `Infinity` in the answer, which is not JSON."""
    return _floor(v, "btm_options.electrical_efficiency", f"btm_options[{o.get('id', o.get('kind', 'BTM'))}].electrical_efficiency")


def _band_containing(raw: Any, library_band: tuple[float, float], half_width: float) -> tuple[float, float]:
    """The library's band for a fraction, unless the value the client supplied lies outside it. A range that does not contain its own value
    is wrong on its face (a derating of 0.99 printed inside [0.85, 0.95]): then the band is drawn around the supplied value instead, clamped
    to a fraction. A value inside the library band keeps the library band, so the reference results do not move."""
    try:
        v = float(raw)
    except (TypeError, ValueError):
        return library_band
    lo, hi = library_band
    if lo <= v <= hi:
        return library_band
    return (max(v - half_width, 0.0), min(v + half_width, 1.0))


def _strict_bool(raw: Any, what: str) -> bool:
    """true or false, nothing else. bool("false") is True in Python, so the text "false" used to switch a firm-rated option ON."""
    if isinstance(raw, bool):
        return raw
    raise IntakeError(f"{what} must be true or false, not {type(raw).__name__}")


def _supplied_lead_time(raw: Any, what: str) -> Any:
    """A lead time the customer wrote must be greater than zero. Zero would date a long-lead item as instantly available (a band of
    zero around zero) and let another relief set the whole schedule. A missing value is not zero: it is absent and takes the library
    placeholder, labelled as one. Non-numbers are refused by the number parser that follows."""
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return raw
    try:
        v = float(raw)
    except OverflowError:
        return raw          # too large for a float: the number parser that follows refuses it by name
    if v == v and -1e300 < v <= 0:
        raise IntakeError(f"{what} is {str(raw)[:24]}; a lead time must be greater than zero weeks. Leave it out to use the library placeholder "
                          f"(which is labelled as one), or give the quoted delivery time. For a unit already on site or in stock, enter the weeks to "
                          f"install and commission it (at least 1): zero would date a long-lead item as instantly available")
    return raw


def _pos(raw: Any, what: str) -> float:
    v = _num(raw, what)
    if v < 0:
        raise IntakeError(f"{what} is {v:g}; it cannot be negative")
    return v



def _dig(doc: dict, path: str) -> Any:
    cur: Any = doc
    for part in path.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


#: The most items one equipment list (transformers, ups, btm_options, thermal.cdus) may carry. This is a bound on the work one request can
#: demand, NOT an engineering claim about how much plant a hall may have: every item is its own line of plant with its own id (identical
#: units are one item with `units`), each adds a solve per scenario (about 12 ms per transformer measured), and the 512 KiB body limit alone
#: would still allow thousands of them. The ceiling sits far above any hall and campus bank this tool has been given; the refusal names it.
MAX_EQUIPMENT_ITEMS = 100


def _reference_vs_ids(doc: dict, ctx, report: "IntakeReport") -> None:
    """Every shipped example writes project.reference as "<site.id>/<hall.id>". When it uses that form and names a different site or hall
    than the document does, the deliverable would carry a reference to another hall: say so, naming both."""
    proj = doc.get("project")
    ref = proj.get("reference") if isinstance(proj, dict) else None
    if not isinstance(ref, str) or "/" not in ref:
        return
    ref_site, _, ref_hall = (part.strip() for part in ref.partition("/"))
    site_id, hall_id = str(ctx.site.id).strip(), str(ctx.hall.id).strip()
    if ref_site.casefold() != site_id.casefold() or ref_hall.casefold() != hall_id.casefold():
        report.warnings.append(
            f"project.reference names {ref_site!r}/{ref_hall!r}, but the document's site.id and hall.id are {site_id!r}/{hall_id!r}. The "
            f"deliverable carries both, so check which hall this intake describes.")


def _rack_total_supplied(doc: dict) -> bool:
    """Whether the document gave hall.rack_positions at all (a read, never a gap: the total has no field spec). Empty list and null count as not given,
    as in ``_Reader.raw``."""
    v = _dig(doc, "hall.rack_positions")
    return v is not None and not (isinstance(v, list) and not v)


def _busway_vs_existing_load(ctx, report: "IntakeReport", rack_total_supplied: bool = True) -> None:
    """The busway constraint reads `busway_ampacity_A` as the INSTALLED total and does not subtract what is already on it. If the racks
    already in the hall would draw more than that total at their design density, the figure is more likely a spare or per-run value than
    the whole hall's busway: say so rather than let the constraint look more precise than the input.

    The occupied count is the client's own (`hall.occupied_positions`, E5 at most) when they gave one. When they did not, it is NOT a fact about
    the hall: it is every position that is not free, read from the total and the free positions (and from the library's default total when the
    client gave none), and the warning says exactly that, as an assumption (E0), instead of stating a count."""
    import math
    lv, hall = ctx.power.lv, ctx.hall
    if lv.existing_load_kW is not None:
        return          # the load already on the busway was given and is subtracted: the "existing load is not subtracted" caveat no longer applies
    declared = hall.occupied_positions
    occupied = int(declared.value) if declared is not None else max(hall.rack_positions - hall.positions_available, 0)
    existing_kW = occupied * hall.design_density_kW_per_rack.value
    phase = math.sqrt(3) if lv.phases == 3 else 1.0
    total_kW = (phase * lv.voltage_V.value * lv.busway_ampacity_A.value * lv.busway_utilisation_limit.value
                * ctx.power.grid.power_factor.value * lv.busway_runs) / 1000.0
    if existing_kW > total_kW > 0:
        if declared is not None:
            who = f"the {occupied} occupied positions you declared (hall.occupied_positions, {declared.evidence.short})"
            ask = ""
        elif rack_total_supplied:
            who = (f"hall.occupied_positions was not supplied, so the occupied positions are an assumption (E0), not a count. Reading every position "
                   f"that is not free as occupied ({hall.rack_positions} in total less {hall.positions_available} free = {occupied} positions)")
            ask = ", and give hall.occupied_positions so this check runs on a count rather than an assumption"
        else:
            who = (f"neither hall.occupied_positions nor hall.rack_positions was supplied, so the occupied positions are an assumption (E0) from the "
                   f"library default total of {hall.rack_positions} positions, not a count of anything in your hall. Reading that total less your "
                   f"{hall.positions_available} free positions as occupied ({occupied} positions)")
            ask = ", and give hall.occupied_positions and hall.rack_positions (a full intake takes both) so this check runs on counts rather than an assumption"
        report.warnings.append(
            f"Busway: {who}, at their {hall.design_density_kW_per_rack.value:g} kW design density, would draw "
            f"{existing_kW:,.0f} kW, more than the {total_kW:,.0f} kW the declared busway can carry. busway_ampacity_A is read as the "
            f"installed total and existing load is not subtracted, so check whether the figure you gave is the whole hall's busway{ask}.")


def _occupied_positions_disclosure(ctx, report: "IntakeReport", rack_total_supplied: bool) -> None:
    """Occupied positions are an optional figure, and the engine never invents one. Two things need saying about it, once each:
    (1) free positions equal the total and no occupied figure was given: the hall is then read as having nothing occupied, which silences the
    busway check against the load already in it, so the client is asked to confirm it (a declared zero is that confirmation);
    (2) a declared occupied count that, with the free positions, does not account for every position the client says the hall has."""
    hall = ctx.hall
    declared = hall.occupied_positions
    if declared is None:
        if hall.positions_available == hall.rack_positions:
            total = (f"hall.positions_available equals hall.rack_positions ({hall.rack_positions})" if rack_total_supplied else
                     f"hall.rack_positions was not supplied, so the total is taken as the {hall.positions_available} free positions")
            report.warnings.append(
                f"hall.occupied_positions was not supplied and {total}, so no position is read as occupied (an assumption, E0). Please confirm "
                f"that nothing is occupied (declare hall.occupied_positions as 0), or give the number of occupied positions: with none read as "
                f"occupied, the check of the busway against the load already in the hall cannot run.")
        return
    accounted = int(declared.value) + hall.positions_available
    if rack_total_supplied and accounted < hall.rack_positions:
        report.warnings.append(
            f"hall.occupied_positions ({int(declared.value)}) and hall.positions_available ({hall.positions_available}) account for {accounted} of "
            f"the {hall.rack_positions} positions in hall.rack_positions: the other {hall.rack_positions - accounted} are neither free nor "
            f"occupied as declared (reserved, out of service or not yet fitted out). They are not counted as free or as drawing load.")


def _redundancy_leaves_nothing(ctx, report: "IntakeReport") -> None:
    """A declared redundancy that leaves no usable capacity is said at load, by item, instead of surfacing only as a rack count of zero.

    One transformer under N+1, one UPS module under N+1, three modules under 2N: each declaration is legal, and each makes the bank carry less than
    it is rated for (nothing at all for the first two). The constraint then reports a negative headroom ("-8,000 kW usable") and 0 racks with no
    word on why. Two findings, both warnings (the declaration is the client's to correct, and a bank that really is short of the existing load is
    a fact about the hall, not a malformed document): a bank (or CDU bank) whose units under its scheme leave NO usable unit; and a set of banks
    whose usable capacity is below the load they already carry."""
    from ..power.redundancy import usable_units
    power = ctx.power
    pf = power.grid.power_factor.value

    def none_usable(section: str, n: int, ident: str, units: int, scheme: str, thing: str) -> bool:
        if usable_units(units, scheme) > 0:
            return False
        report.warnings.append(
            f"{section}[{n}] ({ident}): {units} {thing} under {scheme} leave no usable unit, so this bank carries no load and counts for nothing "
            f"toward the racks. Check the unit count and the scheme: a single unit cannot be N+1, and two cannot be N+2.")
        return True

    tx_usable_kW, any_tx_usable = 0.0, False
    for n, t in enumerate(power.transformers):
        u = usable_units(t.units, t.redundancy)
        any_tx_usable |= u > 0
        none_usable("transformers", n, t.id, t.units, t.redundancy, "unit(s)")
        tx_usable_kW += t.unit_rating_MVA.value * pf * t.derating_factor.value * u * 1000.0
    peak_kW = power.grid.current_site_peak_MW.value * 1000.0
    if power.transformers and any_tx_usable and tx_usable_kW < peak_kW:
        report.warnings.append(
            f"transformers: the usable capacity as declared is {tx_usable_kW:,.0f} kW (rating x power factor x derating x the units left after the "
            f"redundancy reserve), below the {peak_kW:,.0f} kW current site peak (grid.current_site_peak_MW). The transformers cannot carry the "
            f"existing load as declared, so they allow no racks; check the unit counts, the ratings and the schemes.")

    ups_usable_kW, any_ups_usable = 0.0, False
    for n, u_ in enumerate(power.ups):
        u = usable_units(u_.units, u_.redundancy)
        any_ups_usable |= u > 0
        none_usable("ups", n, u_.id, u_.units, u_.redundancy, "module(s)")
        ups_usable_kW += u_.unit_rating_kW.value * u
    it_kW = power.current_it_load_MW.value * 1000.0
    if power.ups and any_ups_usable and ups_usable_kW < it_kW:
        report.warnings.append(
            f"ups: the usable capacity as declared is {ups_usable_kW:,.0f} kW (module rating x the modules left after the redundancy reserve), below "
            f"the {it_kW:,.0f} kW existing protected IT load (grid.current_it_load_MW). The UPS cannot carry the existing load as declared, so it "
            f"allows no racks; check the module counts, the ratings and the schemes.")

    for n, c in enumerate(ctx.thermal.cdus):
        none_usable("thermal.cdus", n, c.id, c.units, c.redundancy, "CDU(s)")


def _existing_busway_vs_installed(path: str, existing, power, report: "IntakeReport") -> None:
    """The load already on the busway cannot exceed what the installed busway can carry. The comparison is against the NAMEPLATE total
    (voltage x ampacity x power factor x runs, no continuous-load derating): a figure above that is not a hall with a full busway, it is a
    document that is wrong or in the wrong unit. A figure between the derated limit and the nameplate is a busway that is full or over its
    continuous limit: accepted (it leaves no racks) and said."""
    import math
    lv = power.lv
    phase = math.sqrt(3.0) if lv.phases == 3 else 1.0
    nameplate_kW = phase * lv.voltage_V.value * lv.busway_ampacity_A.value * power.grid.power_factor.value * lv.busway_runs / 1000.0
    derated_kW = nameplate_kW * lv.busway_utilisation_limit.value
    amps_path = "lv.busway_ampacity_A"
    where = ("supplied" if amps_path in report.supplied
             else "not supplied, so the library placeholder applies; give the busway's ampacity")
    if existing.value > nameplate_kW:
        raise IntakeError(
            f"{path} is {existing.value:g} kW, more than the {nameplate_kW:,.0f} kW the installed busway can carry at its nameplate "
            f"({lv.busway_runs} run(s) x {lv.busway_ampacity_A.value:g} A at {lv.voltage_V.value:g} V, {amps_path} {where}). The load already "
            f"on the busway is carried by it, so it cannot exceed that: check both figures and their units (kW versus kVA, W versus kW)")
    if existing.value > derated_kW:
        report.warnings.append(
            f"{path} is {existing.value:g} kW, above the {derated_kW:,.0f} kW the busway may carry continuously "
            f"({lv.busway_utilisation_limit.value:g} of its nameplate): the busway is over its continuous limit as declared, so it feeds no "
            f"further rack until the load or the limit is rechecked.")


#: Why `installed` is refused on each equipment list. Each list is read as one thing, and a key that would change what an item MEANS must never be
#: silently dropped (a CDU entry with `installed: false` was accepted, ignored, and counted as a CDU already in the hall).
_INSTALLED_MEANING = {
    "thermal.cdus": "declare only CDUs that are already installed; the scenario prices and dates the units it needs",
    "transformers": "a transformer bank is declared only when it is already in the hall (it is counted as installed capacity); leave a bank that is "
                    "not installed out, the study prices and dates the uprate it needs",
    "ups": "a UPS block is declared only when it is already in the hall (it is counted as installed capacity); leave a block that is not "
           "installed out, the study prices and dates the modules it needs",
    "btm_options": "every option listed is a candidate the study may add, and the study decides whether it is taken; an option already running "
                   "is already in the site's metered peak, so leave it out",
}


#: The keys each equipment list reads, and no others. Built from the loader itself (every key it reads for the section), from the keys every shipped
#: example and every test fixture carries, and from what the website's forms send (lib/engagement-intake.ts, lib/ttp-compare.ts,
#: lib/site-registry-engine.ts). A key outside the set used to be dropped without a word and the engine ran on a default in its place: a typo for
#: `units` was two units (racks 28 -> 0); `in_service: false`, `status: "failed"` and `modules_out: 2` were ignored and the failed plant still
#: counted as capacity; a UPS `derating_factor` was ignored. tests/test_intake_integrity.py pins each set.
EQUIPMENT_KEYS: dict[str, frozenset[str]] = {
    "transformers": frozenset({"id", "unit_rating_MVA", "units", "redundancy", "derating_factor", "replacement_lead_time_weeks"}),
    "ups": frozenset({"id", "unit_rating_kW", "units", "redundancy", "step_load_capability"}),
    "thermal.cdus": frozenset({"id", "rated_capacity_kW", "rated_approach_K", "rated_flow_l_per_min", "units", "redundancy"}),
    "btm_options": frozenset({"id", "kind", "capacity_MW", "capex_eur_per_kW", "lead_time_weeks", "firm", "firm_capacity_factor", "opex_eur_per_MWh",
                              "permitting_note", "energy_MWh", "annual_run_hours", "fuel_price_eur_per_MWh", "electrical_efficiency",
                              "variable_om_eur_per_MWh", "fixed_om_eur_per_kW_year", "units", "redundancy", "ride_through_hours"}),
}

#: The keys each object block of the intake reads. `project` is free text and the top level also carries request options (format, objective, ...) when a
#: request body IS the intake, so neither is listed. Every INTAKE_FIELDS path is inside these sets (tests/test_intake_integrity.py).
BLOCK_KEYS: dict[str, frozenset[str]] = {
    "site": frozenset({"id", "name", "country", "metro", "design_drybulb_C", "design_wetbulb_C"}),
    "hall": frozenset({"id", "build_year", "floor_type", "net_white_space_m2", "floor_loading_kPa", "clear_height_m", "aisle_pitch_m", "rack_positions",
                       "positions_available", "design_density_kW_per_rack", "containment", "occupied_positions"}),
    "grid": frozenset({"dso", "firm_capacity_MVA", "power_factor", "contracted_MW", "current_site_peak_MW", "queue_note", "current_it_load_MW"}),
    "lv": frozenset({"voltage_V", "phases", "busway_ampacity_A", "busway_runs", "busway_utilisation_limit", "tapoff_max_A", "rack_feed_topology",
                     "existing_busway_load_kW"}),
    "thermal": frozenset({"plant", "tcs_target_supply_C", "cdu_approach_K", "residual_air_capacity_kW_per_rack", "rdhx", "cdus"}),
    "thermal.plant": frozenset({"id", "chilled_water_capacity_kW", "design_supply_C", "design_return_C", "pump_flow_capacity_l_per_min",
                                "available_head_kPa", "free_cooling_hours_per_year", "existing_flow_l_per_min", "existing_non_it_heat_kW",
                                "dry_cooler_capacity_kW", "dry_cooler_approach_K"}),
    "thermal.rdhx": frozenset({"capacity_kW_per_rack"}),
    "compute": frozenset({"platform", "utilisation", "default_architecture"}),
    "economics": frozenset({"electricity_eur_per_MWh", "horizon_years", "discount_rate"}),
}


def _one_edit_apart(a: str, b: str) -> bool:
    """True when `a` and `b` are equal or differ by one inserted, deleted or substituted letter, or by two adjacent letters swapped (`gird` for `grid`)."""
    if abs(len(a) - len(b)) > 1:
        return False
    if len(a) == len(b):
        wrong = [i for i, (x, y) in enumerate(zip(a, b)) if x != y]
        if len(wrong) == 2 and wrong[1] == wrong[0] + 1 and a[wrong[0]] == b[wrong[1]] and a[wrong[1]] == b[wrong[0]]:
            return True
        return len(wrong) <= 1
    short, long_ = (a, b) if len(a) < len(b) else (b, a)
    i = 0
    while i < len(short) and short[i] == long_[i]:
        i += 1
    return short[i:] == long_[i + 1:]


def _did_you_mean(key: str, allowed) -> str:
    """" Did you mean `x`?" when the unknown key is a near miss (a case slip or one letter off) of an allowed one, else ""."""
    low = key.lower()
    close = sorted(a for a in allowed if _one_edit_apart(low, a.lower()))
    return f" Did you mean `{close[0]}`?" if close else ""


def _unknown_keys_message(where: str, unknown: list[str], allowed, what: str, effect: str) -> str:
    first = unknown[0]
    more = f" Also unknown here: {', '.join(repr(k[:40]) for k in unknown[1:6])}." if len(unknown) > 1 else ""
    return (f"{where}.{first[:60]} is not an input the engine reads (allowed on {what}: {', '.join(sorted(allowed))}).{_did_you_mean(first, allowed)}{more} "
            f"{effect}, so it is refused rather than ignored")


def _refuse_unknown_block_keys(doc: dict) -> None:
    """An unrecognised key in an intake object block is refused by path, never ignored: `compute.rack_kW: 40` was dropped and the platform's 135 kW
    used, `lv.busway_amps` was dropped and the library's 400 A used. A nested block that must be an object is refused when it is not."""
    for block, allowed in BLOCK_KEYS.items():
        cur: Any = doc
        for part in block.split("."):
            cur = cur.get(part) if isinstance(cur, dict) else None
        if cur is None:
            continue
        if not isinstance(cur, dict):
            raise IntakeError(f"{block} must be an object of fields, not {type(cur).__name__}; omit it to use the library defaults, "
                              f"which are then listed as assumptions")
        unknown = [k for k in cur if k not in allowed]
        if unknown:
            raise IntakeError(_unknown_keys_message(
                block, unknown, allowed, block,
                "A key the engine does not read changes nothing, and the study runs on the library default in its place"))


#: The top-level keys of an intake document: the sections the loader reads. `project` is free text. Every INTAKE_FIELDS path starts with one of these
#: (tests/test_intake_audit_fixes.py).
INTAKE_SECTIONS: tuple[str, ...] = ("project", "site", "hall", "grid", "lv", "thermal", "compute", "economics", "transformers", "ups", "btm_options",
                                    "scenarios")
#: The request options a route reads from a body that IS the intake (`body.get("intake") or body`): the output format and objective, the document
#: view, and the per-route choices (`/v1/spec` takes `scenario`, `constraint` and `list`; `/v1/proposal` an `engagement`; `/v1/diff` an `attribute`;
#: `/v1/power/assess` a `target_racks`). They sit beside the intake's sections at the top level, so they are allowed there. A route that reads a new
#: option adds it here (tests/test_intake_audit_fixes.py fails until it does).
REQUEST_OPTION_KEYS: frozenset[str] = frozenset({
    "intake", "format", "objective", "bundle", "view", "engagement", "valid_days", "contact", "reference", "return_by", "scenario", "constraint",
    "list", "target_racks", "baseline", "attribute", "grid_queue_region", "electricity_price_state", "cost_evidence", "before", "after", "previous_state",
})
TOP_LEVEL_KEYS: frozenset[str] = frozenset(INTAKE_SECTIONS) | REQUEST_OPTION_KEYS


#: The document's own envelope, not content. The API adds `schema_version` to every JSON object it sends, the blank template (`GET /v1/intake/template`)
#: included, so a template saved from the API and filled in carries it; `$schema` is the usual pointer from a JSON-Schema-aware editor. Both are
#: accepted and ignored without a word.
ENVELOPE_KEYS: frozenset[str] = frozenset({"schema_version", "$schema"})
#: Metadata that people and tools write beside the sections of a document (a note to the next reader, a title, a comment). The engine reads none of it,
#: so it is ignored, and the warning says so by name: the caller can see it was not used. A key that starts with `_` or `$` is the same kind of thing
#: (a convention for "not data").
BENIGN_METADATA_KEYS: frozenset[str] = frozenset({"notes", "note", "comment", "comments", "metadata", "meta", "title", "description", "name"})
#: How close (difflib ratio) an unknown top-level key must be to a section or request option to be read as a misspelling of it, beside the one-letter
#: slip (`_one_edit_apart`: a letter inserted, dropped or changed, two adjacent letters swapped, or only the case). 0.8 reads `gird`, `Grid`, `halls` and
#: `thermals` as the section they nearly are, and leaves `contracted_MW` and `site_name` (the qualifier's short form) alone.
TOP_LEVEL_NEAR_MISS_RATIO = 0.8


def _near_misses(key: str, allowed) -> list[str]:
    """The allowed names `key` is a misspelling of: one letter off (`_one_edit_apart`, which includes a case slip and a swap of two adjacent letters)
    or a close match by difflib. Sorted, so the answer never depends on set order."""
    low = key.lower()
    close = {a for a in allowed if _one_edit_apart(low, a.lower())}
    close.update(a for a in allowed if difflib.SequenceMatcher(None, low, a.lower()).ratio() >= TOP_LEVEL_NEAR_MISS_RATIO)
    return sorted(close)


def _top_level_key_class(key) -> str:
    """How the loader treats a top-level key: "section" (read), "envelope" (accepted, silently ignored), "metadata" (ignored, with a named warning),
    "misspelt" (a near miss of a section or request option: REFUSED, with the did-you-mean) or "unread" (far from every section: ignored, with a named
    warning).

    The order matters. A misspelt section is the defect this guards (`"gird": {...}` was dropped without a word, a whole section of figures ignored
    and the study run on library defaults). A refusal of every key that is not a section would refuse a document that was fine before (a template with
    a title, a note, the id of the tool that wrote it), so only what is nearly a section is refused."""
    if not isinstance(key, str) or key in TOP_LEVEL_KEYS:
        return "section"
    if key in ENVELOPE_KEYS:
        return "envelope"
    if key.startswith(("_", "$")) or key in BENIGN_METADATA_KEYS:
        return "metadata"
    return "misspelt" if _near_misses(key, TOP_LEVEL_KEYS) else "unread"


def ignored_top_level_keys(doc: dict) -> list[str]:
    """The top-level keys the engine does not read and says so for (metadata and unread keys; the silent envelope keys are not listed)."""
    return [k for k in doc if _top_level_key_class(k) in ("metadata", "unread")]


def _ignored_key_warnings(doc: dict) -> list[str]:
    return [f"{k[:60]} is not read by the engine: it is not one of the intake's sections ({', '.join(INTAKE_SECTIONS)}) or request options, so it was "
            f"ignored and changes no result. If it was meant as one of them, send it under that name." for k in ignored_top_level_keys(doc)]


def _refuse_unknown_top_level_keys(doc: dict) -> None:
    """A top-level key that is nearly a section of the intake or a request option (a misspelling: `gird`, `Grid`, `halls`) is refused by name, with the
    did-you-mean. `"gird": {...}` was dropped without a word, so a whole section of figures was ignored and the study ran on library defaults, while the
    same typo one level down (`grid.contracted_MWW`) was refused. Every other key the engine does not read is IGNORED, with a named warning
    (`_ignored_key_warnings`), or silently when it is the document's own envelope (`schema_version`, `$schema`): refusing those would refuse the very
    template the engine sent, and a caller whose document was fine before."""
    misspelt = [k for k in doc if _top_level_key_class(k) == "misspelt"]
    if misspelt:
        first = misspelt[0]
        more = f" Also unknown here: {', '.join(repr(k[:40]) for k in misspelt[1:6])}." if len(misspelt) > 1 else ""
        # The one-letter slip is the long-standing did-you-mean; a looser difflib match is named only when there is no such slip.
        close = _near_misses(first, TOP_LEVEL_KEYS)
        best = next((a for a in close if _one_edit_apart(first.lower(), a.lower())), close[0])
        # A body with no section of the intake at all is usually the free qualifier's short form (contracted_MW, site_name, ...) sent to a route that
        # takes an intake document: say that, in the words the API has always used for a request that gives none of the intake's fields.
        nothing = ", and the request contains none of the intake fields, so there is nothing to solve" if not any(k in INTAKE_SECTIONS for k in doc) else ""
        raise IntakeError(
            f"{first[:60]} is not a section of the intake{nothing} (the sections are: {', '.join(INTAKE_SECTIONS)}; request options: "
            f"{', '.join(sorted(REQUEST_OPTION_KEYS - {'intake'}))}). Did you mean `{best}`?{more} A section the engine does not read "
            f"changes nothing, and the study would run on the library defaults in its place, so a misspelt one is refused rather than ignored"
            + (". The short form of figures is for POST /v1/qualify; the other routes take an intake document (GET /v1/tools gives its schema)"
               if nothing else ""))


def _equipment_list(items, section: str, report: "IntakeReport | None" = None) -> list:
    """The equipment list as a list of objects, or a refusal that names the section: not a list, an element that is not an object, an item with a
    key the engine does not read, or more items than a request may ask the engine to solve."""
    if items is None:
        return []
    if not isinstance(items, list):
        raise IntakeError(f"{section} must be a list of objects, not {type(items).__name__}. Leave it out, or send null or [], to declare none: "
                          f"only a list is a declaration (0, false, \"\" and {{}} used to be read as an empty list and counted as supplied)")
    if len(items) > MAX_EQUIPMENT_ITEMS:
        raise IntakeError(f"{section} lists {len(items)} items, more than the {MAX_EQUIPMENT_ITEMS} one request may carry. Identical units "
                          "are one item with `units`; split a campus into one request per hall")
    allowed = EQUIPMENT_KEYS[section]
    for n, item in enumerate(items):
        if not isinstance(item, dict):
            raise IntakeError(f"{section}[{n}] must be an object, not {type(item).__name__}")
        if "installed" in item:
            raise IntakeError(f"{section}[{n}].installed is not an input: {_INSTALLED_MEANING[section]}. It changes what the study counts as already "
                              f"there, so it is refused rather than ignored")
        unknown = [k for k in item if k not in allowed]
        if unknown:
            raise IntakeError(_unknown_keys_message(
                f"{section}[{n}]", unknown, allowed, section,
                "A key the engine does not read changes nothing (a failed or out-of-service unit would still be counted as capacity, a misspelt count "
                "would be read as the default)"))
    _refuse_repeated_ids(items, section)
    if report is not None:
        _warn_content_duplicates(items, section, report)
    return items


def _drop_empty_banks(items: list, section: str, report: "IntakeReport") -> list[tuple[int, dict]]:
    """The (position, item) pairs of an equipment list whose bank has at least one unit. A bank declared with `units` below one (a transformer bank,
    UPS block or CDU bank of zero units) that stands BESIDE a bank with units carries no load and counts for nothing; it is not refused (a schedule
    with a decommissioned bank still on it is a plausible document) but IGNORED, with a named warning, so nothing downstream does arithmetic on it
    (a zero-unit bank under N+1 left a usable count of -1). A `units` that is not a whole number is left to the number parser, which refuses it by name. The position is the
    item's place in the list the client wrote, so a gap or a warning names the item they will find.

    The one exception is a list in which NO bank has a unit. That is not a schedule with a decommissioned bank left on it, it is a declaration of
    zero capacity, and it is KEPT AS DECLARED: the constraint binds at zero racks and the relief buys the first units, exactly as before the empty
    banks were ignored. Ignoring every bank would read "the client declared nothing but empty banks" as "nothing to limit" (the 'no limit' reading of a
    missing schedule: an unlimited answer from a hall whose declared equipment is nothing, 28 racks where 0 were declared). The warning says every
    bank declared 0 units, so the reader sees the schedule was taken at its word."""
    def units_of(item: dict) -> int | None:
        if "units" not in item:
            return None
        try:
            return _int(item["units"], f"{section}.units")
        except IntakeError:
            return None          # not a whole number: the number parser refuses it by name where the bank is read

    counts = [units_of(item) for item in items]
    if items and all(u is not None and u < 1 for u in counts):
        names = ", ".join(f"{section}[{n}] ({item.get('id', n)})" for n, item in enumerate(items[:6])) + (" ..." if len(items) > 6 else "")
        report.warnings.append(
            f"{section}: every bank declared 0 units ({names}), so the schedule is kept as declared: it has no capacity, and the study treats {section} as a "
            f"limit of zero (it binds at zero racks until units are added), not as 'no limit'. If the hall does have this equipment, give the number of "
            f"units each bank has; if the schedule is not known, leave {section} out and it is reported as not supplied.")
        return list(enumerate(items))
    kept: list[tuple[int, dict]] = []
    for n, item in enumerate(items):
        units = counts[n]
        if units is not None and units < 1:
            ident = item.get("id", n)
            report.warnings.append(
                f"{section}[{n}] ({ident}): units is {units}, ignored. A bank with no units carries no load and counts for nothing, so the study "
                f"runs without it; remove it from the list, or give the number of units it has.")
            continue
        kept.append((n, item))
    return kept


def _warn_content_duplicates(items, section: str, report: "IntakeReport") -> None:
    """Two entries that differ only in their id may be one machine listed twice under two names, which would count its capacity twice.
    They may also be two genuinely identical machines, which the engine cannot tell apart from a duplicate: so this WARNS and never
    refuses, and says what to do (declare identical units once, with `units`)."""
    seen: dict[str, str] = {}
    for n, item in enumerate(items):
        body = {k: v for k, v in item.items() if k != "id"}
        key = repr(sorted(body.items(), key=lambda kv: kv[0]))
        ident = str(item.get("id", f"{section}[{n}]"))
        if key in seen:
            report.warnings.append(
                f"{section}: {ident} is identical to {seen[key]} apart from its id. If they are one machine listed twice, its capacity "
                f"is counted twice; if they are two identical machines, declare them once with `units`.")
        else:
            seen[key] = ident


def _refuse_repeated_ids(items, section: str) -> None:
    """A repeated explicit id is the same equipment listed twice (its capacity would be counted twice) or two different items
    sharing one name (ambiguous in a ranking and in a diff). Only ids the customer actually wrote count: an omitted id takes a
    default, and two id-less entries are not a repeat."""
    ids = [str(i["id"]) for i in items or [] if isinstance(i, dict) and i.get("id") is not None]
    seen: set[str] = set()
    repeated = sorted({k for k in ids if k in seen or seen.add(k)})   # linear: one pass, not a count per id
    if repeated:
        raise IntakeError(f"{section} names {', '.join(repeated)} twice: the same equipment listed twice would be counted twice. "
                          "Give each item its own id, or raise `units` for identical units")


#: What the loader reads a transformer bank or UPS block as when the client did not declare it. The engine still computes with these (a number is
#: better than a refusal for a first screen) but each use is a NAMED gap beside the figure (`transformers[TX-1].units`), units and redundancy as
#: REQUIRED ones: omitted, a 2N bank was read as N+1 and gave 29 racks where 4 were declared, and the intake still counted as 100% complete.
DEFAULT_BANK_UNITS = 2
DEFAULT_BANK_REDUNDANCY = "N+1"
#: A CDU entry that omits `units` is one CDU (its long-standing default; transformers and UPS default to two).
DEFAULT_CDU_UNITS = 1
DEFAULT_TRANSFORMER_DERATING = 0.9
DEFAULT_UPS_STEP_LOAD = 0.5

#: The data-request "Assumed" cell of a transformer or UPS schedule that was not declared at all. The bank is then not evaluated: its constraint is
#: "no limit", the MOST favourable reading, so the rack count is an upper bound (the capex and the critical path are lower bounds: see
#: HeadroomLadder.unassessed_banks). It used to print the Python literal `[]`.
UNASSESSED_BANK_TEXT = "not evaluated: treated as no limit, so the rack count is an upper bound (E0)"
#: The kind of a behind-the-meter option that did not say what it is. Not a key of DEFAULT_FIRM_FACTOR, so the option is credited no firm capacity.
UNDECLARED_KIND = "undeclared"
#: The same cell for the CDU schedule: the engine does not leave cooling unassessed, it assumes a kit, prices it and dates it.
ASSUMED_CDU_KIT_TEXT = ("three 1,350 kW N+1 CDUs (2,700 kW usable) assumed as the starting point of the hybrid and full-DLC scenarios (E0); the kit is "
                        "priced as a purchase and the racks that depend on it are dated")


def _item_ref(item: dict, n: int) -> str:
    """How a gap names one item of an equipment list: the id the client gave it, else its position (two items without an id are two items)."""
    return str(item["id"]) if item.get("id") is not None else str(n)


def _bank_gaps(section: str, n: int, item: dict) -> list[DataGap]:
    """Named gaps for what the author of a transformer bank, UPS block or CDU bank left out: `units` and `redundancy` are REQUIRED (they set the usable capacity
    outright), the transformer's `derating_factor` and the UPS's `step_load_capability` are optional (a labelled library default, E0). A key present
    with a bad value is refused by the number parser, not listed here: this is only about what was not said."""
    ups, cdu = section == "ups", section == "thermal.cdus"
    noun = "UPS block" if ups else ("CDU bank" if cdu else "Transformer bank")
    parts = "modules" if ups else "units"
    part = "module" if ups else "unit"
    default_units = DEFAULT_CDU_UNITS if cdu else DEFAULT_BANK_UNITS
    ref = _item_ref(item, n)
    who = ref if item.get("id") is not None else f"{section}[{n}]"
    out: list[DataGap] = []
    if "units" not in item:
        out.append(DataGap(
            path=f"{section}[{ref}].units", label=f"{noun} {who}: number of {parts}", unit="units", required=True,
            fallback_description=(f"nobody declared it: {default_units} {part if default_units == 1 else parts} {'is' if default_units == 1 else 'are'} "
                                  f"assumed (E0), the engine's default, not a count from your drawings"),
            why_it_binds=(f"usable capacity is the {parts} left after the redundancy reserve times the {part} rating: the same rating is a "
                          f"different {'block' if ups else 'bank'} at 2 {parts} and at 6, and so permits a different number of racks"),
            how_to_get_it=("The UPS schedule or single-line diagram: how many identical modules make up the block" if ups else
                           "The CDU nameplates and the mechanical single-line diagram: how many identical CDUs make up the bank" if cdu else
                           "The single-line diagram or the transformer nameplates: how many identical units make up the bank")))
    if "redundancy" not in item:
        out.append(DataGap(
            path=f"{section}[{ref}].redundancy", label=f"{noun} {who}: redundancy scheme", unit="-", required=True,
            fallback_description=(f"nobody declared it: {DEFAULT_BANK_REDUNDANCY} is assumed (E0), one {part} held in reserve"),
            why_it_binds=(f"N+1 holds one {part} back, 2N holds half and N holds none: the same four {parts} are 3, 2 or 4 usable. "
                          f"An omitted scheme was read as N+1, which overstates a 2N {'block' if ups else 'bank'} (and understates an N one)"),
            how_to_get_it="The resilience design or the single-line diagram: N, N+1, N+2 or 2N"))
    if ups and "step_load_capability" not in item:
        out.append(DataGap(
            path=f"{section}[{ref}].step_load_capability", label=f"{noun} {who}: accepted step load", unit="-", required=False,
            fallback_description=(f"nobody declared it: {DEFAULT_UPS_STEP_LOAD:g} is assumed (E0), band 0.3-0.7, as the share of the block's rating accepted "
                                  f"as an instantaneous step"),
            why_it_binds="GPU racks present step loads; the share of its rating a UPS accepts at once decides whether it rides one through",
            how_to_get_it="The UPS datasheet: the instantaneous step-load acceptance, as a fraction of rating"))
    if not ups and not cdu and "derating_factor" not in item:
        out.append(DataGap(
            path=f"{section}[{ref}].derating_factor", label=f"{noun} {who}: derating factor", unit="-", required=False,
            fallback_description=(f"nobody declared it: {DEFAULT_TRANSFORMER_DERATING:g} is assumed (E0), band 0.85-0.95, as the share of nameplate usable"),
            why_it_binds="The share of nameplate the bank can carry continuously at site temperature and loading scales its whole capacity",
            how_to_get_it="The transformer datasheet or the manufacturer's loading guide at the site's ambient and cooling class"))
    return out


@dataclass
class _Reader:
    doc: dict
    report: IntakeReport

    def q(self, path: str, unit: str, label: str, default: Quantity | None = None,
          *, evidence: EvidenceClass | None = None, band: Any = None) -> Quantity:
        raw = _dig(self.doc, path)
        spec = FIELD_BY_PATH.get(path)
        if raw is None:
            if default is None:
                raise IntakeError(f"required field missing and no library default: {path}")
            self._gap(path, spec, default)
            return default
        note, src, ev, declared = None, None, evidence, None
        if isinstance(raw, dict):
            raw, note, src, declared = self._annotation(path, label, raw, unit)
            if declared is not None:
                ev = declared
        if ev is None:
            ev = spec.supplied_evidence if spec else CUSTOMER
        if spec:
            self.report.supplied.append(path)
        num = _num(raw, f"{label} ({path})")
        if unit not in _TEMPERATURE_UNITS and num < 0:
            raise IntakeError(f"{label} ({path}) is {num:g} {unit}; it cannot be negative")
        if path in _FRACTION_PATHS and not 0 < num <= 1:
            raise IntakeError(f"{label} ({path}) is {num:g}; it must be above 0 and at most 1")
        _floor(num, path, f"{label} ({path})", unit)
        if path == FIRM_CAPACITY_PATH:
            _refuse_derived_firm_above_ceiling(num, _dig(self.doc, CONTRACTED_PATH), f"{label} ({path})")
        _ceil(num, path, f"{label} ({path})", unit)
        if src or note:
            self.report.sourced.append(SuppliedSource(path, label, unit, num, src, note, ev.short))
        self._note_declared_assumption(path, spec, f"{num:g} {unit}", declared, note)
        return V(num, unit, label, ev, band=band,
                 assumptions=[note] if note else (),
                 sources=[Source(src)] if src else ())

    def _annotation(self, path: str, label: str, raw: dict, unit: str | None = None):
        """Read `{value, note, source, evidence}`: the value, the note, the source and the declared evidence class (None when not declared).

        One reading for every field that accepts the object form, so a figure's source cannot be honoured on one field and silently dropped on
        another. A key outside {value, note, source, evidence, unit} is refused by name, and a `unit` is accepted only when it is the field's own
        (`unit` here is the loader's unit for it): {"value": 30, "unit": "kVA"} on a field in MVA used to be read as 30 MVA, a factor of 1,000 out.
        It is never converted: the figure is refused and the unit the field takes is named."""
        note = raw.get("note")
        src = raw.get("source")
        # Both are carried through the whole run as text. Anything else (a list, an object, a number) is not a note or a source, and a
        # deeply nested one made the engine fail with a RecursionError (a 500 "engine error") instead of a refusal.
        for what, val in (("note", note), ("source", src)):
            if val is not None and not isinstance(val, str):
                raise IntakeError(f"{path}.{what} must be text, not {type(val).__name__}")
        declared = None
        if raw.get("evidence") is not None:      # JSON null = not declared; ANYTHING else, falsy or not, is a claim and must be a class
            declared = declared_evidence_class(path, raw["evidence"])
            # A client can attest to their own data, never to our validation: E6/E7 are
            # earned by the calibration ledger, not by writing them into an intake.
            if declared > EvidenceClass.E5_CUSTOMER_DATA:
                self.report.warnings.append(
                    f"{path}: declared evidence {declared.short} capped at E5; "
                    f"E6 and E7 are earned through the calibration ledger.")
                declared = EvidenceClass.E5_CUSTOMER_DATA
        if "value" not in raw:
            raise IntakeError(f"{label} ({path}) is an object without a \"value\"; give a number, or an object with a value "
                              f"(and optionally note, source, evidence)")
        extra = [k for k in raw if k not in _ANNOTATION_KEYS]
        if extra:
            raise IntakeError(f"{path}.{extra[0][:60]} is not part of the annotated form (allowed: {', '.join(sorted(_ANNOTATION_KEYS))}); a key the "
                              f"engine does not read changes nothing, so it is refused rather than ignored")
        if raw.get("unit") is not None:
            self._check_unit(path, raw["unit"], unit)
        return raw["value"], note, src, declared

    @staticmethod
    def _check_unit(path: str, declared: Any, unit: str | None) -> None:
        spec = FIELD_BY_PATH.get(path)
        mine = {u for u in (unit, spec.unit if spec else None) if u}
        if mine & {"1", "-"}:
            mine |= {"1", "-"}                 # a dimensionless figure is "1" in the loader and "-" in the data request
        if not isinstance(declared, str) or declared.strip() not in mine:
            shown = repr(declared)[:40]
            if mine:
                raise IntakeError(f"{path} declares unit {shown}, but this field is in {' or '.join(sorted(mine))}. The value is not converted: give "
                                  f"the figure in {sorted(mine)[0]}, or leave the unit out")
            raise IntakeError(f"{path} declares unit {shown}, but this field has no unit to compare it with. The value is not converted: leave the "
                              f"unit out")

    def _record_source(self, path: str, inner, note, src, declared) -> None:
        """Show a number's source and note beside it in the report, as for every other annotated figure."""
        spec = FIELD_BY_PATH.get(path)
        if (src or note) and isinstance(inner, (int, float)) and not isinstance(inner, bool) and inner == inner:
            # `is not None`, not truthiness: E0 is 0 and so falsy, and `declared or ...` replaced a figure declared ASSUMED (E0) with the field's
            # supplied class (E5) in the report's source list, i.e. a class ABOVE the one declared, for every integer-typed figure.
            ev = declared if declared is not None else (spec.supplied_evidence if spec else CUSTOMER)
            self.report.sourced.append(SuppliedSource(path, spec.label if spec else path, spec.unit if spec else "", float(inner), src, note, ev.short))

    def raw(self, path: str, default=None, gap_text: str | None = None):
        """The value at `path`, or `default` (recorded as a gap, shown as `gap_text` when given, else as the default itself)."""
        v = _dig(self.doc, path)
        if isinstance(v, list) and not v:
            v = None          # an empty schedule is a missing schedule, not a supplied one
        if v is None:
            spec = FIELD_BY_PATH.get(path)
            if spec:
                self._gap(path, spec, None, gap_text if gap_text is not None else str(default))
            return default
        spec = FIELD_BY_PATH.get(path)
        if isinstance(v, dict) and "value" in v:
            inner, note, src, declared = self._annotation(path, spec.label if spec else path, v, spec.unit if spec else None)
            # The object form promises that a source and a note are recorded. The integer-typed fields read through here used to accept it and
            # drop both (and any declared evidence) without a word; now a number's provenance is shown beside it like every other figure's.
            self._record_source(path, inner, note, src, declared)
            self._note_declared_assumption(path, spec, f"{inner}", declared, note)
            v = inner
        if spec:
            self.report.supplied.append(path)
        return v

    def _note_declared_assumption(self, path: str, spec, shown: str, evidence: EvidenceClass | None, note: str | None) -> None:
        """A REQUIRED figure that was sent and declared an assumption (evidence E0) is open: it is a template's value, not the hall's own figure, and
        counted as complete it let `can_issue` read true and the recommendation say 'no required inputs are missing, so this supports a full Study'
        for a hall nobody had described. It becomes a named gap row, flagged `declared_assumption`: the completeness ratio and the 'required inputs
        missing' count are unchanged (it was sent; `IntakeReport.required_gaps` lists only what is missing), `can_issue` is false and the
        recommendation says so. A figure whose own note says the route that built the document DERIVED it (the qualifier's firm capacity) is not
        the caller's declaration and is left to that route, which records its own row."""
        if evidence is not EvidenceClass.E0_ASSUMPTION or spec is None or not spec.required:
            return
        if isinstance(note, str) and note.startswith(DERIVED_FIGURE_NOTE_PREFIX):
            return
        if any(g.path == path and g.declared_assumption for g in self.report.gaps):
            return
        self.report.gaps.append(DataGap(
            path=path, label=spec.label, unit=spec.unit, required=True, declared_assumption=True,
            fallback_description=(f"{shown}, declared as an assumption (E0): it was sent but it is not measured data, so it counts as open until "
                                  f"the hall's own figure replaces it"),
            why_it_binds=spec.why_it_binds, how_to_get_it=spec.how_to_get_it))

    def _gap(self, path: str, spec, default: Quantity | None, text: str | None = None) -> None:
        if spec is None:
            return
        desc = text if text is not None else (default.render() if default is not None else "—")
        self.report.gaps.append(DataGap(
            path=path, label=spec.label, unit=spec.unit, required=spec.required,
            fallback_description=desc, why_it_binds=spec.why_it_binds,
            how_to_get_it=spec.how_to_get_it))


@dataclass
class Intake:
    project: dict
    context: EnvelopeContext
    scenarios: list[ScenarioSpec]
    report: IntakeReport
    document: dict

    @property
    def client(self) -> str:
        return str(self.project.get("client") or "Unnamed client")

    @property
    def reference(self) -> str:
        return str(self.project.get("reference") or "—")

    @property
    def synthetic(self) -> bool:
        """True only for an intake that says, in so many words, that it is invented.

        ``project.synthetic: true``, or "synthetic" in the client name or note (the reference intakes
        carry both). Anything else is treated as a real client: stamping a real customer's document
        "SYNTHETIC REFERENCE DATA" is a false statement about their asset, and omitting that stamp
        from a demo is how a demo gets mistaken for a real site -- so the default errs towards real and
        the demo intakes say what they are."""
        p = self.project
        return bool(p.get("synthetic")) or "synthetic" in f"{p.get('client', '')} {p.get('note', '')}".lower()


_ARCH_BY_NAME = {a.value: a for a in Architecture}

#: Input sanity bound for a rear-door heat exchanger's per-rack rating (catches W-for-kW slips); not a product claim.
RDHX_MAX_CREDIBLE_kW = 200.0


def _strip_btm(c: EnvelopeContext) -> EnvelopeContext:
    c = c.copy()
    c.power.options = []
    return c


def _install_cdus(c: EnvelopeContext) -> EnvelopeContext:
    if c.thermal.cdus:
        return c
    c = c.copy()
    c.thermal.cdus = [CDUSpec(
        id="CDU-ROW-assumed",
        rated_capacity_kW=V(1350, "kW", "assumed row CDU rated capacity", ASSUMED, band=0.1),
        rated_approach_K=V(5, "K", "assumed CDU rated approach", ASSUMED),
        rated_flow_l_per_min=V(2000, "l/min", "assumed CDU rated flow", ASSUMED),
        units=3, redundancy="N+1", installed=False)]
    return c


def _high_temp_loop(c: EnvelopeContext) -> EnvelopeContext:
    """The dedicated warm-water loop of the full-DLC scenarios. The facility water it can hold is the design dry bulb plus the dry coolers' approach:
    the client's own (`thermal.plant.dry_cooler_approach_K`, kept as given) or, when they gave none, the library's assumed approach (E0)."""
    c = _install_cdus(c)
    if c.thermal.plant.dry_cooler_approach_K is None:
        c.thermal.plant.dry_cooler_approach_K = V(
            thermal_inputs.DEFAULT_DRY_COOLER_APPROACH_K, "K", "assumed dry cooler approach to dry bulb", ASSUMED,
            band=thermal_inputs.DEFAULT_DRY_COOLER_APPROACH_BAND_K)
    return c


def _scenario_set(names: list[str] | None) -> list[ScenarioSpec]:
    """Scenarios are data. This is the standard five; an intake may name a subset."""
    catalogue = {
        "retained_air": ScenarioSpec(
            "retained_air", "Retained air, grid only", Architecture.RETAINED_AIR,
            "Counterfactual: change nothing about the cooling architecture.",
            overrides=_strip_btm),
        "rdhx": ScenarioSpec(
            "rdhx", "Rear-door heat exchangers, grid only", Architecture.RDHX,
            "Lowest-disruption path; keeps the legacy plant, lifts per-rack capability.",
            overrides=_strip_btm),
        "hybrid_dlc": ScenarioSpec(
            "hybrid_dlc", "Hybrid DLC on retained plant, grid only", Architecture.HYBRID_DLC,
            "Direct-to-chip with the existing plant carrying both liquid and residual air load. "
            "Cheapest route to density, worst energy outcome.",
            overrides=lambda c: _strip_btm(_install_cdus(c))),
        "full_dlc": ScenarioSpec(
            "full_dlc", "Full DLC, grid only", Architecture.FULL_DLC,
            "Dedicated warm-water loop for the chip load, legacy plant for the residual air. "
            "Bounded by the grid connection.",
            overrides=lambda c: _strip_btm(_high_temp_loop(c))),
        "full_dlc_btm": ScenarioSpec(
            "full_dlc_btm", "Full DLC plus behind-the-meter supply", Architecture.FULL_DLC,
            "The same hall with on-site firm supply where the grid connection binds. The only "
            "scenario whose capacity is set by what can be built rather than by the queue.",
            overrides=_high_temp_loop),
    }
    if names is not None:
        # A list of scenario ids, and nothing else. A bare string was read as a list of its characters ("rdhx" -> 'unknown scenario(s): r, d, h, x',
        # "hybrid_dlc" -> 'scenarios names d twice'), a number escaped as "'int' object is not iterable": each is refused by the field's name.
        if not isinstance(names, list):
            kind = type(names).__name__
            hint = ""
            if isinstance(names, str):
                kind = f"the text {names[:40]!r}"
                if names in catalogue:
                    hint = f" Did you mean [\"{names}\"]?"
            raise IntakeError(f"scenarios must be a list of scenario ids (for example [\"retained_air\", \"full_dlc\"]), not {kind}."
                              f"{hint} Available: {', '.join(catalogue)}. Leave the field out for the standard set")
        if not names:
            raise IntakeError("scenarios is an empty list: name at least one, or omit the field for the standard set")
        for i, k in enumerate(names):
            if not isinstance(k, str):
                raise IntakeError(f"scenarios[{i}] must be a scenario id (text), not {'null' if k is None else type(k).__name__}. "
                                  f"Available: {', '.join(catalogue)}")
    keys = names or list(catalogue)
    repeated = sorted({k for k in keys if keys.count(k) > 1})
    if repeated:
        raise IntakeError(f"scenarios names {', '.join(repeated)} twice: a scenario compared with itself is not a comparison "
                          "and would be reported twice")
    missing = [k for k in keys if k not in catalogue]
    if missing:
        raise IntakeError(f"unknown scenario(s): {', '.join(m[:60] for m in missing)}.{_did_you_mean(missing[0], catalogue)} "
                          f"Available: {', '.join(catalogue)}")
    return [catalogue[k] for k in keys]


def _generator_structure(opt: GenerationOption, o: dict, report: IntakeReport) -> None:
    """How many units make up a generation option, and the redundancy the plant is held to.

    `capacity_MW` is the option's TOTAL nameplate (capex and economics are priced on it), so it cannot say whether that is one engine or
    four. Without a unit count the whole nameplate was credited as firm: a single 5 MW engine counted 4.6 MW although, under N+1, the
    engine is exactly the unit whose loss the plant must survive. Declared, the credit is `usable_units` of `units` (the arithmetic
    every transformer, UPS and CDU bank already uses); undeclared, the credit is unchanged and the missing structure is a named gap.

    Refused by name, never ignored: a scheme with no unit count to apply it to, a count that is not a whole number of at least one, and
    either field on a technology whose capacity is not made of units that can each be out of service.
    """
    from ..power.btm import UNIT_BASED_KINDS
    from ..power.redundancy import DEFAULT_GENERATION_REDUNDANCY, usable_units
    raw_units, raw_scheme = o.get("units"), o.get("redundancy")
    if raw_units is None and raw_scheme is None:
        if opt.firm and opt.kind in UNIT_BASED_KINDS:
            report.gaps.append(DataGap(
                path=f"btm_options[{opt.id}].units", label=f"{opt.id} unit count and redundancy", unit="units", required=False,
                fallback_description="credited at nameplate x firm factor, as if no unit could be out of service",
                why_it_binds=("firm capacity under N+1 is what is left after the largest unit is lost: the same capacity is none of it as "
                              "one unit, half as two, three quarters as four. Nameplate alone cannot say which it is"),
                how_to_get_it=("the generator schedule: how many units make up the option's capacity_MW, and the redundancy scheme "
                               "your resilience design requires (N, N+1, N+2 or 2N)")))
        return
    if opt.kind not in UNIT_BASED_KINDS:
        raise IntakeError(
            f"BTM option {opt.id}: units and redundancy describe generating units that can each be out of service, so they apply to "
            f"{', '.join(sorted(UNIT_BASED_KINDS))}, not to a {opt.kind!r} option. Remove them; a battery's firm credit comes from its "
            f"energy and ride-through window, not from a unit count.")
    scheme = _redundancy(raw_scheme, f"BTM option {opt.id}") if raw_scheme is not None else None
    if raw_units is None:
        if scheme is not None and scheme.upper().replace(" ", "") not in ("N", "N+0"):
            raise IntakeError(
                f"BTM option {opt.id}: redundancy {scheme!r} needs units: how many identical units make up the {opt.capacity_MW.value:g} MW? "
                f"A scheme cannot be applied to a plant of unknown size, and ignoring it would credit the whole nameplate as firm.")
        return                                          # "N" with no count asks for nothing more than the nameplate already gives
    units = _int_max(raw_units, "btm_options.units", f"BTM option {opt.id} units")
    if units < 1:
        raise IntakeError(f"BTM option {opt.id}: units is {units}; an option has at least one unit")
    opt.units = units
    opt.redundancy = scheme if scheme is not None else DEFAULT_GENERATION_REDUNDANCY
    if not opt.firm:
        return
    if scheme is None:
        report.warnings.append(
            f"BTM option {opt.id}: {units} unit(s) declared with no redundancy scheme, so {DEFAULT_GENERATION_REDUNDANCY} is assumed, as for the "
            f"transformers, UPS and cooling banks. Declare \"redundancy\": \"N\" to count every unit as firm.")
    if usable_units(units, opt.redundancy) == 0:
        report.warnings.append(
            f"BTM option {opt.id}: {units} unit(s) under {opt.redundancy} leave no usable unit, so it adds no firm capacity. "
            f"The same {opt.capacity_MW.value:g} MW as more, smaller units would.")


def _bess_firm_credit(opt: GenerationOption, o: dict, report: IntakeReport) -> None:
    """What a battery is credited as FIRM capacity, and whether that is consistent with what the intake says about it.

    A battery is firm only for what its energy can sustain over the outage window it must ride through. The flat library factor (0.50)
    knows neither, so a 2 MW / 0.1 MWh battery (about five minutes) was credited exactly as a 2 MW / 8 MWh one. Six cases:

      declared energy and window, no factor      the power-vs-energy calculation (unchanged)
      declared energy, NO window, no factor      the LESSER of the flat 0.50 and what the energy supports over the library's 2 h undeclared
                                                 window: never more than the flat default gave, so an assumed window cannot raise a credit
      no energy, no factor                       the flat 0.50 as before, now with the gap named: the credit is tied to no energy at all
      the customer's own factor, with energy     kept as declared (it outranks a library figure), but REFUSED if it asks for more energy than
                                                 the battery stores (physically impossible), and warned about if it asks for more than the
                                                 usable energy gives over the declared window (or over 2 h, labelled, when none is declared)
      the customer's own factor, no energy       kept as declared, the gap named: nothing to check it against

    Nothing here invents an energy rating or a window; a missing one stays missing and is listed with how to get it.
    """
    from ..power.btm import DEFAULT_FIRM_FACTOR, bess_energy_limited_hours, bess_firm_factor_for_duration
    from ..power.reliability import UNDECLARED_RIDE_THROUGH_LABEL
    flat = DEFAULT_FIRM_FACTOR["bess"]
    customer = opt.firm_capacity_factor
    declared_window = o.get("ride_through_hours") is not None
    window_h = _pos(o["ride_through_hours"], "ride_through_hours") if declared_window else None
    undeclared = V(2.0, "h", UNDECLARED_RIDE_THROUGH_LABEL, ASSUMED)
    P = opt.capacity_MW.value

    def gap(field: str, what: str, fallback: str, why: str, how: str) -> None:
        report.gaps.append(DataGap(path=f"btm_options[{opt.id}].{field}", label=f"{opt.id} {what}", unit="MWh" if field == "energy_MWh" else "h",
                                   required=False, fallback_description=fallback, why_it_binds=why, how_to_get_it=how))

    why_energy = ("a battery is firm only for what its stored energy can sustain: with no energy rating its firm credit is the same "
                  "whatever its size, so the capacity it adds to the envelope is unchecked")
    how_energy = "the battery datasheet or supplier quotation: usable energy in MWh at the discharge rate the duty needs"
    why_window = "the same battery is firm for different capacity over a 15-minute ride-through and over 4 hours"
    how_window = "the outage or ride-through window your site's resilience policy requires, in hours"

    if customer is not None:
        f = customer.value
        if opt.energy_MWh is None:
            gap("energy_MWh", "battery energy rating", f"your firm factor {f:g} accepted as declared, unchecked against the battery's energy",
                why_energy, how_energy)
            return
        gross_h = bess_energy_limited_hours(opt, f, usable=False)
        usable_h = bess_energy_limited_hours(opt, f, usable=True)
        h = window_h if declared_window else undeclared.value
        # Refuse only on what the customer declared: a window the library assumed can never justify refusing their figures.
        if declared_window and gross_h is not None and h > gross_h * (1 + 1e-9):
            raise IntakeError(
                f"BTM option {opt.id}: firm_capacity_factor {f:g} credits {f * P:g} MW as firm, which over the declared {h:g} h "
                f"ride-through needs {f * P * h:g} MWh, but the battery stores only {opt.energy_MWh.value:g} MWh. Those figures "
                f"contradict each other: lower the factor, or raise the energy rating, or shorten the ride-through window.")
        if declared_window and usable_h is not None and h > usable_h * (1 + 1e-9):
            report.warnings.append(
                f"BTM option {opt.id}: firm_capacity_factor {f:g} credits {f * P:g} MW over a {h:g} h window, which needs "
                f"{f * P * h:g} MWh; the declared {opt.energy_MWh.value:g} MWh stores that much but gives about "
                f"{usable_h * f * P:g} MWh between the library's usable state-of-charge bounds. Your factor is kept as declared; "
                f"confirm it against the manufacturer's usable energy.")
        if not declared_window:
            if usable_h is not None and usable_h < undeclared.value:
                report.warnings.append(
                    f"BTM option {opt.id}: firm_capacity_factor {f:g} credits {f * P:g} MW as firm, and the declared "
                    f"{opt.energy_MWh.value:g} MWh sustains that for about {usable_h:.2g} h. No ride-through window was declared, so "
                    f"whether that is enough is unchecked. Your factor is kept as declared.")
            gap("ride_through_hours", "battery ride-through window", f"your firm factor {f:g} accepted as declared, unchecked against a window",
                why_window, how_window)
        return

    # No factor from the customer.
    if opt.energy_MWh is None:
        gap("energy_MWh", "battery energy rating", f"the flat library firm factor {flat:g} (E0), the same for any size of battery",
            why_energy, how_energy)
        return
    if declared_window:
        opt.firm_capacity_factor = bess_firm_factor_for_duration(opt, V(window_h, "h", f"{opt.id} required ride-through", ASSUMED))
        return
    energy_aware = bess_firm_factor_for_duration(opt, undeclared)
    if energy_aware.value < flat:
        opt.firm_capacity_factor = energy_aware
        report.warnings.append(
            f"BTM option {opt.id}: no ride-through window was declared. Over the library's {undeclared.value:g} h default the declared "
            f"{opt.energy_MWh.value:g} MWh supports only {energy_aware.value:.2g} of its {P:g} MW as firm, less than the flat "
            f"{flat:g} it was credited before, so the lower figure is used. Declare the window your site requires.")
        gap("ride_through_hours", "battery ride-through window",
            f"a {undeclared.value:g} h library window gives a firm factor of {energy_aware.value:.2g}",
            why_window, how_window)
    else:
        gap("ride_through_hours", "battery ride-through window",
            f"the flat library firm factor {flat:g} (E0); the declared energy supports at least that over a {undeclared.value:g} h window",
            why_window, how_window)


def load(path: str | Path) -> Intake:
    """The intake in a JSON file. A key repeated within one object is refused by name, as the HTTP layer refuses it: `json.loads` alone kept the LAST
    value and dropped the others without a word, so a file saying "contracted_MW": 3 and later "contracted_MW": 10 was read as 10 and exited 0."""
    try:
        doc = read_json(path)
    except DuplicateKeyError as exc:
        raise IntakeError(f"{path}: {exc}") from None
    return load_document(doc)


def load_document(doc: dict) -> Intake:
    """Turn an intake document into a context. Malformed input is an IntakeError naming the problem,
    never a KeyError or a traceback."""
    if not isinstance(doc, dict):
        raise IntakeError("an intake must be a JSON object")
    _refuse_non_object_blocks(doc)
    _refuse_control_characters(doc)
    _refuse_unknown_top_level_keys(doc)
    _refuse_unknown_block_keys(doc)
    try:
        return _load_document(doc)
    except IntakeError:
        raise
    except KeyError as exc:
        raise IntakeError(f"the intake is missing a required field: {exc.args[0]}") from None
    except (ValueError, TypeError, AttributeError) as exc:
        raise IntakeError(f"the intake is malformed: {exc}") from None


def _refuse_control_characters(node: Any, path: str = "", _depth: int = 0) -> None:
    """A control character (NUL and the rest of C0, DEL; tab, newline and carriage return are ordinary text) inside any text of the intake is
    refused by path. It would be printed into the deliverable, where a C consumer, a CSV importer or a log line truncates at it."""
    if _depth > 64:
        return
    if isinstance(node, str):
        if any((ord(c) < 32 and c not in "\t\n\r") or ord(c) == 127 for c in node):
            raise IntakeError(f"{path or 'the intake'} contains a control character (such as NUL), which cannot be printed into a document; "
                              f"remove it")
    elif isinstance(node, dict):
        for k, v in node.items():
            _refuse_control_characters(k, f"{path}.<key>" if path else "<key>", _depth + 1)
            _refuse_control_characters(v, f"{path}.{k}" if path else str(k), _depth + 1)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            _refuse_control_characters(v, f"{path}[{i}]", _depth + 1)


#: The intake sections that are objects of fields. Present but not an object, the section used to be replaced by library defaults without a
#: word, so an intake whose `grid` was the text "oops" was answered as if the client had supplied no grid data at all.
_OBJECT_SECTIONS = ("site", "hall", "grid", "lv", "thermal", "compute", "economics")


def _refuse_non_object_blocks(doc: dict) -> None:
    for name in _OBJECT_SECTIONS:
        if name in doc and doc[name] is not None and not isinstance(doc[name], dict):
            raise IntakeError(f"{name} must be an object of fields, not {type(doc[name]).__name__}; omit it to use the library defaults, "
                              f"which are then listed as assumptions")


def _project_block(doc: dict) -> dict:
    """``project`` is an object of free-text identifiers (client, reference, objective, ...). Absent means no project block;
    anything else that is not an object (null, boolean, number, text, list) is refused rather than reaching ``.get()`` later,
    where it escaped as an AttributeError (a 500 on the deck route). The value is not echoed back: only its type."""
    if "project" not in doc:
        return {}
    project = doc["project"]
    if not isinstance(project, dict):
        kind = "null" if project is None else type(project).__name__
        raise IntakeError(f"project must be an object (for example {{\"client\": ..., \"reference\": ...}}), not {kind}; "
                          f"omit it to supply no project details")
    return project


def _declared_positions(r, path: str = "hall.positions_available") -> int:
    """The rack positions the document declares at `path` (the free positions by default), or 0 when it does not (or declares something
    unusable, which the field's own validation then reports in its own words)."""
    try:
        v = _dig(r.doc, path)   # a read, not r.raw(): reading must not record a gap
        if isinstance(v, dict) and "value" in v:
            # The annotated form {value, evidence, note}: the number is inside. Without unwrapping, a figure above hall.rack_positions
            # declared assumed (or with a note) was read as "not declared" and refused where the same plain number was accepted.
            v = v["value"]
        return int(v) if isinstance(v, (int, float)) and not isinstance(v, bool) and v == v and 0 <= v < 1e9 else 0
    except Exception:
        return 0


def _read_occupied_positions(r) -> Quantity | None:
    """`hall.occupied_positions`: optional, a whole number of positions (plain or the annotated object form), or None when absent.

    Read at the client's class (E5, or lower when they declare lower; never higher), like every other figure. Absent, it is a named OPTIONAL gap
    (recorded at the end of the load) and no count is derived here: the consequences are stated where the figure would be used (`_busway_vs_existing_load`)."""
    path = "hall.occupied_positions"
    raw = _dig(r.doc, path)
    if raw is None or (isinstance(raw, list) and not raw):
        return None         # the optional gap is recorded at the end of the load, after the long-standing ones
    q = r.q(path, "positions", "occupied rack positions")
    _int_max(q.value, path, path)       # whole, zero or more, and below the ceiling: refused by this field's name otherwise
    return q


def _load_document(doc: dict) -> Intake:
    report = IntakeReport()
    project = _project_block(doc)
    r = _Reader(doc, report)

    platform_id = r.raw("compute.platform", "gb300_nvl72")
    if platform_id not in PLATFORMS:
        raise IntakeError(
            f"unknown platform {platform_id!r}. Available: {', '.join(sorted(PLATFORMS))}. "
            "Platforms whose rack power the manufacturer has not published are deliberately absent."
        )
    platform = get_platform(platform_id)

    occupied_positions = _read_occupied_positions(r)
    hall = HallSpec(
        id=str(r.raw("hall.id", "HALL-1")),
        build_year=_build_year(r.raw("hall.build_year", 2015)),
        floor_type=FloorType(r.raw("hall.floor_type", "raised_floor")),
        net_white_space_m2=r.q("hall.net_white_space_m2", "m2", "hall net white space",
                               V(2000, "m2", "assumed hall net white space", ASSUMED, band=0.3)),
        floor_loading_kPa=r.q("hall.floor_loading_kPa", "kPa", "hall design floor loading",
                              V(12, "kPa", "assumed floor loading (TIA-942 Rated-3 design value)",
                                ASSUMED, band=(8, 15))),
        clear_height_m=r.q("hall.clear_height_m", "m", "clear height",
                           V(3.0, "m", "assumed clear height", ASSUMED, band=0.15)),
        aisle_pitch_m=r.q("hall.aisle_pitch_m", "m", "installed aisle pitch",
                          V(2.4, "m", "assumed aisle pitch", ASSUMED, band=0.15)),
        # An undeclared total never contradicts the free positions that WERE declared: the default total is the library's 400, or the
        # free positions when there are more than that (a hall cannot have more free positions than positions). Without this a hall with
        # 401+ free positions, run through the qualifier that asks only for the free positions, was refused over a figure nobody gave.
        # An undeclared total is the library default as it always was (400, or the free positions when there are more), clamped to the ceiling so a
        # free-positions figure above it is refused by its own field. It does NOT grow to hold an occupied count: a total nobody gave is not a figure
        # to refuse a client's own numbers against (see the consistency check below, which runs only on a total the client gave).
        rack_positions=_int_max(r.raw("hall.rack_positions", min(max(400, _declared_positions(r)), PLAUSIBLE_MAX.get("hall.rack_positions", math.inf))),
                                "hall.rack_positions", "hall.rack_positions"),
        positions_available=_int_max(r.raw("hall.positions_available", 100), "hall.positions_available", "hall.positions_available"),
        design_density_kW_per_rack=r.q(
            "hall.design_density_kW_per_rack", "kW", "hall design density per rack",
            V(8, "kW", "assumed design density (European colo 2010-2020: 8-20 kW/rack)",
              ASSUMED, band=(6, 20))),
        containment=str(r.raw("hall.containment", "cold_aisle")),
        occupied_positions=occupied_positions,
    )
    site = SiteSpec(
        id=str(r.raw("site.id", "SITE-1")),
        name=str(r.raw("site.name", "Unnamed site")),
        country=str(r.raw("site.country", "—")),
        metro=str(r.raw("site.metro", "—")),
        design_drybulb_C=r.q("site.design_drybulb_C", "degC", "summer design dry-bulb",
                             V(32, "degC", "assumed summer design dry-bulb", ASSUMED,
                               band=(30, 36))),
        design_wetbulb_C=r.q("site.design_wetbulb_C", "degC", "summer design wet-bulb",
                             V(21, "degC", "assumed summer design wet-bulb", ASSUMED,
                               band=(19, 23))),
        halls=[hall],
    )

    transformers = []
    equipment_gaps: list[DataGap] = []          # per-item gaps for what an equipment list left out; appended after the long-standing rows (below)
    tx_declared = _equipment_list(r.raw("transformers", [], gap_text=UNASSESSED_BANK_TEXT), "transformers", r.report)
    tx_kept = _drop_empty_banks(tx_declared, "transformers", r.report)
    tx_items = [t for _, t in tx_kept]
    for n, t in tx_kept:
        equipment_gaps.extend(_bank_gaps("transformers", n, t))
        transformers.append(TransformerBank(
            id=str(t.get("id", "TX")),
            unit_rating_MVA=V(_pos_max(t["unit_rating_MVA"], "transformers.unit_rating_MVA", "unit_rating_MVA", "MVA"), "MVA", f"{t.get('id','TX')} unit rating",
                              CUSTOMER),
            units=_int_max(t.get("units", DEFAULT_BANK_UNITS), "transformers.units", "transformer units"),
            redundancy=_redundancy(t.get("redundancy", DEFAULT_BANK_REDUNDANCY), "transformer"),
            # a supplied derating is the client's engineering figure (E3, as before); an absent one is a library
            # default and is an assumption (E0)
            derating_factor=V(_frac(t.get("derating_factor", DEFAULT_TRANSFORMER_DERATING), "transformer derating_factor"), "1",
                              f"{t.get('id','TX')} derating",
                              ESTIMATED if t.get("derating_factor") is not None else ASSUMED,
                              band=_band_containing(t.get("derating_factor", DEFAULT_TRANSFORMER_DERATING), (0.85, 0.95), 0.05)),
            replacement_lead_time_weeks=V(_pos_max(_supplied_lead_time(t.get("replacement_lead_time_weeks", 160), "transformers.replacement_lead_time_weeks"), "transformers.replacement_lead_time_weeks",
                                                   "power transformer lead time", "weeks"),
                                          "weeks", "power transformer lead time", ASSUMED,
                                          # The library placeholder carries the library's band. A value the client supplied carries a band
                                          # AROUND ITSELF (the same +-35% a supplied battery lead time gets): a fixed 80-210 band beside a
                                          # supplied 40 or 300 weeks printed a range that did not contain its own date.
                                          band=(80, 210) if t.get("replacement_lead_time_weeks") is None else 0.35),
        ))
    lead_path = "transformers.replacement_lead_time_weeks"
    if not tx_items or any(t.get("replacement_lead_time_weeks") is None for t in tx_items):
        r._gap(lead_path, FIELD_BY_PATH.get(lead_path), None,
               "library placeholder of 160 weeks (band 80-210), not a manufacturer's quote")
    else:
        report.supplied.append(lead_path)
    ups = []
    ups_declared = _equipment_list(r.raw("ups", [], gap_text=UNASSESSED_BANK_TEXT), "ups", r.report)
    ups_kept = _drop_empty_banks(ups_declared, "ups", r.report)
    for n, u in ups_kept:
        equipment_gaps.extend(_bank_gaps("ups", n, u))
        ups.append(UPSBlock(
            id=str(u.get("id", "UPS")),
            unit_rating_kW=V(_pos_max(u["unit_rating_kW"], "ups.unit_rating_kW", "unit_rating_kW", "kW"), "kW", f"{u.get('id','UPS')} module rating",
                             CUSTOMER),
            units=_int_max(u.get("units", DEFAULT_BANK_UNITS), "ups.units", "UPS units"),
            redundancy=_redundancy(u.get("redundancy", DEFAULT_BANK_REDUNDANCY), "UPS"),
            step_load_capability=V(_frac(u.get("step_load_capability", DEFAULT_UPS_STEP_LOAD), "UPS step_load_capability"), "1",
                                   "accepted instantaneous step load", ASSUMED,
                                   band=_band_containing(u.get("step_load_capability", DEFAULT_UPS_STEP_LOAD), (0.3, 0.7), 0.1)),
        ))

    options = []
    btm_items = _equipment_list(r.raw("btm_options", []), "btm_options", r.report)
    for o in btm_items:
        opt = GenerationOption(
            id=str(o.get("id", o.get("kind", "BTM"))),
            kind=(" ".join(str(o["kind"]).replace("-", " ").split()).replace(" ", "_").lower() if o.get("kind") is not None else UNDECLARED_KIND),
            capacity_MW=V(_pos_max(o["capacity_MW"], "btm_options.capacity_MW", "capacity_MW", "MW"), "MW", f"{o.get('id','BTM')} capacity", ASSUMED),
            # Absent means absent: no invented 900 EUR/kW and no invented 36 weeks. The option is then unpriced /
            # undated (a visible gap below), never ranked as complete and never the source of a date.
            capex_eur_per_kW=(V(_pos_max(o["capex_eur_per_kW"], "btm_options.capex_eur_per_kW", "capex_eur_per_kW", "EUR/kW"), "EUR/kW",
                                f"{o.get('id','BTM')} installed capex", ASSUMED, band=0.3)
                              if o.get("capex_eur_per_kW") is not None else None),
            lead_time_weeks=(V(_pos_max(_supplied_lead_time(o["lead_time_weeks"], "btm_options.lead_time_weeks"), "btm_options.lead_time_weeks", "lead_time_weeks", "weeks"), "weeks",
                               f"{o.get('id','BTM')} lead time", ASSUMED, band=0.35)
                             if o.get("lead_time_weeks") is not None else None),
            firm=_strict_bool(o.get("firm", True), f"btm_options[{o.get('id', o.get('kind', 'BTM'))}].firm"),
            firm_capacity_factor=(V(_frac(o["firm_capacity_factor"], "BTM firm_capacity_factor"), "1",
                                    f"{o.get('id','BTM')} firm factor", ASSUMED, band=0.2)
                                  if o.get("firm_capacity_factor") is not None else None),
            opex_eur_per_MWh=(V(_pos_max(o["opex_eur_per_MWh"], "btm_options.opex_eur_per_MWh", "opex_eur_per_MWh", "EUR/MWh"), "EUR/MWh",
                                f"{o.get('id','BTM')} opex", ASSUMED, band=0.4)
                              if o.get("opex_eur_per_MWh") is not None else None),
            permitting_note=str(o.get("permitting_note", "")),
            energy_MWh=(V(_pos_max(o["energy_MWh"], "btm_options.energy_MWh", "energy_MWh", "MWh"), "MWh", f"{o.get('id','BTM')} energy", ASSUMED,
                          band=0.15)
                       if o.get("energy_MWh") is not None else None),
            annual_run_hours=_opt(o, "annual_run_hours", "h", ASSUMED, band=0.15, high=8760.0),
            fuel_price_eur_per_MWh=_opt(o, "fuel_price_eur_per_MWh", "EUR/MWh_fuel", ASSUMED, band=0.4),
            electrical_efficiency=(V(_efficiency(o, _frac(o["electrical_efficiency"], "BTM electrical_efficiency")), "1",
                                     f"{o.get('id','BTM')} electrical efficiency", ASSUMED, band=0.1)
                                   if o.get("electrical_efficiency") is not None else None),
            variable_om_eur_per_MWh=_opt(o, "variable_om_eur_per_MWh", "EUR/MWh", ASSUMED, band=0.4),
            fixed_om_eur_per_kW_year=_opt(o, "fixed_om_eur_per_kW_year", "EUR/kW/yr", ASSUMED, band=0.4),
        )
        if opt.opex_eur_per_MWh is not None and (
                opt.fuel_price_eur_per_MWh is not None or opt.electrical_efficiency is not None
                or opt.variable_om_eur_per_MWh is not None):
            raise IntakeError(
                f"BTM option {opt.id}: opex_eur_per_MWh is an all-in variable cost per MWh generated and already "
                f"contains fuel and variable O&M. Declare EITHER opex_eur_per_MWh OR fuel_price_eur_per_MWh with "
                f"electrical_efficiency (and variable_om_eur_per_MWh), not both: the fuel would be counted twice.")
        if (opt.fuel_price_eur_per_MWh is None) != (opt.electrical_efficiency is None):
            raise IntakeError(
                f"BTM option {opt.id}: fuel_price_eur_per_MWh and electrical_efficiency are only meaningful "
                f"together (fuel cost per MWh generated = price / efficiency).")
        _generator_structure(opt, o, r.report)
        from ..power.btm import DEFAULT_FIRM_FACTOR, INTERMITTENT_KINDS
        if opt.capex_eur_per_kW is not None and opt.capex_eur_per_kW.value == 0:
            # A declared zero is a price, not a missing one: the relief is then costed at nothing and the capex total drops by the option's whole cost.
            r.report.warnings.append(
                f"BTM option {opt.id}: capex_eur_per_kW is 0, so the option is priced as free and the capex total excludes its cost. Leave the field "
                f"out if the price is not known (the option is then listed as unpriced and the total as a lower bound), or give the quoted EUR/kW.")
        if opt.kind == UNDECLARED_KIND:
            # An option without a kind is not a battery (it used to be read as one) and not any other technology: no firm credit, said by name.
            r.report.warnings.append(
                f"BTM option {opt.id}: kind was not declared, so the engine cannot say what technology it is and credits it 0 MW as firm capacity "
                f"(it is not read as a battery). Declare kind as one of {', '.join(sorted(DEFAULT_FIRM_FACTOR))}.")
            r.report.gaps.append(DataGap(
                path=f"btm_options[{opt.id}].kind", label=f"{opt.id} technology (kind)", unit="-", required=False,
                fallback_description="none: credited 0 MW as firm capacity; not read as a battery or as any other technology",
                why_it_binds=("the firm capacity an option adds depends on what it is: a generator, a battery and a solar array are credited very "
                              "differently, and with no kind the option adds nothing to the envelope"),
                how_to_get_it="the supplier's proposal or the generation schedule: the technology of the option"))
        elif opt.kind not in DEFAULT_FIRM_FACTOR:
            # Not refused: a real generator (a diesel set, a gas turbine) is a legitimate thing to declare, and rejecting the whole intake for it
            # would cost the customer the rest of the analysis. It is simply not credited: with no library basis for its firm capacity and no way to
            # check the customer's factor, the option contributes 0 MW as firm, and the warning says how to get it counted.
            r.report.warnings.append(
                f"BTM option {opt.id}: kind {opt.kind!r} is not one the engine models ({', '.join(sorted(DEFAULT_FIRM_FACTOR))}), so it is "
                f"credited 0 MW as firm capacity rather than on your factor alone. Declare it as the nearest modelled kind with its unit count "
                f"and redundancy if that is what it is, or tell us which technology to add.")
        if opt.kind in INTERMITTENT_KINDS and o.get("firm_capacity_factor") not in (None, 0, 0.0):
            r.report.warnings.append(
                f"BTM option {opt.id}: a {opt.kind} array carries no continuous firm capacity, so the declared firm_capacity_factor "
                f"{o.get('firm_capacity_factor')!r} is not applied: it is credited 0 MW as firm. Declare storage with a ride-through window "
                f"for the part of its output that must be relied on.")
        if opt.kind == "bess" and opt.firm:
            _bess_firm_credit(opt, o, r.report)
            if opt.energy_MWh is None:
                r.report.warnings.append(
                    f"BTM option {opt.id}: it is credited as firm capacity with NO declared energy rating. A battery is firm only for what "
                    f"its stored energy can sustain, and recharge is not modelled, so the racks this adds are unverified.")
        from ..power.btm import UNIT_BASED_KINDS as _UBK
        if opt.firm and opt.kind in _UBK and o.get("units") is None:
            r.report.warnings.append(
                f"BTM option {opt.id}: no unit count was declared, so it is credited at nameplate x firm factor as if no unit could be out "
                f"of service. A single unit under N+1 would count as zero firm capacity; the racks this adds are unverified.")
        for key, what, unit, why in (
                ("capex_eur_per_kW", "installed capex", "EUR/kW",
                 "without a price the relief that installs this option is reported as unpriced and the capex "
                 "total is a lower bound"),
                ("lead_time_weeks", "lead time", "weeks",
                 "without a lead time the schedule is incomplete: no date is given for any capacity that "
                 "depends on this option")):
            if getattr(opt, key) is None:
                r.report.gaps.append(DataGap(
                    path=f"btm_options[{opt.id}].{key}", label=f"{opt.id} {what}", unit=unit, required=False,
                    fallback_description="none: the option is left unpriced / undated, not defaulted",
                    why_it_binds=why, how_to_get_it="a supplier quotation or programme for this option"))
        options.append(opt)

    existing_busway_path = "lv.existing_busway_load_kW"
    existing_busway = None
    if _dig(doc, existing_busway_path) is None:
        r._gap(existing_busway_path, FIELD_BY_PATH.get(existing_busway_path), None,
               "0 kW, nothing subtracted (busway_ampacity_A is read as the whole installed total)")
    else:
        existing_busway = r.q(existing_busway_path, "kW", "load already on the busway")

    power = PowerInput(
        grid=GridConnection(
            dso=str(r.raw("grid.dso", "—")),
            firm_capacity_MVA=r.q("grid.firm_capacity_MVA", "MVA", "firm connection capacity",
                                  V(10.0, "MVA", "assumed firm connection capacity", ASSUMED,
                                    band=0.3)),
            power_factor=r.q("grid.power_factor", "1", "site power factor",
                             V(0.97, "1", "assumed site power factor", ASSUMED, band=(0.95, 0.99))),
            contracted_MW=r.q("grid.contracted_MW", "MW", "contracted capacity",
                              V(9.0, "MW", "assumed contracted capacity", ASSUMED, band=0.3)),
            current_site_peak_MW=r.q("grid.current_site_peak_MW", "MW", "current site peak demand",
                                     V(5.0, "MW", "assumed current site peak", ASSUMED, band=0.4)),
            queue_note=str(r.raw("grid.queue_note", "")),
        ),
        current_it_load_MW=r.q("grid.current_it_load_MW", "MW", "current protected IT load",
                               V(3.5, "MW", "assumed current IT load", ASSUMED, band=0.4)),
        transformers=transformers,
        ups=ups,
        lv=LVDistribution(
            voltage_V=r.q("lv.voltage_V", "V", "LV distribution voltage",
                          V(400, "V", "assumed LV distribution voltage", ASSUMED)),
            phases=_phases(r.raw("lv.phases", 3, gap_text="three-phase distribution assumed (E0)")),
            busway_ampacity_A=r.q("lv.busway_ampacity_A", "A", "installed busway ampacity",
                                  V(400, "A", "assumed legacy busway ampacity", ASSUMED,
                                    band=(250, 630))),
            busway_runs=_int_max(r.raw("lv.busway_runs", 6), "lv.busway_runs", "lv.busway_runs"),
            busway_utilisation_limit=r.q("lv.busway_utilisation_limit", "1",
                                         "continuous-load derating on busway",
                                         V(0.8, "1", "assumed continuous-load derating", ASSUMED)),
            tapoff_max_A=r.q("lv.tapoff_max_A", "A", "installed tap-off rating",
                             V(63, "A", "assumed legacy tap-off rating", ASSUMED, band=(32, 125))),
            rack_feed_topology=_rack_feed_topology(_dig(r.doc, "lv.rack_feed_topology")),
            existing_load_kW=existing_busway,
        ),
        options=options,
    )

    cdus = []
    approach_omitted = flow_omitted = False
    cdu_declared = _equipment_list(r.raw("thermal.cdus", [], gap_text=ASSUMED_CDU_KIT_TEXT), "thermal.cdus")
    cdu_kept = _drop_empty_banks(cdu_declared, "thermal.cdus", r.report)
    for cdu_n, c in cdu_kept:
        approach_given, flow_given = "rated_approach_K" in c, "rated_flow_l_per_min" in c
        approach_omitted, flow_omitted = approach_omitted or not approach_given, flow_omitted or not flow_given
        approach = _pos_max(c.get("rated_approach_K", 5), "thermal.cdus.rated_approach_K", "rated_approach_K", "K")
        problem = thermal_inputs.approach_problem(f"thermal.cdus.rated_approach_K ({c.get('id', 'CDU')})", approach) if approach_given else None
        if problem:
            raise IntakeError(problem)
        equipment_gaps.extend(_bank_gaps("thermal.cdus", cdu_n, c))
        cdus.append(CDUSpec(
            id=str(c.get("id", "CDU")),
            rated_capacity_kW=V(_pos_max(c["rated_capacity_kW"], "thermal.cdus.rated_capacity_kW", "rated_capacity_kW", "kW"), "kW",
                                f"{c.get('id','CDU')} rated capacity", CUSTOMER, band=0.1),
            # A declared rating is the client's figure (a nameplate, E5); an omitted one is the library placeholder (E0) and a named gap.
            rated_approach_K=V(approach, "K", f"{c.get('id','CDU')} rated approach", CUSTOMER if approach_given else ASSUMED),
            rated_flow_l_per_min=V(_pos_max(c.get("rated_flow_l_per_min", 2000), "thermal.cdus.rated_flow_l_per_min", "rated_flow_l_per_min", "l/min"),
                                   "l/min", f"{c.get('id','CDU')} rated flow", CUSTOMER if flow_given else ASSUMED),
            units=_int_max(c.get("units", DEFAULT_CDU_UNITS), "thermal.cdus.units", "CDU units"),
            redundancy=_redundancy(c.get("redundancy", DEFAULT_BANK_REDUNDANCY), "CDU"),
            rated_flow_declared=flow_given,
            units_declared="units" in c,
            redundancy_declared="redundancy" in c,
        ))
    if cdus:
        for cdu_path, omitted, fallback in (
                ("thermal.cdus.rated_approach_K", approach_omitted, "5 K assumed (library, E0)"),
                ("thermal.cdus.rated_flow_l_per_min", flow_omitted,
                 "no CDU flow limit applied (CDU flow is read only when every CDU declares it): CDU capacity rests on heat alone")):
            if omitted:
                r._gap(cdu_path, FIELD_BY_PATH.get(cdu_path), None, fallback)
            else:
                report.supplied.append(cdu_path)

    existing_flow_path = "thermal.plant.existing_flow_l_per_min"
    existing_flow = None
    if _dig(doc, existing_flow_path) is None:
        r._gap(existing_flow_path, FIELD_BY_PATH.get(existing_flow_path), None,
               "0 l/min, nothing subtracted (the pumped flow is read as flow available to the new load)")
    else:
        existing_flow = r.q(existing_flow_path, "l/min", "flow the existing hall already draws")

    non_it_path = "thermal.plant.existing_non_it_heat_kW"
    non_it_heat = None
    if _dig(doc, non_it_path) is None:
        r._gap(non_it_path, FIELD_BY_PATH.get(non_it_path), None,
               "0 kW, nothing subtracted (plant headroom is the plant capacity less the IT load only)")
    else:
        non_it_heat = r.q(non_it_path, "kW", "other heat the existing hall already puts on the plant")

    # Optional: heat the dry coolers of the dedicated full-DLC loop can reject. Absent, full DLC has no heat-rejection limit (and the loop is an
    # unpriced component); it is not a gap row because nothing is assumed in its place.
    dry_cooler_path = "thermal.plant.dry_cooler_capacity_kW"
    dry_cooler_capacity = (r.q(dry_cooler_path, "kW", "dry-cooler heat rejection on the dedicated loop")
                           if _dig(doc, dry_cooler_path) is not None else None)

    # Optional: the dry coolers' approach to the design dry bulb. A figure the client gives is read here (E3, like the dry-cooler capacity) and
    # kept by the full-DLC scenarios; absent, those scenarios assume 10 K (E0), and the data request says so beside the dry bulb it is added to.
    dry_cooler_approach_path = "thermal.plant.dry_cooler_approach_K"
    dry_cooler_approach = None
    if _dig(doc, dry_cooler_approach_path) is not None:
        dry_cooler_approach = r.q(dry_cooler_approach_path, "K", "dry-cooler approach to the design dry bulb")
        problem = thermal_inputs.approach_problem(dry_cooler_approach_path, dry_cooler_approach.value)
        if problem:
            raise IntakeError(problem)
    else:
        r._gap(dry_cooler_approach_path, FIELD_BY_PATH.get(dry_cooler_approach_path), None, "")      # worded from the loaded context (finish_optional_gaps)

    thermal = ThermalInput(
        plant=PlantSpec(
            id=str(r.raw("thermal.plant.id", "PLANT")),
            chilled_water_capacity_kW=r.q(
                "thermal.plant.chilled_water_capacity_kW", "kW", "chilled-water plant capacity",
                V(5000, "kW", "assumed chilled-water plant capacity", ASSUMED, band=0.35)),
            design_supply_C=r.q("thermal.plant.design_supply_C", "degC",
                                "plant chilled-water supply temperature",
                                V(7, "degC", "assumed legacy plant supply temperature", ASSUMED,
                                  band=(6, 12))),
            design_return_C=r.q("thermal.plant.design_return_C", "degC",
                                "plant chilled-water return temperature",
                                V(13, "degC", "assumed plant return temperature", ASSUMED,
                                  band=(12, 18))),
            pump_flow_capacity_l_per_min=r.q(
                "thermal.plant.pump_flow_capacity_l_per_min", "l/min", "available pumped flow",
                V(7000, "l/min", "assumed available pumped flow", ASSUMED, band=0.3)),
            available_head_kPa=r.q("thermal.plant.available_head_kPa", "kPa", "available pump head",
                                   V(250, "kPa", "assumed available pump head", ASSUMED, band=0.3)),
            free_cooling_hours_per_year=r.q(
                "thermal.plant.free_cooling_hours_per_year", "h", "free cooling hours",
                V(2500, "h", "assumed free cooling hours", ASSUMED, band=0.3)),
            dry_cooler_capacity_kW=dry_cooler_capacity,
            dry_cooler_approach_K=dry_cooler_approach,
            existing_flow_l_per_min=existing_flow,
            existing_non_it_heat_kW=non_it_heat,
        ),
        tcs_target_supply_C=r.q("thermal.tcs_target_supply_C", "degC", "TCS target supply",
                                TCS_SUPPLY_DESIGN_C),
        cdu_approach_K=r.q("thermal.cdu_approach_K", "K", "CDU approach", CDU_L2L_APPROACH_K),
        residual_air_capacity_kW_per_rack=r.q(
            "thermal.residual_air_capacity_kW_per_rack", "kW", "air removal capacity per position",
            RESIDUAL_AIR_CAPACITY_LEGACY_kW),
        flow_l_per_min_per_kW=V(1.45, "l/min/kW", "TCS flow per kW at 10 K delta-T", ASSUMED,
                                band=(1.4, 1.5)),
        cdus=cdus,
    )
    # Physical bounds (after the platform is resolved: its own maximum inlet temperature is the limit on the TCS target).
    for problem in (thermal_inputs.tcs_target_problem(thermal.tcs_target_supply_C.value, platform),
                    thermal_inputs.approach_problem("thermal.cdu_approach_K", thermal.cdu_approach_K.value)):
        if problem:
            raise IntakeError(problem)
    if existing_flow is not None:
        pump = thermal.plant.pump_flow_capacity_l_per_min
        if existing_flow.value > pump.value:
            pump_path = "thermal.plant.pump_flow_capacity_l_per_min"
            where = ("supplied" if pump_path in r.report.supplied
                     else "not supplied, so the library placeholder applies; give the plant's pumped flow")
            raise IntakeError(
                f"{existing_flow_path} is {existing_flow.value:g} l/min, more than the pumped flow of {pump.value:g} l/min "
                f"({pump_path}, {where}). The flow the existing hall already draws is part of the plant's pumped flow, so it cannot "
                f"exceed it: check both figures and their units")

    if non_it_heat is not None:
        cap = thermal.plant.chilled_water_capacity_kW
        if non_it_heat.value > cap.value:
            cap_path = "thermal.plant.chilled_water_capacity_kW"
            where = ("supplied" if cap_path in r.report.supplied
                     else "not supplied, so the library placeholder applies; give the plant's capacity")
            raise IntakeError(
                f"{non_it_path} is {non_it_heat.value:g} kW, more than the chilled-water plant capacity of {cap.value:g} kW "
                f"({cap_path}, {where}). The other heat the existing hall puts on the plant is carried by that plant, so it cannot "
                f"exceed its capacity: check both figures and their units")

    cluster = ClusterSpec(
        platform=platform,
        utilisation=r.q("compute.utilisation", "1", "annual average rack utilisation",
                        V(0.75, "1", "assumed annual average utilisation", ASSUMED, band=(0.6, 0.9))),
    )

    arch_name = str(r.raw("compute.default_architecture", "hybrid_dlc"))
    if arch_name not in _ARCH_BY_NAME:
        raise IntakeError(f"unknown default_architecture {arch_name!r}. "
                          f"Available: {', '.join(sorted(_ARCH_BY_NAME))}")
    arch = _ARCH_BY_NAME[arch_name]
    # Rear-door heat-exchanger capacity per rack. Absent -> thermal.rdhx stays None and the engine uses a
    # labelled library default (never a manufacturer's rating); the gap ledger records the fallback.
    rdhx_path = "thermal.rdhx.capacity_kW_per_rack"
    if _dig(doc, rdhx_path) is not None:
        cap = r.q(rdhx_path, "kW", "rear-door heat exchanger capacity per rack")
        if not 0 < cap.value <= RDHX_MAX_CREDIBLE_kW:
            raise IntakeError(
                f"{rdhx_path} is {cap.value:g} kW; a rear-door heat exchanger is modelled between 0 and "
                f"{RDHX_MAX_CREDIBLE_kW:g} kW per rack. Check the unit (W versus kW).")
        thermal.rdhx = RDHxSpec(id="RDHX", capacity_kW_per_rack=cap)
    else:
        from ..thermal.library import ARCH_RACK_CAPABILITY_kW
        r._gap(rdhx_path, FIELD_BY_PATH.get(rdhx_path), ARCH_RACK_CAPABILITY_kW[Architecture.RDHX])

    econ = EconomicsInput()
    tariff_path = "economics.electricity_eur_per_MWh"
    if _dig(doc, tariff_path) is not None:
        econ.electricity_eur_per_MWh = r.q(tariff_path, "EUR/MWh", "grid electricity price")
        if econ.electricity_eur_per_MWh.value <= 0:
            raise IntakeError(f"{tariff_path} must be above zero")
    else:
        r._gap(tariff_path, FIELD_BY_PATH.get(tariff_path), None, "library placeholder of 140 EUR/MWh (E0)")
    horizon = _dig(doc, "economics.horizon_years")
    if isinstance(horizon, dict) and "value" in horizon:
        horizon, h_note, h_src, h_declared = r._annotation("economics.horizon_years", "lifecycle horizon", horizon, "years")
        r._record_source("economics.horizon_years", horizon, h_note, h_src, h_declared)
    if horizon is None:
        r._gap("economics.horizon_years", FIELD_BY_PATH.get("economics.horizon_years"), None,
               "none: no lifecycle value is computed")
    else:
        r.report.supplied.append("economics.horizon_years")
        n = _int(horizon, "economics.horizon_years")
        if not 1 <= n <= 50:
            raise IntakeError("economics.horizon_years must be between 1 and 50")
        econ.horizon_years = n
    rate = _dig(doc, "economics.discount_rate")
    if isinstance(rate, dict) and "value" in rate:
        rate, r_note, r_src, r_declared = r._annotation("economics.discount_rate", "discount rate", rate, "1")
        r._record_source("economics.discount_rate", rate, r_note, r_src, r_declared)
    if rate is None:
        r._gap("economics.discount_rate", FIELD_BY_PATH.get("economics.discount_rate"), None,
               "none: the lifecycle value is undiscounted")
    else:
        r.report.supplied.append("economics.discount_rate")
        rv = _num(rate, "economics.discount_rate")
        if not 0 <= rv < 0.5:
            raise IntakeError("economics.discount_rate must be a fraction from 0 up to (not including) 0.5")
        econ.discount_rate = V(rv, "1", "annual discount rate", CUSTOMER)
    # Contradictions that cannot be true of one hall: refused by name, not silently solved.
    if hall.positions_available > hall.rack_positions:
        raise IntakeError(f"hall.positions_available is {hall.positions_available}, more than hall.rack_positions "
                          f"({hall.rack_positions}): free positions cannot exceed the positions that exist")
    if (hall.occupied_positions is not None and _rack_total_supplied(doc)
            and hall.occupied_positions.value + hall.positions_available > hall.rack_positions):
        occ = int(hall.occupied_positions.value)
        raise IntakeError(f"hall.occupied_positions is {occ} and hall.positions_available is {hall.positions_available}: together "
                          f"{occ + hall.positions_available} positions, more than hall.rack_positions ({hall.rack_positions}). A position cannot be both "
                          f"free and occupied, so check the three figures (occupied plus free cannot exceed the positions that exist)")
    if thermal.plant.design_return_C.value <= thermal.plant.design_supply_C.value:
        msg = (f"thermal.plant.design_return_C ({thermal.plant.design_return_C.value:g} degC) is not above "
               f"design_supply_C ({thermal.plant.design_supply_C.value:g} degC): a chilled-water return at or below supply carries no heat")
        if {"thermal.plant.design_supply_C", "thermal.plant.design_return_C"} <= set(report.supplied):
            raise IntakeError(msg)                 # the customer stated both, and they contradict each other
        # Only one was stated: the other is a library default that now sits on the wrong side of it. Say so, do not refuse a document for
        # a figure the customer never gave.
        report.warnings.append(msg + " (one of the two is a library default: supply the other)")
    if existing_busway is not None:
        _existing_busway_vs_installed(existing_busway_path, existing_busway, power, r.report)
    ctx = EnvelopeContext(site=site, hall=hall, power=power, thermal=thermal, cluster=cluster,
                          architecture=arch, pue=PUE_BY_ARCHITECTURE[arch], economics=econ)

    rack_total_supplied = _rack_total_supplied(doc)
    _busway_vs_existing_load(ctx, report, rack_total_supplied)
    _reference_vs_ids(doc, ctx, report)
    if not transformers:
        report.warnings.append("No transformer schedule supplied: transformer capacity is not "
                               "evaluated and may be the true binding constraint.")
    if not ups:
        report.warnings.append("No UPS schedule supplied: the load is treated as unprotected.")
    if not options:
        report.warnings.append("No behind-the-meter options declared: where the grid binds, the "
                               "study can only report that it binds.")
    _occupied_positions_disclosure(ctx, report, rack_total_supplied)          # after the long-standing warnings: none of them moves
    _redundancy_leaves_nothing(ctx, report)
    # Thermal inputs nothing reads, keys that are not inputs at all, and a pump flow that cannot carry the existing hall (warnings only).
    report.warnings.extend(thermal_inputs.unread_input_warnings(doc))
    report.warnings.extend(_ignored_key_warnings(doc))          # top-level keys the engine does not read, by name (envelope keys are silent)
    if {"thermal.plant.pump_flow_capacity_l_per_min", "thermal.plant.design_supply_C", "thermal.plant.design_return_C",
            "grid.current_it_load_MW"} <= set(report.supplied):
        balance = thermal_inputs.heat_balance_warning(
            flow_l_per_min=thermal.plant.pump_flow_capacity_l_per_min.value, supply_C=thermal.plant.design_supply_C.value,
            return_C=thermal.plant.design_return_C.value, existing_it_kW=ctx.power.current_it_load_MW.value * 1000.0,
            existing_flow_declared=existing_flow is not None)
        if balance:
            report.warnings.append(balance)

    # The optional busway-load row goes LAST in the ledger: the deck's "What nobody has measured yet" slide shows the first eight gaps, and a
    # newer optional input must not displace the long-standing ones from it (tests/test_existing_load_input.py pins the first eight).
    # What each transformer bank and UPS block left out, named per item: after the long-standing rows (so every example's list keeps its order) and
    # before the busway-load and occupied-positions rows that stay last.
    r.report.gaps.extend(equipment_gaps)
    r.report.gaps.sort(key=lambda g: g.path == existing_busway_path)       # stable: only that row moves, and only to the end
    if hall.occupied_positions is None:
        # Named as an OPTIONAL gap (never required, outside the completeness ratio) and LAST, after the busway-load row, for the same reason.
        occ_path = "hall.occupied_positions"
        r._gap(occ_path, FIELD_BY_PATH[occ_path], None,
               "no occupied count; every position not free is read as occupied for the busway check only")
    thermal_inputs.finish_optional_gaps(report, ctx)          # last: words the optional thermal / hall gaps and puts them at the end of the ledger
    scenarios = _scenario_set(doc.get("scenarios"))
    return Intake(project=project, context=ctx, scenarios=scenarios,
                  report=report, document=doc)


def blank_intake() -> dict:
    """A skeleton intake document with every field present and empty.

    Hand this to a customer at the end of the first call. Filling it in IS the
    engagement's first milestone."""
    out: dict = {"project": {"client": "", "reference": "", "objective": "max_compute"},
                 "scenarios": ["retained_air", "rdhx", "hybrid_dlc", "full_dlc", "full_dlc_btm"]}
    for f in INTAKE_FIELDS:
        cur = out
        parts = f.path.split(".")
        for p in parts[:-1]:
            cur = cur.setdefault(p, {})
            if not isinstance(cur, dict):
                break      # a per-item field of a list section (transformers.*): the data request names it, not the skeleton
        else:
            cur[parts[-1]] = None if f.path not in ("transformers", "ups") else []
    return out
