"""Release differencing (review R4): successive releases of the calibration report must not let a reader recover one observation.

The attack is arithmetic, not statistical. If release A is the mean over n observations and release B the mean over those n and one more, then
(n+1) x mean_B - n x mean_A is the new observation. gridforge/calibration/release.py is the policy that makes that impossible; this file holds it to
account with an attacker that is NOT built from the code under test: it takes every published sum (as exact fractions, i.e. with NO rounding, the most
generous case for the attacker), knows which observations are in which sum, and solves for whatever the sums determine.

What is proved here, and how:
  * the rules at their boundaries (K, M, the share, the step, the cadence), each with the case one short of the line;
  * the attacker WINS against a publisher that applies only the per-cell floor (so the attacker is worth something) and recovers NOTHING below a safe group
    against the policy, over seeded random months of arrivals (and the same attacker wins again when each rule is switched off, so each rule is needed);
  * a withdrawal does not become a release that isolates the withdrawn observations, and supersession never edits a snapshot.
Pure: no database, no network, no clock. The database half is tests/test_calibration_publication_gates.py.
"""
import copy
import dataclasses
import itertools
import json
import random
import re
import time
from datetime import datetime, timedelta, timezone
from fractions import Fraction
from pathlib import Path

import pytest

from gridforge.calibration import publication as pub
from gridforge.calibration import release as R
from gridforge.calibration import residuals
from gridforge.calibration.ledger import published_source_ref

ROOT = Path(__file__).resolve().parent.parent
T0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
MONTH = timedelta(days=31)


def c(i, org):
    return R.Contribution.from_ids(f"obs-{i}", f"org-{org}")


def spread(start, n, orgs):
    """n observations numbered from `start`, dealt round-robin over the organisation numbers in `orgs`."""
    return [c(start + k, orgs[k % len(orgs)]) for k in range(n)]


def snap(cells, at=T0, figures=None):
    return R.Snapshot.make(cells, released_at=at, figures=figures if figures is not None else {"n": sum(len(v) for v in cells.values())})


def total(obs, at=T0):
    return snap({"total": obs}, at)


def accepted(candidate, history=(), now=None):
    return R.evaluate_release(candidate, list(history), now=now or candidate.released_at)


# =============================================================================================== the constants

def test_the_constants_are_named_documented_and_never_below_the_floors_the_rest_of_the_package_holds():
    assert R.MIN_CELL_OBSERVATIONS >= 10 and R.MIN_CELL_ORGANISATIONS >= 3                 # the brief's conservative defaults
    assert R.MIN_CELL_OBSERVATIONS >= residuals.MIN_APPROVED_OBSERVATIONS
    assert R.MIN_CELL_ORGANISATIONS >= residuals.MIN_DISTINCT_SITES
    assert R.MAX_ORGANISATION_SHARE <= pub.MAX_SINGLE_SITE_SHARE
    assert R.RELEASE_STEP_OBSERVATIONS >= R.MIN_CELL_OBSERVATIONS and R.RELEASE_STEP_ORGANISATIONS >= R.MIN_CELL_ORGANISATIONS
    assert R.MIN_RELEASE_INTERVAL >= timedelta(days=28)
    doc = R.__doc__
    for name in ("MIN_CELL_OBSERVATIONS", "MIN_CELL_ORGANISATIONS", "MAX_ORGANISATION_SHARE", "RELEASE_STEP_", "MIN_RELEASE_INTERVAL"):
        assert name in doc, f"{name} has no stated rationale in the module docstring"


def test_the_database_holds_the_same_numbers():
    sql = next((ROOT / "supabase" / "migrations").glob("0056_*.sql")).read_text()
    body = sql[sql.index("function public.gf_calibration_release_policy()"):]
    body = body[:body.index("$$;")]
    in_sql = {k: int(v) for k, v in re.findall(r"'([a-z_]+)', (\d+)", body)}
    assert in_sql == R.policy()


def test_a_tombstone_hash_is_the_head_of_a_published_ledger_reference():
    """The database tombstones sha256('gridforge.calibration.observation:' || id); the ledger publishes the first 32 hex of that as the head of source_ref,
    so a tombstone can be matched to a published row without the id being published."""
    for oid in ("a8f6e2c0-1b6d-4a52-9d8e-5d4e6f0a1b2c", "obs-1"):
        head = published_source_ref(oid, "e" * 64).split(":")[0]
        assert head == R.observation_hash(oid)[:32]


# =============================================================================================== groups

@pytest.mark.parametrize("sizes,safe", [
    ((4, 3, 3), True),                 # exactly K, M, and the largest share on the line (4 of 10)
    ((3, 3, 3), False),                # nine observations
    ((5, 3, 2), False),                # half of it is one organisation
    ((5, 5), False),                   # two organisations
    ((4, 4, 2), True),
    ((4, 4, 1, 1), True),              # four organisations, the line is the share, not a minimum per organisation (a stated residual)
    ((10,), False),
    ((2,) * 10, True),
    ((3, 3, 3, 3, 3, 3, 3), True),
])
def test_a_group_must_reach_K_and_M_with_no_organisation_above_its_share(sizes, safe):
    obs, i = [], 0
    for org, n in enumerate(sizes):
        for _ in range(n):
            obs.append(c(i, org))
            i += 1
    g = R.check_group(obs)
    assert g.safe is safe, g
    assert (g.observations, g.organisations) == (sum(sizes), len(sizes))
    assert bool(g.reasons) is (not safe)


def test_an_empty_group_is_not_safe_and_a_repeated_observation_is_refused():
    assert not R.check_group([]).safe
    a = c(1, 1)
    with pytest.raises(ValueError):
        R.check_group([a, R.Contribution(a.observation, R.organisation_hash("org-2"))])      # one observation, two organisations
    assert R.check_group([a, a]).observations == 1                                              # the same record twice is one


def test_a_consent_floor_raises_the_bar_for_every_cell_its_observation_is_in_and_never_lowers_it():
    obs = spread(0, 12, [1, 2, 3, 4])
    assert R.check_group(obs).safe
    strict = obs[:1] + [dataclasses.replace(obs[1], min_observations=20)] + obs[2:]
    g = R.check_group(strict)
    assert not g.safe and g.required_observations == 20
    strict_orgs = [dataclasses.replace(obs[0], min_organisations=5)] + obs[1:]
    assert not R.check_group(strict_orgs).safe                                                  # four organisations, five asked for
    assert R.check_group([dataclasses.replace(o, min_observations=1, min_organisations=1) for o in obs]).safe      # a low floor changes nothing


@pytest.mark.parametrize("bad", ["", "abc", "A" * 64, "g" * 64, "a" * 63, None, 5])
def test_identities_must_be_sha256_hashes(bad):
    with pytest.raises(ValueError):
        R.Contribution(bad, "a" * 64)
    with pytest.raises(ValueError):
        R.Contribution("a" * 64, bad)


