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
    #: The top of the scoped band, where the engagement is quoted as a range. The
    #: site used to print "EUR 22k-45k" with the 45 typed into a component, which
    #: made the upper half of every quoted range unsourceable.
    price_eur_max: int = 0
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
        price_eur_max=45_000,
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
    "procurement_spec": Engagement(
        id="procurement_spec",
        name="Procurement Specification",
        price_eur=18_000,
        turnaround_days=12,
        question="What exactly do we buy, and which bid actually moves the date?",
        deliverable=(
            "A tender-ready technical specification for one relief, a machine-readable "
            "response schedule, and a bid comparison in racks and weeks rather than only in "
            "euros."),
        scope_in=(
            "Every numeric requirement derived from the capacity model, naming the constraint "
            "it came from — so a supplier who meets the specification provably relieves the "
            "limit, rather than supplying equipment somebody liked the look of.",
            "Duties quoted at YOUR site conditions, not at a manufacturer's reference "
            "condition. A CDU rated at a 5 K approach and installed on a 24 K site is the "
            "commonest way a liquid retrofit under-delivers.",
            "An evaluation matrix weighted for programme as well as price: the item exists to "
            "unlock compute on a date, and the cheaper, slower bid is the expensive one.",
            "Bid comparison against the capacity model — what each response does to the "
            "energisation date and to deployable rack count.",
            "The response schedule returned to you as structured data you keep.",
        ),
        scope_out=SCOPE_OUT_COMMON + (
            "Running the tender, contracting, or any commercial relationship with the "
            "suppliers. We specify duty and interfaces; we name no make or model, quote no "
            "equipment and take no margin on hardware.",
        ),
        credits_against=None,
        payment_terms=("100% on commissioning. One specification per engagement: a combined "
                       "tender for four unrelated reliefs gets four suppliers quoting the "
                       "parts they are comfortable with and nobody owning the constraint."),
    ),
    "portfolio_screen": Engagement(
        id="portfolio_screen",
        name="Portfolio Screen",
        price_eur=60_000,
        price_eur_max=140_000,
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


@dataclass(frozen=True)
class ApiPlan:
    """Metered access to the engine, sold to software rather than to people.

    Deliberately priced well under the engagements, and deliberately not the same
    product. An engagement is an engineering opinion with a named signatory, an
    issued status and professional indemnity behind it. The API returns modelled
    output in screening mode with none of those things — it is for triage, ranking
    and monitoring at a scale no human deliverable can reach. Anyone who confuses
    the two will find the distinction printed on every response they get back.
    """
    id: str
    name: str
    price_eur_month: int
    monthly_units: int
    audience: str
    includes: tuple[str, ...] = ()

    @property
    def eur_per_unit(self) -> float:
        return round(self.price_eur_month / self.monthly_units, 3)

    @property
    def studies_per_month(self) -> int:
        return self.monthly_units // 5

    @property
    def screens_per_month(self) -> int:
        return self.monthly_units


API_SCOPE_OUT = (
    "No issued engineering opinion, no named signatory and no professional indemnity. "
    "Every API response is screening-mode output and says so.",
    "No design, no procurement and no equipment selection.",
    "No SLA on availability beyond best effort at the Triage tier.",
)

API_PLANS: dict[str, ApiPlan] = {
    "api_triage": ApiPlan(
        id="api_triage",
        name="API — Triage",
        price_eur_month=900,
        monthly_units=600,
        audience="One team screening a portfolio it already owns.",
        includes=(
            "600 units a month: 600 constraint screens, or 120 full solves, or any mix.",
            "The free qualifier stays free and never touches the allowance.",
            "MCP endpoint, so an agent can call the engine directly.",
            "The calibration block on every response, including when it says uncalibrated.",
        ),
    ),
    "api_scale": ApiPlan(
        id="api_scale",
        name="API — Scale",
        price_eur_month=2_900,
        monthly_units=2_500,
        audience="A platform or fund pricing halls continuously rather than in batches.",
        includes=(
            "2,500 units a month.",
            "Portfolio endpoint billed per hall, so a 200-hall sweep is 200 units.",
            "Change notes via /v1/diff: what moved and which input moved it.",
            "Priority on new platform library entries.",
        ),
    ),
    "api_platform": ApiPlan(
        id="api_platform",
        name="API — Platform",
        price_eur_month=7_500,
        monthly_units=10_000,
        audience="Embedding the engine in a product your own customers use.",
        includes=(
            "10,000 units a month.",
            "A named engineer on call for model questions.",
            "Input on the constraint roadmap and the platform library.",
            "Redistribution terms for output shown to your own customers.",
        ),
    ),
}


def api_plan(plan_id: str) -> ApiPlan:
    if plan_id not in API_PLANS:
        raise KeyError(f"unknown API plan {plan_id!r}. "
                       f"One of: {', '.join(sorted(API_PLANS))}")
    return API_PLANS[plan_id]


def engagement(engagement_id: str) -> Engagement:
    if engagement_id not in ENGAGEMENTS:
        raise KeyError(f"unknown engagement {engagement_id!r}. "
                       f"One of: {', '.join(sorted(ENGAGEMENTS))}")
    return ENGAGEMENTS[engagement_id]
