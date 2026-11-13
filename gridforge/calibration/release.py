"""Release differencing resistance: what may be PUBLISHED twice about the same observations (review R4).

Pure functions and constants. Nothing here does I/O, reads a clock or draws a random number: every function takes what it needs and returns the same
answer for the same input. ``publication.py`` says which single figures may leave the building; this says when a SECOND set of figures may follow a first.

THE ATTACK. A published aggregate is a function of the set of observations behind it. A reader who keeps release A (n observations) and release B (the same
set plus one) computes (n+1) x mean_B - n x mean_A and has the new observation, to the rounding of the figures. Rounding (``publication.PUBLIC_SIG_FIGS``) only
blunts it. The same holds inside one release: a cell and its parent differ by the other cells, and a withheld cell is the parent minus the published ones.
The reader needs no model of the data: only the sums, and which observations are in which sum. Anything that leaves the set of published sums such that the
sum over a small group of observations can be recovered is a leak, however the sums were reached. And the reader is not a stranger: an organisation knows its OWN
observations, and subtracts them. A proof that only asks whether one small group is recoverable on its own misses a sum over TWO small groups (cells p = U + a,
q = V + b and r = U + V give p + q - r = a + b: the organisation that owns b reads a off it).

THE RULE, in four parts, all of which must hold for a release to be made:

  1. SAFE CELLS. A published cell rests on at least ``MIN_CELL_OBSERVATIONS`` (K) observations from at least ``MIN_CELL_ORGANISATIONS`` (M) distinct
     organisations, and no organisation supplies more than ``MAX_ORGANISATION_SHARE`` of them. A consent may ask for more (its floors ride on each
     observation, see ``Contribution``); never for less. This is separate from, and in addition to, ``publication.PUBLIC_MIN_SITES`` (distinct SITES),
     which the report builder applies: a cell must pass both.
  2. A STEP BETWEEN RELEASES. Compare the new release with EVERY earlier one (superseded ones included: the reader still holds them), and every published
     cell with every other published set. What the two differ by, in either direction, is what a reader learns. The LARGER of the two differences is the one a
     reader cannot know, and it must itself be a safe group of ``RELEASE_STEP_OBSERVATIONS`` observations from ``RELEASE_STEP_ORGANISATIONS`` organisations. So a
     release with one observation more fails, a swap of one for one fails, and a release that only removes a withdrawn organisation's few observations fails
     until enough new ones have joined to hide them. A membership identical to the last release is not a new release at all (``unchanged``).
  3. NO LINEAR LEAK, against an organisation (or a coalition below M) that knows its own observations. Over the whole collection of published sets (every
     earlier release's cells and this one's) call an ATOM a class of observations that lie in exactly the same published sets: no sum tells them apart, so
     everything a reader derives is a sum over whole atoms. The release is refused if adding and subtracting published sums
       (a) reads off the own sum of an atom that is not a safe group by itself (the earlier proof's whole test), or
       (b) lets a coalition of at most ``MAX_COALITION`` = M - 1 organisations, each knowing exactly its own observations and nothing else, isolate ONE observation of
           another organisation: the atom holds exactly one observation outside the coalition, and some combination of the published sums is supported on that
           atom and on atoms the coalition owns entirely. (Cells p = U + a, q = V + b and r = U + V give p + q - r = a + b: the owner of b reads a. (a) does not see it.)
     Both are decided exactly, in integer arithmetic, over a reduced echelon basis kept per ATOM and grown one published set at a time (``_Space``), so the cost
     follows the number of atoms, not of releases (``MAX_PROOF_ATOMS``).
     WHY NOT "THE ATTACKER KNOWS EVERY OTHER SMALL ATOM". That is the stronger model the review proposed (an atom is exposed if its unit vector is in the row space
     plus the unit vectors of all the other small atoms). It was built, and it is too strong for the releases this policy must make: a withdrawal cuts the groups
     published before it into the withdrawn few (one organisation's, small) and the rest (often below ten), the model then treats both pieces as known although
     nothing new was published about them, and EVERY later release is refused for ever (a simulated history stopped releasing at the first withdrawal; run
     ``gridforge``'s tests/test_release_differencing.py::test_a_twenty_year_monthly_history_still_releases... against it to see). Knowledge is therefore given to
     organisations, which is also what the module's threat model always said ("a participant who knows only its own observations").  4. A CADENCE. No release sooner than ``MIN_RELEASE_INTERVAL`` after the previous one, so that when observations join one at a time the reader still sees at
     most one difference a month, and a reader who submits observations cannot choose when to look.

THE CONSTANTS, and why these numbers (all named, all pinned by tests/test_release_differencing.py, none below the existing floors in ``residuals``):

  K = 10  MIN_CELL_OBSERVATIONS   equal to ``residuals.MIN_APPROVED_OBSERVATIONS``. The attacker we defend against is a participant who knows only its own
                                  observations: it subtracts them and is left with a sum over at least 10 minus its own. K = 10 and the share cap below leave
                                  at least six unknown observations.
  M = 3   MIN_CELL_ORGANISATIONS  equal to ``residuals.MIN_DISTINCT_SITES``. One attacking organisation leaves at least two others whose figures it cannot
                                  separate. An organisation owns one or more sites, so M organisations is at least as strict as M sites.
  0.4     MAX_ORGANISATION_SHARE  ``publication.MAX_SINGLE_SITE_SHARE``: with K and M, ten observations split 4/3/3 pass and 5/3/2 do not; an organisation that
                                  supplies half of a cell IS the cell.
  10, 3   RELEASE_STEP_*          the difference of two releases is itself an aggregate a reader receives, so it is held to the cell floors. Never lower.
  30 days MIN_RELEASE_INTERVAL    monthly; a policy choice, not a derived one. It bounds how often a difference exists, and the step bounds how small it is.

WHAT RULE 3 PROVES, AND ONLY THAT
  Attacker model: a reader who sees every published sum EXACTLY (no rounding), knows which observations are in which sum, and knows the value of every observation
  of at most M - 1 = 2 organisations (a single organisation is the common case) and nothing else. Claim: if rule 3 holds, no such reader determines the value of
  any observation of another organisation, and no atom smaller than a safe group has a sum that anyone can read off. Proof sketch: whatever a reader derives is
  constant on an atom, so it can determine one observation x only if x's atom has x as its only member outside the coalition and the unit vector of that atom is a
  combination of published sums and of atoms the coalition owns entirely, which is exactly what (b) searches for, atom by atom and coalition by coalition. It is
  checked at every release against every earlier published set, so it is a statement about the whole history. Checked: tests/test_release_differencing.py compares
  the incremental proof with the same definition written again from scratch at the level of single observations (exact fractions, no atoms, no basis) on random
  families of sets, runs an independent exact attacker (at the level of observations, written without this module) against seeded runs of the policy, and shows
  that the same attacker finds leaks in the same runs when the proof is reduced to (a) (4 of 150 seeds of the review's sweep).
  Measured, and its limits: a twenty-year monthly history (240 decisions, breakdown cells offered every month, a withdrawal a year) keeps releasing, with a few
  hundred atoms and a decision in well under a second; the cost grows with the number of atoms and the coalitions to try (organisations choose M - 1), roughly
  quadratically in atoms for a decision, which ``MAX_PROOF_ATOMS`` bounds. The proof's own refusals are availability, never a pass.

WHAT THIS DOES NOT DEFEND AGAINST (stated, not hidden)
  * A coalition of M OR MORE organisations. Organisations that between them know every observation in a published difference but one can solve for the last (the
    same limit ``publication.py`` states for sites). Rule 3 makes the coalition that is needed at least M organisations (``MAX_COALITION`` is one fewer); the step
    makes the difference large. Three organisations that own all but one observation of a safe group, between them, are not stopped.
  * AN ATTACKER WHO KNOWS OBSERVATIONS OF ORGANISATIONS IT DOES NOT BELONG TO (a leaked file, a supplier that serves several organisations). Rule 3 gives knowledge
    to organisations only, as above; a reader who also knows an arbitrary small group (the review's stronger model) is not covered.
  * TENANT SPLITTING AND SYBIL ORGANISATIONS. M and the share cap count ORGANISATIONS as the registry (0049) knows them. One company that registers itself as
    several organisations (one address can create up to twenty) is counted as several, so it can supply more than 40% of a cell and satisfy M on its own, and a
    coalition of its own tenants is then one attacker holding all but a few of a cell. Nothing in the data reaching this module says which organisations share
    an owner: the rows carry hashes of the organisation and of the observation and the consent floors, not an owner address, so no grouping by owner domain is done
    here, and none is guessed. The operational mitigation (docs/CALIBRATION_GATES_RUNBOOK.md) is the operator's: treat organisations created from one address or
    one e-mail domain as ONE for M and for the 40% cap until verified organisation identity exists, by merging them in the ``organisation`` hash given to
    ``Contribution`` (an operator-chosen grouping key is all this module needs).
  * A CONSENT GIVEN FOR A STRANGER'S PROJECT. A holder of a project's link token who is an owner of an organisation can attach that project to the organisation's hall
    and record the organisation's consent for it (the token is the credential for the project, 0015; the registry does not check the buyer against the
    organisation). The observation is then published under an organisation that is not the project's real owner. The gates cannot tell, and neither can this module.
  * FIGURES THAT ARE NOT UNWEIGHTED SUMS. The proof treats every published figure as the SUM (or the mean, which is the sum over a known count) over its set,
    each observation counting alike. A figure with weights that differ between observations of one atom (a mean of site means, where sites supply different
    numbers of observations) is a different linear functional: the atoms are finer than this module sees, and the claim does not carry over until the weights are
    in the incidence matrix. Rounding is not modelled (it only blunts a recovery).
  * An observation count that is itself small and known (the first release has no predecessor, so it is held only to rule 1).
  * Anything already published before this policy ran. The history passed in is trusted to be complete; a release missing from it is a release the reader
    holds and this cannot see. ``Snapshot.from_record`` refuses a record whose id does not match its content, which catches an edited row, not a missing one.
    An exposure already present in the history is the history's: a new release is charged only for the observations it newly exposes.
  * More atoms than ``MAX_PROOF_ATOMS``. Nothing is proved, so nothing is released: a refusal, not a pass.
  * A withdrawal cannot recall a release already seen. It supersedes it (``supersede``) so it is no longer served, and excludes the withdrawn observations from
    every later one; the difference between the last release containing them and the next is protected by rule 2, not undone.

THE DATABASE HAS A COPY. supabase/migrations/0056 refuses to register a snapshot that breaks rules 1 (as a whole), 2 (on whole memberships) and 4, using the
same numbers (``policy()`` is compared with ``gf_calibration_release_policy()`` by a test). Rule 4 is measured there on the registry's OWN clock (the time it
recorded each snapshot), and the date a caller gives a release is held to within ``MAX_BACKDATE`` of it, so a release cannot be dated to satisfy the cadence.
Rules 1-3 at the level of each cell, and rule 3 across releases, exist here only: run ``propose_release`` before registering anything.

STATUS. Nothing serves a report through this yet: the public report is still recomputed on every request (``publication.py``, HARD PRECONDITION). The
precondition is met only when the route serves ``Proposal.served`` and registers ``Proposal.snapshot``. The ledger holds 0 observations.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import re
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from functools import cached_property
from math import gcd
from typing import Any, Callable, Iterable, Mapping, Sequence

from . import publication as pub
from .tombstones import observation_hash

SCHEMA = "gridforge.calibration.release/1"

#: K: observations a published cell must rest on.
MIN_CELL_OBSERVATIONS = 10
#: M: distinct organisations a published cell must rest on.
MIN_CELL_ORGANISATIONS = 3
#: The most one organisation may supply of a cell. The same share the site rule uses, deliberately: one threshold for "this contributor IS the cell".
MAX_ORGANISATION_SHARE = pub.MAX_SINGLE_SITE_SHARE
#: The step between releases: the larger difference of any two published sets is a group of at least this many observations ...
RELEASE_STEP_OBSERVATIONS = 10
#: ... from at least this many distinct organisations.
RELEASE_STEP_ORGANISATIONS = 3
#: The least time between two releases.
MIN_RELEASE_INTERVAL = timedelta(days=30)
#: A release may be dated a little ahead of the reading clock (clock skew); not further.
CLOCK_SKEW = timedelta(minutes=5)
#: The proof of rule 3 holds one column per ATOM (a class of observations that lie in exactly the same published sets) and at most one basis vector per atom, so its
#: cost follows the number of atoms, not the number of releases. Beyond this many atoms nothing is proved and the release is refused (an availability limit,
#: never a way to release unproved: a twenty-year monthly history of the release shapes this policy lets through stays far below it).
MAX_PROOF_ATOMS = 1000
#: The largest coalition of organisations the proof defends against: one fewer than M, so that "a coalition below M cannot isolate anyone" is the claim. Each
#: member knows its own observations and nothing else.
MAX_COALITION = MIN_CELL_ORGANISATIONS - 1
#: A release is registered within this long of the time it is dated (the registry's own clock decides when it was recorded, see 0056): not back-dated further.
MAX_BACKDATE = timedelta(days=1)

# Decision codes (stable; a caller may branch on them).
OK = "ok"
EMPTY = "empty"
SMALL_CELL = "small_cell"
TOMBSTONED = "tombstoned"
STEP = "step"
LEAK = "leak"
CADENCE = "cadence"
FUTURE = "future"
PROOF_TOO_LARGE = "proof_too_large"
BACKDATED = "backdated"
COMPLEMENT = "complement"

PUBLISH = "publish"
UNCHANGED = "unchanged"
REFUSED = "refused"

_HEX64 = re.compile(r"^[0-9a-f]{64}\Z")
_NAME_MAX = 120


def policy() -> dict[str, int]:
    """The numbers above in the form ``gf_calibration_release_policy()`` returns them in the database (a test compares the two)."""
    return {"min_cell_observations": MIN_CELL_OBSERVATIONS, "min_cell_organisations": MIN_CELL_ORGANISATIONS,
            "max_organisation_share_permille": round(MAX_ORGANISATION_SHARE * 1000),
            "release_step_observations": RELEASE_STEP_OBSERVATIONS, "release_step_organisations": RELEASE_STEP_ORGANISATIONS,
            "min_release_interval_days": MIN_RELEASE_INTERVAL.days}


# ---------------------------------------------------------------------------------------------- identities

# ``observation_hash`` (imported above) is sha256 of the observation id as the database computes it (``gf_calibration_observation_hash``); its first 32
# characters head the source reference of a published ledger row (``ledger.published_source_ref``), so a tombstone matches a ledger row without the id
# being published. It lives in tombstones.py, which the ledger also reads, so there is one definition.

def organisation_hash(organisation_id: str) -> str:
    """sha256 of the organisation id, as the database computes it (``gf_calibration_organisation_hash``)."""
    return hashlib.sha256(f"gridforge.calibration.organisation:{organisation_id}".encode()).hexdigest()


def _hex64(name: str, v: Any) -> str:
    if not isinstance(v, str) or not _HEX64.match(v):
        raise ValueError(f"{name}: must be 64 lowercase hex characters (a sha256), got {v!r}")
    return v


def _floor(name: str, v: Any) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or v < 0:
        raise ValueError(f"{name}: must be a whole number of at least 0, got {v!r}")
    return v


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat(timespec="microseconds").replace("+00:00", "Z")


def _utc(name: str, v: Any) -> datetime:
    if isinstance(v, str):
        try:
            v = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError as e:
            raise ValueError(f"{name}: not an ISO-8601 timestamp") from e
    if not isinstance(v, datetime) or v.tzinfo is None or v.utcoffset() is None:
        raise ValueError(f"{name}: must be a timezone-aware datetime")
    return v.astimezone(timezone.utc)


def _canonical(obj: Any) -> bytes:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=True, allow_nan=False).encode("ascii")


# ---------------------------------------------------------------------------------------------- contributions and groups

@dataclass(frozen=True)
class Contribution:
    """One observation as the release layer sees it: who it is (a hash), whose it is (a hash), and what its owner's consent asks of any cell it is in.

    ``min_observations`` / ``min_organisations`` are the aggregation floors of the organisation's consent (``gf_calibration_publication_inputs()``); 0 means the
    consent asks for nothing beyond the policy's. They can only raise the bar a cell must clear."""
    observation: str
    organisation: str
    min_observations: int = 0
    min_organisations: int = 0

    def __post_init__(self) -> None:
        _hex64("observation", self.observation)
        _hex64("organisation", self.organisation)
        _floor("min_observations", self.min_observations)
        _floor("min_organisations", self.min_organisations)

    @classmethod
    def from_ids(cls, observation_id: str, organisation_id: str, *, min_observations: int = 0, min_organisations: int = 0) -> "Contribution":
        return cls(observation_hash(observation_id), organisation_hash(organisation_id), min_observations, min_organisations)