@pytest.mark.parametrize("bad", [-1, True, 1.5, "3", None])
def test_a_floor_is_a_whole_number_of_at_least_zero(bad):
    with pytest.raises(ValueError):
        R.Contribution("a" * 64, "b" * 64, min_observations=bad)


def test_exclude_tombstoned_drops_by_hash_and_counts():
    obs = spread(0, 12, [1, 2, 3])
    kept, dropped = R.exclude_tombstoned(iter(obs), {obs[0].observation, obs[5].observation, "f" * 64})
    assert dropped == 2 and len(kept) == 10 and obs[0] not in kept


# =============================================================================================== snapshots

def test_a_snapshot_is_deterministic_and_independent_of_input_order():
    obs = spread(0, 12, [1, 2, 3, 4])
    a = snap({"total": obs, "half": obs[:6]})
    b = snap({"half": list(reversed(obs[:6])), "total": list(reversed(obs))})
    assert a == b and a.snapshot_id == b.snapshot_id
    assert snap({"total": obs}, at=T0 + timedelta(seconds=1)).snapshot_id != a.snapshot_id
    assert snap({"total": obs}, figures={"x": 1}).snapshot_id != snap({"total": obs}, figures={"x": 2}).snapshot_id


def test_a_snapshot_record_holds_hashes_only_and_round_trips_and_a_tampered_one_is_refused():
    obs = spread(0, 12, [1, 2, 3, 4])
    s = snap({"total": obs, "part": obs[:6]})
    rec = s.to_record()
    text = json.dumps(rec)
    assert "obs-" not in text and "org-" not in text                                            # ids appear only as hashes
    assert set(rec) == {"snapshot_id", "released_at", "members", "cells", "figures_sha256"}
    back = R.Snapshot.from_record(json.loads(text))
    assert back.snapshot_id == s.snapshot_id and back.membership == s.membership and back.cell_sets == s.cell_sets
    for mutate in (lambda r: r["members"].pop(next(iter(r["members"]))), lambda r: r.__setitem__("figures_sha256", "0" * 64),
                   lambda r: r.__setitem__("released_at", "2027-01-01T00:00:00Z"), lambda r: r["cells"]["total"].pop()):
        bad = copy.deepcopy(rec)
        mutate(bad)
        with pytest.raises(ValueError):
            R.Snapshot.from_record(bad)
    for junk in ({}, {"members": [], "cells": {}}, None, "x"):
        with pytest.raises(ValueError):
            R.Snapshot.from_record(junk)


def test_a_snapshot_needs_a_cell_a_name_and_members_and_is_immutable():
    obs = spread(0, 12, [1, 2, 3])
    for bad in ({}, {"": obs}, {"x" * 121: obs}, {"a": []}):
        with pytest.raises(ValueError):
            snap(bad)
    s = total(obs)
    with pytest.raises(dataclasses.FrozenInstanceError):
        s.snapshot_id = "0" * 64
    with pytest.raises(ValueError):
        R.Snapshot.make({"t": obs}, released_at=datetime(2026, 1, 1), figures=None)             # a naive datetime is not a time


def test_supersession_is_an_annotation_beside_the_snapshot_never_an_edit_of_it():
    obs = spread(0, 12, [1, 2, 3, 4])
    s = total(obs)
    before = (s.snapshot_id, s.to_record())
    assert R.supersede(s, {"f" * 64}, withdrawal_id="w1", at=T0) is None                         # contains nothing withdrawn
    note = R.supersede(s, {obs[3].observation}, withdrawal_id="w1", at=T0 + MONTH)
    assert note.snapshot_id == s.snapshot_id and note.withdrawal_id == "w1" and note.superseded_at == T0 + MONTH
    assert (s.snapshot_id, s.to_record()) == before                                              # byte for byte the same release
    s2 = total(obs + spread(100, 10, [5, 6, 7]), T0 + MONTH)
    assert R.served([s, s2], []) == s2
    assert R.served([s, s2], [note]) == s2                                                       # the earlier one is the superseded one
    note2 = R.supersede(s2, {obs[3].observation}, withdrawal_id="w1", at=T0 + MONTH)
    assert R.served([s, s2], [note, note2]) is None                                              # nothing left to show
    assert R.served([], []) is None


# =============================================================================================== the step between releases

def first_release(n=12, orgs=(1, 2, 3, 4)):
    return total(spread(0, n, list(orgs)))


def test_the_first_release_is_held_only_to_the_cell_floor():
    assert accepted(first_release()).allowed
    assert not accepted(total(spread(0, 9, [1, 2, 3]))).allowed
    d = accepted(total(spread(0, 12, [1, 2])))
    assert d.verdict == R.REFUSED and R.SMALL_CELL in d.codes


@pytest.mark.parametrize("added,orgs,allowed", [
    (1, [9], False),                   # the textbook attack: one more observation
    (9, [9, 10, 11], False),           # one short of the step
    (10, [9, 10, 11], True),           # exactly the step
    (10, [9, 10], False),              # enough observations, too few organisations
    (10, [9], False),
    (14, [9, 10, 11, 12], True),
    (10, [1, 2, 3], True),             # organisations already in the earlier release may supply the step
])
def test_a_release_must_differ_from_the_last_by_a_safe_group(added, orgs, allowed):
    p = first_release()
    nxt = total(list(p.member_map.values()) + spread(100, added, orgs), T0 + MONTH)
    d = accepted(nxt, [p])
    assert d.allowed is allowed, d
    if not allowed:
        assert R.STEP in d.codes


def test_a_swap_of_one_for_one_is_refused_and_so_is_dropping_a_few():
    p = first_release()
    obs = list(p.member_map.values())
    swapped = total(obs[1:] + [c(500, 9)], T0 + MONTH)
    assert not accepted(swapped, [p]).allowed
    dropped = total(obs[:-1] + spread(300, 10, [20, 21, 22]), T0 + MONTH)
    assert accepted(dropped, [p]).allowed                  # ten new observations hide the one that left
    assert not accepted(total(obs[:-1], T0 + MONTH), [p]).allowed                 # but a bare removal is the removed observation's sum


def test_the_new_release_is_compared_with_every_earlier_one_not_only_the_last():
    """S1; S2 = S1 + twenty; S3 = S1 + ONE of the twenty. S3 differs from S2 by nineteen, which looks fine; S3 minus S1 is that one observation."""
    s1 = first_release()
    base = list(s1.member_map.values())
    twenty = spread(100, 20, [5, 6, 7, 8])
    s2 = total(base + twenty, T0 + MONTH)
    assert accepted(s2, [s1]).allowed
    s3 = total(base + twenty[:1], T0 + 2 * MONTH)
    d = accepted(s3, [s1, s2])
    assert not d.allowed and R.STEP in d.codes
    only_last = R.evaluate_release(s3, [s2], now=s3.released_at)
    assert only_last.allowed, "the fixture must show that checking only the last release would have let it through"


