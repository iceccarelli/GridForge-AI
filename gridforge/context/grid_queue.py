"""Independent evidence beside the grid-wait question: how long did US generation interconnection requests actually take?

The comparison refuses to date grid reinforcement ("a connection date needs the network operator's offer"), and the screen carries a
grid-reinforcement lead time that is an ASSUMPTION (evidence class E0). A buyer asking "how long will the grid take?" is left with a
number nobody can check. This module sets an attributed, MEASURED statistic beside it.

The statistic is Lawrence Berkeley National Laboratory's *Queued Up* (2026 edition, data through 2025, CC BY 4.0): years from interconnection
request to in-service for US generation and storage requests that reached commercial operation. `data/queue_context.json` is a copy of the
fixture the independent gridforge-stress harness computed from the published workbook (workbook sha256 inside).

CONTEXT ONLY, by construction. It never changes a number or an evidence class in the response it sits in, it is not a connection time for a
load or a data centre, it says nothing about a site's own network operator, tariff or study status, and it describes only the requests that
SURVIVED: most requests that enter a queue never reach operation, and the survivorship block says how many. Every output carries those limits.
"""
from __future__ import annotations

import functools
import json
from pathlib import Path
from typing import Any

SCHEMA = "gridforge/grid-queue-context/1"
DATA_FILE = Path(__file__).resolve().parents[1] / "data" / "queue_context.json"
SOURCE_SCHEMA = "gridforge-stress/queue-context/1"
DEFAULT_CONTEXT = "cod_2018_2025"
WEEKS_PER_YEAR = 365.25 / 7
US_NAMES = frozenset({"US", "USA", "UNITED STATES", "UNITED STATES OF AMERICA"})

MUST_NOT_CLAIM = (
    "that the observed queue duration is a connection time for a load or a data centre",
    "that the assumed grid lead time is validated, confirmed or raised in evidence class by this comparison",
    "that this says anything about the site's own network operator, tariff, study status or equipment delivery",
    "that requests which did not reach commercial operation take this long (the statistic excludes them)",
)


class QueueContextError(ValueError):
    """The context cannot be produced without guessing; the message says what to change."""


@functools.lru_cache(maxsize=1)
def _doc() -> dict[str, Any]:
    doc: dict[str, Any] = json.loads(DATA_FILE.read_text())
    if doc.get("schema") != SOURCE_SCHEMA:
        raise QueueContextError("unrecognised queue-context data schema")
    for name, c in {**doc["contexts"], **doc.get("by_region_cod_2018_2025", {})}.items():
        if not (c["n"] > 0 and c["p25"] < c["median"] < c["p75"]):
            raise QueueContextError(f"context {name!r} is not a valid quartile summary")
    return doc


def regions() -> tuple[str, ...]:
    """The region names a request may ask for (LBNL's own groupings, not network operators)."""
    return tuple(sorted(_doc()["by_region_cod_2018_2025"]))


def _survivorship(doc: dict[str, Any]) -> dict[str, Any] | None:
    block = doc.get("survivorship")
    if not block:
        return None
    lo, hi = block["mature_cohort_years"]
    keys = ("entered", "operational", "withdrawn", "active", "suspended", "unknown")
    tot = {k: 0 for k in keys}
    for yr in range(lo, hi + 1):
        for k in keys:
            tot[k] += block["cohorts_by_entry_year"][str(yr)][k]
    unresolved = tot["active"] + tot["suspended"] + tot["unknown"]
    share = round(tot["operational"] / tot["entered"], 3)
    return {
        "entry_years": [lo, hi],
        "entered": tot["entered"],
        "operational": tot["operational"],
        "withdrawn": tot["withdrawn"],
        "unresolved": unresolved,
        "share_operational_of_entered": share,
        "statement": (
            f"Of {tot['entered']} requests that entered these queues in {lo}-{hi}, {tot['operational']} ({share:.1%}) are operational "
            f"and {tot['withdrawn']} withdrawn ({unresolved} unresolved); the durations describe only the operational ones."
        ),
    }


def _position(a: float, p25: float, p50: float, p75: float) -> str:
    if a < p25:
        return "below_p25"
    if a < p50:
        return "between_p25_and_median"
    if a < p75:
        return "between_median_and_p75"
    return "at_or_above_p75"


def _is_us(country: Any) -> bool:
    return isinstance(country, str) and country.strip().upper() in US_NAMES