def _members(group: Iterable[Contribution]) -> dict[str, Contribution]:
    """The group keyed by observation. The same observation twice is refused (it would count as two); the same one repeated identically is one."""
    out: dict[str, Contribution] = {}
    for c in group:
        if not isinstance(c, Contribution):
            raise TypeError(f"expected a Contribution, got {type(c).__name__}")
        prev = out.get(c.observation)
        if prev is not None and prev != c:
            raise ValueError(f"observation {c.observation[:12]}... is listed twice with different organisations or floors")
        out[c.observation] = c
    return out


@dataclass(frozen=True)
class GroupCheck:
    safe: bool
    observations: int
    organisations: int
    largest_share: float
    required_observations: int
    required_organisations: int
    reasons: tuple[str, ...]


def check_group(group: Iterable[Contribution], *, floor_observations: int = MIN_CELL_OBSERVATIONS,
                floor_organisations: int = MIN_CELL_ORGANISATIONS) -> GroupCheck:
    """Is this group of observations one a reader may be given the sum of? At least the floors (raised by any member's consent), spread over enough
    organisations, no organisation above ``MAX_ORGANISATION_SHARE``. An empty group is not safe."""
    ms = _members(group)
    n = len(ms)
    per: dict[str, int] = {}
    for c in ms.values():
        per[c.organisation] = per.get(c.organisation, 0) + 1
    need_n = max([floor_observations, *(c.min_observations for c in ms.values())])
    need_o = max([floor_organisations, *(c.min_organisations for c in ms.values())])
    why = []
    if n < need_n:
        why.append(f"{n} observation(s), at least {need_n} needed")
    if len(per) < need_o:
        why.append(f"{len(per)} organisation(s), at least {need_o} needed")
    if per and not pub.share_ok(per.values(), MAX_ORGANISATION_SHARE):
        why.append(f"one organisation supplies {pub.largest_share(per.values()):.0%}, more than the {MAX_ORGANISATION_SHARE:.0%} allowed")
    return GroupCheck(not why, n, len(per), pub.largest_share(per.values()), need_n, need_o, tuple(why))


