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
from dataclasses import dataclass, field
from typing import Any

from .envelope.time_to_power import schedule
from .intake.loader import load_document
from .scenario.objective import Objective, pick_recommended
from .scenario.run import ScenarioResult, run_all

MAX_DRIVERS_PROBED = 40   # a sanity bound; a hall with more changes is a new study


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

    @staticmethod
    def of(res: ScenarioResult) -> "EnvelopeState":
        t = schedule(res.ladder)
        final = res.ladder.final or res.envelope
        return EnvelopeState(
            racks_as_found=res.envelope.max_racks,
            racks_after_ladder=res.unlocked_racks,
            binding_id=res.envelope.binding.id,
            binding_name=res.envelope.binding.name,
            binding_basis=res.envelope.binding.basis,
            weeks_to_full=t.weeks_to_full,
            sets_the_date=t.critical_item,
            capex_eur=res.economics.capex_total_eur.value,
            it_load_kW=final.it_load_kW.value,
            scenario_id=res.spec.id,
            scenario_name=res.spec.name,
        )


@dataclass
class Driver:
    path: str
    before: Any
    after: Any
    racks_delta: int
    flips_binding_to: str | None = None

    @property
    def material(self) -> bool:
        return self.racks_delta != 0 or self.flips_binding_to is not None


@dataclass
class EnvelopeDiff:
    before: EnvelopeState
    after: EnvelopeState
    drivers: list[Driver] = field(default_factory=list)
    changed_paths: list[str] = field(default_factory=list)
    unprobed: list[str] = field(default_factory=list)
    recommendation_changed: tuple[str, str] | None = None

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
    def material(self) -> bool:
        return bool(self.racks_delta or self.binding_moved
                    or (self.weeks_delta or 0) or self.recommendation_changed)

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
        head = "; ".join(bits)
        return head[:1].upper() + head[1:] + "."


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
    return EnvelopeDiff(before=previous, after=EnvelopeState.of(same))


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

    d = EnvelopeDiff(before=EnvelopeState.of(rec_before), after=EnvelopeState.of(after_same))
    if rec_after.spec.id != rec_before.spec.id:
        d.recommendation_changed = (rec_before.spec.name, rec_after.spec.name)

    d.changed_paths = changed_paths(before_doc, after_doc)
    if not attribute or not d.changed_paths:
        return d

    probe = d.changed_paths[:MAX_DRIVERS_PROBED]
    d.unprobed = d.changed_paths[MAX_DRIVERS_PROBED:]
    fa, fb = flatten(after_doc), flatten(before_doc)
    base = d.before.racks_after_ladder

    for path in probe:
        if path not in fa:
            continue                      # a removed input is reported, not probed
        trial = copy.deepcopy(before_doc)
        try:
            _set_path(trial, path, _unwrap(fa[path]))
            one, all_one = _solve(trial, objective)
            same = _by_id(all_one, pin) or one
        except Exception:
            continue                      # an input that cannot stand alone is not a driver
        st = EnvelopeState.of(same)
        d.drivers.append(Driver(
            path=path,
            before=_unwrap(fb.get(path)),
            after=_unwrap(fa[path]),
            racks_delta=st.racks_after_ladder - base,
            flips_binding_to=(st.binding_name if st.binding_id != d.before.binding_id else None),
        ))

    d.drivers.sort(key=lambda x: (-abs(x.racks_delta), x.path))
    return d
