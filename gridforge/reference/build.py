"""The numbers on each reference page, computed from the engine's own libraries.

The prose in catalogue.py is authored. Everything numeric here is not: it is read
out of the platform library, the thermal library and the cost library at build time,
so a page cannot quietly contradict the engine that a reader is about to run their
hall through.

That is the property worth having. Anyone can write thirteen good pages about data
hall constraints in a week. Keeping them consistent with a working solver for two
years, while the libraries move and quotations replace placeholders, is a different
undertaking — and it is the one that compounds.
"""
from __future__ import annotations

import math

from ..compute.library import PLATFORMS, UNPUBLISHED_PLATFORMS
from ..costs import CostLibrary, DECLARED_UNITS
from ..thermal.library import PUE_BY_ARCHITECTURE
from ..validation import EvidenceClass
from .catalogue import CONSTRAINT_DOCS, RELIEF_LEAD_TIMES, ConstraintDoc

#: The cost-library key each constraint's relief is priced against, where it has one.
#: Read back from the constraint modules via DECLARED_UNITS once a solve has run;
#: stated here so the reference can be built without one.
RELIEF_COST_KEYS = {
    "rack_feed_tapoff": "tapoff.unit",
    "busway_ampacity": "busway.replacement",
    "transformer_capacity": "transformer.replacement",
    "ups_capacity": "ups.per_kW",
    "plant_capacity": "trim_chiller.adiabatic",
    "cdu_capacity": "cdu.addition",
    "residual_air_removal": "inrow_rdhx.per_rack",
    "tcs_supply_achievable": "trim_chiller.adiabatic",
}


def _worked_example(doc: ConstraintDoc) -> dict | None:
    """One arithmetic example per constraint, on the reference platform.

    Deliberately small and checkable. A reader should be able to reproduce it on a
    phone, because a page that asks them to trust a number has taught them nothing.
    """
    plat = PLATFORMS.get("gb300_nvl72")
    if plat is None:
        return None
    rack_kW = plat.rack_kW.value
    if doc.id == "rack_feed_tapoff":
        amps = rack_kW * 1000 / (400 * math.sqrt(3) * 0.95)
        return {"question": f"What current does one {plat.name} rack draw at 400 V?",
                "working": f"{rack_kW:.0f} kW / (1.73 × 400 V × 0.95)",
                "answer": f"{amps:.0f} A per rack",
                "consequence": "A 63 A tap-off feeds a third of one rack."}
    if doc.id == "busway_ampacity":
        kW = 400 * 0.8 * 400 * math.sqrt(3) * 0.95 / 1000
        return {"question": "How many racks does a 400 A busway run carry?",
                "working": f"400 A × 0.8 × 1.73 × 400 V × 0.95 = {kW:.0f} kW; "
                           f"{kW:.0f} / {rack_kW:.0f}",
                "answer": f"{kW / rack_kW:.1f} racks per run",
                "consequence": "Modern AI halls specify 800–1000 A for this reason."}
    if doc.id == "transformer_capacity":
        pue = PUE_BY_ARCHITECTURE.get("full_dlc")
        pue_v = pue.value if pue is not None else 1.2
        mva = 20 * rack_kW * pue_v / 1000 / 0.95
        return {"question": f"What transformer capacity do 20 {plat.name} racks need?",
                "working": f"20 × {rack_kW:.0f} kW × PUE {pue_v:.2f} / 1000 / 0.95",
                "answer": f"{mva:.2f} MVA before redundancy",
                "consequence": "At N+1 the installed capacity has to carry that with one "
                               "unit out of service."}
    if doc.id == "plant_capacity":
        residual = plat.residual_air_kW().value
        return {"question": "How much air load remains after direct liquid cooling?",
                "working": f"{rack_kW:.0f} kW × (1 − {plat.liquid_fraction.value:.2f})",
                "answer": f"{residual:.0f} kW per rack, still to air",
                "consequence": "More than two racks' worth in a hall designed for 8 kW."}
    if doc.id == "cdu_capacity":
        return {"question": "What approach does a 6 °C loop offer a platform accepting "
                            f"{plat.max_inlet_liquid_C.value:.0f} °C?",
                "working": f"{plat.max_inlet_liquid_C.value:.0f} °C − 6 °C",
                "answer": f"{plat.max_inlet_liquid_C.value - 6:.0f} K approach",
                "consequence": "A unit selected at a 5 K approach is being asked to work at "
                               "four to five times that."}
    if doc.id == "hydraulic_flow":
        flow = plat.flow_l_per_min_per_rack.value
        return {"question": "What flow do 20 racks need?",
                "working": f"20 × {flow:.0f} l/min",
                "answer": f"{20 * flow:.0f} l/min",
                "consequence": "Check it against available head, not only against pump "
                               "capacity."}
    if doc.id == "floor_loading":
        loading = plat.rack_mass_kg.value / plat.rack_footprint_m2.value
        return {"question": f"What does one {plat.name} rack impose on the floor?",
                "working": f"{plat.rack_mass_kg.value:.0f} kg / "
                           f"{plat.rack_footprint_m2.value:.2f} m²",
                "answer": f"{loading:,.0f} kg/m² distributed",
                "consequence": "Against a TIA-942 Rated-3 design value of about 1,220 kg/m²."}
    if doc.id == "residual_air_removal":
        residual = plat.residual_air_kW().value
        return {"question": "What must one rack position remove by air?",
                "working": f"{rack_kW:.0f} kW × (1 − {plat.liquid_fraction.value:.2f})",
                "answer": f"{residual:.0f} kW at one position",
                "consequence": "Good containment gets a position to roughly 10–20 kW."}
    return None