def is_safe_group(group: Iterable[Contribution], **kw: int) -> bool:
    return check_group(group, **kw).safe


def exclude_tombstoned(group: Iterable[Contribution], tombstoned: Iterable[str]) -> tuple[list[Contribution], int]:
    """The contributions whose observation is not tombstoned, and how many were dropped. The database view already excludes them; this is the second
    lock for a caller that assembles its input some other way (a re-import of an old export)."""
    items = list(group)
    dead = set(tombstoned)
    kept = [c for c in items if c.observation not in dead]
    return kept, len(items) - len(kept)


# ---------------------------------------------------------------------------------------------- snapshots

@dataclass(frozen=True)
class Snapshot:
    """One release: which observations stood behind which published cell, when, and a digest of the figures. Immutable; never edited, only superseded.

    ``members`` are every observation behind ANY cell, sorted by hash. ``cells`` maps a cell's name to the sorted hashes of the observations it rests on.
    Nothing but hashes: no value, no name, no id. ``snapshot_id`` is the sha256 of the canonical content, so a record that was edited does not match its id."""
    snapshot_id: str
    released_at: datetime
    members: tuple[Contribution, ...]
    cells: tuple[tuple[str, tuple[str, ...]], ...]
    figures_sha256: str

    @classmethod
    def make(cls, cells: Mapping[str, Iterable[Contribution]], *, released_at: datetime, figures: Any = None) -> "Snapshot":
        if not cells:
            raise ValueError("a release publishes at least one cell")
        at = _utc("released_at", released_at)
        by_obs: dict[str, Contribution] = {}
        named: list[tuple[str, tuple[str, ...]]] = []
        for name in sorted(cells):
            if not isinstance(name, str) or not name.strip() or len(name) > _NAME_MAX:
                raise ValueError(f"cell name {name!r}: must be a non-empty string of at most {_NAME_MAX} characters")
            group = _members(cells[name])
            if not group:
                raise ValueError(f"cell {name!r} is empty")
            for h, c in group.items():
                prev = by_obs.get(h)
                if prev is not None and prev != c:
                    raise ValueError(f"observation {h[:12]}... appears in two cells with different organisations or floors")
                by_obs[h] = c
            named.append((name, tuple(sorted(group))))
        members = tuple(by_obs[h] for h in sorted(by_obs))
        fig = hashlib.sha256(_canonical(figures)).hexdigest()
        sid = _snapshot_id(at, members, tuple(named), fig)
        return cls(sid, at, members, tuple(named), fig)

    # --- views -----------------------------------------------------------------------------------------------
    # A snapshot never changes, so these are built once (the decisions below read every earlier snapshot's sets on every call). Callers must not mutate them.
    @cached_property
    def member_map(self) -> dict[str, Contribution]:
        return {c.observation: c for c in self.members}

    @cached_property
    def cell_sets(self) -> dict[str, frozenset[str]]:
        return {name: frozenset(obs) for name, obs in self.cells}

    @cached_property
    def membership(self) -> frozenset[str]:
        return frozenset(c.observation for c in self.members)

    # --- persistence (the columns of calibration_release_snapshots) --------------------------------------------
    def to_record(self) -> dict:
        return {"snapshot_id": self.snapshot_id, "released_at": _iso(self.released_at),
                "members": {c.observation: c.organisation for c in self.members},
                "cells": {name: list(obs) for name, obs in self.cells}, "figures_sha256": self.figures_sha256}

    @classmethod
    def from_record(cls, rec: Mapping[str, Any]) -> "Snapshot":
        """Rebuild a snapshot from a stored record, and refuse one whose id is not the digest of its content. The aggregation floors are not stored (they
        are a property of the consent, not of the release), so a snapshot read back carries none."""
        if not isinstance(rec, Mapping) or not all(isinstance(rec.get(k), Mapping) for k in ("members", "cells")):
            raise ValueError("not a snapshot record: it needs a 'members' object and a 'cells' object")
        try:
            members = {_hex64("observation", k): _hex64("organisation", v) for k, v in rec["members"].items()}
            cells = {str(n): [_hex64("observation", h) for h in obs] for n, obs in rec["cells"].items()}
            at = _utc("released_at", rec["released_at"])
            fig = _hex64("figures_sha256", rec["figures_sha256"])
            sid = _hex64("snapshot_id", rec["snapshot_id"])
        except (KeyError, TypeError) as e:
            raise ValueError(f"not a snapshot record: {type(e).__name__} {e}") from e
        missing = {h for obs in cells.values() for h in obs} - set(members)
        if missing or not cells:
            raise ValueError("a snapshot's cells must list only its members, and there must be at least one cell")
        mem = tuple(Contribution(h, members[h]) for h in sorted(members))
        named = tuple((n, tuple(sorted(set(cells[n])))) for n in sorted(cells))
        if _snapshot_id(at, mem, named, fig) != sid:
            raise ValueError("the snapshot's id is not the digest of its content: the record was edited or is not this release")
        return cls(sid, at, mem, named, fig)


