"""Thermal library defaults. See docs/02_ENGINEERING_REFERENCE §4-§7."""
from __future__ import annotations

from ..common import ASSUMED, V
from ..validation import Quantity, Source
from .schema import Architecture

_OCP = Source("OCP Water-Based Transfer Fluids Guidelines", 2025)
_VERTIV_PUE = Source("Vertiv, quantifying PUE when introducing liquid cooling (modelled)", 2023, vendor=True)
_UPTIME_PUE = Source("Uptime Institute Global Survey", 2025)

# Operating TCS supply temperature actually specified by operators for 500-700 W parts.
TCS_SUPPLY_DESIGN_C = V(30, "degC", "TCS supply temperature design point", ASSUMED, band=(27, 32),
                        sources=[Source("DCD, hot water cold water", 2024)],
                        assumptions=["Operators specify 27-30 degC for 500-700 W parts; "
                                     "the W45 equipment rating is not an operating point"])

CDU_L2L_APPROACH_K = V(5.0, "K", "CDU liquid-to-liquid approach temperature", ASSUMED, band=(4, 6),
                       sources=[Source("Vertiv CoolChip CDU / CoolIT CHx2000 ratings", 2026, vendor=True)],
                       assumptions=["Vendor ratings are stated AT this approach; derate for site FWS temperature"])

# REFERENCE-ONLY. No constraint reads this constant. hydraulic_flow divides the plant's pumped flow by the PLATFORM's own library
# flow per rack (compute/library.py: 130 l/min for a 135 kW GB300 rack = 0.963 l/min/kW of rack power, which implies a TCS delta-T of
# about 13.4 K on the liquid-captured load, not the 10 K behind this 1.45 figure). The intake loader and examples/reference_site.py
# copy the same 1.45 into ThermalInput.flow_l_per_min_per_kW, which is likewise never read. Kept as the documented 10 K screening
# reference (tests/test_physics_equations.py checks it against Q = m_dot cp dT); changing which figure the constraint uses would
# change customer-visible rack counts and is the owner's decision (docs/EXECUTION_STATE.md).
FLOW_L_PER_MIN_PER_KW = V(1.45, "l/min/kW", "TCS flow per kW at 10 K delta-T", ASSUMED,
                          band=(1.4, 1.5),
                          sources=[Source("Chilldyne 500 kW design study (calculated)", 2025, vendor=True)],
                          assumptions=["Reference only: no constraint uses this figure; hydraulic_flow uses the platform's own "
                                       "flow per rack"])

#: Water properties for the delta-T a flow implies, Q[l/min] = P[kW] x 60 / (rho x cp x dT). Used only to DISCLOSE the delta-T
#: behind the platform flow in the hydraulic_flow basis; no limit is computed from them.
WATER_DENSITY_KG_PER_L = 0.997
WATER_CP_KJ_PER_KG_K = 4.19


def implied_delta_T_K(heat_kW: float, flow_l_per_min: float) -> float:
    """The water temperature rise that carries ``heat_kW`` at ``flow_l_per_min`` (dT = P x 60 / (Q x rho x cp)); 0 if no flow."""
    if flow_l_per_min <= 0:
        return 0.0
    return heat_kW * 60.0 / (flow_l_per_min * WATER_DENSITY_KG_PER_L * WATER_CP_KJ_PER_KG_K)


#: The smallest CDU approach (K) the loader accepts, for the TCS-side figure and for a CDU's rating. A liquid-to-liquid heat exchanger moves
#: heat only across a finite temperature difference; vendor ratings are 4-5 K (docs/02 §4) and none is published near zero. An input
#: sanity bound in the manner of RDHX_MAX_CREDIBLE_kW, not a product claim: it catches a zero, a unit slip or a missing digit.
MIN_APPROACH_K = 1.0


def heat_carried_kW(flow_l_per_min: float, delta_T_K: float) -> float:
    """The heat water carries at ``flow_l_per_min`` over ``delta_T_K`` (P = Q x rho x cp x dT / 60); the inverse of ``implied_delta_T_K``."""
    return flow_l_per_min * WATER_DENSITY_KG_PER_L * WATER_CP_KJ_PER_KG_K * delta_T_K / 60.0


#: Thermal intake figures that are accepted and parsed but that NO constraint limit reads, with what each is used for instead. The loader
#: warns, per field, when the client declares one (an input that changes no answer must not look as if it did). The list is derived from
#: what the constraints actually read (grep of ``ctx.thermal`` / ``ctx.site`` in thermal/, site/ and power/ constraints, 2026-11) and is
#: held to it by tests/test_thermal_integrity.py, which perturbs each field across every shipped intake and architecture and checks that no
#: constraint moves, and that every OTHER thermal figure does move something.
UNREAD_THERMAL_INPUTS: dict[str, str] = {
    "thermal.plant.available_head_kPa": (
        "pump head and pressure drop are not modelled; the figure is printed in the procurement specification as the duty point the "
        "supplier must confirm"),
    "thermal.plant.free_cooling_hours_per_year": (
        "free-cooling hours are not modelled (PUE is a fixed library figure per architecture); the figure appears in the procurement "
        "specification only"),
    "thermal.plant.design_return_C": (
        "the return temperature is read only to state the plant delta-T beside the hydraulic_flow basis and to check that it is above "
        "supply; flows are not converted by delta-T"),
    "site.design_wetbulb_C": (
        "the wet-bulb temperature is not modelled (dry coolers are taken to dry bulb); the figure appears in the procurement "
        "specification's site conditions only"),
}

