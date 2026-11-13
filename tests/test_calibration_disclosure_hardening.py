"""The public calibration aggregates cannot be inverted, and a small or lopsided dataset is not called calibrated.

Audit defects D2, D6 and D7. Every observation below is SYNTHETIC and lives only in this file (or a tmp_path); the shipped ledger stays
empty (tests/test_calibration_residuals.py pins it at zero observations).

  D2  differencing (a total minus a published cell = a suppressed cell) and small-n order statistics (mean + median + max of three
      sites = all three sites) re-identified individual sites in /v1/calibration/residuals.
  D7  one site supplying 48 of 50 readings reached CALIBRATED; no interval; builds pooled; a single site's exact ratio and date printed.
  D6  an imported row carried free text (a person, a site, a URL), the observation uuid and the exact dates into a published=True row.
"""
import hashlib
import itertools
import json
import random
import re
from datetime import datetime, timedelta, timezone

import pytest

from gridforge.calibration import accuracy_block, import_export
from gridforge.calibration import residuals as R
from gridforge.calibration.ledger import Ledger, read_chain
from gridforge.calibration.records import ObservationRecord
from gridforge.calibration.schema import Observation, site_only_ref
from gridforge.calibration.stats import CalibrationState, calibration_for
from gridforge.validation.evidence import EvidenceClass

NOW = datetime(2026, 11, 12, tzinfo=timezone.utc)
K = 5            # the published minimum, written out here on purpose: a test that read the constant would move with a weakened one


def rec(i, site, pred=100.0, meas=95.0, *, cap=None, var="it_load_kW", ev="E5_CUSTOMER_DATA", day=0, quality="high",
        version="1.2.3", lead_hours=None, status="approved"):
    at = datetime(2026, 6, 1, tzinfo=timezone.utc) + timedelta(days=day, minutes=i)
    d = {"observation_id": f"obs-{i:05d}", "site_id": f"site_{site:012x}", "hall_id": "H1", "measured_at": at.isoformat(),
         "variable": var, "predicted": pred, "measured": meas, "unit": "kW" if var == "it_load_kW" else "ratio",
         "measurement_source": "metered", "quality": quality, "model_version": version, "evidence": ev,
         "approval_status": status, "capacity_mw": cap}
    if status == "approved":
        d["reviewer"] = "Synthetic Reviewer"
    if lead_hours is not None:
        d["forecast_issued_at"] = (at - timedelta(hours=lead_hours)).isoformat()
    return ObservationRecord.from_dict(d, now=NOW)


def public_var(recs, var="it_load_kW"):
    rep = R.public_report(recs)
    sub = next(s for s in rep["subsystems"].values() if var in s["variables"])
    return sub["variables"][var]


# ---------------------------------------------------------------------------------------------------------------- D2: the audit repros

def audit_differencing_rows(lone_measured=1500):
    """Four sites in the 1-5 MW bucket and ONE site alone in '>=100 MW' (the lead-verified repro: measured 1500 against 1000 predicted, a
    signed error of -500). With the lone site's error running the other way from the four others the sign rule withholds the total as
    well, so the same scenario is run with it running the same way (measured 500: +500), where only the subtraction rules stand guard."""
    rows = [rec(i, i + 1, p, m, cap=2.0) for i, (p, m) in enumerate([(100, 90), (200, 190), (300, 280), (400, 395)])]
    rows.append(rec(10, 99, 1000, lone_measured, cap=150.0))
    return rows


@pytest.mark.parametrize("lone_measured", [1500, 500])
def test_differencing_a_total_against_a_published_cell_does_not_recover_the_suppressed_site(lone_measured):
    lone = 1000 - lone_measured
    v = public_var(audit_differencing_rows(lone_measured))
    cells = [v["residuals"], *v["by_capacity_bucket"].values()]
    # the suppressed site's exact error was recovered as total - published cell, weighting by readings or by sites
    for c in cells:
        for other in cells:
            if c is other or "mean_signed_error" not in c or "mean_signed_error" not in other:
                continue
            for w in ("n", "sites"):
                assert abs(c[w] * c["mean_signed_error"] - other[w] * other["mean_signed_error"] - lone) > 1e-6
                assert abs(c[w] * c["mean_abs_error"] - other[w] * other["mean_abs_error"] - 500.0) > 1e-6
    # and nothing of the lone site's cell is published
    assert v["by_capacity_bucket"][">=100 MW"].keys() == {"n", "sites", "suppressed"}


