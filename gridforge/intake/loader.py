"""Load a customer intake document into an engineering context.

One JSON file in, one study out. Everything the customer did not supply is filled
from the library, recorded as a gap, and rendered in the report as an assumption
with the question that would close it.
"""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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
from .schema import FIELD_BY_PATH, INTAKE_FIELDS, DataGap, IntakeReport

_EVIDENCE_BY_NAME = {e.short: e for e in EvidenceClass}


class IntakeError(ValueError):
    """The intake document cannot be turned into a context at all."""


def _num(raw: Any, what: str = "value") -> float:
    """float() that refuses what float() lets through: NaN, infinity, null, booleans.
    A non-finite number does not fail later with a traceback; it silently drops a
    constraint or ranks a hall first."""
    if isinstance(raw, bool) or raw is None:
        raise IntakeError(f"{what} is {raw!r}, which is not a number")
    try:
        v = float(raw)
    except (TypeError, ValueError):
        raise IntakeError(f"{what} is {raw!r}, which is not a number") from None
    if not math.isfinite(v):
        raise IntakeError(f"{what} is {raw!r}; it must be a finite number")
    return v


def _int(raw: Any, what: str = "value") -> int:
    v = _num(raw, what)
    if v != int(v) or v < 0:
        raise IntakeError(f"{what} is {raw!r}; it must be a whole number, zero or more")
    return int(v)


#: Physical range per field. Anything outside is an unconditional refusal: a power
#: factor of 1.5 or a derating factor of 5 does not make a hall exceptional, it
#: makes the document wrong, and a wrong document must not rank.
_FRACTION_PATHS = {            # (0, 1]
    "grid.power_factor", "lv.busway_utilisation_limit", "compute.utilisation",
}
_TEMPERATURE_UNITS = {"degC"}


def _frac(raw: Any, what: str) -> float:
    v = _num(raw, what)
    if not 0 < v <= 1:
        raise IntakeError(f"{what} is {v:g}; it must be above 0 and at most 1")
    return v


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
    return V(v, unit, f"{o.get('id', 'BTM')} {key}", evidence, band=band)


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
        note, src, ev = None, None, evidence
        if isinstance(raw, dict):
            note = raw.get("note")
            src = raw.get("source")
            if raw.get("evidence"):
                declared = _EVIDENCE_BY_NAME.get(str(raw["evidence"]).upper()[:2], None)
                if declared is not None:
                    # A client can attest to their own data, never to our validation: E6/E7 are
                    # earned by the calibration ledger, not by writing them into an intake.
                    if declared > EvidenceClass.E5_CUSTOMER_DATA:
                        self.report.warnings.append(
                            f"{path}: declared evidence {declared.short} capped at E5; "
                            f"E6 and E7 are earned through the calibration ledger.")
                        declared = EvidenceClass.E5_CUSTOMER_DATA
                    ev = declared
            raw = raw["value"]
        if ev is None:
            ev = spec.supplied_evidence if spec else CUSTOMER
        if spec:
            self.report.supplied.append(path)
        num = _num(raw, f"{label} ({path})")
        if unit not in _TEMPERATURE_UNITS and num < 0:
            raise IntakeError(f"{label} ({path}) is {num:g} {unit}; it cannot be negative")
        if path in _FRACTION_PATHS and not 0 < num <= 1:
            raise IntakeError(f"{label} ({path}) is {num:g}; it must be above 0 and at most 1")
        return V(num, unit, label, ev, band=band,
                 assumptions=[note] if note else (),
                 sources=[Source(src)] if src else ())

    def raw(self, path: str, default=None):
        v = _dig(self.doc, path)
        if isinstance(v, list) and not v:
            v = None          # an empty schedule is a missing schedule, not a supplied one
        if v is None:
            spec = FIELD_BY_PATH.get(path)
            if spec:
                self._gap(path, spec, None, str(default))
            return default
        if isinstance(v, dict) and "value" in v:
            v = v["value"]
        if FIELD_BY_PATH.get(path):
            self.report.supplied.append(path)
        return v

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
    c = _install_cdus(c)
    if c.thermal.plant.dry_cooler_approach_K is None:
        c.thermal.plant.dry_cooler_approach_K = V(
            10, "K", "assumed dry cooler approach to dry bulb", ASSUMED, band=(8, 12))
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
    if names is not None and not names:
        raise IntakeError("scenarios is an empty list: name at least one, or omit the field for the standard set")
    keys = names or list(catalogue)
    missing = [k for k in keys if k not in catalogue]
    if missing:
        raise IntakeError(f"unknown scenario(s): {', '.join(missing)}. "
                          f"Available: {', '.join(catalogue)}")
    return [catalogue[k] for k in keys]


def load(path: str | Path) -> Intake:
    doc = json.loads(Path(path).read_text())
    return load_document(doc)