def context(*, region: str | None = None, country: Any = None, assumed: dict[str, Any] | None = None) -> dict[str, Any]:
    """The measured queue statistic, with its limits; with `assumed`, the product's own grid wait set beside it.

    `region` is one of regions() or None for the pooled US statistic. `assumed` is {"weeks", "band_low_weeks", "band_high_weeks",
    "evidence_class"} as read from a screen payload; it is reported back unchanged and its evidence class is never altered.
    """
    doc = _doc()
    if region is not None:
        known = doc["by_region_cod_2018_2025"]
        if region not in known:
            raise QueueContextError(f"unknown grid_queue_region {region!r}; known: {', '.join(sorted(known))}")
        ctx, name = known[region], f"{region}, requests that reached operation 2018-2025"
    else:
        ctx, name = doc["contexts"][DEFAULT_CONTEXT], "US, requests that reached operation 2018-2025"
    p25, p50, p75 = (ctx[k] * WEEKS_PER_YEAR for k in ("p25", "median", "p75"))
    same_country = _is_us(country)
    prov = doc["provenance"]
    surv = _survivorship(doc)
    out: dict[str, Any] = {
        "schema": SCHEMA,
        "kind": "context_only",
        "source": {
            "name": "Lawrence Berkeley National Laboratory, Queued Up (2026 edition, data through 2025)",
            "licence": "CC BY 4.0",
            "workbook_sha256": prov["workbook_sha256"],
            "measured_on": prov["measured_on"],
            "computed_by": "gridforge-stress harness (independent of this engine); see provenance in data/queue_context.json",
        },
        "observed": {
            "name": name,
            "n": ctx["n"],
            "p25_weeks": round(p25, 1),
            "median_weeks": round(p50, 1),
            "p75_weeks": round(p75, 1),
            "p25_years": ctx["p25"],
            "median_years": ctx["median"],
            "p75_years": ctx["p75"],
            "population": doc["population"],
            "geography": doc["geography"],
            "definition": doc["definition"],
        },
        "survivorship": surv,
        "applicability": {
            "site_country": country if isinstance(country, str) else None,
            "context_geography": doc["geography"],
            "level": "same_country_context" if same_country else "scale_reference_only",
        },
        "limits": list(doc["limits"]),
        "must_not_claim": list(MUST_NOT_CLAIM),
    }
    statements = [
        f"In LBNL's {doc['geography']} generation-queue data ({name}; n={ctx['n']}), requests that reached commercial operation took a "
        f"median {ctx['median']} years from request to in-service (p25 {ctx['p25']}, p75 {ctx['p75']}).",
    ]
    if surv is not None:
        statements.append(surv["statement"])
    statements.append(
        "Applicability: "
        + ("the site is in the same country as the observed data; this is same-country context."
           if same_country else "the site is not in the observed data's country (or none is declared); this is a scale reference only.")
        + " It is not a connection time for a load, and it is not evidence about this site's network operator."
    )
    if assumed is not None:
        a = float(assumed["weeks"])
        comparison = {
            "assumed_weeks": a,
            "assumed_band_weeks": [float(assumed["band_low_weeks"]), float(assumed["band_high_weeks"])],
            "assumed_evidence_class": assumed["evidence_class"],
            "position_of_assumption": _position(a, p25, p50, p75),
            "assumed_over_observed_median": round(a / p50, 3),
            "assumed_band_covers_observed_median": float(assumed["band_low_weeks"]) <= p50 <= float(assumed["band_high_weeks"]),
        }
        out["comparison"] = comparison
        statements.append(
            f"The grid-reinforcement wait assumed here is {a:.0f} weeks (evidence class {assumed['evidence_class']}), "
            f"{comparison['position_of_assumption'].replace('_', ' ')} of that observed distribution "
            f"({comparison['assumed_over_observed_median']}x the observed median). Its evidence class is unchanged by this comparison. "
            "The two measure different processes (a generation interconnection request, and the grid reinforcement this hall needs), so "
            "this is a prompt to ask the network operator, not a correction of the assumption."
        )
    statements.append("This context changes no figure and no evidence class elsewhere in the response.")
    out["statements"] = statements
    return out


def assumption_from_scenarios(scenarios: list[dict[str, Any]] | None, prefer: str | None = None) -> dict[str, Any] | None:
    """The grid-reinforcement lead time a screen payload carries (client tier), or None when it carries none (never defaulted).

    `prefer` is a scenario id (the recommended one): its lead time is read first, so a document and the JSON payload quote the same wait.
    """
    ordered = sorted(scenarios or [], key=lambda sc: sc.get("id") != prefer)
    for sc in ordered:
        for con in sc.get("constraints", []) or []:
            if con.get("id") != "grid_firm_capacity":
                continue
            lt = (con.get("relief") or {}).get("lead_time_weeks")
            if not lt or any(lt.get(k) is None for k in ("value", "low", "high", "evidence")):
                continue
            return {"weeks": float(lt["value"]), "band_low_weeks": float(lt["low"]),
                    "band_high_weeks": float(lt["high"]), "evidence_class": str(lt["evidence"])}
    return None