def test_one_site_off_the_other_way_from_four_is_isolated_by_error_and_absolute_error_together_so_nothing_is_published():
    """error = positive - negative, absolute = positive + negative: the mean of the two gives the negative part alone, which here is one
    site. The total is withheld (and says why) rather than published for the harness below to find."""
    cell = public_var(audit_differencing_rows(1500))["residuals"]
    assert cell.keys() == {"n", "sites", "suppressed"} and "one direction" in cell["suppressed"]


def test_three_sites_publish_no_statistic_at_all_so_mean_median_and_max_cannot_expose_them():
    rows = [rec(i, i + 1, 100, m, cap=2.0) for i, m in enumerate([95, 80, 60])]
    cell = public_var(rows)["residuals"]
    assert cell.keys() == {"n", "sites", "suppressed"} and cell["sites"] == 3
    assert str(K) in cell["suppressed"]
    text = json.dumps(R.public_report(rows))
    for forbidden in ("median_abs_error", "max_abs_error", "median_pct_error", "min_abs_error"):
        assert forbidden not in text


def test_a_published_cell_never_carries_a_median_a_maximum_a_minimum_or_a_percentile():
    rows = [rec(i, i + 1, 100, 90 - i, cap=2.0) for i in range(8)]
    text = json.dumps(R.public_report(rows))
    assert "mean_abs_error" in text, "eight sites do publish a mean"
    for word in ("median", "max_abs", "min_abs", "percentile", "quantile"):
        assert word not in text, word


def test_the_published_minimum_is_five_sites_and_four_is_not_enough():
    four = public_var([rec(i, i + 1, 100, 90 - i) for i in range(4)])["residuals"]
    five = public_var([rec(i, i + 1, 100, 90 - i) for i in range(5)])["residuals"]
    assert "suppressed" in four and "mean_signed_error" not in four
    assert "suppressed" not in five and five["n_sites"] == 5 and five["n_readings"] == 5


def test_complementary_suppression_hides_a_neighbour_so_a_two_site_cell_cannot_be_subtracted_out():
    """Capacity buckets: '1-5 MW' 6 sites, '5-20 MW' 5 sites, '>=100 MW' 2 sites. The two-site cell is suppressed, so the five-site cell
    must be suppressed too: total minus the published cell would otherwise isolate only the two sites of the small one."""
    rows, i = [], 0
    for site, cap in itertools.chain(((s, 2.0) for s in range(1, 7)), ((s, 10.0) for s in range(7, 12)), ((s, 150.0) for s in (12, 13))):
        rows.append(rec(i, site, 100, 100 - 3 * site, cap=cap))
        i += 1
    v = public_var(rows)
    buckets = v["by_capacity_bucket"]
    assert "mean_signed_error" in buckets["1-5 MW"], "six sites stay published"
    assert "suppressed" in buckets[">=100 MW"] and "suppressed" in buckets["5-20 MW"]
    assert "subtract" in buckets["5-20 MW"]["suppressed"], "the reason names why a five-site cell was withheld"
    assert "mean_signed_error" in v["residuals"]


def test_only_one_breakdown_is_published_per_variable_so_two_overlapping_ones_cannot_be_subtracted():
    """Capacity '1-5 MW' = sites 1..6, evidence 'E6' = sites 1..5 (all inside it): the difference is site 6 exactly."""
    rows = [rec(i, i + 1, 100, 100 - 2 * (i + 1), cap=2.0, ev="E6_FIELD_VALIDATED" if i < 5 else "E5_CUSTOMER_DATA") for i in range(6)]
    rows += [rec(20 + i, 30 + i, 100, 90, cap=10.0, ev="E5_CUSTOMER_DATA") for i in range(6)]
    v = public_var(rows)
    published = [name for name in ("by_capacity_bucket", "by_evidence_class", "lead_time_error")
                 if any("mean_signed_error" in c for c in v[name].values())]
    assert len(published) <= 1