def test_a_superseded_release_still_counts_as_history():
    s1 = first_release()
    base = list(s1.member_map.values())
    s2 = total(base + spread(100, 10, [5, 6, 7]), T0 + MONTH)
    note = R.supersede(s2, {next(iter(s2.membership))}, withdrawal_id="w", at=T0 + 2 * MONTH)
    assert note is not None
    # a candidate one observation away from the superseded s2 is refused: whoever saw s2 still holds it
    nxt = total(list(s2.member_map.values()) + [c(900, 30)], T0 + 3 * MONTH)
    assert not accepted(nxt, [s1, s2]).allowed


def test_an_unchanged_membership_is_not_a_new_release():
    s1 = first_release()
    again = total(list(s1.member_map.values()), T0 + MONTH)
    d = accepted(again, [s1])
    assert d.verdict == R.UNCHANGED and not d.allowed


def test_the_cadence_is_a_floor_on_the_time_between_releases():
    s1 = first_release()
    obs = list(s1.member_map.values()) + spread(100, 10, [5, 6, 7])
    just_before = total(obs, T0 + R.MIN_RELEASE_INTERVAL - timedelta(seconds=1))
    on_time = total(obs, T0 + R.MIN_RELEASE_INTERVAL)
    d = accepted(just_before, [s1])
    assert not d.allowed and R.CADENCE in d.codes
    assert accepted(on_time, [s1]).allowed


def test_a_release_dated_ahead_of_the_clock_is_refused():
    s = first_release()
    d = R.evaluate_release(s, [], now=T0 - timedelta(hours=1))
    assert not d.allowed and R.FUTURE in d.codes
    assert R.evaluate_release(s, [], now=T0 - R.CLOCK_SKEW).allowed


def test_a_tombstoned_observation_is_in_no_release_and_the_reasons_are_all_given():
    obs = spread(0, 12, [1, 2, 3, 4])
    s = total(obs)
    d = R.evaluate_release(s, [], now=T0, tombstoned={obs[2].observation})
    assert not d.allowed and R.TOMBSTONED in d.codes
    big = total(spread(0, 3, [1]), T0)                       # several things wrong at once: every code is reported
    d = R.evaluate_release(big, [first_release()], now=T0, tombstoned={big.members[0].observation})
    assert {R.TOMBSTONED, R.SMALL_CELL, R.CADENCE}.issubset(d.codes)


def test_a_withdrawal_that_only_removes_is_not_released_until_enough_new_observations_hide_it():
    s1 = first_release(n=16, orgs=(1, 2, 3, 4))
    base = list(s1.member_map.values())
    s2 = total(base + spread(100, 12, [5, 6, 7]), T0 + MONTH)
    assert accepted(s2, [s1]).allowed
    org1 = {o for o in s2.members if o.organisation == R.organisation_hash("org-1")}
    assert 1 <= len(org1) < R.RELEASE_STEP_OBSERVATIONS
    without = [o for o in s2.members if o not in org1]
    bare = total(without, T0 + 2 * MONTH)
    d = accepted(bare, [s1, s2])
    assert not d.allowed and R.STEP in d.codes             # organisation 1's few observations would be the difference of the two releases
    refilled = total(without + spread(200, 10, [8, 9, 10]), T0 + 3 * MONTH)
    assert accepted(refilled, [s1, s2]).allowed


# =============================================================================================== cells inside one release

def test_a_withheld_small_cell_is_not_recoverable_as_the_total_minus_the_published_cells():
    big_a, big_b, small_c = spread(0, 12, [1, 2, 3, 4]), spread(100, 14, [5, 6, 7, 8]), spread(200, 4, [9, 10, 11, 12])
    cells = {"total": big_a + big_b + small_c, "a": big_a, "b": big_b, "c": small_c}
    plan = R.plan_cells(cells)
    assert plan.withheld["c"] == R.SMALL_CELL
    # Publishing total, a and b would leave total - a - b = c, four observations: the smallest published cell goes too.
    assert plan.withheld.get("a") == R.COMPLEMENT and set(plan.published) == {"total", "b"}
    naive = {n: g for n, g in cells.items() if n != "c"}
    rows = [frozenset(o.observation for o in g) for g in naive.values()]
    assert any(len(a) == 4 for a in R.recoverable_atoms(rows)), "without the rule the four are recoverable"
    kept = [frozenset(o.observation for o in g) for g in plan.published.values()]
    assert all(len(a) >= 10 for a in R.recoverable_atoms(kept))


def test_a_cell_that_moved_by_less_than_the_step_while_the_total_moved_by_more_is_withheld():
    s1 = snap({"total": spread(0, 26, [1, 2, 3, 4]), "a": spread(0, 14, [1, 2, 3, 4])})
    a_plus_five = spread(0, 14, [1, 2, 3, 4]) + spread(100, 5, [5, 6])
    total_plus_ten = spread(0, 26, [1, 2, 3, 4]) + spread(100, 5, [5, 6]) + spread(300, 5, [7, 8, 9])
    plan = R.plan_cells({"total": total_plus_ten, "a": a_plus_five}, [s1])
    assert plan.withheld == {"a": R.STEP} and set(plan.published) == {"total"}


def three_sets():
    """a|d, b|d and a|b, where a and b are safe groups of twelve and d is two observations: (a|d + b|d - a|b) / 2 is d, yet every PAIR of these differs by a
    safe group (a|d against a|b is b, twelve; a|d against b|d is a against b)."""
    a, b, d = spread(0, 12, [1, 2, 3, 4]), spread(100, 12, [5, 6, 7, 8]), spread(200, 2, [9])
    return a, b, d


def test_every_combination_is_considered_not_only_pairs():
    a, b, d = three_sets()
    keys = lambda g: frozenset(o.observation for o in g)          # noqa: E731
    rows = [keys(a + d), keys(b + d), keys(a + b)]
    members = {o.observation: o for o in a + b + d}
    for i, x in enumerate(rows):
        for y in rows[:i] + rows[i + 1:]:
            assert R._step_ok(x, y, members), "the fixture must pass the pair rule"
    assert keys(d) in R.recoverable_atoms(rows)
    s1, s2 = snap({"c1": a + d}, T0), snap({"c2": b + d}, T0 + MONTH)
    verdict = R.evaluate_release(snap({"c3": a + b}, T0 + 2 * MONTH), [s1, s2], now=T0 + 2 * MONTH)
    assert not verdict.allowed and verdict.codes == (R.LEAK,), verdict
    # the same attacker, on exact sums, does recover the two observations of d if the third set is released
    values = {o.observation: 100 + i for i, o in enumerate(a + b + d)}
    sums = [(r, sum(values[k] for k in r)) for r in rows]
    assert (keys(d), sum(values[k] for k in keys(d))) in attack(sums)