def _snapshot_id(at: datetime, members: Sequence[Contribution], cells: Sequence[tuple[str, Sequence[str]]], figures_sha256: str) -> str:
    return hashlib.sha256(_canonical({"schema": SCHEMA, "released_at": _iso(at),
                                      "members": {c.observation: c.organisation for c in members},
                                      "cells": {n: list(o) for n, o in cells}, "figures_sha256": figures_sha256})).hexdigest()


@dataclass(frozen=True)
class Supersession:
    """An annotation appended beside a snapshot, never a change to it: this release contains an observation that has since been withdrawn."""
    snapshot_id: str
    withdrawal_id: str
    superseded_at: datetime
    reason: str


def supersede(snapshot: Snapshot, tombstoned: Iterable[str], *, withdrawal_id: str, at: datetime,
              reason: str = "contains an observation withdrawn with its organisation's consent; later releases exclude it") -> Supersession | None:
    """The annotation for ``snapshot`` if it contains any tombstoned observation, else None. The snapshot is untouched (it is immutable) and still counts as
    history for every later differencing check: a reader who saw it still has it."""
    dead = set(tombstoned) & snapshot.membership
    if not dead:
        return None
    return Supersession(snapshot.snapshot_id, withdrawal_id, _utc("at", at), reason)


def served(history: Sequence[Snapshot], annotations: Iterable[Supersession] = ()) -> Snapshot | None:
    """The release to show now: the latest that has not been superseded, or None. After a withdrawal the latest release is withdrawn from view; an earlier
    one that never contained the withdrawn observations may still be shown, dated as it is."""
    gone = {a.snapshot_id for a in annotations}
    live = [s for s in history if s.snapshot_id not in gone]
    return max(live, key=lambda s: (s.released_at, s.snapshot_id)) if live else None