# ---------------------------------------------------------------------------------------------------------------- D2: the attacker

def _site_truth(recs):
    by_site = {}
    for r in recs:
        by_site.setdefault(r.site_id, []).append(r.predicted - r.measured)
    return by_site


def _targets(recs):
    """Every quantity a re-identification would be after: each site's mean and sum (signed, absolute) and each single reading."""
    out = {}
    for s, errs in _site_truth(recs).items():
        for name, vals in (("signed", errs), ("abs", [abs(e) for e in errs])):
            out[("site mean", s, name)] = sum(vals) / len(vals)
            out[("site sum", s, name)] = sum(vals)
        for k, e in enumerate(errs):
            out[("reading", s, k, "signed")] = e
            out[("reading", s, k, "abs")] = abs(e)
    return out


def _index(values):
    idx = {}
    for key, v in values.items():
        idx.setdefault(round(v, 8), []).append(key)
    return idx


def _hit(idx, x):
    k = round(x, 8)
    for kk in (k, round(k - 1e-8, 8), round(k + 1e-8, 8)):
        if kk in idx:
            return idx[kk][0]
    return None


def attack(block, recs):
    """Subtract anything from anything. Returns the first exact recovery of a single site's figure, or None.

    The attacker holds the published variable block only: the total, the cells of the one breakdown, and their counts. It forms every
    difference of two cells and every total-minus-cells, weighted by readings (n) and by sites, for the signed and the absolute mean, and
    looks for a result that equals a single site's mean, sum or reading, or the aggregate of a cell that was withheld."""
    cells = {}
    if "mean_signed_error" in block["residuals"]:
        cells["TOTAL"] = block["residuals"]
    for fam in ("by_capacity_bucket", "by_evidence_class", "lead_time_error"):
        for name, c in block[fam].items():
            if "mean_signed_error" in c:
                cells[f"{fam}:{name}"] = c
    truth = _targets(recs)
    idx = _index(truth)
    # a cell that rests on fewer than K sites, published as it stands, is already a single site (or two) in aggregate clothing
    for label, c in cells.items():
        if c["sites"] < K:
            return ("published cell below the minimum", label)
    terms = []
    for label, c in cells.items():
        for w in ("n", "sites"):
            terms.append((f"{label}|{w}|signed", c[w] * c["mean_signed_error"]))
            terms.append((f"{label}|{w}|abs", c[w] * c["mean_abs_error"]))
    for (la, a), (lb, b) in itertools.permutations(terms, 2):
        hit = _hit(idx, a - b)
        if hit:
            return (f"{la} - {lb}", hit)
    for suffix in ("n|signed", "n|abs", "sites|signed", "sites|abs"):
        like = [(lab, v) for lab, v in terms if lab.endswith(suffix)]       # three-way differences within one weighting and statistic
        for (la, a), (lb, b), (lc, c) in itertools.permutations(like, 3):
            for val in (a - b - c, a - b + c):
                hit = _hit(idx, val)
                if hit:
                    return (f"{la} -/+ {lb} -/+ {lc}", hit)
    return None