def test_the_algebra_alone_stops_the_three_sets_so_removing_it_would_let_them_through(monkeypatch):
    a, b, d = three_sets()
    s1, s2 = snap({"c1": a + d}, T0), snap({"c2": b + d}, T0 + MONTH)
    third = snap({"c3": a + b}, T0 + 2 * MONTH)
    monkeypatch.setattr(R, "_unsafe_recoverable", lambda rows, members, base=None: set())
    assert R.evaluate_release(third, [s1, s2], now=T0 + 2 * MONTH).allowed


def test_the_proof_refuses_when_it_has_too_many_atoms(monkeypatch):
    """The size limit is on ATOMS (what the proof's cost follows), not on how many sets were published: nothing is proved beyond it, so nothing is released."""
    monkeypatch.setattr(R, "MAX_PROOF_ATOMS", 3)
    s1 = snap({"total": spread(0, 20, [1, 2, 3, 4]), "a": spread(0, 12, [1, 2, 3, 4]), "b": spread(0, 14, [1, 2, 3, 4]), "c": spread(0, 16, [1, 2, 3, 4])})
    d = accepted(s1, [])
    assert not d.allowed and R.PROOF_TOO_LARGE in d.codes
    with pytest.raises(ValueError):
        R.recoverable_atoms([frozenset({str(i)}) for i in range(4)])
    assert not hasattr(R, "MAX_PROOF_ROWS"), "the limit on rows is gone: a long history is not a reason to stop releasing"


# ---- C2: the proof holds against an organisation (or a coalition below M) that knows its own observations

def two_small_groups():
    """Cells p = U + a, q = V + b, r = U + V (U and V safe groups of ten from four organisations; a and b one observation each, a the victim's and b the
    attacker's): p + q - r = a + b exactly. No unit vector is in the row space (no single group is recoverable), yet the organisation that owns b reads a off it."""
    u = [c(i, i % 4) for i in range(10)]
    v = [c(100 + i, 10 + i % 4) for i in range(10)]
    a, b = c(200, "victim"), c(201, "attacker")
    return u, v, a, b, {"cell_p": u + [a], "cell_q": v + [b], "cell_r": u + v}


def test_a_sum_over_two_small_groups_is_refused_although_neither_is_recoverable_alone():
    u, v, a, b, cells = two_small_groups()
    s = snap(cells)
    rows = list(s.cell_sets.values())
    assert R.recoverable_atoms(rows) == [], "the earlier, single-group proof sees nothing here (that is the defect)"
    values = {o.observation: 100 + 7 * i for i, o in enumerate(u + v + [a, b])}
    sums = [(r, sum(values[k] for k in r)) for r in rows]
    # the attacker that owns b (independent of release.py): add b as a known value and read off a
    recovered = attack(sums + [(frozenset({b.observation}), values[b.observation])])
    assert (frozenset({a.observation}), values[a.observation]) in recovered, "the fixture must show the attack works on exact sums"
    d = accepted(s, [])
    assert not d.allowed and d.codes == (R.LEAK,), d
    plan = R.plan_cells(cells)
    assert len(plan.published) < 3 and set(plan.withheld.values()) <= {R.COMPLEMENT}, plan
    kept = [frozenset(o.observation for o in g) for g in plan.published.values()]
    rec = attack([(r, sum(values[k] for k in r)) for r in kept] + [(frozenset({b.observation}), values[b.observation])])
    assert (frozenset({a.observation}), values[a.observation]) not in rec


def test_a_small_group_a_combination_isolates_is_refused_and_two_safe_groups_are_not():
    u, v, a, b, _ = two_small_groups()
    one_more = snap({"p": u + v, "q": u + v + [a]})                                                 # q - p is a: one observation
    assert not accepted(one_more, []).allowed
    three = snap({"p": u + [a], "q": v + [a], "r": u + v + [a]})                                    # p + q - r is a again, from three sets that each look fine
    d = accepted(three, [])
    assert not d.allowed and R.LEAK in d.codes
    assert accepted(snap({"p": u + v, "q": u}), []).allowed                                         # atoms U and V, both safe, both recoverable, and published anyway


def test_two_organisations_that_own_the_rest_of_a_small_group_isolate_its_last_observation():
    """Sets p = U + A, q = V + Y, r = U + V where A holds x (organisation 9) and y5 (organisation 5) and Y holds y6 (organisation 6): p + q - r = A + Y. The
    pair {5, 6} owns y5 and y6, so it reads x off the sum over A + Y. A coalition of ONE organisation cannot (it would have to own all but x of both atoms), which
    is what ``MAX_COALITION`` = M - 1 = 2 is about: the pair is refused, and with the coalition limited to one the same release would pass."""
    u, v = spread(0, 12, [1, 2, 3, 4]), spread(100, 12, [1, 2, 3, 4])
    x, y5, y6 = c(300, 9), c(301, 5), c(302, 6)
    cells = {"p": u + [x, y5], "q": v + [y6], "r": u + v}
    values = {o.observation: 100 + 11 * i for i, o in enumerate(u + v + [x, y5, y6])}
    sums = [(frozenset(o.observation for o in g), sum(values[o.observation] for o in g)) for g in cells.values()]
    known = [(frozenset({k.observation}), values[k.observation]) for k in (y5, y6)]
    assert (frozenset({x.observation}), values[x.observation]) in attack(sums + known), "the fixture must show that the pair of organisations wins on exact sums"
    assert not attack(sums + known[:1]) or (frozenset({x.observation}), values[x.observation]) not in attack(sums + known[:1])         # one of them alone does not
    d = accepted(snap(cells), [])
    assert not d.allowed and R.LEAK in d.codes, d


def test_the_coalition_limit_is_the_only_thing_that_lets_the_pair_through(monkeypatch):
    u, v = spread(0, 12, [1, 2, 3, 4]), spread(100, 12, [1, 2, 3, 4])
    cells = {"p": u + [c(300, 9), c(301, 5)], "q": v + [c(302, 6)], "r": u + v}
    assert not accepted(snap(cells), []).allowed
    monkeypatch.setattr(R, "MAX_COALITION", 1)
    assert accepted(snap(cells), []).allowed, "with the coalition limited to one organisation the proof does not look for the pair"


def test_an_exposure_already_in_the_history_is_not_charged_to_a_release_that_did_not_cause_it():
    u, v, a, b, cells = two_small_groups()
    history = snap(cells)                                                                           # released before the policy existed (its rows are trusted)
    more = list(history.member_map.values()) + spread(500, 12, [30, 31, 32, 33])
    d = R.evaluate_release(total(more, T0 + MONTH), [history], now=T0 + MONTH)
    assert R.LEAK not in d.codes, d


def exact_isolation(sets, members_by_hash, observations):
    """Independent of release.py and of its atoms: build the sums of a seeded set of exact values, and ask the exact solver, for each organisation that knows only
    its own observations, which OTHER observations it determines."""
    values = {o: 1000 + 37 * i for i, o in enumerate(sorted(observations))}
    sums = [(s, sum(values[k] for k in s)) for s in sets]
    leaks = []
    by_org = {}
    for o in observations:
        by_org.setdefault(members_by_hash[o].organisation, set()).add(o)
    for org, own in sorted(by_org.items(), key=lambda kv: -len(kv[1]))[:3]:                       # the three organisations with the most to subtract
        known = [(frozenset({k}), values[k]) for k in sorted(own)]
        for group, _ in attack(sums + known):
            if len(group) == 1 and not (group <= own):
                leaks.append((org[:8], sorted(group)[0][:8]))
    return leaks


