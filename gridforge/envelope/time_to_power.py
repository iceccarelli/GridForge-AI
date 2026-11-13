"""Time to power.

A capacity number alone does not close a deal. The buyer's question is *when*:
how many weeks until the first rack draws power, and how many until the site is
full. In a market where the grid answer is measured in years, weeks are the
product.

The schedule falls out of the Headroom Ladder for free. Each relief has a lead
time; reliefs run in parallel; so the racks unlocked by the first N steps become
available at the longest lead time among those N steps. Plotting that gives an
energisation curve, and the difference between two curves - grid-wait versus
behind-the-meter - is the commercial argument in one number.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from ..validation import EvidenceClass
from .solver import HeadroomLadder


@dataclass
class EnergisationPoint:
    weeks: float
    racks: int
    unlocked_by: str
    domain: str


@dataclass
class TimeToPower:
    points: list[EnergisationPoint] = field(default_factory=list)
    racks_now: int = 0
    max_racks: int = 0

    @property
    def weeks_to_first_rack(self) -> float | None:
        if self.racks_now > 0 and not self.as_found_waits_for_cdu_kit:
            return 0.0
        if not self.complete:
            return None
        for p in self.points:
            if p.racks > 0:
                return p.weeks
        return None

    @property
    def weeks_to_full(self) -> float | None:
        if not self.complete:
            return None        # a relief with no lead time is unknown, not zero weeks: there is no date to give
        for p in self.points:
            if p.racks >= self.max_racks and self.max_racks > 0:
                return p.weeks
        return None

    critical_item: str = "—"
    critical_weeks: float = 0.0
    #: False when a relief that was taken has no lead time. ``points`` then understate elapsed time (the missing
    #: step contributes nothing), so ``weeks_to_first_rack`` / ``weeks_to_full`` return None rather than a date,
    #: and ``critical_weeks`` is a lower bound only.
    complete: bool = True
    #: True when the racks the hall hosts "as found" depend on a CDU kit the engine ASSUMED (``installed=False``) in a liquid scenario.
    #: They are then NOT energised at week 0: the first point is at the library CDU lead time, labelled as an assumption.
    as_found_waits_for_cdu_kit: bool = False
    #: True when the kit is assumed and the scenario deploys anything: no point and no elapsed band is earlier than the kit's lead time,
    #: whether the racks are as found or unlocked by a later relief.
    floored_by_cdu_kit: bool = False


#: The first energisation point of a liquid scenario whose as-found racks depend on an assumed CDU kit, and the item that sets the date while
#: nothing slower does. The weeks, band and class are the library CDU relief's own (``cdu_capacity``), never a figure of this module's.
ASSUMED_CDU_KIT_LABEL = "after CDU kit delivery (library lead time, assumed)"
ASSUMED_CDU_KIT_ITEM = "CDU kit delivery (assumed CDUs)"


def _kit_sets_the_floor(lad: HeadroomLadder) -> bool:
    """True when this ladder deploys something in a liquid scenario whose CDU kit is assumed: no rack of it, as found or unlocked later, is
    energised before the kit is delivered."""
    deployable = (lad.initial.max_racks if lad.initial else 0) > 0 or (lad.final.max_racks if lad.final else 0) > 0
    return deployable and lad.assumed_cdu_kit


def schedule(lad: HeadroomLadder) -> TimeToPower:
    """Energisation curve for a ladder: (weeks elapsed, racks energised)."""
    out = TimeToPower(racks_now=lad.initial.max_racks if lad.initial else 0,
                      max_racks=lad.final.max_racks if lad.final else 0)
    elapsed = 0.0
    kit_sets_time = False        # True while the assumed kit's lead time (not a relief's) is what the elapsed time is
    seen_racks = out.racks_now
    if lad.unassessed_banks or not lad.converged:
        # An undeclared transformer or UPS bank was never timed, and a ladder that stopped on its step budget never reached the ceiling,
        # so every elapsed figure below is a lower bound.
        out.complete = False
    if _kit_sets_the_floor(lad):
        # The CDU kit is assumed so the scenario could be solved: it is not in the hall, and every liquid rack of this scenario, as found or
        # unlocked by a later relief, runs on it. None is energised before the kit is delivered, at the library CDU lead time (an assumption, E0).
        out.floored_by_cdu_kit = True
        out.as_found_waits_for_cdu_kit = out.racks_now > 0
        kit = lad.cdu_kit_lead_time
        if kit is None:
            out.complete = False            # no lead time to give: no date, and none is invented
        else:
            elapsed = kit.value
            kit_sets_time = True
            out.critical_item, out.critical_weeks = ASSUMED_CDU_KIT_ITEM, kit.value
            if out.racks_now > 0:
                out.points.append(EnergisationPoint(kit.value, out.racks_now, ASSUMED_CDU_KIT_LABEL, "thermal"))
    elif out.racks_now > 0:
        out.points.append(EnergisationPoint(0.0, out.racks_now, "available as found", "—"))
    for st in lad.steps:
        if not st.taken:
            continue
        if st.lead_time_weeks is None:
            out.complete = False
        lead = st.lead_time_weeks.value if st.lead_time_weeks is not None else 0.0
        if lead > elapsed:
            elapsed = lead
            kit_sets_time = False
            out.critical_item = st.binding_name
            out.critical_weeks = lead
        if st.racks_after > seen_racks:
            seen_racks = st.racks_after
            if kit_sets_time and lead < elapsed:
                # The racks this relief unlocks are energised when the kit arrives, not when the relief is done: naming the relief at the
                # kit's week would claim a lead time it does not have.
                out.points.append(EnergisationPoint(elapsed, seen_racks, ASSUMED_CDU_KIT_LABEL, "thermal"))
            else:
                out.points.append(EnergisationPoint(elapsed, seen_racks, st.binding_name, st.domain))
    return out


def elapsed_bands(ladder: HeadroomLadder) -> list[tuple[float, float, float, EvidenceClass]]:
    """For each energisation point (same order as ``schedule(ladder).points``): (weeks, low, high, class).

    Reliefs run in parallel, so elapsed time is the longest lead time among the steps taken so far, and its
    band is the longest LOW and longest HIGH among them -- the lead times' own bands, not a multiplier."""
    out: list[tuple[float, float, float, EvidenceClass]] = []
    elapsed = lo = hi = 0.0
    cls: EvidenceClass | None = None
    seen = ladder.initial.max_racks if ladder.initial else 0
    if _kit_sets_the_floor(ladder):                                   # the same rule as schedule(): the points and the bands stay aligned
        kit = ladder.cdu_kit_lead_time
        if kit is not None:
            elapsed, lo, hi, cls = kit.value, kit.band[0], kit.band[1], kit.evidence
            if seen > 0:
                out.append((elapsed, lo, hi, cls))
    elif seen > 0:
        out.append((0.0, 0.0, 0.0, EvidenceClass.E0_ASSUMPTION))
    for st in ladder.steps:
        if not st.taken:
            continue
        lt = st.lead_time_weeks
        if lt is not None:
            elapsed = max(elapsed, lt.value)
            lo, hi = max(lo, lt.band[0]), max(hi, lt.band[1])
            cls = lt.evidence if cls is None else min(cls, lt.evidence)
        if st.racks_after > seen:
            seen = st.racks_after
            out.append((elapsed, lo, hi, cls if cls is not None else EvidenceClass.E0_ASSUMPTION))
    return out