def random_ledger(seed):
    rng = random.Random(seed)
    n_sites = rng.randint(3, 22)
    caps = rng.choice([[None, 2.0], [2.0, 10.0, 150.0], [0.5, 2.0, 10.0, 50.0, 150.0], [2.0]])
    evs = rng.choice([["E5_CUSTOMER_DATA"], ["E5_CUSTOMER_DATA", "E6_FIELD_VALIDATED"]])
    leads = rng.choice([[None], [None, 5], [None, 0.5, 5, 12, 100, 500]])
    mode = rng.choice(["over", "mixed", "mostly_over"])        # which way the model errs; the odd site out is what a sign split would isolate
    whole = rng.random() < 0.6          # each site lies wholly inside one cell of every breakdown (otherwise it may straddle cells)
    rows, i = [], 0
    for s in range(1, n_sites + 1):
        site_cap, site_ev, site_lead = rng.choice(caps), rng.choice(evs), rng.choice(leads)
        odd = rng.random() < 0.15
        for _ in range(rng.randint(1, 3)):
            pred = round(rng.uniform(50, 200), 4)
            if mode == "mixed":
                low, high = 0.6, 1.4
            else:
                low, high = (1.02, 1.4) if (mode == "mostly_over" and odd) else (0.6, 0.98)
            cap, ev, lead = (site_cap, site_ev, site_lead) if whole else (rng.choice([site_cap, rng.choice(caps)]), rng.choice(evs), rng.choice(leads))
            rows.append(rec(i, s, pred, round(pred * rng.uniform(low, high), 4), cap=cap, ev=ev, lead_hours=lead, day=rng.randint(0, 100)))
            i += 1
    return rows


@pytest.fixture
def unrounded(monkeypatch):
    """The structural rule is what is under test, so the publication rounding (a second defence) is switched off: with it on an exact
    recovery is impossible whatever is published."""
    from gridforge.calibration import publication
    monkeypatch.setattr(publication, "PUBLIC_SIG_FIGS", None)


@pytest.mark.parametrize("seed", range(400))
def test_the_differencing_attack_recovers_nothing_from_a_seeded_random_ledger(seed, unrounded):
    rows = random_ledger(seed)
    block = public_var(rows)
    assert attack(block, rows) is None


def lone_site_ledger(seed):
    """Six to ten sites inside '1-5 MW' and ONE site alone in '>=100 MW', every error the same way, one reading per site."""
    rng = random.Random(1000 + seed)
    rows = []
    for i in range(rng.randint(6, 10)):
        pred = round(rng.uniform(50, 200), 4)
        rows.append(rec(i, i + 1, pred, round(pred * rng.uniform(0.6, 0.98), 4), cap=2.0))
    pred = round(rng.uniform(500, 2000), 4)
    rows.append(rec(99, 999, pred, round(pred * rng.uniform(0.3, 0.9), 4), cap=150.0))
    return rows


def test_the_attack_harness_is_not_vacuous_it_does_recover_a_site_when_the_protections_are_off(monkeypatch, unrounded):
    """Control. With the rules on, nothing is recovered from a ledger that has one site alone next to a large published cell; with
    complementary suppression off and several breakdowns allowed, total-minus-cell recovers that site every time. So a pass above means
    the rules bite, not that the attacker is too weak to find anything."""
    from gridforge.calibration import publication
    ledgers = [lone_site_ledger(seed) for seed in range(30)]
    assert all(attack(public_var(rows), rows) is None for rows in ledgers), "with the rules on, nothing is recovered"
    monkeypatch.setattr(publication, "COMPLEMENTARY_SUPPRESSION", False)
    monkeypatch.setattr(publication, "MAX_PUBLISHED_BREAKDOWNS", 3)
    found = [attack(public_var(rows), rows) for rows in ledgers]
    assert all(f is not None and f[1][0] in ("site mean", "site sum", "reading") for f in found), found


def test_two_overlapping_breakdowns_subtract_to_a_site_when_more_than_one_is_published(monkeypatch, unrounded):
    """Control for the one-breakdown rule: capacity '1-5 MW' = sites 1..6 and evidence 'E6' = sites 1..5 (inside it). Their difference is
    site 6. With several breakdowns allowed the attacker finds it; with one it cannot."""
    from gridforge.calibration import publication
    rows = [rec(i, i + 1, 100.0, 100.0 - 3.25 * (i + 1), cap=2.0, ev="E6_FIELD_VALIDATED" if i < 5 else "E5_CUSTOMER_DATA") for i in range(6)]
    rows += [rec(20 + i, 30 + i, 100.0, 90.5 - i, cap=10.0, ev="E5_CUSTOMER_DATA") for i in range(6)]
    assert attack(public_var(rows), rows) is None
    monkeypatch.setattr(publication, "MAX_PUBLISHED_BREAKDOWNS", 3)
    assert attack(public_var(rows), rows) is not None