def months_of_arrivals(seed, publisher=None, months=14):
    """The review's sweep: breakdown cells over arrivals from seven organisations, released month by month under the policy."""
    rng = random.Random(seed)
    pool, history, attrs = [], [], {}
    for month in range(months):
        for _ in range(rng.randint(2, 14)):
            o = c(len(attrs), rng.randrange(7))
            attrs[o.observation] = {"cap": rng.choice("sml"), "ev": rng.choice("AB"), "arch": rng.choice("XYZ")}
            pool.append(o)
        dim = rng.choice(["cap", "ev", "arch"])
        groups = {}
        for o in pool:
            groups.setdefault(f"{dim}:{attrs[o.observation][dim]}", []).append(o)
        p = R.propose_release({"total": pool, **groups}, history=history, now=T0 + MONTH * month, figures_for=lambda names: {"cells": names})
        if p.snapshot:
            history.append(p.snapshot)
    return pool, history


@pytest.mark.parametrize("seed", range(8))
def test_an_organisation_that_knows_only_its_own_observations_isolates_nobody_elses(seed):
    """C2's realistic case (4 of 150 seeds under the earlier proof)."""
    pool, history = months_of_arrivals(seed)
    sets = [cs for s_ in history for cs in s_.cell_sets.values()]
    assert len(history) >= 2, "the run must release something for it to mean anything"
    assert exact_isolation(sets, {o.observation: o for o in pool}, set().union(*sets)) == []


def test_the_leaks_the_earlier_proof_let_through_are_found_by_the_independent_attacker(monkeypatch):
    """Revert-check: with the proof reduced to the earlier single-group test the same seeded months DO release a history that an organisation with only its own
    observations reads another's observation from (seeds 1, 31, 119 and 136 of the review's sweep)."""
    def single_group(rows, members, base=None):
        space = base.copy() if base is not None else R._Space()
        for r in R._distinct_rows(rows):
            space.extend(r)
        return {a for a in space.recoverable() if not R.check_group(members[o] for o in a).safe}
    monkeypatch.setattr(R, "_unsafe_recoverable", single_group)
    found = 0
    for seed in (1, 31, 119, 136):
        pool, history = months_of_arrivals(seed)
        sets = [cs for s_ in history for cs in s_.cell_sets.values()]
        found += bool(exact_isolation(sets, {o.observation: o for o in pool}, set().union(*sets)))
    assert found >= 1, "the independent attacker must be able to find what the earlier proof missed, or the sweep above proves nothing"


def brute_exposed(sets, members, size=None):
    """The criterion written a second way, from the definition, in exact fractions and at the level of single observations (no atoms carried between steps, no
    reduced basis, no pivot bookkeeping): (a) unsafe groups of observations that no published set tells apart whose own sum is a combination of the published
    sums; (b) for each coalition of at most `size` organisations, delete its observations from every published set and ask which single observation is then a
    combination of what is left. Returns the groups (frozensets of observations) the incremental proof reports, so the two can be compared."""
    size = R.MAX_COALITION if size is None else size
    obs = sorted(set().union(*sets))
    sig = {o: tuple(1 if o in s else 0 for s in sets) for o in obs}
    classes = {}
    for o in obs:
        classes.setdefault(sig[o], []).append(o)
    atom_of = {o: frozenset(v) for v in classes.values() for o in v}

    def in_span(rows, target):
        rows = [[Fraction(x) for x in r] for r in rows if any(r)]
        t = [Fraction(x) for x in target]
        for col in range(len(t)):
            piv = next((i for i, r in enumerate(rows) if r[col] != 0 and all(r[k] == 0 for k in range(col))), None)
            if piv is None:
                continue
            f = t[col] / rows[piv][col]
            t = [a - f * b for a, b in zip(t, rows[piv])]
        return not any(t)

    def echelon(rows):
        rows = [[Fraction(x) for x in r] for r in rows]
        out = []
        for col in range(len(rows[0]) if rows else 0):
            piv = next((i for i, r in enumerate(rows) if r[col] != 0), None)
            if piv is None:
                continue
            row = rows.pop(piv)
            row = [x / row[col] for x in row]
            rows = [[a - r[col] * b for a, b in zip(r, row)] for r in rows]
            out.append(row)
        return out

    found = set()
    full = echelon([[1 if o in s else 0 for o in obs] for s in sets])
    for atom in set(atom_of.values()):
        if not R.check_group(members[o] for o in atom).safe and in_span(full, [1 if o in atom else 0 for o in obs]):
            found.add(atom)
    orgs = sorted({members[o].organisation for o in obs})
    for k in range(1, size + 1):
        for coalition in itertools.combinations(orgs, k):
            known = {o for o in obs if members[o].organisation in coalition}
            rest = [o for o in obs if o not in known]
            if not rest:
                continue
            reduced = echelon([[1 if o in s else 0 for o in rest] for s in sets])
            for i, x in enumerate(rest):
                if in_span(reduced, [1 if j == i else 0 for j in range(len(rest))]):
                    found.add(atom_of[x])
    return found


@pytest.mark.parametrize("seed", range(14))
def test_the_incremental_proof_agrees_with_the_definition_computed_from_scratch(seed):
    rng = random.Random(seed)
    pool = [c(i, rng.randrange(6)) for i in range(rng.randint(24, 34))]
    members = {o.observation: o for o in pool}
    blocks = [rng.sample(pool, rng.randint(1, 14)) for _ in range(rng.randint(2, 5))]
    sets = []
    for _ in range(rng.randint(3, 7)):
        picks = rng.sample(blocks, rng.randint(1, min(3, len(blocks))))
        sets.append(frozenset(o.observation for blk in picks for o in blk))
    sets = sorted({s_ for s_ in sets if s_}, key=sorted)
    space = R._Space()
    for s_ in sets:
        space.extend(s_)
    assert space.exposed(members) == brute_exposed(sets, members)
    other = R._Space()                                                                              # the order the sets arrive in does not change the answer
    for s_ in sorted(sets, key=lambda x: (-len(x), sorted(x))):
        other.extend(s_)
    assert other.exposed(members) == space.exposed(members)


def test_the_proof_state_of_a_history_is_a_cache_of_a_pure_computation():
    s1 = first_release()
    s2 = total(list(s1.member_map.values()) + spread(100, 12, [5, 6, 7]), T0 + MONTH)
    third = total(list(s2.member_map.values()) + spread(300, 12, [8, 9, 10]), T0 + 2 * MONTH)
    R._SPACES.clear()
    cold = R.evaluate_release(third, [s1, s2], now=third.released_at)
    warm = R.evaluate_release(third, [s1, s2], now=third.released_at)
    R._SPACES.clear()
    assert cold == warm and cold.allowed
    assert len(R._space_for([s1, s2]).atoms) == 2 and len(R._space_for([s1]).atoms) == 1