# ---------------------------------------------------------------------------------------------- the algebra

def _distinct_rows(rows: Iterable[frozenset[str]]) -> list[frozenset[str]]:
    return sorted({r for r in rows if r}, key=lambda r: (len(r), sorted(r)))


def _combine(v: dict[int, int], pv: int, b: dict[int, int], pivot: int) -> dict[int, int]:
    """``v`` with its entry at ``pivot`` eliminated using ``b`` (whose entry there is ``pv``), in integers: (pv/g) v - (f/g) b, then divided by the gcd of what
    is left, so entries stay small and nothing is ever a fraction."""
    f = v[pivot]
    g = gcd(pv, f)
    x, y = pv // g, f // g
    out = {k: x * v.get(k, 0) - y * b.get(k, 0) for k in v.keys() | b.keys()}
    out = {k: e for k, e in out.items() if e}
    if out:
        d = gcd(*out.values())
        if d > 1:
            out = {k: e // d for k, e in out.items()}
    return out


def _kernel_on(vectors: Sequence[dict[int, int]], forbidden: set[int]) -> list[dict[int, int]]:
    """A basis of the vectors in the span of ``vectors`` that are zero on every coordinate in ``forbidden``: the span's intersection with the coordinate subspace
    that leaves ``forbidden`` out. Elimination on the forbidden coordinates alone, with each full vector carried along; the vectors whose forbidden part reduces to
    nothing are the answer (each is a non-zero combination, because the given vectors are independent). Exact, in integers."""
    # A vector that is the only one with a non-zero entry on some forbidden coordinate cannot be in any combination that is zero there: drop it, and repeat
    # (what remains is usually nothing, and the elimination below is skipped).
    live = [b for b in vectors]
    while True:
        seen: dict[int, int] = {}
        for b in live:
            for k in b:
                if k in forbidden:
                    seen[k] = seen.get(k, 0) + 1
        kept = [b for b in live if all(k not in forbidden or seen[k] > 1 for k in b)]
        if len(kept) == len(live):
            break
        live = kept
    echelon: list[tuple[int, dict[int, int]]] = []
    inside: list[dict[int, int]] = []
    for b in live:
        v = dict(b)
        for p, e in echelon:
            if v.get(p):
                v = _combine(v, e[p], e, p)
        cols = [k for k in v if k in forbidden]
        if cols:
            echelon.append((min(cols), v))
        else:
            inside.append(v)
    return inside


def _unit_coordinates(vectors: Sequence[dict[int, int]], coords: set[int]) -> set[int]:
    """The coordinates a in ``coords`` whose unit vector is in the span of ``vectors`` restricted to ``coords``: some combination of the vectors is zero on every
    coordinate of ``coords`` but ``a`` and non-zero there. One reduction for all of them (a reduced echelon form has a unit vector for a exactly then)."""
    basis: list[tuple[int, dict[int, int]]] = []
    for b in vectors:
        v = {k: x for k, x in b.items() if k in coords}
        for p, e in basis:
            if v.get(p):
                v = _combine(v, e[p], e, p)
        if v:
            piv = min(v)
            basis = [(q, _combine(e, v[piv], v, piv) if piv in e else e) for q, e in basis]
            basis.append((piv, v))
    return {p for p, e in basis if len(e) == 1}


class _Space:
    """The row space of the incidence matrix of every published set, kept as a REDUCED echelon basis over ATOMS, and grown one published set at a time.

    An ATOM is a class of observations that lie in exactly the same published sets: no sum can tell two of them apart, so a reader can only ever learn sums over
    whole atoms (the coefficients of anything a reader derives are constant on an atom). A published set is a 0/1 vector over atoms; the space those vectors span is
    everything a reader can compute by adding and subtracting the published sums. Adding a set can SPLIT an atom (the part in it and the part outside); the basis
    follows by duplicating the split atom's column, so the cost of one more set is bounded by the number of atoms and the size of the basis (at most one vector per
    atom), never by how many sets were published before it. Every basis vector has a pivot atom that is zero in all the others, so an atom whose own sum can be
    read off is a basis vector with a single entry. All arithmetic is in exact integers."""
    __slots__ = ("atom_of", "atoms", "basis", "pivots", "_next")

    def __init__(self) -> None:
        self.atom_of: dict[str, int] = {}
        self.atoms: dict[int, frozenset[str]] = {}
        self.basis: list[tuple[int, dict[int, int]]] = []              # (pivot atom, vector): vectors are never mutated, only replaced
        self.pivots: dict[int, int] = {}                               # pivot atom -> index in ``basis``
        self._next = 0

    def copy(self) -> "_Space":
        s = _Space()
        s.atom_of, s.atoms, s.basis, s.pivots, s._next = dict(self.atom_of), dict(self.atoms), list(self.basis), dict(self.pivots), self._next
        return s

    def _new_atom(self, members: frozenset[str]) -> int:
        a = self._next
        self._next += 1
        self.atoms[a] = members
        for o in members:
            self.atom_of[o] = a
        return a

    def _split(self, a: int, part: frozenset[str]) -> int:
        """Move ``part`` (a proper subset of atom ``a``) into an atom of its own, which inherits ``a``'s coefficient in every basis vector."""
        self.atoms[a] = self.atoms[a] - part
        new = self._new_atom(part)
        for i, (p, b) in enumerate(self.basis):
            if a in b:
                nb = dict(b)
                nb[new] = b[a]
                self.basis[i] = (p, nb)
        return new

    def _reduce(self, v: dict[int, int]) -> dict[int, int]:
        """``v`` with every pivot atom eliminated (one pass: a basis vector is zero on the other pivots, so it brings none back)."""
        for p in [k for k in v if k in self.pivots]:
            _, b = self.basis[self.pivots[p]]
            v = _combine(v, b[p], b, p)
        return v

    def extend(self, row: Iterable[str]) -> None:
        """Add one published set (a set of observation keys)."""
        row = frozenset(row)
        if not row:
            return
        touched: dict[int, set[str]] = {}
        fresh: set[str] = set()
        for o in row:
            a = self.atom_of.get(o)
            if a is None:
                fresh.add(o)
            else:
                touched.setdefault(a, set()).add(o)
        inside = []
        for a in sorted(touched):
            part = touched[a]
            inside.append(a if len(part) == len(self.atoms[a]) else self._split(a, frozenset(part)))
        if fresh:
            inside.append(self._new_atom(frozenset(fresh)))
        if len(self.atoms) > MAX_PROOF_ATOMS:
            raise ValueError(f"{len(self.atoms)} atoms (groups of observations no published sum tells apart): more than the {MAX_PROOF_ATOMS} this proof will hold")
        v = self._reduce({a: 1 for a in inside})
        if v:
            piv = min(v)
            for i, (q, b) in enumerate(self.basis):
                if piv in b:
                    self.basis[i] = (q, _combine(b, v[piv], v, piv))
            self.pivots[piv] = len(self.basis)
            self.basis.append((piv, v))

    def public(self) -> set[int]:
        """The atoms whose own sum anyone can read off the published sums (the unit vector of the atom is in the row space): their sums are public."""
        return {p for p, b in self.basis if len(b) == 1}

    def exposed(self, members: Mapping[str, "Contribution"]) -> set[frozenset[str]]:
        """The atoms that adding and subtracting the published sums puts within reach of the attacker this policy is built for. Two things, both exact:

        (a) An atom that is not a safe group by itself whose OWN sum can be read off (its unit vector is in the row space): a sum over a handful of observations.
        (b) An atom with ONE observation that some COALITION of at most ``MAX_COALITION`` organisations can isolate. The coalition knows the value of every
            observation of its organisations, and nothing else (the sums over atoms whose own sum is public are public). Anything a reader derives is constant on an
            atom, so the coalition determines an observation only if the atom has exactly one observation outside the coalition (the rest are its own), and the unit
            vector of that atom is in the row space plus the atoms the coalition owns entirely: some combination of the published sums is supported on the target
            atom and on atoms that belong wholly to the coalition. For a single organisation that is "it subtracts its own observations and is left with one"; for
            the example that breaks the single-atom test, p = U + a, q = V + b, r = U + V gives p + q - r = a + b, which the owner of b reads as a.

        Returns the atoms found (empty: none). Not covered, by construction: a coalition of MORE than ``MAX_COALITION`` organisations (the stated limit: a coalition
        that holds all but one observation of a safe group), an attacker who knows observations of organisations it does not belong to, tenant splitting."""
        public = self.public()
        out: set[frozenset[str]] = {self.atoms[a] for a in public if not check_group(members[o] for o in self.atoms[a]).safe}          # (a)
        out |= self._isolated_by_coalitions(members, MAX_COALITION, public)
        return out

    def _isolated_by_coalitions(self, members: Mapping[str, "Contribution"], size: int, public: set[int]) -> set[frozenset[str]]:
        count: dict[int, dict[str, int]] = {}
        for a, obs in self.atoms.items():
            if a in public:
                continue
            per: dict[str, int] = {}
            for o in obs:
                g = members[o].organisation
                per[g] = per.get(g, 0) + 1
            count[a] = per
        # An atom matters to a coalition of at most `size` organisations only if it belongs wholly to them (at most `size` organisations), or has exactly one
        # observation outside them (an organisation with one observation in it, the rest spread over at most `size` others).
        relevant = {a for a, per in count.items() if len(per) <= size or (len(per) <= size + 1 and 1 in per.values())}
        if not relevant:
            return set()
        rows = [b for p, b in self.basis if p in relevant]                     # a combination can only have a pivot atom that matters or is public
        forbidden = {k for b in rows for k in b if k not in relevant and k not in public}
        support = _kernel_on(rows, forbidden)                                  # combinations of published sums that touch only the atoms that matter
        if not support:
            return set()
        touched = {k for v in support for k in v}                              # a combination that reaches the target is supported on atoms like these
        involved = sorted({g for a in touched if a in count for g in count[a]})
        found: set[frozenset[str]] = set()
        for k in range(1, size + 1):
            for coalition in itertools.combinations(involved, k):
                owned = set(coalition)
                mono = {a for a in relevant if set(count[a]) <= owned}
                target = {a for a in relevant if sum(n for g, n in count[a].items() if g not in owned) == 1}
                if not target:
                    continue
                reach = _kernel_on(support, relevant - (mono | target))
                if not reach:
                    continue
                found.update(self.atoms[a] for a in _unit_coordinates(reach, target))
        return found

    def recoverable(self) -> list[frozenset[str]]:
        """The atoms whose own sum can be read off the published sums, ordered by (size, members): the SINGLE-atom case only, kept as a diagnostic. It is weaker
        than ``exposed`` (it misses a sum over two small atoms), and is not what a release is held to."""
        return sorted((self.atoms[a] for a in self.public()), key=lambda x: (len(x), sorted(x)))


def recoverable_atoms(rows: Iterable[frozenset[str]]) -> list[frozenset[str]]:
    """The groups of observations whose SUM alone can be recovered exactly by adding and subtracting the published sums over ``rows`` (one observation set per
    published sum). The single-atom diagnostic, ordered by (size, members); ``propose_release`` holds a release to the stronger ``_unsafe_recoverable``. Raises
    ValueError beyond ``MAX_PROOF_ATOMS`` atoms."""
    space = _Space()
    for r in _distinct_rows(rows):
        space.extend(r)
    return space.recoverable()


#: The proof state of the most recent histories, keyed by the ids of their snapshots (a snapshot id is the digest of its content, so the same ids are the same
#: rows). A decision for the next release grows the cached state of the history by one release instead of reducing every earlier one again. A cache of a pure
#: computation: it changes how long an answer takes, never what it is.
_SPACES: "OrderedDict[tuple[str, ...], _Space]" = OrderedDict()
_SPACES_KEPT = 6


def _space_for(history: Sequence[Snapshot]) -> _Space:
    key = tuple(s.snapshot_id for s in history)
    hit = _SPACES.get(key)
    if hit is None:
        start = 0
        space = _Space()
        for k in range(len(key) - 1, 0, -1):
            prefix = _SPACES.get(key[:k])
            if prefix is not None:
                space, start = prefix.copy(), k
                break
        for s in history[start:]:
            for cell in _distinct_rows(s.cell_sets.values()):
                space.extend(cell)
        hit = _SPACES[key] = space
    _SPACES.move_to_end(key)
    while len(_SPACES) > _SPACES_KEPT:
        _SPACES.popitem(last=False)
    if len(hit.atoms) > MAX_PROOF_ATOMS:
        raise ValueError(f"{len(hit.atoms)} atoms (groups of observations no published sum tells apart): more than the {MAX_PROOF_ATOMS} this proof will hold")
    return hit


def _unsafe_recoverable(rows: Iterable[frozenset[str]], members: Mapping[str, Contribution], base: "_Space | None" = None) -> set[frozenset[str]]:
    """The small atoms the published sums over ``rows`` (added to those in ``base``, the proof state of the history, when one is given) expose to an attacker who
    knows every other small atom: see ``_Space.exposed``. A function of its own so that a test can take the proof out and watch the rest of the policy fail."""
    extra = _distinct_rows(rows)
    space = base if base is not None and not extra else (base.copy() if base is not None else _Space())
    for r in extra:
        space.extend(r)
    return space.exposed(members)


def _newly_exposed(history: Sequence[Snapshot], cells: Iterable[frozenset[str]], members: Mapping[str, Contribution]) -> set[str]:
    """The observations that publishing ``cells`` after ``history`` puts in an exposed small atom although the history alone did not. (An exposure already in the
    history is the history's, which this policy trusts and cannot undo; it is not charged to the release that did not cause it.) Raises ValueError beyond
    ``MAX_PROOF_ATOMS``."""
    base = _space_for(history)
    after = set().union(*_unsafe_recoverable(list(cells), members, base))
    if not after:
        return set()                                                  # nothing is exposed once the cells are published: nothing is newly exposed
    return after - set().union(*_unsafe_recoverable((), members, base))


def _protecting_half(x: frozenset[str], y: frozenset[str]) -> frozenset[str]:
    """What a reader learns from the difference of the sums over x and y is the sum over x - y minus the sum over y - x. The larger of those two is the one a
    reader cannot know (a tie: the first). Empty when x and y are the same set."""
    a, b = x - y, y - x
    if not a and not b:
        return frozenset()
    return a if len(a) >= len(b) else b


def _step_ok(x: frozenset[str], y: frozenset[str], members: Mapping[str, Contribution]) -> bool:
    half = _protecting_half(x, y)
    if not half:
        return True
    if len(half) < RELEASE_STEP_OBSERVATIONS:                         # a consent floor can only raise the bar: too few is too few, without counting organisations
        return False
    per: dict[str, int] = {}
    need_n, need_o = RELEASE_STEP_OBSERVATIONS, RELEASE_STEP_ORGANISATIONS
    for o in half:                                                    # check_group, without building a group object for every pair of sets of a long history
        c = members[o]
        per[c.organisation] = per.get(c.organisation, 0) + 1
        if c.min_observations > need_n:
            need_n = c.min_observations
        if c.min_organisations > need_o:
            need_o = c.min_organisations
    return len(half) >= need_n and len(per) >= need_o and pub.share_ok(per.values(), MAX_ORGANISATION_SHARE)


def _all_members(candidate: Snapshot, history: Sequence[Snapshot]) -> dict[str, Contribution]:
    out: dict[str, Contribution] = {}
    for s in history:
        out.update(s.member_map)
    out.update(candidate.member_map)             # the candidate's contributions (with their consent floors) win
    return out


def _history_rows(history: Sequence[Snapshot]) -> list[frozenset[str]]:
    return [cell for s in history for cell in s.cell_sets.values()]


def _cell_step_violations(cells: Mapping[str, frozenset[str]], history: Sequence[Snapshot], members: Mapping[str, Contribution]) -> list[str]:
    """Names of candidate cells that differ from some other published set (an earlier release's cell, or another candidate cell) by less than the step."""
    bad = []
    others_hist = _history_rows(history)
    for name in sorted(cells):
        x = cells[name]
        peers = others_hist + [c for n, c in cells.items() if n != name]
        if any(not _step_ok(x, y, members) for y in peers):
            bad.append(name)
    return bad


# ---------------------------------------------------------------------------------------------- deciding

@dataclass(frozen=True)
class Decision:
    verdict: str                       # 'publish' | 'unchanged' | 'refused'
    codes: tuple[str, ...]
    reasons: tuple[str, ...]

    @property
    def allowed(self) -> bool:
        return self.verdict == PUBLISH


def evaluate_release(candidate: Snapshot, history: Sequence[Snapshot], *, now: datetime,
                     tombstoned: Iterable[str] = ()) -> Decision:
    """May ``candidate`` be released after ``history`` (every earlier release, superseded ones included)? Returns every reason it may not, not the first."""
    clock = _utc("now", now)
    hist = sorted(history, key=lambda s: (s.released_at, s.snapshot_id))
    codes: list[str] = []
    why: list[str] = []

    def refuse(code: str, text: str) -> None:
        if code not in codes:
            codes.append(code)
        why.append(text)

    dead = set(tombstoned) & candidate.membership
    if dead:
        refuse(TOMBSTONED, f"{len(dead)} observation(s) were withdrawn with their organisation's consent and may not be in any release")
    if candidate.released_at > clock + CLOCK_SKEW:
        refuse(FUTURE, "the release is dated in the future")
    if candidate.released_at < clock - MAX_BACKDATE:
        refuse(BACKDATED, f"the release is dated more than {MAX_BACKDATE.days} day(s) before the time it is being made: a release cannot be back-dated to satisfy the cadence")
    members = _all_members(candidate, hist)
    if hist and candidate.membership == hist[-1].membership and candidate.cell_sets == hist[-1].cell_sets and not codes:
        return Decision(UNCHANGED, (UNCHANGED,), ("the membership of every cell equals the last release: nothing new to publish",))
    cells = candidate.cell_sets
    for name in sorted(cells):
        g = check_group(candidate.member_map[o] for o in cells[name])
        if not g.safe:
            refuse(SMALL_CELL, f"cell {name!r} is not a safe group: " + "; ".join(g.reasons))
    if hist and candidate.released_at < hist[-1].released_at + MIN_RELEASE_INTERVAL:
        refuse(CADENCE, f"the last release was {_iso(hist[-1].released_at)}; the next may not be before "
                        f"{_iso(hist[-1].released_at + MIN_RELEASE_INTERVAL)} ({MIN_RELEASE_INTERVAL.days} days)")
    for s in hist:
        if not _step_ok(candidate.membership, s.membership, members):
            refuse(STEP, f"differs from release {s.snapshot_id[:12]} by less than {RELEASE_STEP_OBSERVATIONS} observations from "
                         f"{RELEASE_STEP_ORGANISATIONS} organisations in its larger difference: their difference would be a small group's sum")
    for name in _cell_step_violations(cells, hist, members):
        refuse(STEP, f"cell {name!r} differs from another published set by too few observations or organisations")
    try:
        newly = _newly_exposed(hist, cells.values(), members)
    except ValueError as e:
        refuse(PROOF_TOO_LARGE, str(e) + ": nothing can be proved, so nothing is released")
    else:
        if newly:
            refuse(LEAK, f"adding and subtracting published sums would isolate {len(newly)} observation(s) that sit in groups too small to be safe by themselves "
                         "(a sum over them, or over some of them with the others known, is recoverable)")
    if codes:
        return Decision(REFUSED, tuple(codes), tuple(why))
    return Decision(PUBLISH, (OK,), ("every rule holds",))


@dataclass(frozen=True)
class CellPlan:
    published: Mapping[str, tuple[Contribution, ...]]
    withheld: Mapping[str, str]                  # cell name -> code (SMALL_CELL, STEP, COMPLEMENT)


def plan_cells(cells: Mapping[str, Iterable[Contribution]], history: Sequence[Snapshot] = (),
               tombstoned: Iterable[str] = ()) -> CellPlan:
    """Which of the candidate cells may be published, and why the others may not. Cells that are not safe groups are withheld; then, while publishing the rest
    would let a withheld or earlier-published group be recovered (a total minus its published cells; a cell one observation away from its earlier self), the
    smallest remaining cell is withheld too. Deterministic: ties break on the cell's name."""
    dead = set(tombstoned)
    groups = {name: _members(c for c in g if c.observation not in dead) for name, g in cells.items()}
    published: dict[str, dict[str, Contribution]] = {}
    withheld: dict[str, str] = {}
    for name in sorted(groups):
        if groups[name] and check_group(groups[name].values()).safe:
            published[name] = groups[name]
        else:
            withheld[name] = SMALL_CELL
    hist = sorted(history, key=lambda s: (s.released_at, s.snapshot_id))
    while published:
        members: dict[str, Contribution] = {}
        for s in hist:
            members.update(s.member_map)
        for g in published.values():
            members.update(g)
        sets = {n: frozenset(g) for n, g in published.items()}
        bad = _cell_step_violations(sets, hist, members)
        if bad:
            victim, code = min(bad, key=lambda n: (len(sets[n]), n)), STEP
        else:
            try:
                new = _newly_exposed(hist, sets.values(), members)
            except ValueError:
                new = {""}
            if not new:
                break
            victim, code = min(sets, key=lambda n: (len(sets[n]), n)), COMPLEMENT
        withheld[victim] = code
        del published[victim]
    return CellPlan({n: tuple(published[n][o] for o in sorted(published[n])) for n in sorted(published)}, dict(sorted(withheld.items())))


@dataclass(frozen=True)
class Proposal:
    decision: Decision
    plan: CellPlan
    snapshot: Snapshot | None              # the release to register and publish; None unless the decision allows it
    served: Snapshot | None                # what to show now: the new release, else the latest that has not been superseded
    figures: Any = None                    # what ``figures_for`` built for the new release (the caller stores it beside snapshot_id)


def propose_release(cells: Mapping[str, Iterable[Contribution]], *, history: Sequence[Snapshot], annotations: Iterable[Supersession] = (),
                    now: datetime, figures_for: Callable[[Sequence[str]], Any], tombstoned: Iterable[str] = ()) -> Proposal:
    """The whole decision for one reading of the ledger: withhold what must be withheld, build the figures of what remains (``figures_for`` receives the
    published cell names, in order), and release only if every rule holds. If not, the caller keeps serving ``served`` unchanged, which is the point:
    the report is a snapshot, not a function of the ledger at the time of the request."""
    notes = tuple(annotations)
    plan = plan_cells(cells, history, tombstoned)
    keep = served(history, notes)
    if not plan.published:
        codes = (EMPTY, *dict.fromkeys(plan.withheld.values()))
        reasons = ("no cell can be published: " + ("; ".join(f"{n}: {c}" for n, c in plan.withheld.items()) or "no cell was offered"),)
        return Proposal(Decision(REFUSED, codes, reasons), plan, None, keep)
    figures = figures_for(list(plan.published))
    snap = Snapshot.make(plan.published, released_at=now, figures=figures)
    decision = evaluate_release(snap, history, now=now, tombstoned=tombstoned)
    if decision.allowed:
        return Proposal(decision, plan, snap, snap, figures)
    return Proposal(decision, plan, None, keep)