# ---------------------------------------------------------------------------------------------------------------- D7: states

def test_the_audit_repro_one_site_supplying_48_of_50_readings_is_not_calibrated():
    rows = [rec(d, 1, 100, 70, day=d) for d in range(48)] + [rec(48, 2, 100, 100), rec(49, 3, 100, 100, day=1)]
    block = R.residual_report(rows)["subsystems"]["envelope"]["variables"]["it_load_kW"]
    assert block["state"] == R.INDICATIVE
    assert "96%" in block["state_reason"] and "40%" in block["state_reason"]
    assert R.variable_state(rows) == R.INDICATIVE


def variable_with_site_counts(counts):
    rows, i = [], 0
    for site, n in enumerate(counts, start=1):
        for _ in range(n):
            rows.append(rec(i, site, 100, 90 + 0.01 * i, day=i))
            i += 1
    return rows


@pytest.mark.parametrize("counts,state", [
    ((4, 3, 3), R.CALIBRATED),               # 40% is the line and is allowed
    ((4, 4, 2), R.CALIBRATED),
    ((5, 3, 2), R.INDICATIVE),               # 50%
    ((8, 1, 1), R.INDICATIVE),
    ((5, 5), R.INDICATIVE),                  # only two sites
    ((2, 2, 2, 2, 2), R.CALIBRATED),
    ((3, 3, 3), R.INDICATIVE),               # nine observations: one short
    ((3, 3, 2, 2), R.CALIBRATED),
    ((41, 3, 3, 3), R.INDICATIVE),
])
def test_calibrated_needs_enough_sites_and_no_site_above_the_share(counts, state):
    assert R.variable_state(variable_with_site_counts(counts)) == state


def test_the_constants_are_named_and_the_site_floor_is_not_lowered():
    from gridforge.calibration import publication
    assert R.MIN_DISTINCT_SITES == 3
    assert publication.MAX_SINGLE_SITE_SHARE == 0.4
    assert publication.PUBLIC_MIN_SITES == K
    assert publication.PUBLIC_MIN_SITES >= R.MIN_DISTINCT_SITES


def test_the_ledger_state_has_the_same_share_rule():
    def obs(site, i):
        return Observation(key="envelope.racks", site_ref=site_only_ref(f"S{site}"), predicted=20.0, observed=24.0 + i, unit="racks",
                           observed_on=f"2026-0{1 + i % 9}-15", evidence=EvidenceClass.E5_CUSTOMER_DATA, method="metering")
    lopsided = [obs(1, 0), obs(1, 1), obs(1, 2), obs(2, 3), obs(3, 4)]      # 60% from one site
    assert calibration_for("envelope.racks", lopsided).state is CalibrationState.INDICATIVE
    even = [obs(1, 0), obs(1, 1), obs(2, 2), obs(2, 3), obs(3, 4)]          # 40%
    assert calibration_for("envelope.racks", even).state is CalibrationState.CALIBRATED


# ---------------------------------------------------------------------------------------------------------------- D7: site-level statistics

def test_statistics_are_over_site_means_so_one_prolific_site_does_not_dominate():
    rows = [rec(d, 1, 100, 90, day=d) for d in range(20)]                    # one site, 20 readings, +10 each
    rows += [rec(100 + s, s + 2, 100, 100) for s in range(5)]                # five sites, one reading, 0 each
    cell = R.residual_report(rows)["subsystems"]["envelope"]["variables"]["it_load_kW"]["residuals"]
    assert cell["n_readings"] == 25 and cell["n_sites"] == 6
    assert cell["mean_signed_error"] == pytest.approx(10.0 / 6)                # pooled over readings it would be 8.0
    assert cell["mean_abs_error"] == pytest.approx(10.0 / 6)


