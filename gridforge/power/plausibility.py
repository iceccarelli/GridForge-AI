"""Plausibility of an intake: findings about inputs that cannot describe a working site.

An input set can be perfectly valid and still impossible: a 1 MVA connection carrying a 40 MW hall. The engine then
reports 0 deployable racks with nothing to say about why, which reads as a real answer about the hall rather than as
a question about the inputs (most often a MW/MVA/kW unit slip). These findings are warnings, never corrections: no
input is changed and no number is invented.
"""
from __future__ import annotations

from ..numerics import leq


#: Relative slack before contracted power counts as exceeding the firm connection: float noise, not an engineering allowance.
_TOLERANCE = 1e-6


def _exceeds(a: float, b: float) -> bool:
    """``a`` is genuinely larger than ``b``: larger, and not merely larger by the float noise of the arithmetic that produced one of them
    (``numerics.leq``). A NaN is never "larger" (no finding is raised on an undetermined figure, as before)."""
    return a > b and not leq(a, b)


def plausibility_findings(ctx) -> list[str]:
    """Warnings about the inputs in ``ctx`` (an EnvelopeContext), in the words a report prints. Empty when none."""
    out: list[str] = []
    g = ctx.power.grid
    firm_MW = g.firm_capacity_MVA.value * g.power_factor.value
    ceiling_MW = min(firm_MW, g.contracted_MW.value)
    it_MW = ctx.power.current_it_load_MW.value
    peak_MW = g.current_site_peak_MW.value
    if g.contracted_MW.value > firm_MW * (1 + _TOLERANCE):
        # Not an impossibility: a contract can name more than the connection can carry (non-firm or interruptible capacity, a different
        # metering point, a unit slip). It is an input discrepancy the operator must settle, so it is stated, never silently resolved.
        out.append(
            f"The contracted capacity ({g.contracted_MW.value:,.2f} MW) is more than the firm connection can deliver "
            f"({g.firm_capacity_MVA.value:,.2f} MVA x {g.power_factor.value:.2f} = {firm_MW:,.2f} MW). The model uses the lesser, "
            f"{ceiling_MW:,.2f} MW, so the extra contracted capacity adds nothing here. One of the two figures may be wrong or in "
            f"the wrong unit (MW, MVA, kW), or the contract may include capacity that is not firm. Confirm with the network operator "
            f"which figure is the firm entitlement before relying on this result.")
    # leq, not >: the ceiling is a product (18 MVA x 0.95 is 17.099999999999998), so a site peak declared as exactly 17.1 MW is AT the
    # ceiling, not over it; saying the connection is overdrawn would be a false finding about the customer's own figures.
    if _exceeds(it_MW, ceiling_MW):
        out.append(
            f"The firm supply ceiling ({ceiling_MW:,.2f} MW: the lesser of the firm connection "
            f"{g.firm_capacity_MVA.value:,.2f} MVA x {g.power_factor.value:.2f} and the contracted "
            f"{g.contracted_MW.value:,.2f} MW) cannot cover the current IT load ({it_MW:,.2f} MW). No hall can "
            f"run on that supply, so the zero headroom below says the inputs disagree with each other, not that "
            f"the hall is full. Check the units (MW, MVA, kW) before relying on this result.")
    elif _exceeds(peak_MW, ceiling_MW):
        out.append(
            f"The firm supply ceiling ({ceiling_MW:,.2f} MW) cannot cover the current site peak "
            f"({peak_MW:,.2f} MW). The connection is already overdrawn on the inputs given, so the zero "
            f"headroom below says the inputs disagree with each other. Check the units (MW, MVA, kW) before "
            f"relying on this result.")
    if _exceeds(it_MW, peak_MW):
        out.append(
            f"The current site peak ({peak_MW:,.2f} MW) is below the current IT load ({it_MW:,.2f} MW), but the IT load is part of the "
            f"site peak, so one of the two figures is wrong or in the wrong unit (MW, MVA, kW), or one is a design value and the other a "
            f"metered one. Supply headroom is taken from the peak, so a peak that is too low frees supply that does not exist and "
            f"overstates the racks the grid can carry. Confirm both figures from the same metering period before relying on this result.")
    return out


def defaulted_date_findings(intake) -> list[str]:
    """A date that rests on a lead time the client never supplied must say so wherever the date is shown. The engine
    treats every lead time as an assumption (E0); an omitted transformer lead time is a library placeholder, and the
    result otherwise looks the same as one the client declared."""
    if any(g.path == "transformers.replacement_lead_time_weeks" for g in intake.report.gaps):
        return ["The transformer replacement lead time was not supplied: a library placeholder of 160 weeks "
                "(band 80-210) is used, and it can set the date. It is not a manufacturer's quote or a delivery "
                "commitment. Supply a written lead time to replace it."]
    if intake.report.supplied and "transformers.replacement_lead_time_weeks" in intake.report.supplied:
        return ["The transformer lead time is customer-supplied (unverified): it is used as typed, with a generic "
                "+-35% band around it, and the engine still classes it E0 (an assumption): the engine cannot check a figure against a "
                "written manufacturer quotation, so it stays an assumption until that quotation is reviewed. It is not a delivery commitment."]
    return []


def intake_warnings(intake) -> list[str]:
    """The intake's own warnings followed by the plausibility findings (each once)."""
    out = list(intake.report.warnings)
    for w in plausibility_findings(intake.context):
        if w not in out:
            out.append(w)
    return out