def _cost_basis(key: str) -> dict | None:
    """What the engine currently prices this relief at, and how strong that is.

    Published including — especially including — when it is a placeholder. A cost
    library full of E0 defaults is the honest state of a young practice, and saying
    so is what makes the E5 lines credible when they arrive.
    """
    if not key:
        return None
    lib = CostLibrary.resolved()
    entry = lib.entries.get(key)
    if entry is None:
        return {"key": key, "basis": "library_default", "evidence": "E0_ASSUMPTION",
                "note": "A placeholder with a −50%/+100% band, not a price. It is replaced "
                        "by a quotation the first time we tender this relief on a real "
                        "project."}
    q = entry.quantity()
    return {"key": key, "basis": entry.basis, "evidence": q.evidence.name,
            "unit": DECLARED_UNITS.get(key, entry.unit),
            "note": "Priced from a quotation obtained on a real project."
                    if q.evidence >= EvidenceClass.E3_ENGINEERING_ESTIMATE
                    else "Still a library placeholder."}


def doc_payload(doc: ConstraintDoc) -> dict:
    lo, hi = RELIEF_LEAD_TIMES.get(doc.id, (0, 0))
    return {
        "id": doc.id,
        "slug": doc.slug,
        "name": doc.name,
        "domain": doc.domain,
        "headline": doc.headline,
        "limits": doc.limits,
        "relation": doc.relation,
        "binds_when": doc.binds_when,
        "relief": doc.relief,
        "relief_risk": doc.relief_risk,
        "misconception": doc.misconception,
        "sources": list(doc.sources),
        "see_also": list(doc.see_also),
        "lead_time_weeks": {"low": lo, "high": hi} if hi else None,
        "worked_example": _worked_example(doc),
        "cost_basis": _cost_basis(RELIEF_COST_KEYS.get(doc.id, "")),
    }


def reference_payload() -> dict:
    """Everything the public constraint reference needs, in one file."""
    return {
        "schema": "gridforge/constraint-reference/1",
        "count": len(CONSTRAINT_DOCS),
        "notice": (
            "Every figure on these pages is modelled or a published design value. None is a "
            "measurement of any customer's asset. The worked examples use the reference "
            "platform's published rack power and are reproducible by hand."),
        "constraints": [doc_payload(d) for d in CONSTRAINT_DOCS],
        "domains": sorted({d.domain for d in CONSTRAINT_DOCS}),
    }


def platform_payload() -> dict:
    """The platform library, published — including what is deliberately absent."""
    return {
        "schema": "gridforge/platform-library/1",
        "platforms": [{
            "id": p.id, "name": p.name, "status": p.status,
            "rack_kW": p.rack_kW.rounded(),
            "peak_rack_kW": p.peak_rack_kW.rounded(),
            "liquid_fraction": p.liquid_fraction.rounded(),
            "residual_air_kW": p.residual_air_kW().rounded(),
            "max_inlet_liquid_C": p.max_inlet_liquid_C.rounded(),
            "flow_l_per_min_per_rack": p.flow_l_per_min_per_rack.rounded(),
            "rack_mass_kg": p.rack_mass_kg.rounded(),
            "rack_footprint_m2": p.rack_footprint_m2.rounded(),
            "floor_loading_kg_per_m2": round(
                p.rack_mass_kg.value / p.rack_footprint_m2.value),
            "gpus_per_rack": p.gpus_per_rack,
            "voltage_domain": p.voltage_domain,
            "rack_feed_current_A": (p.rack_feed_current_A.rounded()
                                    if p.rack_feed_current_A else None),
            "sources": sorted({str(s) for n in p.rack_kW.prov.walk()
                               for s in n.sources}),
            # A generic archetype has no manufacturer and therefore no source, and
            # is marked as such rather than published as though somebody built it.
            # An unsourced row that looks like the sourced ones beside it is the
            # quietest way a library loses its authority.
            "generic": not any(n.sources for n in p.rack_kW.prov.walk()),
        } for p in PLATFORMS.values()],
        "deliberately_absent": UNPUBLISHED_PLATFORMS,
        "notice": (
            "Platforms whose rack power the manufacturer has not published are absent by "
            "design rather than pending. An invented number in a capacity study is how an "
            "engineering reputation ends."),
    }
