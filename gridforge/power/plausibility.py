"""Plausibility of an intake: findings about inputs that cannot describe a working site.

An input set can be perfectly valid and still impossible: a 1 MVA connection carrying a 40 MW hall. The engine then
reports 0 deployable racks with nothing to say about why, which reads as a real answer about the hall rather than as
a question about the inputs (most often a MW/MVA/kW unit slip). These findings are warnings, never corrections: no
input is changed and no number is invented.
"""
from __future__ import annotations


def plausibility_findings(ctx) -> list[str]:
    """Warnings about the inputs in ``ctx`` (an EnvelopeContext), in the words a report prints. Empty when none."""
    out: list[str] = []
    g = ctx.power.grid
    firm_MW = g.firm_capacity_MVA.value * g.power_factor.value
    ceiling_MW = min(firm_MW, g.contracted_MW.value)
    it_MW = ctx.power.current_it_load_MW.value
    peak_MW = g.current_site_peak_MW.value
    if it_MW > ceiling_MW:
        out.append(
            f"The firm supply ceiling ({ceiling_MW:,.2f} MW: the lesser of the firm connection "
            f"{g.firm_capacity_MVA.value:,.2f} MVA x {g.power_factor.value:.2f} and the contracted "
            f"{g.contracted_MW.value:,.2f} MW) cannot cover the current IT load ({it_MW:,.2f} MW). No hall can "
            f"run on that supply, so the zero headroom below says the inputs disagree with each other, not that "
            f"the hall is full. Check the units (MW, MVA, kW) before relying on this result.")
    elif peak_MW > ceiling_MW:
        out.append(
            f"The firm supply ceiling ({ceiling_MW:,.2f} MW) cannot cover the current site peak "
            f"({peak_MW:,.2f} MW). The connection is already overdrawn on the inputs given, so the zero "
            f"headroom below says the inputs disagree with each other. Check the units (MW, MVA, kW) before "
            f"relying on this result.")
    return out


def intake_warnings(intake) -> list[str]:
    """The intake's own warnings followed by the plausibility findings (each once)."""
    out = list(intake.report.warnings)
    for w in plausibility_findings(intake.context):
        if w not in out:
            out.append(w)
    return out
