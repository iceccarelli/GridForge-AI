"""The report section that sets EIA's published average electricity price beside the price the document used.

Pure formatting of a `gridforge.context.energy_price.context(...)` result into report blocks. It adds no number of its own: every figure it
prints is copied from that result, in its own currency, and nothing is converted. It is prose by design: these are external statistics, not
model outputs, so they carry no evidence class and the section says in so many words that it is context, not an input to any figure here.
"""
from __future__ import annotations

from typing import Any

from .model import Bullets, Callout, Para, Section


def _price(sector: dict[str, Any] | None) -> str:
    return f"{sector['usd_per_MWh']:,.1f} US dollars per MWh" if sector else "no published figure"


def section(ctx: dict[str, Any], heading: str) -> Section:
    o, a, src = ctx["observed"], ctx["applicability"], ctx["source"]
    s = Section(heading)
    s.blocks.append(Para(
        "This document prices energy at the figure stated in its economics. For scale only, here is what has been published about what "
        "customers actually paid. It is an external statistic, not a model output, and it is not an input to any figure in this document."))
    items = [
        f"{o['area']}, {o['period']}: industrial customers paid {_price(o['sectors'].get('industrial'))} on average and commercial "
        f"customers {_price(o['sectors'].get('commercial'))}. Source: {src['name']}, released {src['release_date']}.",
        "These are averages over every customer in the sector for one month, delivery included, and the latest month is preliminary. They are "
        "not a data-centre price, not a tariff this site would be offered, and not a forecast.",
        "The site is in the United States; the figure is the state or national average for the sector." if a["level"] == "same_country_context"
        else "The site is not stated to be in the United States, so a US average is a scale reference at most.",
    ]
    assumed = ctx.get("assumed")
    if assumed:
        items.append(
            f"This document uses {assumed['eur_per_MWh']:,.0f} euros per MWh ({assumed['source']}). The two figures are in different "
            "currencies and are not converted here; convert at your own rate before comparing. Its evidence class is unchanged by this "
            "comparison.")
    s.blocks.append(Bullets(items))
    s.blocks.append(Callout(
        "note",
        "Context only: this is not the tariff for this site and it changes no figure, cost or evidence class in this document. The contracted "
        "tariff, once known, replaces the price used here."))
    return s
