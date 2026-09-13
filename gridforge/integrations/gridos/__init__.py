"""GridOS-derived capabilities.

Status after the repository audit (docs/06): GridOS is the real engineering asset
of the four repositories - ~13k lines of tested, CI-covered, MIT-licensed Python
with a value-stacked dispatch MILP, forecasting, a receding-horizon controller and
an ROI backtest. It is consumed here through a port, lazily, never migrated.

What is wired: `adapter.GridOSEnergyValue` (EnergyValueModel) and
`adapter.firm_capacity_from_duration`, which needs no GridOS import at all.

What stays dormant: telemetry representation, digital-twin state, grid-state
models and visualisation. Those wait for a customer-facing workflow that pays
for them.
"""
from ..ports import EnergyValueModel, NotWired, TelemetrySource  # noqa: F401
from .adapter import (GRIDOS_SOURCE, GridOSEnergyValue, SiteEnergyProfile,  # noqa: F401
                      firm_capacity_from_duration, gridos_available)

EXTRACTION_CANDIDATES = [
    "economic dispatch (value-stacked: arbitrage + demand charge + degradation) — WIRED",
    "ROI backtest, baseline vs optimised — WIRED",
    "firm capacity from storage duration — WIRED (no GridOS import needed)",
    "load and solar forecasting — candidate, not yet needed by a paid workflow",
    "receding-horizon control (MPC) — operations, not feasibility; out of scope for a study",
    "telemetry representation / digital twin / grid state — dormant",
]
