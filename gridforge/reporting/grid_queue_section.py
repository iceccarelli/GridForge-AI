"""The report section that sets measured queue history beside a grid wait the document does not date.

Pure formatting of a `gridforge.context.grid_queue.context(...)` result into report blocks. It adds no number of its own: every figure it
prints is copied from that result. It is prose by design: these are external statistics, not model outputs, so they carry no evidence class
of their own and the section says in so many words that it is context, not an input to anything else in the document.
"""
from __future__ import annotations

from typing import Any

from .model import Bullets, Callout, Para, Section

MONTHS_PER_YEAR = 12


def _months(years: float) -> int:
    return round(years * MONTHS_PER_YEAR)


def section(ctx: dict[str, Any], heading: str) -> Section:
    o, a = ctx["observed"], ctx["applicability"]
    s = Section(heading)
    s.blocks.append(Para(
        "This document does not date grid reinforcement: a connection date needs the network operator's written offer. For scale only, here "
        "is what has been observed elsewhere. It is an external statistic, not a model output, and it is not an input to any figure in this "
        "document."))
    items = [
        f"US generation and storage requests that reached commercial operation took a median of {_months(o['median_years'])} months from "
        f"request to operation (middle half {_months(o['p25_years'])}-{_months(o['p75_years'])} months), across {o['n']} projects "
        f"({o['name']}). Source: Lawrence Berkeley National Laboratory, Queued Up 2026 edition, {ctx['source']['licence']}.",
    ]
    surv = ctx.get("survivorship")
    if surv:
        lo, hi = surv["entry_years"]
        items.append(
            f"Only {surv['share_operational_of_entered']:.0%} of the {surv['entered']} requests that entered a queue in {lo}-{hi} reached "
            f"operation ({surv['withdrawn']} were withdrawn, {surv['unresolved']} unresolved). The figure above describes only the requests "
            "that did.")
    items.append(
        "The site is in the same country as the observed data." if a["level"] == "same_country_context" else
        "The site is not in the observed data's country, or none is declared, so treat this as a scale reference only.")
    cmp = ctx.get("comparison")
    if cmp:
        items.append(
            f"The grid-reinforcement wait this document assumes is {cmp['assumed_weeks']:.0f} weeks (evidence class "
            f"{cmp['assumed_evidence_class'].split('_', 1)[0]}); it sits {cmp['position_of_assumption'].replace('_', ' ')} of that observed "
            f"distribution ({cmp['assumed_over_observed_median']}x the observed median). Its evidence class is unchanged by this comparison. "
            "The two measure different processes (a generation interconnection request, and the grid reinforcement this hall needs), so "
            "treat this as a prompt to ask the network operator, not as a correction of the assumption.")
    s.blocks.append(Bullets(items))
    s.blocks.append(Callout(
        "note",
        "Context only: this is not a connection time for a load or a data centre, it says nothing about this site's network operator, tariff or "
        "study status, and it changes no figure, date or evidence class in this document."))
    return s
