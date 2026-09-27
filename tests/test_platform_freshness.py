"""The platform library has a refresh cadence now (HANDOFF.md §6d #20).

`gridforge/platforms.py`-equivalent (`gridforge/compute/library.py`) hardcodes
accelerator families with a status of "shipping" and no mechanism forced anyone to
re-check them as the market moved — the library could silently age into
wrongness and nothing would say so. This does not solve "needs an owner" (that is
a person, not a patch) but it does solve "silently": a shipping platform whose
newest cited source is older than the review window fails the build, by name,
with the fix spelled out. The GPU accelerator market ships a new flagship
generation roughly annually; 24 months is deliberately more than one full cycle
of margin so this does not nag on a currently-accurate entry, while still being
short enough that a platform cannot go two full generations uncorroborated
without somebody having to look at it and make a decision — bump the source,
find a fresher one, or downgrade the platform's status.
"""
from datetime import date

import pytest

from gridforge.clock import report_date
from gridforge.compute.library import PLATFORMS, newest_source_year

REVIEW_WINDOW_YEARS = 2

SHIPPING = [p for p in PLATFORMS.values() if p.status == "shipping"]


@pytest.mark.parametrize("platform", SHIPPING, ids=lambda p: p.id)
def test_shipping_platform_carries_at_least_one_dated_source(platform):
    """A shipping platform with no dated source anywhere cannot be aged at all,
    which is worse than being stale — nobody can tell the difference between
    "checked recently" and "never checked." Every field seeded from a real spec
    sheet carries a Source with a year; this only fires if that stops being true."""
    assert newest_source_year(platform) is not None, (
        f"{platform.id}: no field carries a dated Source. Add one from the "
        f"datasheet or announcement this entry was seeded from.")


@pytest.mark.parametrize("platform", SHIPPING, ids=lambda p: p.id)
def test_shipping_platform_is_within_the_review_window(platform):
    year = newest_source_year(platform)
    if year is None:
        return  # covered, and failed, by the test above
    cutoff = date(report_date().year - REVIEW_WINDOW_YEARS, report_date().month,
                  min(report_date().day, 28))
    newest = date(year, 1, 1)
    assert newest >= cutoff, (
        f"{platform.id}: newest cited source is from {year}, more than "
        f"{REVIEW_WINDOW_YEARS} years before {report_date().isoformat()}. The "
        f"accelerator market has likely moved since this was seeded — re-check "
        f"rack_kW, liquid_fraction and rack_feed_current_A against the current "
        f"vendor datasheet, then either bump the Source year or add a newer "
        f"corroborating one. If the platform is genuinely end-of-life, set its "
        f"status to something other than 'shipping' instead of silencing this.")
