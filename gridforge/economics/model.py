"""Screening economics. AACE Class 5 (order of magnitude, -50%/+100%).

We do not have a proprietary cost database yet. Every unit cost here is E0 and
carries that band. docs/02 §9 item 12: the two circulating retrofit benchmarks
differ by 4-6x, so a single point estimate here would be dishonest. Replace this
library with real quotations obtained during projects 1 and 2 - that cost library
is a genuine proprietary asset; these placeholders are not.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace

from ..common import ASSUMED, ESTIMATED, MODELLED, V
from ..costs import BAND_BY_EVIDENCE, cdu_cost, cost, library
from ..envelope.solver import EnvelopeResult, HeadroomLadder, rack_evidence
from ..validation import Quantity

CONVERSION_COST_KEY = "conversion.per_rack"


def conversion_capex_per_rack():
    return cost(CONVERSION_COST_KEY, 55_000, "EUR/rack",
                "in-hall conversion per rack (manifolds, QDs, rack fit-out, commissioning)",
                note="Excludes IT hardware, migration and lost tenancy revenue. Public retrofit "
                     "benchmarks span 2-12 MEUR per MW; this default is neither a quotation nor a "
                     "benchmark.")

ELECTRICITY_EUR_PER_MWH = V(140, "EUR/MWh", "all-in electricity price", ASSUMED, band=(90, 220),
                            assumptions=["Placeholder. Replace with the site's actual contracted tariff."])


AACE_CLASS = "Class 5 (order of magnitude): -50% / +100%"


@dataclass
class BtmOpex:
    """Operating economics of the behind-the-meter options the ladder installed. Never partly applied: either every
    installed option has every input its operating cost needs, or none of it is applied and ``missing`` says why."""
    applied: bool
    options: list = field(default_factory=list)       # per-option rows (plain data)
    missing: list = field(default_factory=list)       # what prevents the figure, per option
    generated_MWh: Quantity | None = None
    used_MWh: Quantity | None = None                  # generation that displaces site demand (capped at demand)
    variable_eur: Quantity | None = None
    fixed_eur: Quantity | None = None
    curtailed: bool = False


@dataclass
class EconomicsResult:
    capex_conversion_eur: Quantity
    capex_relief_eur: Quantity
    capex_total_eur: Quantity
    capex_eur_per_kW_it: Quantity
    annual_energy_MWh: Quantity
    annual_energy_cost_eur: Quantity          # the site's annual recurring energy bill: grid + BTM operating cost
    energy_cost_per_gpu_hour_eur: Quantity
    critical_path_weeks: float
    aace_class: str = AACE_CLASS
    cost_basis_mix: dict = None  # type: ignore[assignment]
    #: False when any part of the capex has no price: a relief, or a component of one (see ``unpriced``). The
    #: total is then a LOWER BOUND, not an estimate.
    capex_complete: bool = True
    #: Cost components with no price at all, each {where, component, key, unit, scope}.
    unpriced: list = field(default_factory=list)
    capex_cdu_kit_eur: Quantity | None = None
    cdu_kit_scope: str = ""
    #: Priced lines resting on a quotation of limited comparability: [{where, note}].
    limited: list = field(default_factory=list)
    #: Cost keys on this run's path whose accepted evidence is a synthetic fixture.
    synthetic_evidence: list = field(default_factory=list)
    tariff_eur_per_MWh: Quantity | None = None
    tariff_declared: bool = False
    annual_grid_energy_cost_eur: Quantity | None = None
    btm: BtmOpex | None = None
    #: False when installed BTM generation has no usable operating cost: the energy bill then prices ALL energy at
    #: the grid tariff, which is not what the hall would pay.
    opex_complete: bool = True
    lifecycle_cost_eur: Quantity | None = None
    horizon_years: int | None = None
    discount_rate: float | None = None
    lifecycle_basis: str = ""
    #: False when a relief on the path has no lead time: ``critical_path_weeks`` is then a lower bound.
    critical_path_complete: bool = True

    def unpriced_summary(self) -> list[dict]:
        """The unpriced components grouped by what they are: one row per missing price, with the total quantity it
        would apply to and every place it is needed. (A report lists each missing price once, not once per step.)"""
        groups: dict[str, dict] = {}
        for u in self.unpriced:
            g = groups.setdefault(u["key"] or u["component"], {
                "key": u["key"], "component": u["component"], "unit": u["unit"], "quantity": 0.0, "where": []})
            g["quantity"] += float(u.get("quantity", 0.0))
            g["where"].append(u["where"])
        return sorted(groups.values(), key=lambda g: g["component"])

    @property
    def rests_on_placeholders(self) -> int:
        return (self.cost_basis_mix or {}).get("library_default", 0)

    @property
    def lifecycle_complete(self) -> bool:
        return self.lifecycle_cost_eur is not None and self.capex_complete and self.opex_complete

    @property
    def limitations(self) -> list[str]:
        """Every reason this economics result is not decision-grade, in the words a report prints. Empty only when
        every priced line rests on a quotation or better, nothing is unpriced, and the energy price is declared."""
        out: list[str] = []
        if self.unpriced:
            items = [f"{g['component']} ({g['quantity']:g} x {g['unit'].split('/')[-1]}, needed in "
                     f"{len(g['where'])} place{'s' if len(g['where']) != 1 else ''})" for g in self.unpriced_summary()]
            out.append("the capex total is a LOWER BOUND: no price exists for " + "; ".join(items))
        if self.synthetic_evidence:
            out.append("synthetic cost evidence (a test fixture, not a real quotation) is in the price basis: "
                       + ", ".join(self.synthetic_evidence))
        if self.limited:
            out.append(f"{len(self.limited)} priced line(s) rest on a supplier quotation of limited comparability "
                       f"(scaled to a quantity the supplier did not quote, or with no stated scope)")
        n = self.rests_on_placeholders
        if n:
            total = sum((self.cost_basis_mix or {}).values())
            out.append(f"{n} of {total} priced lines are library placeholders, not prices")
        if not self.tariff_declared:
            out.append("the grid electricity price is a placeholder (140 EUR/MWh), not the site's tariff")
        if self.btm is not None and not self.btm.applied:
            out.append("installed behind-the-meter generation has no usable operating cost: " + "; ".join(self.btm.missing)
                       + ". The energy cost prices all energy at the grid tariff")
        if self.horizon_years is None:
            out.append("no lifecycle horizon was declared, so no lifecycle value is computed")
        return out

    @property
    def decision_grade(self) -> bool:
        return not [x for x in self.limitations if not x.startswith("no lifecycle horizon")]


def _unpriced_rows(lad: HeadroomLadder) -> list[dict]:
    rows = []
    for st in lad.taken_steps:
        for key, what, unit, qty in st.unpriced:
            rows.append({"where": f"step {st.step}: {st.relief_description}", "component": what, "key": key,
                         "unit": unit, "quantity": qty, "scope": st.scope})
        if st.capex_eur is None:
            rows.append({"where": f"step {st.step}: {st.relief_description}", "component": "the relief itself",
                         "key": st.cost_key or "", "unit": "EUR", "quantity": 1.0, "scope": st.scope})
    return rows


def _btm_opex(options: list, facility_energy_MWh: Quantity) -> BtmOpex:
    rows, missing = [], []
    for o in options:
        row = {"id": o.id, "kind": o.kind, "capacity_MW": o.capacity_MW.value}
        need: list[str] = []
        # The model applies what the client declares; it does not simulate a dispatch. For storage the declared
        # opex_eur_per_MWh must be the all-in cost of each MWh DISCHARGED (including the energy used to charge
        # it); for PV or wind the price per MWh delivered with run hours as equivalent full-load hours.
        if o.annual_run_hours is None:
            need.append(f"{o.id}: annual_run_hours not declared")
        if o.opex_eur_per_MWh is None and (o.fuel_price_eur_per_MWh is None or o.electrical_efficiency is None):
            need.append(f"{o.id}: no energy cost basis (declare opex_eur_per_MWh, or fuel_price_eur_per_MWh with "
                        f"electrical_efficiency)")
        if o.opex_eur_per_MWh is None and o.variable_om_eur_per_MWh is None:
            need.append(f"{o.id}: variable_om_eur_per_MWh not declared (0 if the fuel route already includes it)")
        if o.fixed_om_eur_per_kW_year is None:
            need.append(f"{o.id}: fixed_om_eur_per_kW_year not declared (0 if carried elsewhere)")
        row["missing"] = need
        rows.append(row)
        missing.extend(need)
    if missing:
        return BtmOpex(applied=False, options=rows, missing=missing)

    gen_total = None
    var_cost = []
    fixed_total = None
    for o, row in zip(options, rows):
        gen = (o.capacity_MW * o.annual_run_hours).convert(1.0, "MWh", f"{o.id} annual generation")
        per_MWh = o.opex_eur_per_MWh if o.opex_eur_per_MWh is not None else (
            (o.fuel_price_eur_per_MWh / o.electrical_efficiency).convert(1.0, "EUR/MWh", f"{o.id} fuel cost per MWh generated")
            + o.variable_om_eur_per_MWh)
        fixed = (o.capacity_MW.convert(1000.0, "kW", f"{o.id} capacity in kW") * o.fixed_om_eur_per_kW_year).convert(
            1.0, "EUR", f"{o.id} fixed O&M per year")
        row.update({"generated_MWh": gen.value, "cost_eur_per_MWh": per_MWh.value, "fixed_eur": fixed.value})
        gen_total = gen if gen_total is None else gen_total + gen
        var_cost.append((gen, per_MWh))
        fixed_total = fixed if fixed_total is None else fixed_total + fixed
    # Generation beyond what the hall consumes is not valued (export is not modelled): cap it, and say so.
    used_frac = min(1.0, facility_energy_MWh.value / gen_total.value) if gen_total.value > 0 else 0.0
    used = gen_total * V(used_frac, "1", "share of BTM generation consumed on site", MODELLED)
    variable = None
    for gen, per_MWh in var_cost:
        v = (gen * per_MWh * V(used_frac, "1", "share consumed on site", MODELLED)).relabel(
            "BTM variable operating cost", "economics.btm_variable", step_evidence=MODELLED)
        variable = v if variable is None else variable + v
    return BtmOpex(applied=True, options=rows, generated_MWh=gen_total, used_MWh=used.relabel(
        "BTM generation consumed on site", "economics.btm_used", step_evidence=MODELLED),
        variable_eur=variable, fixed_eur=fixed_total, curtailed=used_frac < 1.0)


def _allocated_quotes(lad: HeadroomLadder, assumed_cdu_units: int) -> set[str]:
    """Library keys whose quotation is ALLOCATED across this run's steps rather than extrapolated: the quantities the
    steps need (plus the assumed CDU kit, which is priced on the cdu.addition line) add up to the quantity the supplier
    quoted. Splitting a package price across the steps of that package is arithmetic, not an assumption about a size the
    supplier never priced, so those steps are not flagged limited."""
    lib = library()
    out: set[str] = set()
    for key, e in lib.entries.items():
        if e.unit != "EUR" or e.quoted_quantity is None or e.comparability != "exact":
            continue
        steps = [st for st in lad.taken_steps if st.cost_key == key and st.quantity is not None]
        needed = sum(st.quantity for st in steps) + (assumed_cdu_units if key == "cdu.addition" else 0)
        if (steps or (key == "cdu.addition" and assumed_cdu_units)) and abs(needed / e.quoted_quantity - 1.0) <= 0.01:
            out.add(key)
            for st in steps:
                if st.cost_kind == "quoted_scaled":
                    st.cost_kind = "quoted_allocation"
                    st.limited = False
                    st.basis_note = ("the quotation covers this constraint's steps together and is allocated across them "
                                     "in proportion to the capacity each adds")
    return out


def evaluate(res: EnvelopeResult, lad: HeadroomLadder, utilisation: Quantity) -> EconomicsResult:
    ctx_f, ctx_i = lad.final_context, lad.initial_context
    settings = ctx_f.economics if ctx_f is not None else None
    keys = sorted({k for k in lad.cost_keys if "." in k} | {CONVERSION_COST_KEY})
    # The class of a derived rack count is the weakest constraint that caps it, not a blanket claim (labels.py).
    racks = V(float(res.max_racks), "racks", "deployable racks", rack_evidence(res))
    conv = (racks * conversion_capex_per_rack()).relabel(
        "in-hall conversion capex", "economics.conversion_capex", step_evidence=MODELLED)
    unpriced = _unpriced_rows(lad)
    assumed_units = sum(c.units for c in (ctx_i.thermal.cdus if ctx_i is not None else []) if not c.installed)
    allocated = _allocated_quotes(lad, assumed_units if res.max_racks > 0 else 0)
    # Lines whose price rests on a quotation of limited comparability: scaled to a quantity the supplier did not quote,
    # or quoted with no stated scope. They stay in the total, visibly limited, never treated as a clean benchmark.
    limited_rows = [{"where": f"step {st.step}: {st.relief_description}", "note": st.basis_note or "limited comparability"}
                    for st in lad.taken_steps if st.limited]
    # The relief cost is the sum of the priced rungs, each carrying the band and evidence class of the library
    # line it came from -- a firm quotation narrows it, a placeholder widens it.
    priced = [st.capex_eur for st in lad.taken_steps if st.capex_eur is not None]
    capex_complete = len(priced) == len(lad.taken_steps) and not unpriced
    aace = library().aace_class(keys)
    if priced:
        relief = priced[0]
        for q in priced[1:]:
            relief = relief + q
        # The estimate is only as mature as its weakest priced line (the AACE class says so). Interval addition of
        # the lines can come out narrower than that class allows when a few lines are firmer than the rest, so
        # the band is never narrower than the cost library's band for the weakest line's evidence class.
        lo_f, hi_f = BAND_BY_EVIDENCE[library().weakest(keys)]
        relief = replace(relief, lo=min(relief.band[0], relief.value * lo_f),
                         hi=max(relief.band[1], relief.value * hi_f))
        relief = relief.relabel("capex of relief measures taken along the headroom ladder",
                                "economics.relief_capex", step_evidence=MODELLED, assumptions=[aace])
    else:
        relief = V(0.0, "EUR", "capex of relief measures taken along the headroom ladder", MODELLED,
                   assumptions=["No relief was needed or priced."])

    # CDUs the engine ASSUMED so a liquid scenario could be solved are not in the hall: buying them is capex. The
    # ladder prices every CDU it ADDS; this prices the ones it started from, so no unit is priced twice or not at all.
    kit, kit_scope = None, ""
    if res.max_racks > 0 and assumed_units > 0:
        kit, _kind, kit_scope, kit_unpriced, kit_extra, kit_limited, kit_note = cdu_cost(
            assumed_units, "initial CDU kit (assumed, not installed)")
        if kit_limited and "cdu.addition" not in allocated:
            limited_rows.append({"where": "initial CDU kit", "note": kit_note or "limited comparability"})
        keys = sorted(set(keys) | {"cdu.addition"} | set(kit_extra))
        aace = library().aace_class(keys)
        for key, what, unit, qty in kit_unpriced:
            unpriced.append({"where": "initial CDU kit (no CDU schedule was supplied)", "component": what,
                             "key": key, "unit": unit, "quantity": qty, "scope": kit_scope})
        capex_complete = capex_complete and not kit_unpriced
    total = conv + relief
    if kit is not None:
        total = total + kit
    total = total.relabel("total capex", "economics.total_capex", step_evidence=MODELLED)
    per_kW = (total / res.it_load_kW).relabel(
        "capex per kW of IT load deployed", "economics.capex_per_kW", step_evidence=MODELLED) \
        if res.it_load_kW.value > 0 else V(0, "EUR/kW", "capex per kW (no deployable load)", MODELLED)

    hours = V(8760.0, "h", "hours per year", ESTIMATED)
    energy = (res.facility_load_kW * utilisation * hours).convert(
        0.001, "MWh", "annual site energy for the deployed load")
    declared = settings is not None and settings.electricity_eur_per_MWh is not None
    tariff = settings.electricity_eur_per_MWh if declared else ELECTRICITY_EUR_PER_MWH
    installed = [o for o in (ctx_f.power.options if ctx_f is not None else []) if o.installed] if res.max_racks > 0 else []
    btm = _btm_opex(installed, energy) if installed else None
    grid_cost = (energy * tariff).relabel("annual grid energy cost", "economics.grid_energy_cost", step_evidence=MODELLED)
    if btm is not None and btm.applied:
        grid_share = V(max(0.0, 1.0 - btm.used_MWh.value / energy.value) if energy.value > 0 else 0.0, "1",
                       "share of site energy bought from the grid", MODELLED)
        grid_cost = (grid_cost * grid_share).relabel("annual grid energy cost", "economics.grid_energy_cost",
                                                     step_evidence=MODELLED)
        cost_ = (grid_cost + btm.variable_eur + btm.fixed_eur).relabel(
            "annual energy cost", "economics.energy_cost", step_evidence=MODELLED)
    else:
        cost_ = grid_cost.relabel("annual energy cost", "economics.energy_cost", step_evidence=MODELLED)
    opex_complete = btm is None or btm.applied
    gpu_hours = float(res.gpus) * 8760.0
    per_gpu_h = (cost_ / V(gpu_hours, "gpu*h", "annual GPU hours", ESTIMATED)).relabel(
        "energy cost per GPU-hour", "economics.energy_per_gpu_hour", step_evidence=MODELLED) \
        if gpu_hours > 0 else V(0, "EUR/gpu*h", "energy cost per GPU-hour (no GPUs deployable)", MODELLED)

    life, basis, horizon, rate = None, "", None, None
    if settings is not None and settings.horizon_years and res.max_racks > 0:
        horizon = settings.horizon_years
        r_ = settings.discount_rate.value if settings.discount_rate is not None else None
        rate = r_
        factor = float(horizon) if not r_ else (1.0 - (1.0 + r_) ** (-horizon)) / r_
        life = (total + cost_ * V(factor, "1", "years of recurring cost (annuity factor)", MODELLED)).relabel(
            f"lifecycle cost over {horizon} years", "economics.lifecycle_cost", step_evidence=MODELLED)
        basis = (f"capex at year 0 plus the annual energy cost for {horizon} years, "
                 + (f"discounted at {r_:.1%} (end-year)" if r_ else "undiscounted")
                 + ", flat prices, no escalation; excludes IT hardware, migration, lost tenancy revenue, "
                   "non-energy operating cost of the cooling plant, and decommissioning")

    return EconomicsResult(
        conv, relief, total, per_kW, energy, cost_, per_gpu_h, lad.critical_path_weeks, aace,
        library().basis_mix(keys), capex_complete, unpriced=unpriced, capex_cdu_kit_eur=kit,
        cdu_kit_scope=kit_scope, limited=limited_rows,
        synthetic_evidence=sorted(k for k in keys if k in library().entries and library().entries[k].synthetic), tariff_eur_per_MWh=tariff, tariff_declared=declared,
        annual_grid_energy_cost_eur=grid_cost, btm=btm, opex_complete=opex_complete,
        lifecycle_cost_eur=life, horizon_years=horizon, discount_rate=rate, lifecycle_basis=basis,
        critical_path_complete=lad.critical_path_complete)