#: Every key the loader reads under the thermal sections. Anything else declared there is not an input of this engine and is said to be
#: ignored (a pump-redundancy key, a hot-day derate, a water-availability flag ...). A test holds this to the loader's own reads.
KNOWN_THERMAL_KEYS: dict[str, frozenset[str]] = {
    "thermal": frozenset({"plant", "tcs_target_supply_C", "cdu_approach_K", "residual_air_capacity_kW_per_rack", "cdus", "rdhx"}),
    "thermal.plant": frozenset({"id", "chilled_water_capacity_kW", "design_supply_C", "design_return_C", "pump_flow_capacity_l_per_min",
                                "available_head_kPa", "free_cooling_hours_per_year", "existing_flow_l_per_min",
                                "existing_non_it_heat_kW", "dry_cooler_capacity_kW"}),
    "thermal.cdus": frozenset({"id", "rated_capacity_kW", "rated_approach_K", "rated_flow_l_per_min", "units", "redundancy"}),
    "thermal.rdhx": frozenset({"capacity_kW_per_rack"}),
}

#: Words that mark a site or hall key as a cooling / water input (a flag the engine does not read), so a declared one is said to be ignored
#: without warning about every unrelated key a form may send.
COOLING_KEY_WORDS = ("water", "wue", "cool", "chill", "pump", "thermal", "humid", "redundan")

RESIDUAL_AIR_CAPACITY_LEGACY_kW = V(8.0, "kW", "legacy hall air removal capacity per rack position",
                                    ASSUMED, band=(6, 12),
                                    assumptions=["European colo built 2010-2020 designed 8-20 kW/rack; "
                                                 "per-position air capacity assumed at the low end for a "
                                                 "hall at full occupancy"])

# PUE by architecture. The 1.05-1.15 DLC figure in vendor material is unproven
# (docs/02 §9 item 10); we use a defensible design band instead.
#
# These are FIXED annual-average constants per architecture, divided into peak firm-supply headroom (power/constraints.py). They do
# not respond to the site's dry-bulb or wet-bulb design temperature, free-cooling hours, the achievable water temperature, or a trim
# chiller's power; only the architecture selects the figure (scenario/run.py). The wide bands are the only allowance for climate.
PUE_FIXED_NOTE = ("PUE is a fixed library figure for the cooling architecture; it is not recomputed for this site's climate, "
                  "free-cooling hours or achievable water temperature, so the IT headroom it divides into is not climate-adjusted")

PUE_BY_ARCHITECTURE: dict[Architecture, Quantity] = {
    Architecture.RETAINED_AIR: V(1.45, "1", "PUE, retained air architecture", ASSUMED, band=(1.35, 1.60),
                                 sources=[_UPTIME_PUE], assumptions=[PUE_FIXED_NOTE]),
    Architecture.RDHX: V(1.35, "1", "PUE, rear-door heat exchanger architecture", ASSUMED, band=(1.28, 1.45),
                         sources=[_UPTIME_PUE], assumptions=[PUE_FIXED_NOTE]),
    Architecture.HYBRID_DLC: V(1.30, "1", "PUE, hybrid DLC on legacy plant", ASSUMED, band=(1.22, 1.40),
                               sources=[_VERTIV_PUE],
                               assumptions=["Legacy low-temperature plant retained for residual air load, "
                                            "so free-cooling benefit is largely forgone", PUE_FIXED_NOTE]),
    Architecture.FULL_DLC: V(1.20, "1", "PUE, full DLC with high-temperature loop", ASSUMED, band=(1.15, 1.28),
                             sources=[_VERTIV_PUE],
                             assumptions=["Vendor claims of 1.05-1.15 are unproven; 1.15-1.25 used for design "
                                          "per docs/02 §7", PUE_FIXED_NOTE]),
}

# Practical per-rack capability of each architecture (docs/02 §3).
ARCH_RACK_CAPABILITY_kW: dict[Architecture, Quantity] = {
    Architecture.RETAINED_AIR: V(22, "kW", "practical per-rack limit, contained air", ASSUMED, band=(15, 25)),
    Architecture.RDHX: V(60, "kW", "practical per-rack limit, rear-door heat exchanger", ASSUMED, band=(20, 80)),
    Architecture.HYBRID_DLC: V(142, "kW", "practical per-rack limit, DLC on retained plant", ASSUMED, band=(100, 150)),
    Architecture.FULL_DLC: V(150, "kW", "practical per-rack limit, full DLC", ASSUMED, band=(120, 160)),
}

TCS_WATER_QUALITY = {
    "conductivity_uS_per_cm_max": 1500,
    "pH_range": (8.0, 10.5),
    "tss_ppm_max": 5,
    "sidestream_filtration_um": 5,
    "inline_filtration_um": 50,
    "azole_inhibitor_ppm_min": 100,
    "_source": str(_OCP),
}
