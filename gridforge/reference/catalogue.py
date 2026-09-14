"""What each constraint is, in words a competent engineer will not argue with.

Authored, not generated. A generated explanation of why a busway derates is a
paragraph of filler, and filler on an engineering site costs more credibility than
it buys traffic. What IS generated is every number: see build.py.

Rules for entries here:
  * `relation` is the governing physics, stated so it can be checked.
  * `binds_when` is a test the reader can run against their own hall in a minute,
    from figures they already have. That is the whole value of the page.
  * `misconception` is the mistake we actually see. Where there isn't one, leave it
    empty rather than inventing one.
  * No vendor is named anywhere. We take no margin on hardware and the reference is
    not the place to start.
"""
from __future__ import annotations

from dataclasses import dataclass, field


class ReferenceError(ValueError):
    pass


@dataclass(frozen=True)
class ConstraintDoc:
    id: str
    name: str
    domain: str
    slug: str
    headline: str            # one sentence, the thing a reader remembers
    limits: str              # what physically runs out
    relation: str            # the governing relation, checkable
    binds_when: str          # a test against the reader's own hall
    relief: str              # what moves it
    relief_risk: str         # what that relief costs beyond money
    misconception: str = ""
    sources: tuple[str, ...] = ()
    see_also: tuple[str, ...] = ()

    def __post_init__(self) -> None:
        for field_name in ("headline", "limits", "relation", "binds_when", "relief"):
            if not getattr(self, field_name).strip():
                raise ReferenceError(f"{self.id}: {field_name} is empty")


#: Indicative relief lead times, in weeks, as ranges seen in European retrofits.
#: Published because the schedule, not the capex, is what usually decides.
RELIEF_LEAD_TIMES: dict[str, tuple[int, int]] = {
    "rack_feed_tapoff": (12, 40),
    "busway_ampacity": (16, 44),
    "transformer_capacity": (52, 160),
    "ups_capacity": (20, 52),
    "grid_firm_capacity": (30, 260),
    "plant_capacity": (24, 60),
    "cdu_capacity": (16, 40),
    "hydraulic_flow": (12, 36),
    "tcs_supply_achievable": (20, 52),
    "residual_air_removal": (10, 30),
    "architecture_capability": (12, 36),
    "floor_space": (4, 20),
    "floor_loading": (12, 40),
}

_E = "electrical"
_T = "thermal"
_P = "physical"