#: What a figure in weeks must be called while the lead time that sets it is an assumption.
ASSUMED_DATE_LABEL = "assumed lead time, not a date"

DATE_BASIS_NONE = "none"          # no date can be given (nothing deployable, or a lead time is missing)
DATE_BASIS_ASSUMED = "assumed"    # the weakest lead time behind the figure is an E0 assumption
DATE_BASIS_SUPPORTED = "supported"  # every lead time behind the figure is above E0 (declared, quoted, ...)


@dataclass(frozen=True)
class DateBasis:
    """What an elapsed-weeks figure rests on, for every renderer and payload that prints one.

    ``basis``           none | assumed | supported
    ``evidence_class``  the WEAKEST class among the lead times behind the figure, e.g. "E0" (None when no date)
    ``binding_item``    the item whose lead time sets the figure (None when no date)
    ``label``           the sentence a reader sees next to the figure; never a bare date
    """
    basis: str
    evidence_class: str | None
    binding_item: str | None
    label: str

    @property
    def assumed(self) -> bool:
        return self.basis == DATE_BASIS_ASSUMED

    @property
    def caption(self) -> str:
        """The label without the item name, for renderers that already say "set by ..." themselves."""
        if self.basis == DATE_BASIS_ASSUMED:
            return f"{ASSUMED_DATE_LABEL} ({self.evidence_class})"
        if self.basis == DATE_BASIS_SUPPORTED:
            return f"lead times of class {self.evidence_class} at best"
        return "no date"

    def to_dict(self) -> dict:
        """The additive machine keys. Contains no number of weeks, so it is safe on the public tier."""
        return {"date_basis": self.basis, "date_evidence_class": self.evidence_class,
                "date_binding_item": self.binding_item, "date_label": self.label}


