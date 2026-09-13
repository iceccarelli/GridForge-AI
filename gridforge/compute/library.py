"""GPU platform library. Seeded from docs/02_ENGINEERING_REFERENCE.

EVERY entry here is E0 (assumption / library default) unless it has been
independently corroborated. Vendor figures carry Source(vendor=True), which the
report renderer surfaces and which can never on its own lift a claim above E0.
Platforms whose rack power is NOT published are deliberately absent — see
docs/02 §9. Do not add them to win a sales meeting.
"""
from __future__ import annotations

from ..common import ASSUMED, V
from ..validation import Source
from .schema import GPUPlatform

_QCT = Source("QCT QoolRack GB200 NVL72 technical brief", 2025, vendor=True)
_LENOVO = Source("Lenovo Press LP2357, GB300 NVL72", 2026, vendor=True)
_NVIDIA_RA = Source("NVIDIA NVL72 AI Factory Reference Architecture", 2026, vendor=True)
_UPTIME = Source("Uptime Intelligence, AI and cooling methods and capacities", 2025)

GB200_NVL72 = GPUPlatform(
    id="gb200_nvl72",
    name="NVIDIA GB200 NVL72",
    status="shipping",
    rack_kW=V(132, "kW", "GB200 NVL72 rack total TDP", ASSUMED, band=(120, 132), sources=[_QCT]),
    peak_rack_kW=V(132, "kW", "GB200 NVL72 peak rack power", ASSUMED, sources=[_QCT]),
    liquid_fraction=V(0.87, "1", "GB200 NVL72 liquid heat capture fraction", ASSUMED,
                      band=(0.80, 0.90), sources=[_QCT, _UPTIME],
                      assumptions=["Residual air load assumed rejected by existing room cooling"]),
    max_inlet_liquid_C=V(45, "degC", "GB200 max liquid inlet temperature", ASSUMED, sources=[_QCT]),
    flow_l_per_min_per_rack=V(125, "l/min", "GB200 NVL72 rack flow", ASSUMED, band=(120, 130), sources=[_QCT]),
    rack_mass_kg=V(1360, "kg", "GB200 NVL72 rack mass", ASSUMED, band=0.05,
                   sources=[Source("The Register, DGX GB200 NVL72", 2024)]),
    rack_footprint_m2=V(0.72, "m2", "rack footprint 0.6 x 1.2 m", ASSUMED),
    gpus_per_rack=72,
    voltage_domain="415/480 VAC -> 48 VDC busbar",
    rack_feed_current_A=V(200, "A", "assumed rack feed current at 400 V 3ph", ASSUMED, band=0.15,
                          assumptions=["Derived from rack kW at 400 V three-phase, 0.99 PF; confirm against OEM drawing"]),
)

GB300_NVL72 = GPUPlatform(
    id="gb300_nvl72",
    name="NVIDIA GB300 NVL72",
    status="shipping",
    rack_kW=V(135, "kW", "GB300 NVL72 rack TDP", ASSUMED, band=(132, 142), sources=[_LENOVO, _NVIDIA_RA]),
    peak_rack_kW=V(155, "kW", "GB300 NVL72 peak rack power", ASSUMED, sources=[_LENOVO]),
    liquid_fraction=V(0.90, "1", "GB300 NVL72 liquid heat capture fraction", ASSUMED,
                      band=(0.85, 0.92), sources=[_LENOVO],
                      assumptions=["Cold plates on CPU/GPU/HBM/NVSwitch; residual air load must still be removed"]),
    max_inlet_liquid_C=V(45, "degC", "GB300 max liquid inlet (ASHRAE W45 survival rating)", ASSUMED,
                         sources=[_LENOVO],
                         assumptions=["W45 is an equipment survival rating, NOT an operating point. "
                                      "Design TCS supply at 27-32 degC (docs/02 §4)."]),
    flow_l_per_min_per_rack=V(130, "l/min", "GB300 NVL72 rack flow", ASSUMED, band=(120, 140), sources=[_LENOVO]),
    rack_mass_kg=V(1400, "kg", "GB300 NVL72 rack mass", ASSUMED, band=0.08,
                   assumptions=["Extrapolated from GB200; obtain OEM rack drawing before structural sign-off"]),
    rack_footprint_m2=V(0.72, "m2", "rack footprint 0.6 x 1.2 m", ASSUMED),
    gpus_per_rack=72,
    voltage_domain="200-277 VAC in, 50 VDC out, 6-8 x 33 kW shelves",
    rack_feed_current_A=V(205, "A", "assumed rack feed current at 400 V 3ph", ASSUMED, band=0.15,
                          assumptions=["Derived from rack kW at 400 V three-phase; confirm against OEM drawing"]),
)

GENERIC_DLC_50 = GPUPlatform(
    id="generic_dlc_50",
    name="Generic DLC server rack, 50 kW",
    status="shipping",
    rack_kW=V(50, "kW", "generic DLC rack power", ASSUMED, band=0.1),
    peak_rack_kW=V(55, "kW", "generic DLC peak rack power", ASSUMED),
    liquid_fraction=V(0.75, "1", "generic DLC liquid capture fraction", ASSUMED, band=(0.70, 0.80),
                      sources=[_UPTIME]),
    max_inlet_liquid_C=V(40, "degC", "generic DLC max inlet", ASSUMED),
    flow_l_per_min_per_rack=V(72, "l/min", "generic DLC rack flow at 1.44 l/min/kW", ASSUMED, band=0.1),
    rack_mass_kg=V(900, "kg", "generic DLC rack mass", ASSUMED, band=0.15),
    rack_footprint_m2=V(0.72, "m2", "rack footprint 0.6 x 1.2 m", ASSUMED),
    gpus_per_rack=32,
    voltage_domain="400 VAC 3ph",
    rack_feed_current_A=V(76, "A", "generic DLC rack feed current", ASSUMED, band=0.15),
)

PLATFORMS = {p.id: p for p in (GB200_NVL72, GB300_NVL72, GENERIC_DLC_50)}

# Deliberately NOT in the library (docs/02 §9): Vera Rubin NVL144 / VR200,
# Rubin Ultra NVL576, AMD Helios MI450. Rack power is not published. Adding an
# estimate here would put an unsourced number into a paid deliverable.
UNPUBLISHED_PLATFORMS = {
    "vr200_nvl144": "NVIDIA has not published rack power. Third-party estimates 190-230 kW are unverified.",
    "rubin_ultra_nvl576": "~600 kW is a stated target from GTC reporting, not a specification.",
    "amd_helios_mi450": "AMD has not published rack-level power for MI450/MI455X.",
}


def get_platform(platform_id: str) -> GPUPlatform:
    if platform_id in UNPUBLISHED_PLATFORMS:
        raise ValueError(
            f"{platform_id}: {UNPUBLISHED_PLATFORMS[platform_id]} "
            "Refusing to supply a number for paid engineering work."
        )
    return PLATFORMS[platform_id]