def test_a_release_cannot_be_back_dated_by_more_than_a_day():
    s = first_release()
    now = T0 + timedelta(days=100)
    d = R.evaluate_release(s, [], now=now)
    assert not d.allowed and R.BACKDATED in d.codes
    assert R.evaluate_release(s, [], now=T0 + R.MAX_BACKDATE).allowed
    assert R.BACKDATED in R.evaluate_release(s, [], now=T0 + R.MAX_BACKDATE + timedelta(seconds=1)).codes


def long_history(releases):
    """`releases` consecutive releases of three sets each (the total and two halves of it), every one a safe group, built directly: twenty-four new observations a
    release, from six organisations, so each half's step is twelve observations from three organisations. Returns the history and the next release's cells."""
    pool, history = [], []
    for k in range(releases):
        pool += [c(1000 * k + j, f"o{(3 * k + j) % 12}") for j in range(24)]
        half = {h: [o for i, o in enumerate(pool) if i % 2 == h] for h in (0, 1)}
        history.append(snap({"total": list(pool), "even": half[0], "odd": half[1]}, T0 + MONTH * k))
    return history, pool


def test_a_history_of_hundreds_of_published_sets_does_not_stop_releases():
    """C11: the proof reduced a matrix with one row per distinct published set and refused beyond 300 of them, so every release was refused once a monthly
    history held that many (about thirteen years of the three-cell releases below). It now holds one column per atom, and what stands for the history is a state
    that is grown, so a candidate after 160 releases (481 distinct sets) is judged on the atoms."""
    history, pool = long_history(160)
    rows = len({cell for s_ in history for cell in s_.cell_sets.values()})
    assert rows > 450
    nxt = pool + [c(990000 + j, f"o{j % 12}") for j in range(24)]
    cells = {"total": nxt, "even": [o for i, o in enumerate(nxt) if i % 2 == 0], "odd": [o for i, o in enumerate(nxt) if i % 2 == 1]}
    started = time.monotonic()
    d = R.evaluate_release(snap(cells, T0 + MONTH * 160), history, now=T0 + MONTH * 160)
    assert d.allowed, d
    space = R._space_for(history)
    assert len(space.atoms) <= 2 * len(history) and len(space.basis) <= len(space.atoms) < R.MAX_PROOF_ATOMS
    assert time.monotonic() - started < 60
    assert not hasattr(R, "MAX_PROOF_ROWS")


def test_a_twenty_year_monthly_history_still_releases_and_the_proof_stays_within_its_budget():
    """Two hundred and forty months of arrivals from twelve organisations, three breakdown cells offered each month besides the total, and a withdrawal of six
    observations every year. (The earlier proof, run on a denser version of the same months, stopped releasing at about month 158: the last 82 of 240 decisions refused.)"""
    rng = random.Random(20)
    pool, history, attrs = [], [], {}
    nobs, slowest = 0, 0.0
    started = time.monotonic()
    for month in range(240):
        for _ in range(rng.randint(1, 6)):
            o = c(nobs, rng.randrange(12))
            nobs += 1
            attrs[o.observation] = rng.choice("sml")
            pool.append(o)
        if month % 12 == 11 and history:
            gone = [o for o in pool if o.organisation == R.organisation_hash(f"org-{rng.randrange(12)}")][:6]
            pool = [o for o in pool if o not in gone]
        cells = {"total": pool, **{f"cap:{k}": [o for o in pool if attrs[o.observation] == k] for k in "sml"}}
        t0 = time.monotonic()
        p = R.propose_release(cells, history=history, now=T0 + MONTH * month, figures_for=lambda names: {"cells": names})
        slowest = max(slowest, time.monotonic() - t0)
        if p.snapshot:
            history.append(p.snapshot)
    space = R._space_for(history)
    assert len(history) >= 100 and history[-1].released_at > T0 + MONTH * 225, (len(history), history[-1].released_at)       # a release every other month, to the end
    assert len(space.atoms) < R.MAX_PROOF_ATOMS // 2 and len(space.basis) <= len(space.atoms)
    assert slowest < 20 and time.monotonic() - started < 240, (slowest, time.monotonic() - started)
    members = {c_.observation: c_ for s_ in history for c_ in s_.members}
    assert space.exposed(members) == set()                                                          # nothing in the whole history is isolated


# =============================================================================================== proposing a release

def test_propose_release_serves_the_last_release_unchanged_when_it_may_not_make_a_new_one():
    seen = []

    def figures(names):
        seen.append(list(names))
        return {"cells": list(names)}

    obs = spread(0, 12, [1, 2, 3, 4])
    p1 = R.propose_release({"total": obs}, history=[], now=T0, figures_for=figures)
    assert p1.decision.allowed and p1.snapshot is p1.served and p1.figures == {"cells": ["total"]}
    # one new observation a month later: refused, and the reader is shown the first release again
    p2 = R.propose_release({"total": obs + [c(99, 9)]}, history=[p1.snapshot], now=T0 + MONTH, figures_for=figures)
    assert not p2.decision.allowed and p2.snapshot is None and p2.served == p1.snapshot and R.STEP in p2.decision.codes
    # ten new observations from three organisations: released
    p3 = R.propose_release({"total": obs + spread(100, 10, [5, 6, 7])}, history=[p1.snapshot], now=T0 + MONTH, figures_for=figures)
    assert p3.decision.allowed and p3.served == p3.snapshot != p1.snapshot
    # nothing new at all: served as it is
    p4 = R.propose_release({"total": obs}, history=[p1.snapshot], now=T0 + MONTH, figures_for=figures)
    assert p4.decision.verdict == R.UNCHANGED and p4.served == p1.snapshot and p4.snapshot is None
    assert seen[0] == ["total"]


def test_propose_release_with_nothing_publishable_publishes_nothing_and_says_so():
    p = R.propose_release({"total": spread(0, 4, [1, 2])}, history=[], now=T0, figures_for=lambda names: {})
    assert p.snapshot is None and p.served is None and p.decision.codes == (R.EMPTY, R.SMALL_CELL) and p.plan.withheld == {"total": R.SMALL_CELL}


def test_the_decision_is_deterministic_and_does_not_depend_on_the_order_things_arrive_in():
    obs = spread(0, 24, [1, 2, 3, 4, 5])
    cells = {"total": obs, "x": obs[:12], "y": obs[12:], "z": obs[6:18]}
    runs = []
    for seed in range(5):
        rng = random.Random(seed)
        shuffled = {n: rng.sample(g, len(g)) for n, g in rng.sample(sorted(cells.items()), len(cells))}
        pr = R.propose_release(shuffled, history=[], now=T0, figures_for=lambda names: {"names": list(names)})
        runs.append((pr.decision, pr.plan, pr.snapshot))
    assert all(r == runs[0] for r in runs)


