#!/usr/bin/env python3
"""Generate public/observatory/scenarios.json: engine output for three APPROVED SYNTHETIC halls.

The Observatory shows how a data-centre hall's power path limits the racks it can host. Nothing in it may be a number the
engine did not compute, so this script does not model anything: it builds three invented intake documents, hands them to
the repository's own request handlers IN-PROCESS (the functions behind /v1/screen and /v1/compare, no network, no server),
and maps what comes back onto the shape in lib/observatory/types.ts (ScenarioFile).

Where the contract wants something the engine does not provide, the field is null and says why:
  * a stage the engine does not model (main switchgear) has no constraint key and a null capacity;
  * weeks to capacity is null unless every lead time behind it is above class E0 (the engine labels any lead time an
    intake supplies as an assumption, so with the current engine no outcome is dated);
  * capex of an outcome that deploys no rack is null (the engine reports "n/a: nothing deployable", never 0 EUR);
  * the engine states no capacity for a stage it has no constraint for, and no power-path load it does not charge.

Reproducible byte for byte, exactly like scripts/build-reference.sh: the date is pinned (GRIDFORGE_REPORT_DATE, default
2026-09-14), nothing reads the clock, private cost lines and the private calibration ledger are shut out, keys are sorted
and the order of everything else is the engine's own. CI regenerates the file and fails on any byte of difference.

    python3 scripts/build-observatory.py                       # writes public/observatory/scenarios.json
    python3 scripts/build-observatory.py -o /tmp/scenarios.json
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import os
import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_OUT = REPO / "public" / "observatory" / "scenarios.json"
DEFAULT_DATE = "2026-09-14"          # same pin as scripts/build-reference.sh

SCHEMA = "gridforge/observatory-scenarios/1"
ROUTES_USED = ["/v1/compare", "/v1/screen"]

sys.path.insert(0, str(REPO))

from gridforge.api.server import ROUTES, VERSION, _run  # noqa: E402
from gridforge.api.tiers import Tier  # noqa: E402
from gridforge.calibration import accuracy_block, all_keys  # noqa: E402
from gridforge.calibration.ledger import load_ledger  # noqa: E402
from gridforge.clock import report_date_iso  # noqa: E402
from gridforge.common import ASSUMED, ESTIMATED, V  # noqa: E402
from gridforge.constraints import floor_racks  # noqa: E402
from gridforge.envelope.solver import rack_evidence  # noqa: E402
from gridforge.power.btm import installed_firm_kW  # noqa: E402
from gridforge.power.constraints import _effective_units, _it_headroom_to_racks, _lesser_of  # noqa: E402
from gridforge.power.plausibility import intake_warnings  # noqa: E402
from gridforge.provenance import code_sha256  # noqa: E402
from gridforge.thermal.constraints import _liquid_load_to_plant  # noqa: E402
from gridforge.thermal.schema import Architecture  # noqa: E402
from gridforge.validation import Quantity  # noqa: E402
from gridforge.validation.quantity import _round_sig  # noqa: E402

_PRIVATE_FILES = {          # names the engine reads at call time
    "GRIDFORGE_COST_LIBRARY": "private-costs.json",
    "GRIDFORGE_CALIBRATION_LEDGER": "private-ledger.json",
}


@contextlib.contextmanager
def pinned_engine(date: str):
    """Run the engine as CI runs it: a pinned report date, and no private cost lines or private calibration ledger
    (a developer's quotations or client site data would change the numbers, and must never reach a public file).
    Everything is restored on exit, so importing this module or building from a test leaves the process as it was."""
    from gridforge import costs
    nothing = os.path.join(tempfile.gettempdir(), "gridforge-observatory-no-such-dir")      # never created
    names = ["GRIDFORGE_REPORT_DATE", *_PRIVATE_FILES]
    saved_env = {n: os.environ.get(n) for n in names}
    saved_library = costs._LIBRARY
    try:
        os.environ["GRIDFORGE_REPORT_DATE"] = date
        for name, leaf in _PRIVATE_FILES.items():
            os.environ[name] = os.path.join(nothing, leaf)
        costs.reload_library()          # the cost library is cached per process: re-resolve it with no private lines
        yield
    finally:
        for n, v in saved_env.items():
            if v is None:
                os.environ.pop(n, None)
            else:
                os.environ[n] = v
        costs._LIBRARY = saved_library


REFERENCE_INTAKE = REPO / "examples" / "intake" / "reference_hall.json"

# Where the invented halls are placed: nowhere. The engine inputs keep a metro and a country because its intake needs them, but
# they are internal: no city, country or campus name is written to the file.
REGION = "invented site (no location)"

SYNTHETIC_NOTE = ("SYNTHETIC DATA: invented for the Observatory. Not a customer, a company or a site; "
                  "no figure here is a measurement.")


# --- the three approved synthetic halls --------------------------------------------------------------------------------
# Hall A is the repository's reference hall, untouched, so the Observatory agrees with the worked example in
# public/reference. Halls B and C are invented here; every input is a plain number, labelled exactly as the engine labels
# any supplied input. They were chosen to teach three different things.

def hall_a() -> dict:
    return json.loads(REFERENCE_INTAKE.read_text(encoding="utf-8"))


def hall_b() -> dict:
    """A modern hall whose full direct-liquid-cooling case is stopped by the temperature of the facility water."""
    return {
        "project": {"client": "Synthetic Hall B (invented)", "reference": "SYN-B/DUB-B1", "objective": "max_compute",
                    "note": SYNTHETIC_NOTE},
        "site": {"id": "SYN-B", "name": "Synthetic Hall B campus", "country": "IE", "metro": "Dublin",
                 "design_drybulb_C": 26, "design_wetbulb_C": 19},
        "hall": {"id": "SYN-B1", "build_year": 2019, "floor_type": "slab", "net_white_space_m2": 2400,
                 "floor_loading_kPa": 20, "clear_height_m": 4.2, "aisle_pitch_m": 2.4, "rack_positions": 420,
                 "positions_available": 260, "design_density_kW_per_rack": 12, "containment": "cold_aisle"},
        "grid": {"dso": "Synthetic DSO", "firm_capacity_MVA": 11.0, "power_factor": 0.97, "contracted_MW": 10.0,
                 "current_site_peak_MW": 6.1, "current_it_load_MW": 4.2,
                 "queue_note": "Invented: the site's connected load is assumed not to be increasable, so densification "
                               "inside the existing contract is the only path."},
        "transformers": [{"id": "TX-A/B", "unit_rating_MVA": 5.0, "units": 3, "redundancy": "N+1",
                          "derating_factor": 0.9, "replacement_lead_time_weeks": 160}],
        "ups": [{"id": "UPS-1", "unit_rating_kW": 1200, "units": 6, "redundancy": "N+1", "step_load_capability": 0.5}],
        "lv": {"voltage_V": 400, "phases": 3, "busway_ampacity_A": 800, "busway_runs": 10,
               "busway_utilisation_limit": 0.8, "tapoff_max_A": 250},
        "thermal": {"plant": {"id": "CH-PLANT", "chilled_water_capacity_kW": 7600, "design_supply_C": 18,
                              "design_return_C": 26, "pump_flow_capacity_l_per_min": 14000, "available_head_kPa": 250,
                              "free_cooling_hours_per_year": 2600},
                    "residual_air_capacity_kW_per_rack": {"value": 16, "evidence": "E3",
                                                          "note": "Invented value for a synthetic hall"},
                    "cdus": []},
        "compute": {"platform": "gb300_nvl72", "utilisation": 0.75, "default_architecture": "full_dlc"},
        "btm_options": [{"id": "GEN-8MW", "kind": "gas_engine", "capacity_MW": 8.0, "capex_eur_per_kW": 820,
                         "lead_time_weeks": 56, "firm": True, "opex_eur_per_MWh": 110, "annual_run_hours": 6000,
                         "fixed_om_eur_per_kW_year": 18,
                         "permitting_note": "Invented: consent and fuel supply set the programme."}],
        "economics": {"electricity_eur_per_MWh": {"value": 125, "note": "Illustrative value in a synthetic hall; not a tariff."},
                      "horizon_years": 10, "discount_rate": 0.08},
        "scenarios": ["retained_air", "rdhx", "hybrid_dlc", "full_dlc", "full_dlc_btm"],
    }


def hall_c() -> dict:
    """A hall with real electrical headroom: one transformer bank binds, and once it is relieved the hall runs out of positions."""
    return {
        "project": {"client": "Synthetic Hall C (invented)", "reference": "SYN-C/OSL-C1", "objective": "max_compute",
                    "note": SYNTHETIC_NOTE},
        "site": {"id": "SYN-C", "name": "Synthetic Hall C campus", "country": "NO", "metro": "Oslo",
                 "design_drybulb_C": 24, "design_wetbulb_C": 17},
        "hall": {"id": "SYN-C1", "build_year": 2021, "floor_type": "slab", "net_white_space_m2": 2400,
                 "floor_loading_kPa": 25, "clear_height_m": 4.8, "aisle_pitch_m": 2.7, "rack_positions": 300,
                 "positions_available": 40, "design_density_kW_per_rack": 20, "containment": "cold_aisle"},
        "grid": {"dso": "Synthetic DSO", "firm_capacity_MVA": 30.0, "power_factor": 0.97, "contracted_MW": 26.0,
                 "current_site_peak_MW": 6.0, "current_it_load_MW": 4.0,
                 "queue_note": "Invented: the connection is large and largely unused; the limit is inside the building."},
        "transformers": [{"id": "TX-A/B", "unit_rating_MVA": 5.0, "units": 3, "redundancy": "N+1",
                          "derating_factor": 0.9, "replacement_lead_time_weeks": 104}],
        "ups": [{"id": "UPS-1", "unit_rating_kW": 2000, "units": 8, "redundancy": "N+1", "step_load_capability": 0.5}],
        "lv": {"voltage_V": 400, "phases": 3, "busway_ampacity_A": 1000, "busway_runs": 14,
               "busway_utilisation_limit": 0.8, "tapoff_max_A": 400},
        "thermal": {"plant": {"id": "CH-PLANT", "chilled_water_capacity_kW": 12000, "design_supply_C": 20,
                              "design_return_C": 30, "pump_flow_capacity_l_per_min": 22000, "available_head_kPa": 250,
                              "free_cooling_hours_per_year": 7600},
                    "residual_air_capacity_kW_per_rack": {"value": 22, "evidence": "E3",
                                                          "note": "Invented value for a synthetic hall"},
                    "cdus": [{"id": "CDU-1", "rated_capacity_kW": 1500, "rated_approach_K": 5,
                              "rated_flow_l_per_min": 2000, "units": 6, "redundancy": "N+1"}]},
        "compute": {"platform": "gb300_nvl72", "utilisation": 0.75, "default_architecture": "hybrid_dlc"},
        "btm_options": [],
        "scenarios": ["retained_air", "rdhx", "hybrid_dlc", "full_dlc"],
    }


HALLS = [
    {"id": "hall-a-rack-feed", "title": "Synthetic Hall A", "doc": hall_a,
     "headline": "hybrid_dlc", "lesson": "rack_feed"},
    {"id": "hall-b-water-temperature", "title": "Synthetic Hall B", "doc": hall_b,
     "headline": "full_dlc", "lesson": "water"},
    {"id": "hall-c-headroom", "title": "Synthetic Hall C", "doc": hall_c,
     "headline": "hybrid_dlc", "lesson": "headroom"},
]


# --- Quantity -> contract ------------------------------------------------------------------------------------------------
def _fin(x):
    return x if isinstance(x, (int, float)) and math.isfinite(x) else None


def q_out(q: Quantity | None, unit: str | None = None) -> dict | None:
    """An engine Quantity as the contract's Quantity: the engine's own rounding (fewer figures for weaker evidence),
    its own band and its own evidence class. Nothing is added."""
    if q is None:
        return None
    n = q.sigfigs()
    lo, hi = q.band
    return {"value": _fin(q.rounded()), "low": _fin(_round_sig(lo, n)), "high": _fin(_round_sig(hi, n)),
            "unit": unit or q.unit, "evidence": q.evidence.short}


def q_missing(unit: str, evidence: str, reason: str) -> dict:
    return {"value": None, "low": None, "high": None, "unit": unit, "evidence": evidence, "missingReason": reason}


def same_quantity(a: Quantity, b: Quantity) -> bool:
    return (a.value == b.value or (math.isnan(a.value) and math.isnan(b.value))) and a.band == b.band \
        and a.evidence == b.evidence and a.unit == b.unit


def _cls(name: str) -> str:
    return name.split("_", 1)[0]


# --- the power path, from the engine's own constraint arithmetic --------------------------------------------------------
# The engine reports each stage as a count of racks plus a sentence; it does not return the capacity it subtracted from.
# These functions rebuild those capacities with the engine's own helpers and Quantity arithmetic (same labels, same
# evidence rules) and then REFUSE to continue unless the rebuilt chain gives back exactly the rack count, band and
# evidence the engine reported for that constraint. If the engine's arithmetic changes, this build fails; it never
# publishes a capacity the engine would no longer agree with.
def _check(name: str, mine: Quantity, engine_constraint) -> None:
    if not same_quantity(mine, engine_constraint.max_racks):
        raise SystemExit(f"{name}: the rebuilt capacity does not reproduce the engine's constraint "
                         f"({mine.value}/{mine.band}/{mine.evidence.short} vs "
                         f"{engine_constraint.max_racks.value}/{engine_constraint.max_racks.band}/"
                         f"{engine_constraint.max_racks.evidence.short}). Update scripts/build-observatory.py.")


def utility_stage(ctx, c):
    g = ctx.power.grid
    firm_kW = (g.firm_capacity_MVA * g.power_factor).convert(1000.0, "kW", "firm grid capacity")
    contracted_kW = g.contracted_MW.convert(1000.0, "kW", "contracted capacity")
    ceiling = _lesser_of(firm_kW, contracted_kW, "firm supply ceiling (lesser of firm connection and contracted)")
    btm = installed_firm_kW(ctx.power)
    if btm.value > 0:
        ceiling = (ceiling + btm).relabel("firm supply: grid import plus behind-the-meter",
                                          "power.total_firm_supply", step_evidence=ESTIMATED)
    peak = g.current_site_peak_MW.convert(1000.0, "kW", "current site peak")
    headroom = (ceiling - peak).relabel("firm supply headroom", "power.grid_headroom", step_evidence=ESTIMATED)
    _check("utility", floor_racks(_it_headroom_to_racks(headroom, ctx, "firm supply headroom")), c["grid_firm_capacity"])
    return ceiling, peak


def transformer_stage(ctx, c):
    total = None
    for t in ctx.power.transformers:
        n = _effective_units(t.units, t.redundancy)
        cap = (t.unit_rating_MVA * ctx.power.grid.power_factor * t.derating_factor).convert(
            1000.0 * n, "kW", f"{t.id} usable capacity ({t.redundancy}, {n} of {t.units} units)")
        total = cap if total is None else total + cap
    peak = ctx.power.grid.current_site_peak_MW.convert(1000.0, "kW", "current site peak")
    headroom = (total - peak).relabel("transformer headroom", "power.transformer_headroom", step_evidence=ESTIMATED)
    _check("transformer", floor_racks(_it_headroom_to_racks(headroom, ctx, "transformer headroom")),
           c["transformer_capacity"])
    return total, peak


def ups_stage(ctx, c):
    total = None
    for u in ctx.power.ups:
        n = _effective_units(u.units, u.redundancy)
        cap = (u.unit_rating_kW * V(float(n), "1", f"{u.id} usable units ({u.redundancy})", ASSUMED)).relabel(
            f"{u.id} usable UPS capacity", "power.ups_capacity")
        total = cap if total is None else total + cap
    existing = ctx.power.current_it_load_MW.convert(1000.0, "kW", "existing protected IT load")
    headroom = (total - existing).relabel("UPS headroom for new IT load", "power.ups_headroom", step_evidence=ESTIMATED)
    _check("ups", floor_racks(headroom / ctx.cluster.platform.rack_kW), c["ups_capacity"])
    return total, existing


def busway_stage(ctx, c):
    lv = ctx.power.lv
    phase_factor = math.sqrt(3.0) if lv.phases == 3 else 1.0
    per_run = (lv.voltage_V * lv.busway_ampacity_A * lv.busway_utilisation_limit *
               ctx.power.grid.power_factor).convert(phase_factor / 1000.0, "kW", "usable capacity per busway run")
    total = (per_run * V(float(lv.busway_runs), "1", "busway runs in hall", ASSUMED)).relabel(
        "total usable busway capacity in hall", "power.busway_total", step_evidence=ESTIMATED)
    _check("busway", floor_racks(total / ctx.cluster.platform.rack_kW), c["busway_ampacity"])
    return total


def plant_stage(ctx, c):
    plat = ctx.cluster.platform
    per_rack = plat.rack_kW if _liquid_load_to_plant(ctx) else plat.residual_air_kW()
    existing = ctx.power.current_it_load_MW.convert(1000.0, "kW", "existing hall heat load on plant")
    capacity = ctx.thermal.plant.chilled_water_capacity_kW
    headroom = (capacity - existing).relabel("chilled-water plant headroom", "thermal.plant_headroom",
                                             step_evidence=ESTIMATED)
    _check("plant", floor_racks(headroom / per_rack), c["plant_capacity"])
    return capacity, existing, per_rack


def water_stage(ctx, c):
    """Required vs achievable facility-water temperature (a gate: the achievable temperature must not exceed the required)."""
    t = ctx.thermal
    required = (t.tcs_target_supply_C - t.cdu_approach_K).relabel(
        "facility water supply temperature required", "thermal.required_fws", step_evidence=ESTIMATED)
    if t.trim_chiller_installed:
        achievable = t.plant.design_supply_C.relabel("achievable", "thermal.trim_chiller_fws", step_evidence=ESTIMATED)
    elif ctx.architecture == Architecture.FULL_DLC and t.plant.dry_cooler_approach_K is not None:
        achievable = (ctx.site.design_drybulb_C + t.plant.dry_cooler_approach_K).relabel(
            "achievable", "thermal.dry_cooler_fws", step_evidence=ESTIMATED)
    else:
        achievable = t.plant.design_supply_C.relabel("achievable", "thermal.plant_fws", step_evidence=ESTIMATED)
    engine_passes = math.isinf(c["tcs_supply_achievable"].racks)
    if (achievable.value <= required.value) != engine_passes:
        raise SystemExit("water: the rebuilt gate disagrees with the engine's tcs_supply_achievable. "
                         "Update scripts/build-observatory.py.")
    return required, achievable


# --- building one scenario ------------------------------------------------------------------------------------------------
def node(nid, kind, label, capacity, load_found, load_after, binds, key):
    return {"id": nid, "kind": kind, "label": label, "capacity": capacity, "loadAsFound": load_found,
            "loadAfterPlan": load_after, "binds": binds, "constraintKey": key}


def power_path(res) -> list[dict]:
    ctx = res.ladder.initial_context
    final = res.ladder.final
    env = res.envelope
    plat = ctx.cluster.platform
    c = {x.id: x for x in env.constraints}
    binding = env.binding.id
    fac_found, fac_after = env.facility_load_kW, final.facility_load_kW
    it_found, it_after = env.it_load_kW, final.it_load_kW
    n_found, n_after = env.max_racks, final.max_racks
    ev_found, ev_after = rack_evidence(env), rack_evidence(final)

    ceiling, peak = utility_stage(ctx, c)
    tx_total, tx_peak = transformer_stage(ctx, c)
    ups_total, ups_existing = ups_stage(ctx, c)
    busway_total = busway_stage(ctx, c)
    plant_cap, plant_existing, per_rack = plant_stage(ctx, c)
    required_c, achievable_c = water_stage(ctx, c)
    ctx_after = res.ladder.final_context
    _, achievable_after = water_stage(ctx_after, {x.id: x for x in final.constraints})

    need_A = plat.rack_feed_current_A
    nodes = [
        node("utility", "utility", "Utility connection (firm supply)", q_out(ceiling),
             q_out(peak + fac_found), q_out(peak + fac_after), binding == "grid_firm_capacity", "grid_firm_capacity"),
        node("transformer", "transformer", "Transformers (usable after redundancy and derating)", q_out(tx_total),
             q_out(tx_peak + fac_found), q_out(tx_peak + fac_after), binding == "transformer_capacity",
             "transformer_capacity"),
        node("switchgear", "switchgear", "Main switchgear (not modelled by the engine)",
             q_missing("kW", "E0", "The engine has no switchgear constraint, so it states no capacity for this stage."),
             None, None, False, None),
        node("ups", "ups", "UPS (usable after redundancy)", q_out(ups_total),
             q_out(ups_existing + it_found), q_out(ups_existing + it_after), binding == "ups_capacity", "ups_capacity"),
        node("busway", "busway", "Busway runs (usable capacity against new IT load)", q_out(busway_total),
             q_out(it_found), q_out(it_after), binding == "busway_ampacity", "busway_ampacity"),
        node("rack-feed", "rack_feed", "Rack feed / tap-off (current per rack)",
             q_out(ctx.power.lv.tapoff_max_A), q_out(need_A), q_out(need_A), binding == "rack_feed_tapoff",
             "rack_feed_tapoff") if need_A is not None else
        node("rack-feed", "rack_feed", "Rack feed / tap-off (current per rack)",
             q_missing("A", "E0", "The platform declares no rack feed current, so the engine does not assess this stage."),
             None, None, False, None),
        node("rack", "rack", "Rack positions (new racks against positions available)",
             q_out(c["floor_space"].max_racks),
             q_out(V(float(n_found), "racks", "racks deployable as found", ev_found)),
             q_out(V(float(n_after), "racks", "racks deployable after the plan", ev_after)),
             binding == "floor_space", "floor_space"),
        node("cooling-plant", "cooling", "Chilled-water plant (heat load against capacity)", q_out(plant_cap),
             q_out(plant_existing + per_rack * V(float(n_found), "1", "racks as found", ev_found)),
             q_out(plant_existing + per_rack * V(float(n_after), "1", "racks after the plan", ev_after)),
             binding == "plant_capacity", "plant_capacity"),
        node("cooling-water", "cooling", "Facility water temperature (required maximum against achievable)",
             q_out(required_c), q_out(achievable_c), q_out(achievable_after), binding == "tcs_supply_achievable",
             "tcs_supply_achievable"),
    ]
    return nodes


def constraints_out(res) -> list[dict]:
    env = res.envelope
    return [{"key": c.id, "name": c.name, "domain": c.domain,
             "racksAllowed": None if math.isinf(c.racks) else int(c.racks),
             "passes": math.isinf(c.racks),
             "binds": c.id == env.binding.id, "basis": c.basis, "evidence": c.max_racks.evidence.short}
            for c in env.sorted_constraints()]


def rack_rows(res) -> list[dict]:
    ctx = res.ladder.initial_context
    hall, plat = ctx.hall, ctx.cluster.platform
    occupied = max(hall.rack_positions - hall.positions_available, 0)
    found, after = res.envelope.max_racks, res.unlocked_racks
    rows = []
    if occupied:
        d = hall.design_density_kW_per_rack
        rows.append({"id": "existing-racks",
                     "label": "Existing racks: occupied positions at the hall's design density (a design value, not a measurement)",
                     "racks": occupied, "kwPerRackAsFound": _fin(d.rounded()), "kwPerRackAfterPlan": _fin(d.rounded())})
    kw = _fin(plat.rack_kW.rounded())
    rows.append({"id": "new-platform-racks",
                 "label": f"New {plat.name} racks after the plan ({found} deployable as found)",
                 "racks": after, "kwPerRackAsFound": kw if found > 0 else None,
                 "kwPerRackAfterPlan": kw if after > 0 else None})
    return rows


def weeks_out(row: dict) -> tuple[dict, bool]:
    """Weeks to full capacity. A figure is given only when the engine says it is supported (every lead time above E0)."""
    t = row["time_to_power"]
    ev = t.get("date_evidence_class") or t.get("evidence") or "E0"
    if t["status"] == "dated" and t.get("date_basis") == "supported":
        return ({"value": t["weeks"], "low": t["low"], "high": t["high"], "unit": "weeks", "evidence": t["evidence"]}, True)
    if t["status"] == "dated":          # assumed: the engine calls it "assumed lead time, not a date"
        reason = f"Not a date: {t['date_label']}. Weeks are given only when every lead time behind them is above class E0."
    else:
        reason = t["reason"]
    return (q_missing("weeks", ev, reason), False)


def capex_pricing(sc: dict, has_capex: bool) -> str:
    """What the priced lines behind a capex rest on, from the engine's own output: economics.cost_basis_mix counts the priced
    library lines by basis ("library_default" is a placeholder, not a price) and a taken ladder step priced from the intake carries
    cost_basis "client_supplied". Anything else (a benchmark, an estimate, a quotation) is a supplied figure."""
    if not has_capex:
        return "none"
    mix = {b: v["lines"] for b, v in sc["economics"]["cost_basis_mix"].items()}
    placeholders = mix.get("library_default", 0)
    supplied = sum(n for b, n in mix.items() if b != "library_default") + sum(
        1 for st in sc["ladder"] if st["taken"] and st["cost_basis"] == "client_supplied")
    if placeholders and supplied:
        return "partly_supplied"
    if supplied:
        return "supplied"
    if placeholders:
        return "placeholder"
    raise SystemExit("cannot derive capexPricing: the engine reports no priced line behind a capex figure")


def outcome_out(res, row, sc) -> dict:
    econ = row["economics"]
    final = res.ladder.final
    weeks, dated = weeks_out(row)
    if res.economics.nothing_deployable:
        capex = q_missing("EUR", res.economics.capex_total_eur.evidence.short, econ["capex_na_reason"])
    else:
        capex = q_out(res.economics.capex_total_eur)
    unpriced: list[str] = []
    for u in econ["unpriced_components"]:
        name = str(u.get("component") or u.get("key"))
        if name not in unpriced:
            unpriced.append(name)
    classes = [rack_evidence(final), final.it_load_kW.evidence]
    if not res.economics.nothing_deployable:
        classes.append(res.economics.capex_total_eur.evidence)
    classes += [s.lead_time_weeks.evidence for s in res.ladder.taken_steps if s.lead_time_weeks is not None]
    return {"id": res.spec.id, "name": res.spec.name, "racksAsFound": res.envelope.max_racks,
            "racksAfterPlan": res.unlocked_racks,
            "bindingAfterPlan": final.binding.id if final else None,
            "itLoadKwAfterPlan": q_out(final.it_load_kW), "weeksToCapacity": weeks, "dated": dated,
            "capexEur": capex, "capexComplete": bool(econ["capex_complete"]),
            "capexPricing": capex_pricing(sc, capex["value"] is not None),
            "unpricedComponents": unpriced, "evidence": min(classes).short}


def summary_of(h, res, outcome) -> str:
    env = res.envelope
    plat = res.ladder.initial_context.cluster.platform.name
    lesson = {
        "rack_feed": "The rack feed binds first: the installed tap-offs cannot carry one rack of the target platform.",
        "water": "The temperature of the facility water binds first: it is too warm for direct liquid cooling.",
        "headroom": "The hall has real electrical headroom, so one transformer bank binds first and, once relieved, "
                    "rack positions bind instead.",
    }[h["lesson"]]
    after = outcome["bindingAfterPlan"]
    after_name = next(c.name for c in res.ladder.final.constraints if c.id == after)
    return (f"{lesson} For {plat} racks in the \"{res.spec.name}\" scenario the engine finds {outcome['racksAsFound']} "
            f"deployable as found and {outcome['racksAfterPlan']} after the plan, where the binding constraint is "
            f"{after_name.lower()}. The hall is invented and every figure is modelled, not measured.")


def scenario_out(h, doc: dict, calibration_statement: str) -> dict:
    handler_screen = ROUTES["/v1/screen"][0]
    handler_compare = ROUTES["/v1/compare"][0]
    screen = handler_screen({"intake": doc}, Tier.CLIENT)
    compare = handler_compare({"intake": doc, "objective": "max_compute"}, Tier.CLIENT)
    intake, results = _run(doc)
    by_id = {r.spec.id: r for r in results}
    rows = {r["id"]: r for r in compare["scenarios"]}
    # The same solve answers both handlers: refuse to publish if they ever disagree.
    for s in screen["scenarios"]:
        r, row = by_id[s["id"]], rows[s["id"]]
        assert s["as_found"]["racks"] == row["as_found"]["racks"] == r.envelope.max_racks, s["id"]
        assert s["after_ladder"]["racks"] == row["after_ladder"]["racks"] == r.unlocked_racks, s["id"]
    head = by_id[h["headline"]]
    screen_by_id = {x["id"]: x for x in screen["scenarios"]}
    outcomes = [outcome_out(by_id[sid], rows[sid], screen_by_id[sid]) for sid in rows]
    head_outcome = next(o for o in outcomes if o["id"] == h["headline"])
    ctx = head.ladder.initial_context
    g = ctx.power.grid
    site = intake.context.site

    constraints = constraints_out(head)
    limitations: list[str] = []

    def add(text):
        if text and text not in limitations:
            limitations.append(text)

    add("Synthetic hall: every input is invented for demonstration. It is not a customer, a company or a site, and nothing in it has been measured.")
    add("The calibration ledger is empty: nothing in this scenario is measured or calibrated. " + calibration_statement)
    add("The engine labels any input an intake supplies as supplied by the client (class E5); in this synthetic hall that label "
        "describes how the engine treats an input, not a measurement.")
    for caveat in compare["caveats"]:
        add(caveat)
    for text in head_row_limitations(rows[h["headline"]]):
        add(text)
    for text in intake_warnings(intake):
        add(text)
    if any(o["unpricedComponents"] or not o["capexComplete"] for o in outcomes if o["capexEur"]["value"] is not None):
        add("A capex that is not complete, or that lists unpriced components, is a lower bound, not a complete price.")
    add("The power path and the constraints are shown for the headline outcome "
        f"({head.spec.name}); other architectures are compared under outcomes. Stage capacities are as found: the plan's "
        "reliefs raise several of them, so a stage's load after the plan may exceed its as-found capacity.")
    add("Loads: the engine charges the existing site peak to the utility connection and transformers, the existing IT load to the "
        "UPS and the chilled-water plant, and only the new IT load to the busway; it models no switchgear. A null load is a "
        "load the engine does not charge to that stage.")
    add("A constraint with no racks-allowed figure passes: the engine reports no finite limit for it in this architecture, so it "
        "does not limit the hall. How well supported that is shows in its evidence class, not in the figure being absent.")
    found_binding = next(c for c in constraints if c["binds"])
    tied = [c["name"] for c in constraints
            if not c["binds"] and c["racksAllowed"] is not None and c["racksAllowed"] == found_binding["racksAllowed"]]
    if tied:
        add("Tied as found: " + "; ".join(tied) + " also allow" + ("s" if len(tied) == 1 else "") +
            f" {found_binding['racksAllowed']} racks. The engine names the first constraint in its fixed order as binding "
            f"({found_binding['name']}), so relieving that one alone may not unlock racks.")
    dated = [o["name"] for o in outcomes if o["dated"]]
    if dated:
        add("Weeks to capacity are given only for outcomes whose every lead time is above class E0 (" + "; ".join(dated) +
            "); every other outcome has no date.")
    else:
        add("No outcome here is dated: weeks to capacity are given only when every lead time behind them is above class E0, "
            "and none is.")
    rr = rack_rows(head)
    if any(r["id"] == "existing-racks" for r in rr):
        add("The existing-racks row is the occupied positions at the hall's design density, a design value. The current IT load "
            "is a separate invented input: occupied positions multiplied by design density is not claimed to equal it, and the "
            "engine uses the two independently (the current IT load is charged to the UPS and the chilled-water plant).")
    pricing: dict[str, list[str]] = {}
    for o in outcomes:
        pricing.setdefault(o["capexPricing"], []).append(o["name"])
    labels = {"placeholder": "rest entirely on library placeholders (not prices)",
              "partly_supplied": "rest partly on a supplied figure and partly on library placeholders",
              "supplied": "rest on supplied figures only"}
    parts = [f"{'; '.join(names)} {labels[k]}" for k, names in sorted(pricing.items()) if k != "none"]
    if parts:
        add("Capex pricing: " + ". ".join(parts) + ". An outcome with no racks has no capex figure.")

    return {
        "id": h["id"], "title": h["title"], "summary": summary_of(h, head, head_outcome), "synthetic": True,
        "hall": {"name": h["title"], "platform": ctx.cluster.platform.name,
                 "contractedMW": _fin(g.contracted_MW.rounded()), "currentItLoadMW": _fin(ctx.power.current_it_load_MW.rounded()),
                 "positionsAvailable": ctx.hall.positions_available,
                 "region": REGION},
        "powerPath": power_path(head),
        "constraints": constraints,
        "rackRows": rack_rows(head),
        "outcomes": outcomes, "headlineOutcome": h["headline"], "limitations": limitations,
    }


def head_row_limitations(row: dict) -> list[str]:
    return list(row["economics"].get("limitations") or [])


# --- the content fingerprint -------------------------------------------------------------------------------------------------
# contentSha256 seals every leaf of the file but itself, so the loader (lib/observatory/scenario-data.ts, contentFingerprint) can
# refuse a schema-valid hand edit of any figure. The two implementations must agree exactly; a shared test vector in
# tests/test_observatory_scenarios.py and tests/site/observatory-scenarios.test.ts pins them. One line per leaf, "/path\t<kind><value>":
# z = null, b = boolean, n = number (integers without a point, others shortest round-trip; exponent notation and magnitudes above
# 2**53 are refused), s = string (JSON-escaped, not ASCII-escaped). Keys are visited in sorted order, arrays by index; lines are
# joined with "\n" and hashed as UTF-8.
def _canonical_number(x, at: str) -> str:
    if isinstance(x, bool):
        raise TypeError(at)
    if isinstance(x, float):
        if not math.isfinite(x) or abs(x) > 2 ** 53:
            raise ValueError(f"{at}: number out of range for the content fingerprint")
        text = str(int(x)) if x == int(x) else repr(x)
    else:
        if abs(x) > 2 ** 53:
            raise ValueError(f"{at}: number out of range for the content fingerprint")
        text = str(x)
    if "e" in text.lower():
        raise ValueError(f"{at}: number in exponent notation cannot be fingerprinted")
    return "0" if text == "-0" else text


def _fingerprint_lines(value, at: str, out: list) -> None:
    if value is None:
        out.append(f"{at}\tz")
    elif isinstance(value, bool):
        out.append(f"{at}\tb{'true' if value else 'false'}")
    elif isinstance(value, (int, float)):
        out.append(f"{at}\tn{_canonical_number(value, at)}")
    elif isinstance(value, str):
        out.append(f"{at}\ts{json.dumps(value, ensure_ascii=False)}")
    elif isinstance(value, list):
        for i, v in enumerate(value):
            _fingerprint_lines(v, f"{at}/{i}", out)
    elif isinstance(value, dict):
        for k in sorted(value):
            _fingerprint_lines(value[k], f"{at}/{k}", out)
    else:
        raise TypeError(f"{at}: {type(value).__name__} cannot be fingerprinted")


def content_fingerprint(doc: dict) -> str:
    """SHA-256 (hex) of every leaf of a scenario file other than its own contentSha256."""
    lines: list = []
    _fingerprint_lines({k: v for k, v in doc.items() if k != "contentSha256"}, "", lines)
    return hashlib.sha256("\n".join(lines).encode("utf-8")).hexdigest()


def build(date: str = DEFAULT_DATE) -> dict:
    with pinned_engine(date):
        return _build()


def _build() -> dict:
    for route in ROUTES_USED:
        if route not in ROUTES:
            raise SystemExit(f"the engine no longer serves {route}")
    cal = accuracy_block(all_keys(), load_ledger(published_only=True))
    if cal["observations"] != 0:
        raise SystemExit("the calibration ledger is no longer empty: the Observatory's 'empty' state must be revisited")
    scenarios = [scenario_out(h, h["doc"](), cal["statement"]) for h in HALLS]
    doc = {
        "schema": SCHEMA,
        "engine": {"version": VERSION, "codeSha256": code_sha256(), "routes": list(ROUTES_USED)},
        "generatedAt": report_date_iso(),
        "synthetic": True,
        "calibration": {"state": "empty", "statement": cal["statement"]},
        "scenarios": scenarios,
    }
    doc["contentSha256"] = content_fingerprint(doc)
    return doc


def dumps(doc: dict) -> str:
    return json.dumps(doc, indent=2, sort_keys=True, ensure_ascii=False, allow_nan=False) + "\n"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("-o", "--out", default=str(DEFAULT_OUT))
    args = ap.parse_args(argv)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(dumps(build(os.environ.get("GRIDFORGE_REPORT_DATE") or DEFAULT_DATE)).encode("utf-8"))
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
