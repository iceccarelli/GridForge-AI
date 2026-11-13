"""Release differencing resistance: what may be PUBLISHED twice about the same observations (review R4).

Pure functions and constants. Nothing here does I/O, reads a clock or draws a random number: every function takes what it needs and returns the same
answer for the same input. ``publication.py`` says which single figures may leave the building; this says when a SECOND set of figures may follow a first.

THE ATTACK. A published aggregate is a function of the set of observations behind it. A reader who keeps release A (n observations) and release B (the same
set plus one) computes (n+1) x mean_B - n x mean_A and has the new observation, to the rounding of the figures. Rounding (``publication.PUBLIC_SIG_FIGS``) only
blunts it. The same holds inside one release: a cell and its parent differ by the other cells, and a withheld cell is the parent minus the published ones.
The reader needs no model of the data: only the sums, and which observations are in which sum. Anything that leaves the set of published sums such that the
sum over a small group of observations can be recovered is a leak, however the sums were reached.

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
  3. NO LINEAR LEAK. Over the whole collection of published sets (every earlier release's cells and this one's) no observation group smaller than a safe
     cell may be recoverable by adding and subtracting published sums. That is the pair rule extended to any combination (a cell, its parent and the other
     cells; three releases that individually look fine). It is decided exactly, in exact integer arithmetic, by row-reducing the incidence matrix.
  4. A CADENCE. No release sooner than ``MIN_RELEASE_INTERVAL`` after the previous one, so that when observations join one at a time the reader still sees at
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

WHAT THIS DOES NOT DEFEND AGAINST (stated, not hidden)
  * A coalition. Organisations that between them know every observation in a published difference but one can solve for the last (the same limit
    ``publication.py`` states for sites). The step makes that coalition large: at least M - 1 organisations plus all but one of the observations of the last.
  * An observation count that is itself small and known (the first release has no predecessor, so it is held only to rule 1).
  * Anything already published before this policy ran. The history passed in is trusted to be complete; a release missing from it is a release the reader
    holds and this cannot see. ``Snapshot.from_record`` refuses a record whose id does not match its content, which catches an edited row, not a missing one.
  * A withdrawal cannot recall a release already seen. It supersedes it (``supersede``) so it is no longer served, and excludes the withdrawn observations from
    every later one; the difference between the last release containing them and the next is protected by rule 2, not undone.

THE DATABASE HAS A COPY. supabase/migrations/0056 refuses to register a snapshot that breaks rules 1 (as a whole), 2 (on whole memberships) and 4, using the
same numbers (``policy()`` is compared with ``gf_calibration_release_policy()`` by a test). Rules 1-3 at the level of each cell, and rule 3 across
releases, exist here only: run ``propose_release`` before registering anything.

STATUS. Nothing serves a report through this yet: the public report is still recomputed on every request (``publication.py``, HARD PRECONDITION). The
precondition is met only when the route serves ``Proposal.served`` and registers ``Proposal.snapshot``. The ledger holds 0 observations.
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
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
#: The proof of rule 3 row-reduces a matrix with one row per distinct published set. Beyond this many rows nothing is proved and the release is refused.
MAX_PROOF_ROWS = 300

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
    @property
    def member_map(self) -> dict[str, Contribution]:
        return {c.observation: c for c in self.members}

    @property
    def cell_sets(self) -> dict[str, frozenset[str]]:
        return {name: frozenset(obs) for name, obs in self.cells}

    @property
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


def recoverable_atoms(rows: Iterable[frozenset[str]]) -> list[frozenset[str]]:
    """The groups of observations whose SUM can be recovered exactly by adding and subtracting the published sums over ``rows``.

    ``rows`` are the published sets (one observation set per published sum). Observations that belong to exactly the same rows can never be told apart
    (an "atom"); the sum over an atom is recoverable if and only if its indicator vector is in the row space of the incidence matrix, which is decided
    exactly by reducing the matrix in integers. Returns the recoverable atoms, ordered by (size, members). Raises ValueError beyond
    ``MAX_PROOF_ROWS`` distinct rows."""
    rs = _distinct_rows(rows)
    if len(rs) > MAX_PROOF_ROWS:
        raise ValueError(f"{len(rs)} distinct published sets: more than the {MAX_PROOF_ROWS} this proof will reduce")
    if not rs:
        return []
    universe = sorted(set().union(*rs))
    by_signature: dict[int, list[str]] = {}
    for o in universe:
        sig = 0
        for i, r in enumerate(rs):
            if o in r:
                sig |= 1 << i
        by_signature.setdefault(sig, []).append(o)
    atoms = [frozenset(v) for _, v in sorted(by_signature.items())]
    signatures = sorted(by_signature)
    m = [[1 if (sig >> i) & 1 else 0 for sig in signatures] for i in range(len(rs))]
    pivots = _row_reduce(m)
    out = []
    for r_idx, col in enumerate(pivots):
        if all(v == 0 for j, v in enumerate(m[r_idx]) if j != col):
            out.append(atoms[col])
    return sorted(out, key=lambda a: (len(a), sorted(a)))


def _row_reduce(m: list[list[int]]) -> list[int]:
    """Gauss-Jordan elimination in place over the integers (exact: each row is scaled, never divided into a fraction, and kept small by its gcd). Returns
    the pivot column of each leading row. A pivot row is a multiple of its column's unit vector exactly when it is zero everywhere else."""
    pivots: list[int] = []
    r, ncols = 0, len(m[0]) if m else 0
    for c in range(ncols):
        if r == len(m):
            break
        p = next((i for i in range(r, len(m)) if m[i][c] != 0), None)
        if p is None:
            continue
        m[r], m[p] = m[p], m[r]
        pv = m[r][c]
        for i in range(len(m)):
            if i != r and m[i][c] != 0:
                f = m[i][c]
                row = [pv * a - f * b for a, b in zip(m[i], m[r])]
                g = gcd(*row)
                m[i] = [v // g for v in row] if g > 1 else row
        pivots.append(c)
        r += 1
    return pivots


def _unsafe_recoverable(rows: Iterable[frozenset[str]], members: Mapping[str, Contribution]) -> set[frozenset[str]]:
    return {a for a in recoverable_atoms(rows) if not check_group(members[o] for o in a).safe}


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
    return check_group((members[o] for o in half), floor_observations=RELEASE_STEP_OBSERVATIONS,
                       floor_organisations=RELEASE_STEP_ORGANISATIONS).safe


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
        before = _unsafe_recoverable(_history_rows(hist), members)
        after = _unsafe_recoverable(_history_rows(hist) + list(cells.values()), members)
    except ValueError as e:
        refuse(PROOF_TOO_LARGE, str(e) + ": nothing can be proved, so nothing is released")
    else:
        new = after - before
        if new:
            refuse(LEAK, f"adding and subtracting published sums would recover the sum over {len(new)} group(s) of "
                         f"{sorted(len(a) for a in new)} observation(s), each below the safe-group floor")
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
                new = _unsafe_recoverable(_history_rows(hist) + list(sets.values()), members) - _unsafe_recoverable(_history_rows(hist), members)
            except ValueError:
                new = {frozenset()}
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