def load_document(doc: dict) -> Intake:
    """Turn an intake document into a context. Malformed input is an IntakeError naming the problem,
    never a KeyError or a traceback."""
    if not isinstance(doc, dict):
        raise IntakeError("an intake must be a JSON object")
    try:
        return _load_document(doc)
    except IntakeError:
        raise
    except KeyError as exc:
        raise IntakeError(f"the intake is missing a required field: {exc.args[0]}") from None
    except (ValueError, TypeError, AttributeError) as exc:
        raise IntakeError(f"the intake is malformed: {exc}") from None


def _load_document(doc: dict) -> Intake:
    report = IntakeReport()
    r = _Reader(doc, report)

    platform_id = r.raw("compute.platform", "gb300_nvl72")
    if platform_id not in PLATFORMS:
        raise IntakeError(
            f"unknown platform {platform_id!r}. Available: {', '.join(sorted(PLATFORMS))}. "
            "Platforms whose rack power the manufacturer has not published are deliberately absent."
        )
    platform = get_platform(platform_id)

    hall = HallSpec(
        id=str(r.raw("hall.id", "HALL-1")),
        build_year=_int(r.raw("hall.build_year", 2015)),
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
        rack_positions=_int(r.raw("hall.rack_positions", 400)),
        positions_available=_int(r.raw("hall.positions_available", 100)),
        design_density_kW_per_rack=r.q(
            "hall.design_density_kW_per_rack", "kW", "hall design density per rack",
            V(8, "kW", "assumed design density (European colo 2010-2020: 8-20 kW/rack)",
              ASSUMED, band=(6, 20))),
        containment=str(r.raw("hall.containment", "cold_aisle")),
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
    for t in r.raw("transformers", []) or []:
        transformers.append(TransformerBank(
            id=str(t.get("id", "TX")),
            unit_rating_MVA=V(_pos(t["unit_rating_MVA"], 'unit_rating_MVA'), "MVA", f"{t.get('id','TX')} unit rating",
                              CUSTOMER),
            units=_int(t.get("units", 2)),
            redundancy=_redundancy(t.get("redundancy", "N+1"), "transformer"),
            # a supplied derating is the client's engineering figure (E3, as before); an absent one is a library
            # default and is an assumption (E0)
            derating_factor=V(_frac(t.get("derating_factor", 0.9), "transformer derating_factor"), "1",
                              f"{t.get('id','TX')} derating",
                              ESTIMATED if t.get("derating_factor") is not None else ASSUMED, band=(0.85, 0.95)),
            replacement_lead_time_weeks=V(_pos(t.get("replacement_lead_time_weeks", 160), 'replacement_lead_time_weeks'),
                                          "weeks", "power transformer lead time", ASSUMED,
                                          band=(80, 210)),
        ))
    ups = []
    for u in r.raw("ups", []) or []:
        ups.append(UPSBlock(
            id=str(u.get("id", "UPS")),
            unit_rating_kW=V(_pos(u["unit_rating_kW"], 'unit_rating_kW'), "kW", f"{u.get('id','UPS')} module rating",
                             CUSTOMER),
            units=_int(u.get("units", 2)),
            redundancy=_redundancy(u.get("redundancy", "N+1"), "UPS"),
            step_load_capability=V(_frac(u.get("step_load_capability", 0.5), "UPS step_load_capability"), "1",
                                   "accepted instantaneous step load", ASSUMED, band=(0.3, 0.7)),
        ))

    options = []
    for o in r.raw("btm_options", []) or []:
        opt = GenerationOption(
            id=str(o.get("id", o.get("kind", "BTM"))),
            kind=str(o.get("kind", "bess")).strip().lower(),
            capacity_MW=V(_pos(o["capacity_MW"], 'capacity_MW'), "MW", f"{o.get('id','BTM')} capacity", ASSUMED),
            # Absent means absent: no invented 900 EUR/kW and no invented 36 weeks. The option is then unpriced /
            # undated (a visible gap below), never ranked as complete and never the source of a date.
            capex_eur_per_kW=(V(_pos(o["capex_eur_per_kW"], 'capex_eur_per_kW'), "EUR/kW",
                                f"{o.get('id','BTM')} installed capex", ASSUMED, band=0.3)
                              if o.get("capex_eur_per_kW") is not None else None),
            lead_time_weeks=(V(_pos(o["lead_time_weeks"], 'lead_time_weeks'), "weeks",
                               f"{o.get('id','BTM')} lead time", ASSUMED, band=0.35)
                             if o.get("lead_time_weeks") is not None else None),
            firm=bool(o.get("firm", True)),
            firm_capacity_factor=(V(_frac(o["firm_capacity_factor"], "BTM firm_capacity_factor"), "1",
                                    f"{o.get('id','BTM')} firm factor", ASSUMED, band=0.2)
                                  if o.get("firm_capacity_factor") is not None else None),
            opex_eur_per_MWh=(V(_pos(o["opex_eur_per_MWh"], 'opex_eur_per_MWh'), "EUR/MWh",
                                f"{o.get('id','BTM')} opex", ASSUMED, band=0.4)
                              if o.get("opex_eur_per_MWh") is not None else None),
            permitting_note=str(o.get("permitting_note", "")),
            energy_MWh=(V(_pos(o["energy_MWh"], 'energy_MWh'), "MWh", f"{o.get('id','BTM')} energy", ASSUMED,
                          band=0.15)
                       if o.get("energy_MWh") is not None else None),
            annual_run_hours=_opt(o, "annual_run_hours", "h", ASSUMED, band=0.15, high=8760.0),
            fuel_price_eur_per_MWh=_opt(o, "fuel_price_eur_per_MWh", "EUR/MWh_fuel", ASSUMED, band=0.4),
            electrical_efficiency=(V(_frac(o["electrical_efficiency"], "BTM electrical_efficiency"), "1",
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
        # A BESS option with both an energy rating and a declared ride-through
        # requirement gets the real power-vs-energy firm factor computed from
        # gridforge.power.storage, replacing btm.DEFAULT_FIRM_FACTOR's flat 0.50
        # guess. An explicit firm_capacity_factor in the intake still wins — a
        # customer's own site-specific figure outranks either calculation.
        if (opt.kind == "bess" and opt.energy_MWh is not None
                and opt.firm_capacity_factor is None and o.get("ride_through_hours") is not None):
            from ..power.btm import bess_firm_factor_for_duration
            hours = V(_pos(o["ride_through_hours"], 'ride_through_hours'), "h",
                     f"{opt.id} required ride-through", ASSUMED)
            opt.firm_capacity_factor = bess_firm_factor_for_duration(opt, hours)
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
            phases=_phases(r.raw("lv.phases", 3)),
            busway_ampacity_A=r.q("lv.busway_ampacity_A", "A", "installed busway ampacity",
                                  V(400, "A", "assumed legacy busway ampacity", ASSUMED,
                                    band=(250, 630))),
            busway_runs=_int(r.raw("lv.busway_runs", 6)),
            busway_utilisation_limit=r.q("lv.busway_utilisation_limit", "1",
                                         "continuous-load derating on busway",
                                         V(0.8, "1", "assumed continuous-load derating", ASSUMED)),
            tapoff_max_A=r.q("lv.tapoff_max_A", "A", "installed tap-off rating",
                             V(63, "A", "assumed legacy tap-off rating", ASSUMED, band=(32, 125))),
        ),
        options=options,
    )

    cdus = []
    for c in r.raw("thermal.cdus", []) or []:
        cdus.append(CDUSpec(
            id=str(c.get("id", "CDU")),
            rated_capacity_kW=V(_pos(c["rated_capacity_kW"], 'rated_capacity_kW'), "kW",
                                f"{c.get('id','CDU')} rated capacity", CUSTOMER, band=0.1),
            rated_approach_K=V(_pos(c.get("rated_approach_K", 5), 'rated_approach_K'), "K",
                               f"{c.get('id','CDU')} rated approach", ASSUMED),
            rated_flow_l_per_min=V(_pos(c.get("rated_flow_l_per_min", 2000), 'rated_flow_l_per_min'), "l/min",
                                   f"{c.get('id','CDU')} rated flow", ASSUMED),
            units=_int(c.get("units", 1)),
            redundancy=_redundancy(c.get("redundancy", "N+1"), "CDU"),
        ))

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
            dry_cooler_capacity_kW=None,
            dry_cooler_approach_K=None,
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
        horizon = horizon["value"]
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
        rate = rate["value"]
    if rate is None:
        r._gap("economics.discount_rate", FIELD_BY_PATH.get("economics.discount_rate"), None,
               "none: the lifecycle value is undiscounted")
    else:
        r.report.supplied.append("economics.discount_rate")
        rv = _num(rate, "economics.discount_rate")
        if not 0 <= rv < 0.5:
            raise IntakeError("economics.discount_rate must be a fraction from 0 up to (not including) 0.5")
        econ.discount_rate = V(rv, "1", "annual discount rate", CUSTOMER)
    ctx = EnvelopeContext(site=site, hall=hall, power=power, thermal=thermal, cluster=cluster,
                          architecture=arch, pue=PUE_BY_ARCHITECTURE[arch], economics=econ)

    if not transformers:
        report.warnings.append("No transformer schedule supplied: transformer capacity is not "
                               "evaluated and may be the true binding constraint.")
    if not ups:
        report.warnings.append("No UPS schedule supplied: the load is treated as unprotected.")
    if not options:
        report.warnings.append("No behind-the-meter options declared: where the grid binds, the "
                               "study can only report that it binds.")

    scenarios = _scenario_set(doc.get("scenarios"))
    return Intake(project=doc.get("project", {}), context=ctx, scenarios=scenarios,
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
        cur[parts[-1]] = None if f.path not in ("transformers", "ups") else []
    return out
