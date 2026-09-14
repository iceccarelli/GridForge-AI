"""Screening economics. AACE Class 5 (order of magnitude, -50%/+100%).

We do not have a proprietary cost database yet. Every unit cost here is E0 and
carries that band. docs/02 §9 item 12: the two circulating retrofit benchmarks
differ by 4-6x, so a single point estimate here would be dishonest. Replace this
library with real quotations obtained during projects 1 and 2 - that cost library
is a genuine proprietary asset; these placeholders are not.
"""
from __future__ import annotations

from dataclasses import dataclass

from ..common import ASSUMED, ESTIMATED, MODELLED, V
from ..costs import cost, library
from ..envelope.solver import EnvelopeResult, HeadroomLadder
from ..validation import Quantity

CONVERSION_COST_KEY = "conversion.per_rack"


def conversion_capex_per_rack():
    return cost(CONVERSION_COST_KEY, 55_000, "EUR/rack",
                "in-hall conversion per rack (manifolds, QDs, rack fit-out, commissioning)",
                note="Excludes IT hardware, migration and lost tenancy revenue. Public retrofit "
                     "benchmarks span 2-12 MEUR per MW; neither is a benchmark.")

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

    @property
    def rests_on_placeholders(self) -> int:
        return (self.cost_basis_mix or {}).get("library_default", 0)


def evaluate(res: EnvelopeResult, lad: HeadroomLadder, utilisation: Quantity) -> EconomicsResult:
    keys = sorted({k for k in lad.cost_keys if "." in k} | {CONVERSION_COST_KEY})
    racks = V(float(res.max_racks), "racks", "deployable racks", ESTIMATED)
    conv = (racks * conversion_capex_per_rack()).relabel(
        "in-hall conversion capex", "economics.conversion_capex", step_evidence=MODELLED)
    relief_total = lad.cumulative_capex_eur
    aace = library().aace_class(keys)
    relief = V(relief_total, "EUR", "capex of relief measures taken along the headroom ladder",
               ASSUMED, band=(relief_total * 0.5, relief_total * 2.0),
               assumptions=[aace])
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
                           lad.critical_path_weeks, aace, library().basis_mix(keys))
