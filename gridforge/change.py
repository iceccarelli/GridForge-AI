"""What changed, and which input changed it.

A study is a photograph. A hall is not: contracted power moves, tenancy frees up,
the tenant's platform changes, a quotation lands. The client's real question six
months later is not "solve it again" — it is **"what moved, and why."**

Nobody else can answer that, because nobody else is holding the model. That is the
basis for charging on a cadence rather than per document, and it is an honest
recurring need rather than a subscription wrapped around bespoke work.

The attribution is a one-at-a-time contribution analysis: re-solve the old hall with
exactly one input moved to its new value, and the change in the answer is that
input's contribution. Contributions do not sum to the total when constraints
interact, so the residual is reported rather than hidden — a driver table that
silently adds up to the wrong number is worse than no driver table.
"""
from __future__ import annotations

import copy
import hashlib
import json
from dataclasses import dataclass, field
from typing import Any

from .costs import library
from .envelope.solver import rack_evidence
from .envelope.time_to_power import full_capacity_band, schedule, schedule_complete
from .intake.loader import load_document
from .scenario.objective import Objective, pick_recommended
from .scenario.run import ScenarioResult, run_all

MAX_DRIVERS_PROBED = 40   # a sanity bound; a hall with more changes is a new study


def _digest(rows) -> str:
    return hashlib.sha256(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()[:16]


def intake_digest(doc: dict) -> str:
    """Fingerprint of the physics inputs of an intake (notes and project metadata excluded)."""
    flat = {k: _unwrap(v) for k, v in flatten(doc).items()
            if not (k.startswith("project.") or k == "scenarios")}
    return _digest(sorted(flat.items()))


def declared_evidence(doc: Any, prefix: str = "") -> dict[str, str]:
    """{path: evidence class the client declared} for every wrapped input. flatten() deliberately
    treats the wrapper as one leaf, so without this an upgrade from an assumption to a client-supplied
    measurement was invisible: same value, same digest, 'nothing changed'."""
    out: dict[str, str] = {}
    if isinstance(doc, dict):
        if "value" in doc:
            if doc.get("evidence"):
                out[prefix] = str(doc["evidence"]).upper()[:2]
            return out
        for k, v in doc.items():
            out.update(declared_evidence(v, f"{prefix}.{k}" if prefix else k))
    elif isinstance(doc, list):
        for i, v in enumerate(doc):
            out.update(declared_evidence(v, f"{prefix}[{i}]"))
    return {k: v for k, v in out.items() if not (k.startswith("project.") or k == "scenarios")}


def evidence_digest(doc: dict) -> str:
    ev = declared_evidence(doc)
    return _digest(sorted(ev.items())) if ev else ""


#: A capex movement this large is a change to the investment case even when the (wide, screening-class)
#: uncertainty bands still overlap; below it the note may call the movement noise.
CAPEX_MATERIAL_FRACTION = 0.10


def price_basis_digest() -> str:
    """Fingerprint of the recorded prices (cost library) a solve rests on. A new quotation changes it."""
    return _digest(sorted((e.key, e.value, e.basis, e.valid_until or "", e.stale)
                          for e in library().entries.values()))


def relief_path_digest(res: ScenarioResult) -> str:
    """Fingerprint of the relief path and the lead times along it, independent of rack counts."""
    return _digest([(st.binding_id, st.relief_description, st.cost_key, st.taken,
                     None if st.lead_time_weeks is None else (st.lead_time_weeks.value, st.lead_time_weeks.band))
                    for st in res.ladder.steps])


@dataclass
class EnvelopeState:
    racks_as_found: int
    racks_after_ladder: int
    binding_id: str
    binding_name: str
    binding_basis: str
    weeks_to_full: float | None
    sets_the_date: str
    capex_eur: float
    it_load_kW: float
    scenario_id: str
    scenario_name: str
    # Provenance of the figures above. All optional so a state recorded before they existed still loads;
    # an empty value means "not recorded", which a change note must say rather than guess.
    racks_class: str = ""                  # EvidenceClass name of the rack count
    weeks_lo: float | None = None
    weeks_hi: float | None = None
    weeks_class: str = ""
    schedule_complete: bool = True         # False: a relief taken has no lead time, so no date is given
    capex_lo: float | None = None
    capex_hi: float | None = None
    capex_class: str = ""
    capex_complete: bool = True            # False: a relief taken has no price, so capex is a lower bound
    intake_digest: str = ""
    evidence_digest: str = ""
    price_basis_digest: str = ""
    relief_path_digest: str = ""

    @staticmethod
    def of(res: ScenarioResult, doc: dict | None = None) -> "EnvelopeState":
        t = schedule(res.ladder)
        final = res.ladder.final or res.envelope
        full = full_capacity_band(res.ladder, t)       # (weeks, lo, hi, class) | None
        rack_cls = min([rack_evidence(res.envelope)] + ([rack_evidence(res.ladder.final)] if res.ladder.final else []))
        complete = schedule_complete(res.ladder)
        cap = res.economics.capex_total_eur
        return EnvelopeState(
            racks_as_found=res.envelope.max_racks,
            racks_after_ladder=res.unlocked_racks,
            binding_id=res.envelope.binding.id,
            binding_name=res.envelope.binding.name,
            binding_basis=res.envelope.binding.basis,
            weeks_to_full=full[0] if full is not None else None,
            sets_the_date=t.critical_item,
            capex_eur=cap.value,
            it_load_kW=final.it_load_kW.value,
            scenario_id=res.spec.id,
            scenario_name=res.spec.name,
            racks_class=rack_cls.name,
            weeks_lo=full[1] if full is not None else None,
            weeks_hi=full[2] if full is not None else None,
            weeks_class=full[3].name if full is not None else "",
            schedule_complete=complete,
            capex_lo=cap.band[0], capex_hi=cap.band[1], capex_class=cap.evidence.name,
            capex_complete=res.economics.capex_complete,
            intake_digest=intake_digest(doc) if doc is not None else "",
            evidence_digest=evidence_digest(doc) if doc is not None else "",
            price_basis_digest=price_basis_digest(),
            relief_path_digest=relief_path_digest(res),
        )


@dataclass
class Driver:
    path: str
    before: Any
    after: Any
    racks_delta: int
    flips_binding_to: str | None = None
    racks_class: str = ""     # weakest rack-count class of the baseline and of this one-input trial

    @property
    def material(self) -> bool:
        return self.racks_delta != 0 or self.flips_binding_to is not None


@dataclass
class EnvelopeDiff:
    before: EnvelopeState
    after: EnvelopeState
    drivers: list[Driver] = field(default_factory=list)
    changed_paths: list[str] = field(default_factory=list)
    unprobed: list[str] = field(default_factory=list)       # beyond the probe cap: never re-solved alone
    unprobeable: list[str] = field(default_factory=list)    # removed, or cannot stand alone: no contribution exists
    recommendation_changed: tuple[str, str] | None = None
    #: Did the customer's inputs change? "changed" | "unchanged" (verified) | "unknown" (the earlier inputs
    #: were not recorded, so a change cannot be ruled in or out and must not be attributed to either side).
    inputs: str = "unknown"
    #: What on OUR side differs from the recorded run, when it can be told: "prices", "relief path",
    #: "constraint model". Empty when nothing differs or when the earlier run recorded no fingerprint.
    drift: list[str] = field(default_factory=list)
    drift_known: bool = False
    #: Inputs whose declared evidence class changed while their value did not (or alongside it).
    evidence_changes: list[str] = field(default_factory=list)
    #: Evidence digest differs between two recorded states (paths unknown when only digests were kept).
    evidence_digest_changed: bool = False

    @property
    def racks_delta(self) -> int:
        return self.after.racks_after_ladder - self.before.racks_after_ladder

    @property
    def weeks_delta(self) -> float | None:
        a, b = self.before.weeks_to_full, self.after.weeks_to_full
        return None if (a is None or b is None) else b - a

    @property
    def capex_delta(self) -> float:
        return self.after.capex_eur - self.before.capex_eur

    @property
    def binding_moved(self) -> bool:
        return self.before.binding_id != self.after.binding_id

    @property
    def explained(self) -> int:
        return sum(d.racks_delta for d in self.drivers)

    @property
    def residual(self) -> int:
        """What the single-input probes do not account for. Non-zero means the
        constraints interacted, which is normal and must be said out loud."""
        return self.racks_delta - self.explained

    @property
    def capex_moved(self) -> bool:
        a = self.before.capex_eur
        if a <= 0:
            return self.after.capex_eur > 0
        return abs(self.capex_delta) / a >= CAPEX_MATERIAL_FRACTION

    @property
    def evidence_moved(self) -> bool:
        return bool(self.evidence_changes or self.evidence_digest_changed
                    or (self.before.racks_class and self.after.racks_class
                        and self.before.racks_class != self.after.racks_class)
                    or (self.before.capex_class and self.after.capex_class
                        and self.before.capex_class != self.after.capex_class))

    @property
    def material(self) -> bool:
        return bool(self.racks_delta or self.binding_moved
                    or (self.weeks_delta or 0) or self.recommendation_changed
                    or self.capex_moved or self.evidence_moved)

    def headline(self) -> str:
        if not self.material:
            return ("Nothing that changes the answer. The envelope, the binding constraint "
                    "and the date all hold.")
        bits = []
        if self.racks_delta:
            bits.append(f"{self.racks_delta:+d} racks "
                        f"({self.before.racks_after_ladder} to {self.after.racks_after_ladder})")
        if self.binding_moved:
            bits.append(f"what binds first moved from {self.before.binding_name.lower()} "
                        f"to {self.after.binding_name.lower()}")
        w = self.weeks_delta
        if w:
            bits.append(f"{w:+.0f} weeks to full capacity")
        if self.recommendation_changed:
            bits.append("the recommended architecture changed to "
                        f"{self.recommendation_changed[1]}")
        if self.capex_moved:
            bits.append(f"indicative capex moved {self.capex_delta / 1e6:+.1f} M EUR "
                        f"({self.before.capex_eur / 1e6:.1f} to {self.after.capex_eur / 1e6:.1f})")
        if self.evidence_moved:
            bits.append("the evidence behind the answer changed (an input was upgraded or downgraded)")
        head = "; ".join(bits)
        return head[:1].upper() + head[1:] + "."


def _weaker(a: str, b: str) -> str:
    """The weaker of two recorded evidence-class names ("" = not recorded, which is never a claim)."""
    from .validation import EvidenceClass
    names = [n for n in (a, b) if n in EvidenceClass.__members__]
    return min(names, key=lambda n: EvidenceClass[n]) if names else ""


# --- flattening --------------------------------------------------------------
def _unwrap(v: Any) -> Any:
    return v["value"] if isinstance(v, dict) and "value" in v else v


def flatten(doc: Any, prefix: str = "") -> dict[str, Any]:
    """Leaf paths of an intake document. A {"value": x, "note": ...} wrapper is a
    single leaf, not a subtree — the note is provenance, not an input."""
    out: dict[str, Any] = {}
    if isinstance(doc, dict):
        if "value" in doc:
            out[prefix] = doc["value"]
            return out
        for k, v in doc.items():
            out.update(flatten(v, f"{prefix}.{k}" if prefix else k))
    elif isinstance(doc, list):
        for i, v in enumerate(doc):
            out.update(flatten(v, f"{prefix}[{i}]"))
    else:
        out[prefix] = doc
    return out


def _set_path(doc: dict, path: str, value: Any) -> None:
    parts: list[Any] = []
    for seg in path.split("."):
        while "[" in seg:
            name, rest = seg.split("[", 1)
            if name:
                parts.append(name)
            idx, seg = rest.split("]", 1)
            parts.append(int(idx))
        if seg:
            parts.append(seg)
    cur: Any = doc
    for p in parts[:-1]:
        if isinstance(p, int):
            while len(cur) <= p:
                cur.append({})
            cur = cur[p]
        else:
            if not isinstance(cur.get(p), (dict, list)):
                cur[p] = {}
            cur = cur[p]
    last = parts[-1]
    if isinstance(last, int):
        while len(cur) <= last:
            cur.append(None)
        cur[last] = value
    else:
        existing = cur.get(last) if isinstance(cur, dict) else None
        if isinstance(existing, dict) and "value" in existing:
            existing["value"] = value
        else:
            cur[last] = value


def changed_paths(before: dict, after: dict) -> list[str]:
    fb, fa = flatten(before), flatten(after)
    out = []
    for k in sorted(set(fb) | set(fa)):
        if k.startswith("project.") or k == "scenarios":
            continue        # metadata, not an input to the physics
        if _unwrap(fb.get(k)) != _unwrap(fa.get(k)):
            out.append(k)
    return out


# --- the diff ----------------------------------------------------------------
def _solve(doc: dict, objective: Objective) -> tuple[ScenarioResult, list[ScenarioResult]]:
    intake = load_document(copy.deepcopy(doc))
    results = run_all(intake.context, intake.scenarios)
    return pick_recommended(results, objective), results


def _by_id(results: list[ScenarioResult], scenario_id: str) -> ScenarioResult | None:
    return next((r for r in results if r.spec.id == scenario_id), None)


def diff_from_state(previous: EnvelopeState, after_doc: dict, *,
                    objective: Objective = Objective.MAX_COMPUTE) -> EnvelopeDiff:
    """Compare a recorded answer against the hall solved today.

    A watch needs this: when nothing in the intake has moved but our own libraries
    or the constraint set have, the answer can still change — and the client is
    entitled to hear that from us rather than discover it. With no changed inputs
    there are no drivers, and the change note says plainly that the movement came
    from our side.
    """
    _, all_after = _solve(after_doc, objective)
    same = _by_id(all_after, previous.scenario_id)
    if same is None:
        rec, _ = _solve(after_doc, objective)
        same = rec
    now = EnvelopeState.of(same, after_doc)
    d = EnvelopeDiff(before=previous, after=now)
    if previous.intake_digest:
        d.inputs = "unchanged" if previous.intake_digest == now.intake_digest else "changed"
    if previous.evidence_digest or now.evidence_digest:
        if previous.evidence_digest != now.evidence_digest:
            d.evidence_digest_changed = True
            d.inputs = "changed"
    if d.inputs == "unchanged" and previous.price_basis_digest and previous.relief_path_digest:
        # The customer's inputs are verifiably the same, so any movement is ours. Say which part differs.
        d.drift_known = True
        if previous.price_basis_digest != now.price_basis_digest:
            d.drift.append("prices")
        if previous.relief_path_digest != now.relief_path_digest:
            d.drift.append("relief path")
        if d.material and not d.drift:
            d.drift.append("constraint model")
    return d


def diff(before_doc: dict, after_doc: dict, *,
         objective: Objective = Objective.MAX_COMPUTE,
         attribute: bool = True) -> EnvelopeDiff:
    rec_before, _ = _solve(before_doc, objective)
    rec_after, all_after = _solve(after_doc, objective)

    # Compare like for like: the same scenario in both, so a change in the answer is
    # a change in the hall rather than a change of subject. A change in which
    # architecture is recommended is reported separately, because it is its own news.
    pin = rec_before.spec.id
    after_same = _by_id(all_after, pin) or rec_after

    d = EnvelopeDiff(before=EnvelopeState.of(rec_before, before_doc),
                     after=EnvelopeState.of(after_same, after_doc))
    if rec_after.spec.id != rec_before.spec.id:
        d.recommendation_changed = (rec_before.spec.name, rec_after.spec.name)

    d.changed_paths = changed_paths(before_doc, after_doc)
    eb, ea = declared_evidence(before_doc), declared_evidence(after_doc)
    d.evidence_changes = sorted(k for k in set(eb) | set(ea) if eb.get(k) != ea.get(k))
    d.inputs = "changed" if (d.changed_paths or d.evidence_changes) else "unchanged"
    d.drift_known = True          # both solved by this engine, now: nothing on our side differs between them
    if not attribute or not d.changed_paths:
        return d

    probe = d.changed_paths[:MAX_DRIVERS_PROBED]
    d.unprobed = d.changed_paths[MAX_DRIVERS_PROBED:]
    fa, fb = flatten(after_doc), flatten(before_doc)
    base = d.before.racks_after_ladder

    for path in probe:
        if path not in fa:
            d.unprobeable.append(path)    # a removed input has no "new value" to move it to
            continue
        trial = copy.deepcopy(before_doc)
        try:
            _set_path(trial, path, _unwrap(fa[path]))
            one, all_one = _solve(trial, objective)
            same = _by_id(all_one, pin) or one
        except Exception:
            d.unprobeable.append(path)    # an input that cannot stand alone is not a driver, and is said so
            continue
        st = EnvelopeState.of(same)
        d.drivers.append(Driver(
            path=path,
            before=_unwrap(fb.get(path)),
            after=_unwrap(fa[path]),
            racks_delta=st.racks_after_ladder - base,
            flips_binding_to=(st.binding_name if st.binding_id != d.before.binding_id else None),
            racks_class=_weaker(d.before.racks_class, st.racks_class),
        ))

    d.drivers.sort(key=lambda x: (-abs(x.racks_delta), x.path))
    return d
