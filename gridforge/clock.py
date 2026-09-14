"""One place that answers "what is today".

Generated documents carry a date, which makes them non-deterministic — and a
build that cannot reproduce its own output byte for byte cannot tell you whether
the published reference study is stale or merely re-dated.

GRIDFORGE_REPORT_DATE pins it. CI uses that to regenerate the public reference
artefacts and fail if they differ, so the worked example on the website can never
quietly drift from the engine that produced it.
"""
from __future__ import annotations

import os
from datetime import date


def report_date() -> date:
    pinned = os.environ.get("GRIDFORGE_REPORT_DATE")
    if pinned:
        try:
            return date.fromisoformat(pinned)
        except ValueError:
            pass
    return date.today()


def report_date_iso() -> str:
    return report_date().isoformat()