# ---------------------------------------------------------------------------------------------------------------- D7: the interval

@pytest.mark.parametrize("df,expected", [(1, 12.706), (4, 2.776), (9, 2.262), (29, 2.045), (30, 2.042)])
def test_the_student_t_table_matches_the_tabulated_values(df, expected):
    from gridforge.calibration import publication
    assert publication.t_quantile_975(df) == expected


def test_beyond_thirty_degrees_of_freedom_the_wider_value_is_used_and_zero_is_refused():
    from gridforge.calibration import publication
    assert publication.t_quantile_975(31) == publication.t_quantile_975(500) == 2.042
    with pytest.raises(ValueError):
        publication.t_quantile_975(0)


def test_the_interval_over_sites_is_a_student_t_interval_on_site_means_with_the_stated_label(unrounded):
    rows = []
    errs = {1: 4.0, 2: 6.0, 3: 5.0, 4: 7.0, 5: 3.0, 6: 5.0}
    for s, e in errs.items():
        rows += [rec(10 * s + k, s, 100, 100 - e - d, day=k) for k, d in enumerate((-1.0, 1.0))]   # two readings per site, mean e
    cell = public_var(rows)["residuals"]
    iv = cell["interval_over_sites"]
    means = list(errs.values())
    m = sum(means) / 6
    sd = (sum((x - m) ** 2 for x in means) / 5) ** 0.5
    half = 2.571 * sd / 6 ** 0.5
    assert iv["published"] is True and iv["confidence"] == 0.95 and iv["df"] == 5
    assert iv["mean_signed_error"]["low"] == pytest.approx(m - half) and iv["mean_signed_error"]["high"] == pytest.approx(m + half)
    assert "interval over sites, assumes sites are exchangeable; not a guarantee for any given hall" in iv["label"]


def test_below_the_published_minimum_no_interval_is_published_and_the_reason_is_given():
    cell = public_var([rec(i, i + 1, 100, 90 - i) for i in range(4)])["residuals"]
    assert "interval_over_sites" not in cell and str(K) in cell["suppressed"]
    private = R.residual_report([rec(i, i + 1, 100, 90 - i) for i in range(4)])["subsystems"]["envelope"]["variables"]["it_load_kW"]["residuals"]
    assert private["interval_over_sites"]["published"] is False
    assert "fewer than 5 sites" in private["interval_over_sites"]["reason"]


# ---------------------------------------------------------------------------------------------------------------- D7: builds are not pooled

def two_builds():
    rows, i = [], 0
    for s in range(1, 8):                       # build "9.9.9-acme-site": 7 sites, one reading each
        rows.append(rec(i, s, 100, 100 - s, version="9.9.9-acme-site", day=i)); i += 1
    for s in range(20, 23):                     # build "1.0.0": 3 sites
        rows.append(rec(i, s, 100, 50, version="1.0.0", day=i)); i += 1
    return rows


def test_records_of_different_builds_are_never_pooled_into_one_headline():
    rows = two_builds()
    block = R.residual_report(rows)["subsystems"]["envelope"]["variables"]["it_load_kW"]
    assert block["approved_observations"] == 10
    assert block["residuals"]["n_readings"] == 7 and block["residuals"]["n_sites"] == 7, "the headline is one build, the one with most sites"
    assert block["model_versions"]["n_versions"] == 2 and block["model_versions"]["pooled"] is False
    assert set(block["by_model_version"]) == {"9.9.9-acme-site", "1.0.0"}


def test_the_public_report_names_no_version_string_and_pools_nothing():
    rows = two_builds()
    text = json.dumps(R.public_report(rows))
    assert "acme" not in text and "9.9.9" not in text and "1.0.0" not in text
    block = public_var(rows)
    assert block["model_versions"] == {"n_versions": 2, "pooled": False,
                                       "headline": "the build with the most contributing sites; other builds are not pooled into it"}


# ---------------------------------------------------------------------------------------------------------------- D7: the ledger block

