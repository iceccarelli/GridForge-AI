"""The engagement catalogue.

Mirrors `lib/products.ts` on the website. Two languages, one price list — so
`tests/test_catalogue_parity.py` parses the TypeScript and fails the build if they
ever disagree. A proposal that quotes a different number from the checkout page is
worse than no proposal.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class Engagement:
    id: str
    name: str
    price_eur: int
    turnaround_days: int
    question: str
    deliverable: str
    scope_in: tuple[str, ...] = ()
    scope_out: tuple[str, ...] = ()
    credits_against: str | None = None
    payment_terms: str = "100% on commissioning. The engagement opens when payment clears."


SCOPE_OUT_COMMON = (
    "Stamped design drawings, or any deliverable requiring a professional engineering signature.",
    "CFD of the hall — available as a priced add-on or a later phase.",
    "Equipment selection, bill of materials, pricing or procurement. We quote no equipment and "
    "take no margin on hardware.",
    "Structural sign-off. Our floor-loading check is a screening calculation only.",
    "Electrical protection and arc-flash studies.",
    "Commissioning, migration planning and tenancy strategy.",
)

ENGAGEMENTS: dict[str, Engagement] = {
    "density_screen": Engagement(
        id="density_screen",
        name="Density Screen",
        price_eur=4_500,
        turnaround_days=5,
        question="What stops this hall first, and how far can it go?",
        deliverable=(
            "Density Screen document (HTML and Markdown), the first six rungs of the headroom "
            "ladder, and a data request you can hand your own engineers verbatim."),
        scope_in=(
            "The binding constraint as the hall stands, with the basis stated in engineering units.",
            "Deployable racks of your target platform, as found and after the costed ladder.",
            "The item that sets the date.",
            "Every cooling architecture screened against the same constraint set.",
            "The list of inputs still assumed, each with why it binds and where to get it.",
        ),
        scope_out=SCOPE_OUT_COMMON,
        credits_against="envelope_study",
    ),
    "envelope_study": Engagement(
        id="envelope_study",
        name="Capacity & Density Envelope Study",
        price_eur=22_000,
        turnaround_days=25,
        question=("How much AI compute can this hall carry, what binds first, and what does each "
                  "step of density cost?"),
        deliverable=(
            "Envelope Study (HTML and Markdown), machine-readable model pack, and a 90-minute "
            "walkthrough with your engineering team."),
        scope_in=(
            "The complete headroom ladder: every constraint, what relieves it, what that costs "
            "and how long it takes.",
            "Time to power, with the item that sets the date named.",
            "All architectures compared, grid-only and behind-the-meter.",
            "One-at-a-time sensitivity against the relieved case.",
            "Screening economics with the accuracy class stated, and a risk register.",
            "A model pack you keep, so you can re-run our conclusion when your inputs change.",
        ),
        scope_out=SCOPE_OUT_COMMON,
    ),
    "portfolio_screen": Engagement(
        id="portfolio_screen",
        name="Portfolio Screen",
        price_eur=60_000,
        turnaround_days=45,
        question="Which of these halls should carry the compute, and in what order?",
        deliverable="Portfolio Screen document and one model pack per hall.",
        scope_in=(
            "Every hall screened with one identical model, library and assumption set, so the "
            "ranking is comparable even where the inputs are not equally complete.",
            "Ranking by deliverable compute, by time to power and by capital cost per rack — the "
            "three orderings rarely agree.",
            "A portfolio view of which constraint binds across several halls, because a shared "
            "constraint is a programme, not a site problem.",
        ),
        scope_out=SCOPE_OUT_COMMON,
    ),
}


def engagement(engagement_id: str) -> Engagement:
    if engagement_id not in ENGAGEMENTS:
        raise KeyError(f"unknown engagement {engagement_id!r}. "
                       f"One of: {', '.join(sorted(ENGAGEMENTS))}")
    return ENGAGEMENTS[engagement_id]