CONSTRAINT_DOCS: tuple[ConstraintDoc, ...] = (
    ConstraintDoc(
        id="rack_feed_tapoff", name="Rack feed / tap-off rating", domain=_E,
        slug="rack-feed-tapoff-rating",
        headline="The commonest hard stop in a legacy hall is the last two metres of copper.",
        limits="The continuous current a single rack position can be fed at, set by the "
               "tap-off unit on the busway and the flexible cord to the rack PDU.",
        relation="I = P / (√3 · V · pf). A 132 kW rack at 400 V three-phase and pf 0.95 "
                 "draws on the order of 200 A per feed. A hall built for 8 kW racks is "
                 "typically fitted with 32–63 A tap-offs.",
        binds_when="Divide your target rack power by (1.73 × your busway voltage × 0.95). "
                   "If the answer exceeds the rating stamped on your installed tap-off "
                   "units, this binds before anything else does — and it binds at rack one, "
                   "not at scale.",
        relief="Higher-rated tap-off units, and the busway itself where its ampacity does "
               "not allow them. Usually the cheapest rung on the ladder in euros and one of "
               "the faster ones in weeks.",
        relief_risk="Tap-off units have been a reported shortage item. Installation onto an "
                    "energised busway is possible with some systems and not others; where it "
                    "is not, the outage per run is a commercial cost in an occupied hall.",
        misconception="Operators quote the hall's total kW and conclude they have headroom. "
                      "Total capacity says nothing about whether one position can be fed.",
        sources=("Uptime Intelligence — at high density, power distribution creates issues "
                 "more often than cooling.",),
        see_also=("busway_ampacity", "transformer_capacity"),
    ),
    ConstraintDoc(
        id="busway_ampacity", name="Busway ampacity", domain=_E,
        slug="busway-ampacity",
        headline="A 400 A busway run cannot feed three 130 kW racks, whatever the hall total says.",
        limits="The continuous current a busway run carries, derated for ambient, grouping "
               "and the site's own continuous-load policy.",
        relation="Racks per run = (ampacity × utilisation limit × √3 × V × pf) / rack power. "
                 "At 400 A, 0.8 continuous limit, 400 V and pf 0.95, a run supports roughly "
                 "210 kW — about 1.6 racks of a 132 kW platform.",
        binds_when="Take your installed ampacity per run, multiply by your continuous-load "
                   "derating (often 0.8), and convert to kW. Divide by your target rack "
                   "power. If that number is smaller than the racks you want per run, this "
                   "binds. Legacy halls commonly run 400 A; modern AI halls specify "
                   "800–1000 A.",
        relief="Replace the busway with a higher ampacity, or add further runs where riser "
               "and routing space exists. Adding runs is usually cheaper and slower than it "
               "sounds, because the constraint moves upstream to the panel.",
        relief_risk="Replacement is invasive in an occupied hall and is normally phased run "
                    "by run. Adding runs needs riser space that a 2014 building may not have.",
        misconception="Ampacity is often read as a nameplate rather than a continuous rating. "
                      "The derated figure is the one that decides.",
        sources=("IEC 61439-6 busbar trunking systems; site continuous-load policy.",),
        see_also=("rack_feed_tapoff", "transformer_capacity"),
    ),
    ConstraintDoc(
        id="transformer_capacity", name="Transformer capacity", domain=_E,
        slug="transformer-capacity",
        headline="The transformer is rarely the tightest constraint and is usually the one "
                 "that sets the date.",
        limits="Usable secondary capacity after the site's derating policy and at the "
               "redundancy the hall is sold on.",
        relation="Required MVA ≈ (racks × rack kW × PUE) / 1000 / pf, at N+1 or 2N as the "
                 "hall is contracted. Harmonic content from GPU rectifier loads derates a "
                 "standard unit further.",
        binds_when="Sum your existing IT load and the new load at your expected PUE, divide "
                   "by 0.95, and compare against installed capacity with one unit out of "
                   "service. If the margin is thin, check lead time before you check price.",
        relief="Additional or replacement transformer capacity, and the switchgear that comes "
               "with it.",
        relief_risk="Lead times of 120–160+ weeks have been reported for power transformers. "
                    "This is the item most likely to set the energisation date for the whole "
                    "retrofit, and every week of it is a week of contracted power earning "
                    "nothing.",
        misconception="Treated as a capex line when it is a schedule line. A cheaper "
                      "transformer eighteen months later is the expensive one.",
        sources=("Reported European transformer lead times, 2025–2026.",),
        see_also=("grid_firm_capacity", "ups_capacity"),
    ),
    ConstraintDoc(
        id="ups_capacity", name="UPS capacity (protected load)", domain=_E,
        slug="ups-capacity",
        headline="AI training loads step harder than anything a 2014 UPS was specified for.",
        limits="Protected capacity available for new IT load, and the instantaneous step the "
               "installed blocks will accept without transferring to bypass.",
        relation="Headroom = installed protected capacity × redundancy factor − existing "
                 "protected load. Separately, a synchronised training job can present a step "
                 "of a large fraction of its own rating in milliseconds.",
        binds_when="Compare protected headroom against the new IT load. Then ask a second "
                   "question most people skip: what step load are the installed blocks rated "
                   "for, and what step will a synchronised job actually present?",
        relief="Additional modules where the installed system parallels, or a new block with "
               "its own switchgear where it does not.",
        relief_risk="Mixed-vintage parallel operation is a common and expensive surprise. "
                    "Whether new modules will parallel with the installed system is a "
                    "question to settle before it is priced, not after.",
        misconception="Capacity is checked and step-load capability is not. The second is "
                      "what causes the incident.",
        sources=("Site UPS schedules; manufacturer step-load ratings.",),
        see_also=("transformer_capacity",),
    ),
    ConstraintDoc(
        id="grid_firm_capacity", name="Firm supply (grid import and behind-the-meter)", domain=_E,
        slug="firm-supply-capacity",
        headline="In core European metros the grid connection is the asset, and it is not "
                 "growing before the 2030s.",
        limits="Firm capacity available for new load: contracted grid import, less current "
               "site peak, plus any behind-the-meter supply that genuinely counts as firm.",
        relation="Headroom = (contracted MW − current site peak MW) + Σ(BTM capacity × firm "
                 "capacity factor). A battery contributes its firm fraction, not its "
                 "nameplate.",
        binds_when="Subtract your current site peak from your contracted capacity. If the "
                   "remainder is smaller than your intended new IT load at your expected PUE, "
                   "this binds — and unlike every other constraint on this list, you cannot "
                   "buy your way out of it inside the decision horizon in most European "
                   "metros.",
        relief="Behind-the-meter supply, where it is firm and consentable. Otherwise, getting "
               "more compute out of the capacity already contracted — which is the whole "
               "premise of a density retrofit.",
        relief_risk="Consent, not equipment, is the schedule risk for combustion plant. "
                    "Grid-code compliance and fire separation govern battery programmes. A "
                    "capacity factor applied to a nameplate is an assumption, and should be "
                    "labelled as one.",
        misconception="Nameplate BTM capacity counted as firm. A 2 MW battery is not 2 MW of "
                      "firm capacity, and the fraction that is depends on the duty.",
        sources=("Mainova on Frankfurt connection availability; TenneT queue positions; "
                 "CRU Large Energy User policy, Ireland.",),
        see_also=("transformer_capacity",),
    ),
    ConstraintDoc(
        id="plant_capacity", name="Chilled-water plant capacity", domain=_T,
        slug="chilled-water-plant-capacity",
        headline="Direct liquid cooling does not remove the air load — it shrinks it, and the "
                 "remainder still needs the plant you already have.",
        limits="Chilled-water capacity available for the residual air load that liquid "
               "cooling does not capture.",
        relation="Residual air load per rack = rack kW × (1 − liquid capture fraction). At a "
                 "0.85 capture fraction a 132 kW rack still rejects about 20 kW to air — "
                 "more than a whole rack in the hall's original design.",
        binds_when="Multiply your target rack count by rack power by (1 − capture fraction) "
                   "and compare against plant headroom at your site's summer design dry bulb, "
                   "not at a standard rating condition.",
        relief="Additional plant, adiabatic assist, or a trim chiller on a high-temperature "
               "loop. Raising the loop temperature is often worth more than raising duty.",
        relief_risk="Retaining low-temperature plant for the residual air load forgoes most "
                    "of the free-cooling benefit the liquid loop was supposed to deliver.",
        misconception="\"We are going liquid, so cooling is solved.\" The residual air load "
                      "of a dense hall frequently exceeds the hall's entire original design "
                      "load.",
        sources=("Platform liquid capture fractions from published vendor architectures, "
                 "corroborated where possible.",),
        see_also=("residual_air_removal", "cdu_capacity", "tcs_supply_achievable"),
    ),
    ConstraintDoc(
        id="cdu_capacity", name="CDU capacity at site conditions", domain=_T,
        slug="cdu-capacity-site-conditions",
        headline="A CDU rated at a 5 K approach, installed on a site running 24 K, is not the "
                 "CDU you bought.",
        limits="Heat rejected from the technology cooling loop to facility water, at the "
               "approach temperature the site actually offers.",
        relation="Usable duty falls as the approach between facility water and the platform's "
                 "maximum inlet temperature widens. A unit quoted at a 5 K approach delivers "
                 "materially less at the 20–25 K approach a legacy 6 °C loop presents.",
        binds_when="Take your facility water supply temperature and your platform's maximum "
                   "technology-loop inlet temperature. The difference is your available "
                   "approach. Ask for the selection output at THAT approach — not the "
                   "datasheet figure.",
        relief="Additional CDU capacity, or raising the facility water temperature so the "
               "approach widens in your favour.",
        relief_risk="A linear derate against approach is a screening approximation. Confirm "
                    "against the manufacturer's performance curve before committing capital. "
                    "Technology-loop water chemistry is a warranty question before it is a "
                    "capacity question.",
        misconception="The single most common way a liquid retrofit under-delivers: rated "
                      "duty taken from a datasheet at a reference condition the site does not "
                      "have.",
        sources=("OCP Water-Based Transfer Fluids Guidelines; manufacturer performance data "
                 "at stated approach.",),
        see_also=("tcs_supply_achievable", "hydraulic_flow", "plant_capacity"),
    ),
    ConstraintDoc(
        id="hydraulic_flow", name="Hydraulic flow capacity", domain=_T,
        slug="hydraulic-flow-capacity",
        headline="A flow figure without a head figure is not a duty point.",
        limits="Pumped flow available to the technology cooling loop at the system's actual "
               "resistance.",
        relation="Required flow ≈ rack count × platform flow per rack. Around 1.45 l/min per "
                 "kW at a 10 K delta-T is a reasonable screening figure; the platform's own "
                 "published flow per rack is better.",
        binds_when="Multiply target racks by the platform's flow per rack and compare against "
                   "installed pumped capacity — then check available head against the "
                   "resistance the new loop adds. Halls pass the first test and fail the "
                   "second.",
        relief="Pump replacement or addition, and pipework where the resistance is in the "
               "distribution rather than the pumps.",
        relief_risk="Head is where retrofits are caught out. Adding flow to a loop whose "
                    "resistance has risen gives a duty point nobody modelled.",
        misconception="Flow capacity quoted from the pump nameplate rather than from the duty "
                      "point of the system as it will be built.",
        sources=("OCP fluid guidelines; site hydraulic records.",),
        see_also=("cdu_capacity", "tcs_supply_achievable"),
    ),
    ConstraintDoc(
        id="tcs_supply_achievable", name="Achievable facility water temperature", domain=_T,
        slug="achievable-facility-water-temperature",
        headline="Legacy plant makes 6 °C water beautifully. Liquid cooling would rather have 30 °C.",
        limits="The facility water temperature the site can actually deliver to the CDUs, "
               "which sets the approach and therefore the usable duty.",
        relation="A high-temperature loop at around 30 °C supply unlocks free cooling for "
                 "most of a European year and widens nothing — the approach to a platform "
                 "accepting 45 °C inlet stays comfortable. A 6 °C loop wastes that twice.",
        binds_when="If your plant is designed around 6–10 °C supply and you are adding liquid "
                   "cooling, the question is not whether the plant is big enough but whether "
                   "it should be making water that cold at all.",
        relief="A separate high-temperature loop, adiabatic assist, or a trim chiller sized "
               "for the hours the free cooling does not cover.",
        relief_risk="Two loops means two sets of controls and a commissioning problem. "
                    "Retaining the low-temperature loop for residual air load is usually "
                    "unavoidable and is what caps the efficiency gain.",
        misconception="Treating water temperature as a plant setting rather than as the "
                      "variable that decides both CDU duty and annual energy.",
        sources=("OCP Water-Based Transfer Fluids Guidelines, 2025.",),
        see_also=("cdu_capacity", "plant_capacity"),
    ),
    ConstraintDoc(
        id="residual_air_removal", name="Residual air load removal per rack", domain=_T,
        slug="residual-air-load-removal",
        headline="Twenty kilowatts of air load in a rack position designed for eight is still "
                 "an air problem.",
        limits="Heat removable from a single rack position by air, at the hall's containment "
               "and airflow.",
        relation="Residual air per rack = rack kW × (1 − liquid capture). The hall's per-"
                 "position air capability — commonly 10–20 kW with good containment — is what "
                 "it must fit inside.",
        binds_when="Compare the residual air load of one target rack against what one position "
                   "in your hall can actually remove today. Containment quality decides this "
                   "more than plant capacity does.",
        relief="In-row cooling or rear-door heat exchangers at the affected positions.",
        relief_risk="Rear doors need water at the position, which is a pipework and leak-"
                    "detection question in a live hall.",
        misconception="Per-position capability inferred from hall-average density. The average "
                      "is not the limit; the position is.",
        sources=("Uptime Intelligence on practical retrofit density ceilings.",),
        see_also=("plant_capacity", "architecture_capability"),
    ),
    ConstraintDoc(
        id="architecture_capability", name="Cooling architecture per-rack capability", domain=_T,
        slug="cooling-architecture-capability",
        headline="Air-cooled halls stop somewhere between 20 and 40 kW a rack, and no amount "
                 "of plant changes that.",
        limits="The maximum per-rack power the chosen cooling architecture can support at all, "
               "before any question of capacity.",
        relation="A gate rather than a capacity: retained air, rear-door, hybrid DLC and full "
                 "DLC each have a per-rack ceiling. Exceeding it is not a shortfall, it is an "
                 "architecture that does not apply.",
        binds_when="If your target rack power is above roughly 40 kW and the hall is air "
                   "cooled with containment, this gate closes before any capacity constraint "
                   "is reached. The honest answer at that point is an architecture change, "
                   "not more plant.",
        relief="Change the architecture: rear-door, hybrid direct liquid cooling, or full DLC "
               "with a high-temperature loop.",
        relief_risk="Each step up is a larger programme and a different skill set in the hall. "
                    "The decision is rarely reversible within a tenancy.",
        misconception="Believing a hall can be pushed to 100 kW+ a rack with better airflow. "
                      "Fewer than 4% of facilities can host 100 kW racks today.",
        sources=("Uptime Institute Global Survey 2025/26: 82% of operators' densest rack is "
                 "below 30 kW; practical retrofit ceiling 20–40 kW.",),
        see_also=("residual_air_removal", "cdu_capacity"),
    ),
    ConstraintDoc(
        id="floor_space", name="Available rack positions", domain=_P,
        slug="available-rack-positions",
        headline="The cheapest constraint to discover and the most awkward to relieve, "
                 "because it is somebody's tenancy.",
        limits="Rack positions that can actually be released for the new deployment.",
        relation="Positions available, not positions installed. A hall with 560 positions and "
                 "380 under contract has 180.",
        binds_when="Count what you can genuinely empty inside the programme. If that is fewer "
                   "than the racks the power and cooling would allow, this binds — and it "
                   "binds on commercial terms, not engineering ones.",
        relief="Release positions from existing tenancy, or consolidate.",
        relief_risk="Commercial and contractual, not capital. The lead time is a negotiation, "
                    "which makes it the hardest item on the ladder to programme honestly.",
        misconception="Counting installed positions rather than releasable ones, which "
                      "overstates the envelope before any physics is done.",
        sources=("Site tenancy records.",),
        see_also=("floor_loading",),
    ),
    ConstraintDoc(
        id="floor_loading", name="Floor loading", domain=_P,
        slug="floor-loading",
        headline="A fully populated AI rack weighs around 1.4 tonnes and a Rated-3 raised "
                 "floor was designed for about 1,220 kg/m².",
        limits="Distributed and point load the hall floor can carry, including the raised "
               "floor system where one is present.",
        relation="Rack mass divided by footprint, against the design distributed load — and "
                 "separately against point loads at the castors, which is usually the harder "
                 "test.",
        binds_when="Divide your platform's rack mass by its footprint and compare against your "
                   "hall's design floor loading. If it is close, treat the number in the "
                   "building record as a screening value and commission a structural "
                   "assessment before committing.",
        relief="Structural strengthening, load spreading, or relocating the deployment to slab.",
        relief_risk="Structural work in a live hall is disruptive and the assessment itself "
                    "can invalidate the plan. It is cheap relative to the decision and should "
                    "be done early for that reason.",
        misconception="Treating the design value in the building record as a measurement. It "
                      "is a design value, and a 2014 record may not reflect what was built.",
        sources=("TIA-942 Rated-3 floor loading design values; platform rack masses from "
                 "published vendor data.",),
        see_also=("floor_space",),
    ),
)

_BY_ID = {d.id: d for d in CONSTRAINT_DOCS}
_BY_SLUG = {d.slug: d for d in CONSTRAINT_DOCS}


def constraint_doc(key: str) -> ConstraintDoc:
    d = _BY_ID.get(key) or _BY_SLUG.get(key)
    if d is None:
        raise ReferenceError(
            f"no reference entry for {key!r}. One of: {', '.join(sorted(_BY_ID))}")
    return d


def all_docs() -> tuple[ConstraintDoc, ...]:
    return CONSTRAINT_DOCS