# =============================================================================================== the attacker

def attack(published):
    """Everything an exact-arithmetic reader can learn from `published`, a list of (set of observation keys, exact sum): the groups of observations whose
    SUM is determined, each with that sum. Written independently of release.py: one column per observation, identical columns merged (they cannot be told
    apart), Gauss-Jordan over Fractions on the augmented matrix. A group is determined when its pivot row has no other non-zero coefficient."""
    keys = sorted(set().union(*[s for s, _ in published]))
    cols = {}
    for k in keys:
        cols.setdefault(tuple(1 if k in s else 0 for s, _ in published), []).append(k)
    sigs = list(cols)
    m = [[Fraction(sig[i]) for sig in sigs] + [Fraction(v)] for i, (_, v) in enumerate(published)]
    r = 0
    pivots = []
    for col in range(len(sigs)):
        piv = next((i for i in range(r, len(m)) if m[i][col] != 0), None)
        if piv is None:
            continue
        m[r], m[piv] = m[piv], m[r]
        m[r] = [x / m[r][col] for x in m[r]]
        for i in range(len(m)):
            if i != r and m[i][col] != 0:
                f = m[i][col]
                m[i] = [a - f * b for a, b in zip(m[i], m[r])]
        pivots.append(col)
        r += 1
    out = []
    for row, col in zip(m, pivots):
        if all(x == 0 for j, x in enumerate(row[:-1]) if j != col):
            out.append((frozenset(cols[sigs[col]]), row[-1]))
    return out


def bucket(contribution):
    return "b" + str(int(contribution.observation[:2], 16) % 3)


def month_cells(pool):
    cells = {"total": pool}
    for b in ("b0", "b1", "b2"):
        cells[b] = [o for o in pool if bucket(o) == b]
    return {n: g for n, g in cells.items() if g}


def simulate(seed, publisher, months=14, step=MONTH, arrivals=5):
    """Observations arrive a few at a time from a handful of organisations; at each month's end the publisher is asked what to release. Returns every
    published sum an exact reader would hold as (observations, sum), the true values, the releases made, and the same sums with the cell's name and month."""
    rng = random.Random(seed)
    orgs = [f"org-{i}" for i in range(rng.randint(5, 9))]
    values, pool, history, sums, named, releases = {}, [], [], [], [], []
    for month in range(months):
        for _ in range(rng.randint(0, arrivals)):
            o = R.Contribution.from_ids(f"s{seed}-{len(values)}", rng.choice(orgs))
            values[o.observation] = rng.randint(1, 10_000)
            pool.append(o)
        now = T0 + step * (month + 1)
        snapshot, published = publisher(month_cells(pool), history, now)
        if snapshot is not None:
            history.append(snapshot)
            releases.append(snapshot)
        for name, group in published.items():
            keys = frozenset(o.observation for o in group)
            sums.append((keys, sum(values[k] for k in keys)))
            named.append((month, name, keys, sum(values[k] for k in keys)))
    return sums, values, releases, named


def naive_publisher(cells, history, now):
    """The per-cell floor and nothing else: every cell that is a safe group is published every month."""
    ok = {n: g for n, g in cells.items() if R.check_group(g).safe}
    if not ok:
        return None, {}
    snap_ = R.Snapshot.make(ok, released_at=now, figures={"n": len(ok)})
    return snap_, ok


def policy_publisher(cells, history, now):
    p = R.propose_release(cells, history=history, now=now, figures_for=lambda names: {"cells": list(names)})
    return (p.snapshot, {n: p.plan.published[n] for n in p.plan.published}) if p.snapshot else (None, {})


def smallest_recovered(sums):
    return min((len(a) for a, _ in attack(sums)), default=None) if sums else None


SEEDS = range(24)


def test_the_attack_works_against_a_publisher_that_applies_only_the_cell_floor():
    """The attacker is worth something: recovers a single observation's exact value in most seeded runs, and every value it reports is true."""
    wins = 0
    for seed in SEEDS:
        sums, values, _, _ = simulate(seed, naive_publisher)
        for group, value in attack(sums):
            assert value == sum(values[k] for k in group)                                         # it never reports a wrong sum
        small = smallest_recovered(sums)
        wins += small is not None and small < R.MIN_CELL_OBSERVATIONS
    assert wins >= int(0.8 * len(SEEDS)), wins


def test_the_classic_difference_of_two_means_is_one_observation_without_the_policy():
    for seed in SEEDS:
        sums, values, releases, named = simulate(seed, naive_publisher)
        totals = [(keys, v) for _, name, keys, v in named if name == "total"]
        for (x, sx), (y, sy) in zip(totals, totals[1:]):
            if len(y) - len(x) == 1 and x < y:
                (new,) = y - x
                assert (sy - sx) == values[new]                  # (n+1) x mean_B - n x mean_A, exactly
                return
    pytest.fail("no seed produced a release one observation after another")


def test_the_policy_never_releases_the_total_one_observation_after_the_last():
    for seed in SEEDS:
        _, _, releases, named = simulate(seed, policy_publisher)
        totals = [keys for _, name, keys, _ in named if name == "total"]
        for x, y in zip(totals, totals[1:]):
            assert len(y - x) >= R.RELEASE_STEP_OBSERVATIONS or len(x - y) >= R.RELEASE_STEP_OBSERVATIONS


@pytest.mark.parametrize("arrivals", [5, 14])            # a trickle (breakdown cells stay small) and a flood (they are big enough to publish)
def test_nothing_below_a_safe_group_is_recoverable_from_what_the_policy_releases(arrivals):
    released_any, cells_published = 0, set()
    for seed in SEEDS:
        sums, values, releases, named = simulate(seed, policy_publisher, arrivals=arrivals)
        cells_published |= {name for _, name, _, _ in named}
        released_any += len(releases) >= 2
        if not sums:
            continue
        for group, value in attack(sums):
            assert value == sum(values[k] for k in group)
            members = [c_ for r in releases for c_ in r.members if c_.observation in group]
            assert R.check_group({m.observation: m for m in members}.values()).safe, (seed, len(group))
        # successive releases and, more than that, ANY two published sets: what the pair determines is a group a reader cannot know.
        distinct = sorted({s for s, _ in sums}, key=lambda s: (len(s), sorted(s)))
        for i, x in enumerate(distinct):
            for y in distinct[i + 1:]:
                assert max(len(x - y), len(y - x)) >= R.RELEASE_STEP_OBSERVATIONS, (seed, len(x), len(y), len(x - y), len(y - x))
        for earlier, later in zip(releases, releases[1:]):
            assert max(len(later.membership - earlier.membership), len(earlier.membership - later.membership)) >= R.RELEASE_STEP_OBSERVATIONS
            assert later.released_at - earlier.released_at >= R.MIN_RELEASE_INTERVAL
    assert released_any >= len(SEEDS) // 2, "the policy must release often enough for these runs to mean something"
    if arrivals > 10:
        assert len(cells_published) > 1, "with enough arrivals the breakdown cells must be exercised too"