NO_DATE = DateBasis(DATE_BASIS_NONE, None, None, "no date: nothing is deployable or a lead time on the path is missing")
#: The two causes NO_DATE names, for a ladder that knows which one is true (``no_date_cause``). The generic NO_DATE stays for a stored state or a
#: change note, which carries no ladder to say which.
NO_DATE_NOT_DEPLOYABLE = DateBasis(DATE_BASIS_NONE, None, None, "no date: nothing is deployable in this scenario")
NO_DATE_LEAD_TIME_MISSING = DateBasis(DATE_BASIS_NONE, None, None, "no date: a lead time on the path is missing")

CAUSE_NOT_DEPLOYABLE = "not_deployable"
CAUSE_LEAD_TIME_MISSING = "lead_time_missing"
CAUSE_CURVE_INCOMPLETE = "curve_incomplete"


def no_date_cause(ladder: HeadroomLadder, ttp: "TimeToPower | None" = None) -> str | None:
    """Why a ladder has no time-to-full-capacity date, or None when it has one: ``not_deployable`` (no rack is deployable, so there is nothing to
    date), ``lead_time_missing`` (racks are deployable but a lead time on the path is missing: an equipment bank was not declared, or a taken relief
    has none), or ``curve_incomplete`` (the energisation curve never reaches the full envelope). Chosen in that order; it is the same test as
    ``full_capacity_band``, so a ladder has a cause exactly when it has no date."""
    ttp = ttp if ttp is not None else schedule(ladder)
    if not ttp.max_racks:
        return CAUSE_NOT_DEPLOYABLE
    if not schedule_complete(ladder):
        return CAUSE_LEAD_TIME_MISSING
    if full_capacity_band(ladder, ttp) is None:
        return CAUSE_CURVE_INCOMPLETE
    return None


def no_date_reason(ladder: HeadroomLadder, ttp: "TimeToPower | None" = None) -> str | None:
    """The cause of ``no_date_cause`` as a sentence a reader can act on (None when the ladder has a date). Carries no number of weeks, so it is
    safe on the public tier."""
    cause = no_date_cause(ladder, ttp)
    if cause is None:
        return None
    if cause == CAUSE_NOT_DEPLOYABLE:
        return "No rack is deployable in this scenario, so there is nothing to date."
    if cause == CAUSE_LEAD_TIME_MISSING:
        return "No defensible date: " + ladder.incomplete_reason + "."
    return "The energisation curve never reaches the full envelope."


def date_basis(ladder: HeadroomLadder, ttp: "TimeToPower | None" = None) -> DateBasis:
    """Classify the time-to-full-capacity figure of a ladder by the evidence behind its lead times.

    A figure whose weakest lead time is an assumption (E0) is not a date: it is an assumed lead time and is
    labelled as one, with the weakest class and the name of the item that sets it."""
    ttp = ttp if ttp is not None else schedule(ladder)
    got = full_capacity_band(ladder, ttp)
    if got is None:
        cause = no_date_cause(ladder, ttp)
        return (NO_DATE_NOT_DEPLOYABLE if cause == CAUSE_NOT_DEPLOYABLE
                else NO_DATE_LEAD_TIME_MISSING if cause == CAUSE_LEAD_TIME_MISSING else NO_DATE)
    item = ttp.critical_item if ttp.critical_item and ttp.critical_item != "—" else None
    return date_basis_of(got[3], item)


def date_basis_of(cls: EvidenceClass, item: str | None) -> DateBasis:
    """The same classification from a recorded class and item name (a stored state, a change note)."""
    if cls <= EvidenceClass.E0_ASSUMPTION:
        return DateBasis(DATE_BASIS_ASSUMED, cls.short, item,
                         f"{ASSUMED_DATE_LABEL} ({cls.short}" + (f"; set by {item.lower()}" if item else "") + ")")
    return DateBasis(DATE_BASIS_SUPPORTED, cls.short, item,
                     f"lead times of class {cls.short} at best" + (f"; set by {item.lower()}" if item else ""))


def schedule_complete(ladder: HeadroomLadder) -> bool:
    """True when every relief taken has a lead time and every equipment bank was declared. A missing lead time
    is not 'zero weeks': ``schedule`` would treat it as such and understate the date, so an incomplete schedule
    yields no date at all. An undeclared bank is the same gap one step earlier: its reliefs were never taken, so
    never timed."""
    return ladder.critical_path_complete


