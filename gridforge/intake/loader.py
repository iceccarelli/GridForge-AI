"""Load a customer intake document into an engineering context.

One JSON file in, one study out. Everything the customer did not supply is filled
from the library, recorded as a gap, and rendered in the report as an assumption
with the question that would close it.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..common import ASSUMED, CUSTOMER, ESTIMATED, V
from ..compute.library import PLATFORMS, get_platform
from ..compute.schema import ClusterSpec
from ..constraints import EnvelopeContext
from ..power.schema import (GenerationOption, GridConnection, LVDistribution, PowerInput,
                            TransformerBank, UPSBlock)
from ..scenario.schema import ScenarioSpec
from ..site.schema import FloorType, HallSpec, SiteSpec
from ..thermal.library import (CDU_L2L_APPROACH_K, PUE_BY_ARCHITECTURE,
                               RESIDUAL_AIR_CAPACITY_LEGACY_kW, TCS_SUPPLY_DESIGN_C)
from ..thermal.schema import Architecture, CDUSpec, PlantSpec, ThermalInput
from ..validation import EvidenceClass, Quantity, Source
from .schema import FIELD_BY_PATH, INTAKE_FIELDS, DataGap, IntakeReport

_EVIDENCE_BY_NAME = {e.short: e for e in EvidenceClass}


class IntakeError(ValueError):
    """The intake document cannot be turned into a context at all."""


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
                ev = _EVIDENCE_BY_NAME.get(str(raw["evidence"]).upper()[:2], None) or ev
            raw = raw["value"]
        if ev is None:
            ev = spec.supplied_evidence if spec else CUSTOMER
        if spec:
            self.report.supplied.append(path)
        return V(float(raw), unit, label, ev, band=band,
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
        return str(self.project.get("client", "Unnamed client"))

    @property
    def reference(self) -> str:
        return str(self.project.get("reference", "—"))


_ARCH_BY_NAME = {a.value: a for a in Architecture}


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
        units=3, redundancy="N+1")]
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
        build_year=int(r.raw("hall.build_year", 2015)),
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
        rack_positions=int(r.raw("hall.rack_positions", 400)),
        positions_available=int(r.raw("hall.positions_available", 100)),
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
                             V(32, "degC", "assumed summer design dry-bulb", ESTIMATED,
                               band=(30, 36))),
        design_wetbulb_C=r.q("site.design_wetbulb_C", "degC", "summer design wet-bulb",
                             V(21, "degC", "assumed summer design wet-bulb", ESTIMATED,
                               band=(19, 23))),
        halls=[hall],
    )

    transformers = []
    for t in r.raw("transformers", []) or []:
        transformers.append(TransformerBank(
            id=str(t.get("id", "TX")),
            unit_rating_MVA=V(float(t["unit_rating_MVA"]), "MVA", f"{t.get('id','TX')} unit rating",
                              CUSTOMER),
            units=int(t.get("units", 2)),
            redundancy=str(t.get("redundancy", "N+1")),
            derating_factor=V(float(t.get("derating_factor", 0.9)), "1",
                              f"{t.get('id','TX')} derating", ESTIMATED, band=(0.85, 0.95)),
            replacement_lead_time_weeks=V(float(t.get("replacement_lead_time_weeks", 160)),
                                          "weeks", "power transformer lead time", ASSUMED,
                                          band=(80, 210)),
        ))
    ups = []
    for u in r.raw("ups", []) or []:
        ups.append(UPSBlock(
            id=str(u.get("id", "UPS")),
            unit_rating_kW=V(float(u["unit_rating_kW"]), "kW", f"{u.get('id','UPS')} module rating",
                             CUSTOMER),
            units=int(u.get("units", 2)),
            redundancy=str(u.get("redundancy", "N+1")),
            step_load_capability=V(float(u.get("step_load_capability", 0.5)), "1",
                                   "accepted instantaneous step load", ASSUMED, band=(0.3, 0.7)),
        ))

    options = []
    for o in r.raw("btm_options", []) or []:
        options.append(GenerationOption(
            id=str(o.get("id", o.get("kind", "BTM"))),
            kind=str(o.get("kind", "bess")),
            capacity_MW=V(float(o["capacity_MW"]), "MW", f"{o.get('id','BTM')} capacity", ASSUMED),
            capex_eur_per_kW=V(float(o.get("capex_eur_per_kW", 900)), "EUR/kW",
                               f"{o.get('id','BTM')} installed capex", ASSUMED, band=0.3),
            lead_time_weeks=V(float(o.get("lead_time_weeks", 36)), "weeks",
                              f"{o.get('id','BTM')} lead time", ASSUMED, band=0.35),
            firm=bool(o.get("firm", True)),
            firm_capacity_factor=(V(float(o["firm_capacity_factor"]), "1",
                                    f"{o.get('id','BTM')} firm factor", ASSUMED, band=0.2)
                                  if o.get("firm_capacity_factor") is not None else None),
            opex_eur_per_MWh=(V(float(o["opex_eur_per_MWh"]), "EUR/MWh",
                                f"{o.get('id','BTM')} opex", ASSUMED, band=0.4)
                              if o.get("opex_eur_per_MWh") is not None else None),
            permitting_note=str(o.get("permitting_note", "")),
        ))

    power = PowerInput(
        grid=GridConnection(
            dso=str(r.raw("grid.dso", "—")),
            firm_capacity_MVA=r.q("grid.firm_capacity_MVA", "MVA", "firm connection capacity",
                                  V(10.0, "MVA", "assumed firm connection capacity", ASSUMED,
                                    band=0.3)),
            power_factor=r.q("grid.power_factor", "1", "site power factor",
                             V(0.97, "1", "assumed site power factor", ESTIMATED, band=(0.95, 0.99))),
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
            phases=int(r.raw("lv.phases", 3)),
            busway_ampacity_A=r.q("lv.busway_ampacity_A", "A", "installed busway ampacity",
                                  V(400, "A", "assumed legacy busway ampacity", ASSUMED,
                                    band=(250, 630))),
            busway_runs=int(r.raw("lv.busway_runs", 6)),
            busway_utilisation_limit=r.q("lv.busway_utilisation_limit", "1",
                                         "continuous-load derating on busway",
                                         V(0.8, "1", "assumed continuous-load derating", ESTIMATED)),
            tapoff_max_A=r.q("lv.tapoff_max_A", "A", "installed tap-off rating",
                             V(63, "A", "assumed legacy tap-off rating", ASSUMED, band=(32, 125))),
        ),
        options=options,
    )

    cdus = []
    for c in r.raw("thermal.cdus", []) or []:
        cdus.append(CDUSpec(
            id=str(c.get("id", "CDU")),
            rated_capacity_kW=V(float(c["rated_capacity_kW"]), "kW",
                                f"{c.get('id','CDU')} rated capacity", CUSTOMER, band=0.1),
            rated_approach_K=V(float(c.get("rated_approach_K", 5)), "K",
                               f"{c.get('id','CDU')} rated approach", ASSUMED),
            rated_flow_l_per_min=V(float(c.get("rated_flow_l_per_min", 2000)), "l/min",
                                   f"{c.get('id','CDU')} rated flow", ASSUMED),
            units=int(c.get("units", 1)),
            redundancy=str(c.get("redundancy", "N+1")),
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
                V(2500, "h", "assumed free cooling hours", ESTIMATED, band=0.3)),
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

    arch = _ARCH_BY_NAME.get(str(r.raw("compute.default_architecture", "hybrid_dlc")),
                             Architecture.HYBRID_DLC)
    ctx = EnvelopeContext(site=site, hall=hall, power=power, thermal=thermal, cluster=cluster,
                          architecture=arch, pue=PUE_BY_ARCHITECTURE[arch])

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