def test_a_patient_attacker_who_adds_one_observation_a_month_never_sees_a_difference_of_one():
    """The attacker's own organisation submits a single observation every month and watches. The policy does not release until enough others have joined."""
    rng = random.Random(7)
    pool, history, sums, values = spread(0, 12, [1, 2, 3, 4]), [], [], {}
    for o in pool:
        values[o.observation] = rng.randint(1, 9999)
    held = 0
    for month in range(24):
        mine = c(1000 + month, "attacker")
        values[mine.observation] = rng.randint(1, 9999)
        pool.append(mine)
        if month % 2 == 1:                                                                      # others trickle in too: four every second month
            for k in range(4):
                o = c(2000 + 4 * month + k, f"org-{5 + k}")
                values[o.observation] = rng.randint(1, 9999)
                pool.append(o)
        now = T0 + MONTH * (month + 1)
        p = R.propose_release({"total": pool}, history=history, now=now, figures_for=lambda n: {"n": len(pool)})
        held += p.snapshot is None
        if p.snapshot:
            history.append(p.snapshot)
            sums.append((frozenset(o.observation for o in pool), sum(values[o.observation] for o in pool)))
    assert held >= 12 and len(history) >= 3
    for earlier, later in zip(history, history[1:]):
        assert len(later.membership - earlier.membership) >= R.RELEASE_STEP_OBSERVATIONS
    assert all(len(group) >= R.MIN_CELL_OBSERVATIONS for group, _ in attack(sums))


def test_a_withdrawal_followed_by_a_release_does_not_expose_the_withdrawn_observations():
    rng = random.Random(3)
    s1_obs = spread(0, 16, [1, 2, 3, 4])
    s2_obs = s1_obs + spread(100, 12, [5, 6, 7])
    values = {o.observation: rng.randint(1, 9999) for o in s2_obs + spread(200, 10, [8, 9, 10])}
    s1, s2 = total(s1_obs, T0), total(s2_obs, T0 + MONTH)
    gone = {o.observation for o in s2_obs if o.organisation == R.organisation_hash("org-1")}
    note = R.supersede(s2, gone, withdrawal_id="w", at=T0 + 2 * MONTH)
    assert note is not None and R.served([s1, s2], [note]) == s1
    survivors = [o for o in s2_obs if o.observation not in gone]
    d = accepted(total(survivors, T0 + 2 * MONTH), [s1, s2])
    assert not d.allowed                                                                         # the release that would show the gap is refused
    s4_obs = survivors + spread(200, 10, [8, 9, 10])
    s4 = total(s4_obs, T0 + 3 * MONTH)
    assert accepted(s4, [s1, s2]).allowed
    sums = [(s.membership, sum(values[k] for k in s.membership)) for s in (s1, s2, s4)]
    recovered = attack(sums)
    assert recovered and all(len(group) >= 10 for group, _ in recovered)
    assert not any(group & gone for group, _ in recovered if len(group) < 10)


def test_with_the_step_and_the_algebra_switched_off_the_same_attacker_wins(monkeypatch):
    """Revert-check for the rules together: take the step, the combination proof and the cadence out and the policy is the naive publisher, and loses to
    the same attacker in the same seeded months."""
    monkeypatch.setattr(R, "_step_ok", lambda x, y, members: True)
    monkeypatch.setattr(R, "_unsafe_recoverable", lambda rows, members, base=None: set())
    monkeypatch.setattr(R, "MIN_RELEASE_INTERVAL", timedelta(0))
    wins = 0
    for seed in SEEDS:
        sums, values, releases, _ = simulate(seed, policy_publisher)
        small = smallest_recovered(sums)
        wins += small is not None and small < R.MIN_CELL_OBSERVATIONS
    assert wins >= int(0.8 * len(SEEDS)), wins


def test_the_step_and_the_algebra_each_stop_a_swap_of_one_observation_for_another(monkeypatch):
    """Drop the first observation (organisation 1's) and add one of organisation 9's: the two releases differ by one observation each way. The step refuses it. The
    earlier single-group proof saw nothing here (no group is recoverable on its own); the coalition proof refuses it too, since organisation 1 owns the dropped one."""
    p = first_release()
    swapped = total(list(p.member_map.values())[1:] + [c(500, 9)], T0 + MONTH)
    d = accepted(swapped, [p])
    assert not d.allowed and R.STEP in d.codes and R.LEAK in d.codes, d
    with monkeypatch.context() as m:
        m.setattr(R, "_unsafe_recoverable", lambda rows, members, base=None: set())
        assert R.STEP in accepted(swapped, [p]).codes and R.LEAK not in accepted(swapped, [p]).codes
    with monkeypatch.context() as m:
        m.setattr(R, "_step_ok", lambda x, y, members: True)
        d = accepted(swapped, [p])
        assert not d.allowed and R.LEAK in d.codes and R.STEP not in d.codes


def test_the_cadence_bounds_how_often_a_difference_can_exist(monkeypatch):
    """Weekly looks at a slow trickle of arrivals: the step alone would release whenever ten have joined; the cadence holds it to one a month."""
    week = timedelta(days=7)
    counts = {}
    for label, interval in (("monthly", R.MIN_RELEASE_INTERVAL), ("always", timedelta(0))):
        monkeypatch.setattr(R, "MIN_RELEASE_INTERVAL", interval)
        n = 0
        for seed in range(6):
            _, _, releases, _ = simulate(seed, policy_publisher, months=40, step=week, arrivals=3)
            n += len(releases)
            if label == "monthly":
                assert all(b.released_at - a.released_at >= R.MIN_RELEASE_INTERVAL for a, b in zip(releases, releases[1:]))
        counts[label] = n
    assert counts["always"] > counts["monthly"] > 0


def test_the_cell_floor_alone_is_what_the_complement_rule_adds_to():
    """Switch only the algebra off: the total-minus-published-cells attack on a withheld cell succeeds, which is why plan_cells runs it."""
    big_a, big_b, small_c = spread(0, 12, [1, 2, 3, 4]), spread(100, 14, [5, 6, 7, 8]), spread(200, 4, [9, 10, 11, 12])
    values = {o.observation: 100 + i for i, o in enumerate(big_a + big_b + small_c)}
    cells = {"total": big_a + big_b + small_c, "a": big_a, "b": big_b}
    sums = [(frozenset(o.observation for o in g), sum(values[o.observation] for o in g)) for g in cells.values()]
    assert min(len(g) for g, _ in attack(sums)) == 4                                              # the four of c are recovered
    plan = R.plan_cells({**cells, "c": small_c})
    kept = [(frozenset(o.observation for o in g), sum(values[o.observation] for o in g)) for g in plan.published.values()]
    assert min(len(g) for g, _ in attack(kept)) >= 10