def ledger_obs(site, i, digest="", observed=24.0, predicted=20.0):
    extra = dict(source_ref=f"{i + 1:08x}-0000-0000-0000-000000000000:{'ab' * 32}", model_digest=digest,
                 reviewed_by="Role", reviewed_at="2026-07-01") if digest else {}
    return Observation(key="envelope.racks", site_ref=site_only_ref(f"S{site}"), predicted=predicted, observed=observed,
                       unit="racks", observed_on=f"2026-{1 + i % 9:02d}-15", evidence=EvidenceClass.E5_CUSTOMER_DATA,
                       method="metering", **extra)


def test_one_site_is_not_printed_with_its_exact_ratio_and_date():
    block = accuracy_block(["envelope.racks"], Ledger(observations=[ledger_obs(1, 0, observed=24.6)]))
    entry = block["keys"][0]
    assert entry["median_ratio"] is None and entry["bias_pct"] is None and entry["observed_range"] is None
    assert entry["last_observed_on"] is None
    text = json.dumps(block)
    assert "1.23" not in text and "2026-01-15" not in text and "23%" not in text
    assert "fewer than 5 sites" in entry["statement"]


def test_five_sites_publish_a_ratio_with_an_interval_and_a_coarse_date():
    rows = [ledger_obs(s, s, observed=22.0 + s) for s in range(1, 6)]
    entry = accuracy_block(["envelope.racks"], Ledger(observations=rows))["keys"][0]
    assert entry["median_ratio"] is not None and entry["state"] == "calibrated"
    assert entry["interval_over_sites"]["published"] is True and "exchangeable" in entry["interval_over_sites"]["label"]
    assert re.fullmatch(r"\d{4}-\d{2}", entry["last_observed_on"]), "the month, never the day"


def test_ledger_records_without_a_build_digest_are_labelled_pooled_across_unrecorded_versions():
    rows = [ledger_obs(s, s) for s in range(1, 6)]
    entry = accuracy_block(["envelope.racks"], Ledger(observations=rows))["keys"][0]
    assert "pooled across unrecorded model versions" in entry["model_builds"]["basis"]


def test_ledger_observations_of_different_builds_are_not_pooled():
    a, b = "a" * 64, "b" * 64
    rows = [ledger_obs(s, s, digest=a) for s in range(1, 7)] + [ledger_obs(s, 10 + s, digest=b, observed=40.0) for s in range(7, 10)]
    c = calibration_for("envelope.racks", rows)
    assert (c.n, c.sites) == (6, 6), "the headline build is the one with the most sites"
    assert c.other_build_observations == 3 and c.median_ratio == pytest.approx(24.0 / 20.0)


# ---------------------------------------------------------------------------------------------------------------- the empty ledger

def test_with_zero_observations_the_public_output_is_byte_identical_to_what_it_was():
    """Digests of the output of the code BEFORE this change, taken with the same call."""
    pub = hashlib.sha256(json.dumps(R.public_report([]), sort_keys=True).encode()).hexdigest()
    priv = hashlib.sha256(json.dumps(R.residual_report([]), sort_keys=True).encode()).hexdigest()
    acc = hashlib.sha256(json.dumps(accuracy_block(ledger=Ledger()), sort_keys=True).encode()).hexdigest()
    assert pub == "35ee964cd25793905653dafffefd49ebadc0c23fb7fe2f32ab0f8f28647a5568"
    assert priv == "927433fd2800c8179e5e8449d197f26839f953356be2dcb5ff351d62e882163e"
    assert acc == "4cc8eb4b8d1945876014b575390e96fbf2ccdd22f2d6456995d42b142560fc38"


# ---------------------------------------------------------------------------------------------------------------- D6: published rows

SHA = "ab" * 32
DIGEST = "cd" * 32
HOSTILE_METHOD = "Revenue meter M3 at Equinix DB2 Dublin, signed by J. Murphy, see https://evil.example/leak?site=acme"
HOSTILE_REVIEWER = "J. Murphy <j.murphy@equinix.example>"


