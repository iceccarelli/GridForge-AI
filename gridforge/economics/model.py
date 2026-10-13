"""Screening economics. AACE Class 5 (order of magnitude, -50%/+100%).

We do not have a proprietary cost database yet. Every unit cost here is E0 and
carries that band. docs/02 §9 item 12: the two circulating retrofit benchmarks
differ by 4-6x, so a single point estimate here would be dishonest. Replace this
library with real quotations obtained during projects 1 and 2 - that cost library
is a genuine proprietary asset; these placeholders are not.
"""
from __future__ import annotations

from dataclasses import dataclass, replace

from ..common import ASSUMED, ESTIMATED, MODELLED, V
from ..costs import BAND_BY_EVIDENCE, cost, library
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
class EconomicsResult:
    capex_conversion_eur: Quantity
    capex_relief_eur: Quantity
    capex_total_eur: Quantity
    capex_eur_per_kW_it: Quantity
    annual_energy_MWh: Quantity
    annual_energy_cost_eur: Quantity
    energy_cost_per_gpu_hour_eur: Quantity
    critical_path_weeks: float
    aace_class: str = AACE_CLASS
    cost_basis_mix: dict = None  # type: ignore[assignment]
    #: False when a relief taken on the ladder has no price: the total is then a lower bound, not an estimate.
    capex_complete: bool = True

    @property
    def rests_on_placeholders(self) -> int:
        return (self.cost_basis_mix or {}).get("library_default", 0)


def evaluate(res: EnvelopeResult, lad: HeadroomLadder, utilisation: Quantity) -> EconomicsResult:
    keys = sorted({k for k in lad.cost_keys if "." in k} | {CONVERSION_COST_KEY})
    # The class of a derived rack count is the weakest constraint that caps it, not a blanket claim (labels.py).
    racks = V(float(res.max_racks), "racks", "deployable racks", rack_evidence(res))
    conv = (racks * conversion_capex_per_rack()).relabel(
        "in-hall conversion capex", "economics.conversion_capex", step_evidence=MODELLED)
    # The relief cost is the sum of the priced rungs, each carrying the band and evidence class of the library
    # line it came from -- a firm quotation narrows it, a placeholder widens it. It used to be the point value
    # times a fixed 0.5x-2x, which ignored every quotation in the cost library.
    priced = [st.capex_eur for st in lad.taken_steps if st.capex_eur is not None]
    capex_complete = len(priced) == len(lad.taken_steps)
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
    total = (conv + relief).relabel("total capex", "economics.total_capex", step_evidence=MODELLED)
    per_kW = (total / res.it_load_kW).relabel(
        "capex per kW of IT load deployed", "economics.capex_per_kW", step_evidence=MODELLED) \
        if res.it_load_kW.value > 0 else V(0, "EUR/kW", "capex per kW (no deployable load)", MODELLED)

    hours = V(8760.0, "h", "hours per year", ESTIMATED)
    energy = (res.facility_load_kW * utilisation * hours).convert(
        0.001, "MWh", "annual site energy for the deployed load")
    cost_ = (energy * ELECTRICITY_EUR_PER_MWH).relabel(
        "annual energy cost", "economics.energy_cost", step_evidence=MODELLED)
    gpu_hours = float(res.gpus) * 8760.0
    per_gpu_h = (cost_ / V(gpu_hours, "gpu*h", "annual GPU hours", ESTIMATED)).relabel(
        "energy cost per GPU-hour", "economics.energy_per_gpu_hour", step_evidence=MODELLED) \
        if gpu_hours > 0 else V(0, "EUR/gpu*h", "energy cost per GPU-hour (no GPUs deployable)", MODELLED)

    return EconomicsResult(conv, relief, total, per_kW, energy, cost_, per_gpu_h,
                           lad.critical_path_weeks, aace, library().basis_mix(keys), capex_complete)