def full_capacity_band(ladder: HeadroomLadder, ttp: TimeToPower
                       ) -> tuple[float, float, float, EvidenceClass] | None:
    """(weeks, low, high, class) to reach the full envelope, from the lead times that set it.

    None when no rack is deployable or the schedule is incomplete: there is then no defensible date."""
    if not ttp.max_racks or not schedule_complete(ladder):
        return None
    for p, (w, lo, hi, cls) in zip(ttp.points, elapsed_bands(ladder)):
        if p.racks >= ttp.max_racks:
            return (p.weeks, lo, hi, cls)
    return None


@dataclass
class TimeToPowerComparison:
    baseline_label: str
    option_label: str
    baseline: TimeToPower
    option: TimeToPower

    @property
    def weeks_saved(self) -> float | None:
        a, b = self.baseline.weeks_to_full, self.option.weeks_to_full
        if a is None or b is None:
            return None
        return a - b

    @property
    def racks_gained(self) -> int:
        return self.option.max_racks - self.baseline.max_racks


def compare(baseline_label: str, baseline: HeadroomLadder,
            option_label: str, option: HeadroomLadder) -> TimeToPowerComparison:
    return TimeToPowerComparison(baseline_label, option_label,
                                 schedule(baseline), schedule(option))


# --- the record behind a projected date -----------------------------------------------------------------------------------
#
# A date that cannot say what sets it, where its lead time came from, how sure it is, what is missing and what the model
# leaves out is a number, not a finding. ``date_record`` is the one place that says all of it; the model pack and the
# comparison both carry it, so no renderer has to rebuild the answer from scattered keys.

#: Bumped whenever the way a date is derived (not merely worded) changes. Version 1: every relief taken starts together
#: (all parallel); elapsed time is the longest lead time; the interval is the longest low and longest high.
CALCULATION_VERSION = "gridforge.time_to_power/1"
DEPENDENCY_MODEL = "all_parallel"

LEAD_SOURCE_SUPPLIED = "customer_supplied_unverified"
LEAD_SOURCE_LIBRARY = "library_placeholder"
LEAD_SOURCE_MISSING = "missing"
LEAD_SOURCE_UNKNOWN = "not_determined"   # no intake document was given, so supplied cannot be told from library

LEAD_SOURCE_LABELS = {
    LEAD_SOURCE_SUPPLIED: "customer-supplied (unverified)",
    LEAD_SOURCE_LIBRARY: "library placeholder",
    LEAD_SOURCE_MISSING: "missing",
    LEAD_SOURCE_UNKNOWN: "source not determined",
}

#: The dependency limitation, verbatim wherever a date is recorded. The intake has no field that says one relief must wait
#: for another, so the model cannot do otherwise; it says so instead of implying a sequence it does not know.
SCHEDULE_LIMITATION = (
    "Reliefs are assumed to start together and run in parallel, so the date is the longest single lead time. No dependency "
    "between reliefs is modelled (the intake carries none), so a chain of works that must run one after another would take "
    "longer than this. Every lead time here is an assumption (E0), whether a library placeholder or a figure the customer "
    "supplied: none is a manufacturer's quotation or a delivery commitment. The interval is the longest low and the longest "
    "high among the lead times taken, a generic tolerance, not a statistical confidence interval.")

#: Library default for a transformer lead time (the loader's placeholder; also the fallback in power/constraints.py).
_TRANSFORMER_PLACEHOLDER_WEEKS = 160.0


def _doc_list(document, key):
    items = document.get(key) if isinstance(document, dict) else None
    return [i for i in items if isinstance(i, dict)] if isinstance(items, list) else []


def step_lead_source(step, document: dict | None) -> str:
    """Where a taken step's lead time came from, read from the intake document: ``customer_supplied_unverified`` when the
    customer typed the figure, ``library_placeholder`` when the engine's own default stands in, ``missing`` when there is
    none, ``not_determined`` when no document was given (never guessed).

    The engine classes both of the first two E0 (intake/loader.py builds a supplied transformer lead time with ASSUMED; the
    library values in power/, thermal/ and site/ constraints are ASSUMED too). This reads the source; it does not raise
    the class. Only the transformer bank (the slowest bank sets the date) and behind-the-meter options accept a supplied
    lead time; every other relief lead time is a library figure."""
    lt = step.lead_time_weeks
    if lt is None:
        return LEAD_SOURCE_MISSING
    if document is None:
        return LEAD_SOURCE_UNKNOWN
    if step.binding_id == "transformer_capacity":
        vals = []
        for bank in _doc_list(document, "transformers"):
            raw = bank.get("replacement_lead_time_weeks")
            ok = isinstance(raw, (int, float)) and not isinstance(raw, bool)
            vals.append((float(raw) if ok else _TRANSFORMER_PLACEHOLDER_WEEKS, ok))
        if not vals:
            return LEAD_SOURCE_LIBRARY
        top_val, top_supplied = vals[0]
        for val, supplied in vals[1:]:
            if val > top_val:                       # the first bank among equals, as the constraint picks it
                top_val, top_supplied = val, supplied
        if abs(top_val - lt.value) > 1e-9:
            return LEAD_SOURCE_UNKNOWN              # the document and the solved value disagree: say so, do not guess
        return LEAD_SOURCE_SUPPLIED if top_supplied else LEAD_SOURCE_LIBRARY
    for opt in _doc_list(document, "btm_options"):
        oid = str(opt.get("id", opt.get("kind", "BTM")))
        if lt.prov.label == f"{oid} lead time" and opt.get("lead_time_weeks") is not None:
            return LEAD_SOURCE_SUPPLIED
    return LEAD_SOURCE_LIBRARY


