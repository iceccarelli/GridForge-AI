"""Measured US retail electricity prices beside the engine's own electricity price, as context only.

Without a contracted tariff the economics use a library placeholder of 140 EUR/MWh (evidence class E0, band 90-220). A buyer asking "is that
a sensible number?" is left with a figure nobody can check. This module sets the U.S. Energy Information Administration's published average
price for the site's state and sector beside it.

`data/retail_price_context.json` is a copy of the fixture the independent gridforge-stress harness parsed from EIA's Electric Power Monthly,
Table 5.6.A (Form EIA-861M).

CONTEXT ONLY, by construction. It never changes a price, a cost or an evidence class in the response it sits in. It is the average over every
customer in a sector and state for ONE month, delivery included: not a data-centre price, not the tariff a load would be offered, not a
forecast. EIA reports US cents per kWh and the engine works in EUR/MWh; no exchange rate is supplied, so the two are shown in their own
currencies and not converted. A declared contracted tariff is reported back unchanged and always outranks this statistic.
"""
from __future__ import annotations

import functools
import json
from pathlib import Path
from typing import Any

SCHEMA = "gridforge/retail-price-context/1"
SOURCE_SCHEMA = "gridforge-stress/price-context/1"
DATA_FILE = Path(__file__).resolve().parents[1] / "data" / "retail_price_context.json"
US_NAMES = frozenset({"US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"})
US_TOTAL = "U.S. Total"
USD_PER_MWH_PER_CENT_PER_KWH = 10.0  # 1 US cent/kWh = 10 US dollars/MWh, exactly
#: EIA's census-division and region rows share the table with the states; a site is in a state, so only states (and the US total) are offered.
DIVISIONS = frozenset({
    "New England", "Middle Atlantic", "East North Central", "West North Central", "South Atlantic", "East South Central",
    "West South Central", "Mountain", "Pacific Contiguous", "Pacific Noncontiguous",
})

MUST_NOT_CLAIM = (
    "that the published average is the price this load would be offered or would pay",
    "that the assumed or declared electricity price is validated, confirmed or changed in evidence class by this comparison",
    "that one month is a year of prices, or a forecast of any later month",
    "that a US cents-per-kWh statistic converts to EUR/MWh at any particular exchange rate",
)


class PriceContextError(ValueError):
    """The context cannot be produced without guessing; the message says what to change."""


@functools.lru_cache(maxsize=1)
def _doc() -> dict[str, Any]:
    doc: dict[str, Any] = json.loads(DATA_FILE.read_text())
    if doc.get("schema") != SOURCE_SCHEMA:
        raise PriceContextError("unrecognised retail-price data schema")
    if US_TOTAL not in doc["rows"]:
        raise PriceContextError("retail-price data carries no US total")
    return doc


def states() -> tuple[str, ...]:
    """The names a request may ask for: US states and the District of Columbia, as EIA spells them."""
    return tuple(sorted(n for n in _doc()["rows"] if n != US_TOTAL and n not in DIVISIONS))


def _is_us(country: Any) -> bool:
    return isinstance(country, str) and country.strip().upper() in US_NAMES


def _sector(row: dict[str, Any], name: str) -> dict[str, Any] | None:
    cur, prior = row[name]["current"], row[name]["prior"]
    if cur is None:
        return None
    return {
        "usd_per_MWh": round(cur * USD_PER_MWH_PER_CENT_PER_KWH, 1),
        "cents_per_kWh": cur,
        "same_month_prior_year_cents_per_kWh": prior,
    }


def context(*, state: str | None = None, country: Any = None, assumed_eur_per_mwh: float | None = None,
            declared: bool = False) -> dict[str, Any]:
    """The published commercial and industrial prices for `state` (or the US total), with the limits.

    `assumed_eur_per_mwh` is the engine's electricity price as used; `declared` says whether it came from the buyer's own tariff rather than
    the library placeholder. It is reported back unchanged and never converted.
    """
    doc = _doc()
    if state is not None and state not in states():
        raise PriceContextError(f"unknown electricity_price_state {state!r}; known: {', '.join(states())}")
    name = state or US_TOTAL
    row = doc["rows"][name]
    sectors = {s: _sector(row, s) for s in ("commercial", "industrial")}
    if not any(sectors.values()):
        raise PriceContextError(f"EIA publishes no commercial or industrial price for {name!r} in {doc['period']}")
    same_country = _is_us(country)
    prov = doc["provenance"]
    out: dict[str, Any] = {
        "schema": SCHEMA,
        "kind": "context_only",
        "source": {
            "name": "U.S. Energy Information Administration, Electric Power Monthly, Table 5.6.A (Form EIA-861M)",
            "release_date": doc["release_date"],
            "measured_on": prov["measured_on"],
            "page_sha256": prov["page_sha256"],
            "computed_by": "gridforge-stress harness (independent of this engine); see provenance in data/retail_price_context.json",
        },
        "observed": {
            "area": name,
            "period": doc["period"],
            "unit": "US dollars per MWh (published as US cents per kWh)",
            "sectors": sectors,
            "definition": doc["definition"],
            "status": prov["status_of_values"],
        },
        "applicability": {
            "site_country": country if isinstance(country, str) else None,
            "level": "same_country_context" if same_country else "scale_reference_only",
            "note": ("The site is in the United States; the figure is the state or national average for the sector, not this site's price."
                     if same_country else
                     "The site is not stated to be in the United States. A US average says nothing about its tariff; it is a scale "
                     "reference at most."),
        },
        "limits": list(MUST_NOT_CLAIM),
        "statements": [
            "This is the average price paid by every customer in the sector in one month, delivery included. A load's price is set by its "
            "contracted tariff, which this does not replace.",
            "EIA reports US cents per kWh; the engine's price is in EUR/MWh. They are shown in their own currencies and are not converted.",
        ],
    }
    if assumed_eur_per_mwh is not None:
        out["assumed"] = {
            "eur_per_MWh": assumed_eur_per_mwh,
            "source": "declared by the buyer (economics.electricity_eur_per_MWh)" if declared
                      else "library placeholder (evidence class E0); no contracted tariff supplied",
            "evidence_class_unchanged": True,
        }
        if not declared:
            out["statements"].append(
                "The engine's electricity price is a placeholder because none was declared. Replace it with the contracted tariff; "
                "this statistic is only for judging whether the placeholder is in a plausible range once you convert at your own rate.")
    return out