def export_row(n, **kw):
    r = {"id": f"{n:08x}-1111-2222-3333-444444444444", "key": "btm.firm_MW", "observed_value": 28.5, "predicted_value": 30.0,
         "unit": "MW", "site_ref": site_only_ref(f"Site {n}"), "measurement_kind": "metered", "evidence_sha256": SHA,
         "engine_provenance_digest": DIGEST, "report_date": "2026-03-17", "observed_on": "2026-06-30", "method": HOSTILE_METHOD,
         "evidence_class": "E5", "reviewed_by": HOSTILE_REVIEWER, "reviewed_at": "2026-07-02T09:41:17+00:00"}
    r.update(kw)
    return r


def export(rows):
    return {"schema": "gridforge/calibration-export/1", "rows": rows}


def test_a_published_row_carries_no_name_no_site_no_url_no_uuid_and_no_exact_date(tmp_path):
    p = tmp_path / "imp.json"
    import_export(export([export_row(1), export_row(2)]), p, accept_mixed_refs=True)
    on_disk = p.read_text()
    for leaked in ("Murphy", "Equinix", "Dublin", "evil.example", "https://", "acme", "M3", "j.murphy",
                   export_row(1)["id"], export_row(2)["id"], "2026-06-30", "2026-07-02", "2026-03-17", "09:41"):
        assert leaked not in on_disk, leaked
    got, _ = read_chain(p)
    assert all(o.published for o in got)
    o = got[0]
    assert o.method == "metered", "only the measurement kind, from the closed list"
    assert o.reviewed_by == "calibration reviewer"
    assert o.observed_on == "2026-06-01" and o.reviewed_at.startswith("2026-07-01")
    assert o.source_ref.endswith(":" + SHA) and export_row(1)["id"] not in o.source_ref


def test_the_hashed_reference_still_refuses_the_same_export_twice(tmp_path):
    p = tmp_path / "imp.json"
    import_export(export([export_row(1)]), p, accept_mixed_refs=True)
    with pytest.raises(Exception, match="already"):
        import_export(export([export_row(1)]), p, accept_mixed_refs=True)


def test_a_previously_imported_row_with_free_text_is_published_only_in_its_controlled_form(tmp_path, monkeypatch):
    """Rows imported before this change hold the raw text on disk (the file and its hash chain are not rewritten). The published view
    of the ledger shows them in the controlled form."""
    from gridforge.calibration import ledger as L
    legacy = Observation(key="btm.firm_MW", site_ref=site_only_ref("Site 9"), predicted=30.0, observed=28.5, unit="MW",
                         observed_on="2026-06-30", evidence=EvidenceClass.E5_CUSTOMER_DATA,
                         method="metered: " + HOSTILE_METHOD, note="model report_date 2026-03-17", kind="measured",
                         source_ref=f"{9:08x}-1111-2222-3333-444444444444:{SHA}", model_digest=DIGEST,
                         reviewed_by=HOSTILE_REVIEWER, reviewed_at="2026-07-02T09:41:17+00:00", source="import", published=True)
    view = L.published_form(legacy)
    blob = json.dumps(view.to_dict())
    for leaked in ("Murphy", "Equinix", "evil.example", "2026-06-30", "2026-03-17", "444444444444"):
        assert leaked not in blob
    assert view.site_ref == legacy.site_ref and view.observed == legacy.observed and view.predicted == legacy.predicted
    assert view.method == "metered" and view.reviewed_by == "calibration reviewer"


def test_the_non_published_cli_path_is_unchanged(tmp_path):
    from gridforge.calibration.ledger import append_observation
    p = tmp_path / "cli.json"
    o = Observation(key="envelope.racks", site_ref=site_only_ref("Client A"), predicted=26.0, observed=24.0, unit="racks",
                    observed_on="2026-06-30", evidence=EvidenceClass.E5_CUSTOMER_DATA, method="half-hourly metering, 3 months",
                    source="cli", published=False)
    append_observation(o, p)
    got, _ = read_chain(p)
    assert got[0].method == "half-hourly metering, 3 months" and got[0].observed_on == "2026-06-30" and got[0].published is False