def date_record(ladder: HeadroomLadder, ttp: TimeToPower | None = None, document: dict | None = None) -> dict:
    """Everything that stands behind a projected date, as plain data.

    Keys: ``status`` (dated | no_deployable_racks | lead_time_missing | no_date), ``controlling_component`` (the item
    whose lead time sets the date, None when undated), ``tied_components`` (other items with the same lead time: the date
    does not depend on which is named), ``lead_time_source`` and ``lead_time_source_label`` of that item,
    ``evidence_class`` (the weakest behind the date, unchanged by the source), ``date_interval_weeks`` ({low, high} or
    None), ``missing_inputs``, ``dependency_model``, ``limitation`` and ``calculation_version``."""
    ttp = ttp if ttp is not None else schedule(ladder)
    taken = ladder.taken_steps
    missing = [f"not declared: {b}" for b in ladder.unassessed_banks]
    missing += [f"lead time: {s.binding_name}" for s in taken if s.lead_time_weeks is None]
    got = full_capacity_band(ladder, ttp)
    if not ttp.max_racks:
        status = "no_deployable_racks"
    elif missing:
        status = "lead_time_missing"
    elif got is None:
        status = "no_date"
    else:
        status = "dated"
    controlling = tied = src = None
    if status == "dated":
        controlling = ttp.critical_item
        ctrl = next((s for s in taken if s.binding_name == controlling and s.lead_time_weeks is not None
                     and s.lead_time_weeks.value == ttp.critical_weeks), None)
        if ctrl is not None:
            src = step_lead_source(ctrl, document)
        else:
            src = LEAD_SOURCE_LIBRARY if controlling == ASSUMED_CDU_KIT_ITEM else LEAD_SOURCE_UNKNOWN
        tied = sorted({s.binding_name for s in taken if s.lead_time_weeks is not None
                       and s.lead_time_weeks.value == ttp.critical_weeks and s.binding_name != controlling})
    limitation = SCHEDULE_LIMITATION
    if src == LEAD_SOURCE_SUPPLIED:
        limitation += (f" The lead time that sets the date is {LEAD_SOURCE_LABELS[src]}: typed by the customer, not checked "
                       "against a written quotation.")
    elif src == LEAD_SOURCE_LIBRARY:
        limitation += f" The lead time that sets the date is a {LEAD_SOURCE_LABELS[src]}, not the customer's figure."
    if ttp.floored_by_cdu_kit and ladder.unassessed_banks:
        limitation += (" The CDU kit is assumed, so no rack is dated earlier than the library CDU lead time; but NO date is given here, because "
                       "not declared: " + ", ".join(ladder.unassessed_banks) + " (the reliefs those banks would need are neither priced nor "
                       "timed, so any date would be a lower bound). A date is only given for the CDU kit alone when every bank is declared.")
    elif ttp.floored_by_cdu_kit:
        limitation += (" No rack is dated earlier than the library CDU lead time, and the first-rack date rests on it (an assumption: the intake "
                       "declares no CDUs, so the scenario assumes a kit); the kit's commissioning and the conversion works are not in the schedule.")
    return {
        "status": status,
        "controlling_component": controlling,
        "tied_components": tied,
        "lead_time_source": src,
        "lead_time_source_label": LEAD_SOURCE_LABELS.get(src) if src else None,
        "evidence_class": got[3].short if got is not None else None,
        "date_interval_weeks": {"low": got[1], "high": got[2]} if got is not None else None,
        "missing_inputs": missing,
        "dependency_model": DEPENDENCY_MODEL,
        "limitation": limitation,
        "calculation_version": CALCULATION_VERSION,
    }
