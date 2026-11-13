"""The durable observation-record store, its review gate, the CLI over it, the public aggregate route and the
disclosure wording.

EVERY record in this file is SYNTHETIC, built here for the test. All of it is written under pytest's tmp_path
(the store location is pointed there through GRIDFORGE_CALIBRATION_RECORDS); nothing touches the shipped ledger,
a committed file or public/.
"""
import json
import os
import subprocess
import sys
import threading
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pytest

from gridforge.api import server as S
from gridforge.calibration import accuracy_block, all_keys, load_ledger, residuals as R, store
from gridforge.calibration.ledger import BUNDLED_PATH, LedgerIntegrityError
from gridforge.calibration.records import VARIABLES
from gridforge.calibration.schema import site_only_ref

ROOT = Path(__file__).resolve().parents[1]
NOW = datetime(2026, 11, 3, 12, 0, tzinfo=timezone.utc)
SUBMITTER = "Sam Submitter"
REVIEWER = "Rae Reviewer"
SECRET_TEXT = "ACME-SECRET-CONFIGURATION-NAME"


def row(i=1, site="A", variable="it_load_kW", predicted=100.0, measured=95.0, **kw):
    """A SYNTHETIC draft record row."""
    d = {"observation_id": f"obs-{i:04d}", "site_id": site_only_ref(site), "hall_id": "H1",
         "measured_at": "2026-10-01T00:00:00Z", "variable": variable,
         "predicted": predicted, "measured": measured, "unit": VARIABLES[variable][1],
         "measurement_source": "metered", "quality": "high", "model_version": "1.2.3",
         "evidence": "E5_CUSTOMER_DATA"}
    d.update(kw)
    return d


@pytest.fixture()
def path(tmp_path, monkeypatch):
    p = tmp_path / "records.jsonl"
    monkeypatch.setenv(store.ENV_VAR, str(p))
    return p


def put(path, rows, who=SUBMITTER):
    return store.ingest(rows, submitter=who, path=path, now=NOW)


def approve(path, oid, who=REVIEWER):
    return store.review(oid, "approved", reviewer=who, reason="checked against the meter export", path=path, now=NOW)


def calibrated_set(variable="it_load_kW", n=10, sites=3, start=1):
    """SYNTHETIC rows enough to reach CALIBRATED for one variable."""
    return [row(start + i, site=f"S{i % sites}", variable=variable, measured=95.0 + 0.01 * i) for i in range(n)]


# --- ingest -----------------------------------------------------------------

def test_ingest_stores_validated_rows_as_draft_with_the_submitter(path):
    out = put(path, [row(1), row(2, site="B")])
    assert (out["submitted"], out["stored"], out["duplicates_skipped"]) == (2, 2, 0)
    got = store.load_all(path)
    assert [s.record.approval_status for s in got] == ["draft", "draft"]
    assert {s.submitted_by for s in got} == {SUBMITTER} and all(s.record.reviewer is None for s in got)
    assert store.approved_records(path) == []


def test_one_invalid_row_refuses_the_whole_batch_and_writes_nothing(path):
    with pytest.raises(store.StoreError, match="whole batch is refused"):
        put(path, [row(1), row(2, predicted=float("nan")), row(3, unit="MW")])
    assert not path.exists()


def test_a_row_that_arrives_approved_or_reviewed_is_refused(path):
    with pytest.raises(store.StoreError, match="draft only"):
        put(path, [row(1, approval_status="approved", reviewer="Someone")])
    with pytest.raises(store.StoreError, match="draft only"):
        put(path, [row(2, reviewer="Someone")])
    assert not path.exists()


def test_an_empty_batch_and_a_missing_submitter_are_refused(path):
    with pytest.raises(store.StoreError, match="no records"):
        put(path, [])
    for who in ("", "   ", None):
        with pytest.raises(store.StoreError, match="submitter is required"):
            put(path, [row(1)], who=who)
    assert not path.exists()


def test_the_same_content_is_deduplicated_by_content_hash_and_counted(path):
    put(path, [row(1), row(2)])
    size = path.stat().st_size
    out = put(path, [row(1), row(2), row(3)])
    assert (out["stored"], out["duplicates_skipped"]) == (1, 2)
    assert len(store.load_all(path)) == 3
    again = put(path, [row(1)])
    assert again["stored"] == 0 and again["duplicates_skipped"] == 1
    assert path.stat().st_size > size            # only the one new entry was appended, nothing rewritten


def test_an_observation_id_cannot_be_reused_with_different_content(path):
    put(path, [row(1)])
    before = path.read_bytes()
    with pytest.raises(store.StoreError, match="already stored with different content"):
        put(path, [row(1, measured=50.0)])
    assert path.read_bytes() == before


def test_two_rows_with_one_id_in_a_batch_are_refused(path):
    with pytest.raises(store.StoreError, match="duplicate observation_id"):
        put(path, [row(1), row(1, measured=50.0)])


# --- review -----------------------------------------------------------------

def test_review_appends_a_new_entry_and_never_edits_history(path):
    put(path, [row(1)])
    before = path.read_bytes()
    approve(path, "obs-0001")
    after = path.read_bytes()
    assert after.startswith(before) and len(after.splitlines()) == len(before.splitlines()) + 1
    s = store.load_all(path)[0]
    assert s.record.approval_status == "approved" and s.record.reviewer == REVIEWER
    assert s.reviews[-1]["reason"] == "checked against the meter export" and s.submitted_by == SUBMITTER


def test_the_latest_entry_is_the_current_state(path):
    put(path, [row(1)])
    approve(path, "obs-0001")
    store.review("obs-0001", "rejected", reviewer="Other Person", reason="meter was later found miscalibrated",
                 path=path, now=NOW)
    assert store.load_all(path)[0].record.approval_status == "rejected"
    assert store.approved_records(path) == []
    assert len(store.load_all(path)[0].reviews) == 2
    with pytest.raises(store.StoreError, match="already rejected"):
        store.review("obs-0001", "rejected", reviewer="Third", reason="again", path=path, now=NOW)


def test_reviewer_and_reason_are_mandatory(path):
    put(path, [row(1)])
    before = path.read_bytes()
    for decision in ("approved", "rejected"):
        for reviewer, reason in (("", "r"), ("  ", "r"), ("N", ""), ("N", "   "), (None, "r"), ("N", None)):
            with pytest.raises(store.StoreError, match="required"):
                store.review("obs-0001", decision, reviewer=reviewer, reason=reason, path=path, now=NOW)
    with pytest.raises(store.StoreError, match="decision must be"):
        store.review("obs-0001", "draft", reviewer="N", reason="r", path=path, now=NOW)
    assert path.read_bytes() == before


def test_the_submitter_cannot_approve_their_own_record_however_the_name_is_spelled(path):
    put(path, [row(1)])
    for spelled in (SUBMITTER, SUBMITTER.upper(), f"  {SUBMITTER.lower().replace(' ', '   ')} "):
        with pytest.raises(store.StoreError, match="submitted it"):
            approve(path, "obs-0001", who=spelled)
    assert store.load_all(path)[0].record.approval_status == "draft"
    # Withdrawing your own submission is not self-approval.
    store.review("obs-0001", "rejected", reviewer=SUBMITTER, reason="submitted by mistake", path=path, now=NOW)
    assert store.load_all(path)[0].record.approval_status == "rejected"


def test_reviewing_an_unknown_record_is_refused(path):
    put(path, [row(1)])
    with pytest.raises(store.StoreError, match="no stored record"):
        approve(path, "obs-9999")


# --- tamper detection -------------------------------------------------------

def build_three(path):
    put(path, [row(1), row(2, site="B")])
    approve(path, "obs-0001")


def test_an_untouched_store_verifies_and_reports_a_head(path):
    assert store.load_all(path) == [] and store.chain_head(path) is None
    build_three(path)
    assert len(store.chain_head(path)) == 64


@pytest.mark.parametrize("how", ["edit_value", "delete_line", "reorder", "truncate", "garbage", "append_unlinked",
                                 "blank_line", "replace_with_self_approval"])
def test_a_broken_chain_raises_and_is_never_skipped(path, how):
    build_three(path)
    lines = path.read_text().splitlines()
    if how == "edit_value":
        path.write_text("\n".join([lines[0].replace("95.0", "99.0"), *lines[1:]]) + "\n")
    elif how == "delete_line":
        path.write_text("\n".join(lines[1:]) + "\n")
    elif how == "reorder":
        path.write_text("\n".join([lines[1], lines[0], *lines[2:]]) + "\n")
    elif how == "truncate":
        path.write_text("\n".join(lines))   # last line has no newline: cut short
    elif how == "garbage":
        path.write_text("\n".join([*lines, "not json"]) + "\n")
    elif how == "append_unlinked":
        path.write_text("\n".join([*lines, json.dumps({"kind": "review"})]) + "\n")
    elif how == "blank_line":
        path.write_text("\n".join([lines[0], "", *lines[1:]]) + "\n")
    else:
        # A forger who recomputes every hash still cannot make a self-approval replay as valid.
        forged = json.loads(lines[-1])
        forged["reviewer"] = SUBMITTER
        forged.pop("entry_hash")
        forged["entry_hash"] = store._sha(forged)
        path.write_text("\n".join([*lines[:-1], json.dumps(forged, sort_keys=True)]) + "\n")
    with pytest.raises(LedgerIntegrityError):
        store.load_all(path)
    with pytest.raises(LedgerIntegrityError):
        store.approved_records(path)
    size = path.stat().st_size
    with pytest.raises(LedgerIntegrityError):
        put(path, [row(7, site="C")])
    with pytest.raises(LedgerIntegrityError):
        approve(path, "obs-0002")
    assert path.stat().st_size == size            # nothing was appended onto a broken chain


# --- where it lives ---------------------------------------------------------

def test_the_store_refuses_to_live_in_the_package_directory(tmp_path):
    inside = store.PACKAGE_DIR / "data" / "records.jsonl"
    with pytest.raises(store.StoreError, match="package directory"):
        store.ingest([row(1)], submitter=SUBMITTER, path=inside, now=NOW)
    with pytest.raises(store.StoreError, match="package directory"):
        store.review("obs-0001", "approved", reviewer=REVIEWER, reason="r", path=BUNDLED_PATH.parent / "x.jsonl")
    assert not inside.exists()


def test_default_location_is_next_to_the_private_ledger_and_the_env_var_overrides(tmp_path, monkeypatch):
    monkeypatch.delenv(store.ENV_VAR, raising=False)
    monkeypatch.setenv("GRIDFORGE_CALIBRATION_LEDGER", str(tmp_path / "sub" / "ledger.json"))
    assert store.store_path() == tmp_path / "sub" / store.RECORDS_FILENAME
    monkeypatch.setenv(store.ENV_VAR, str(tmp_path / "elsewhere.jsonl"))
    assert store.store_path() == tmp_path / "elsewhere.jsonl"


def test_the_shipped_ledger_is_still_empty():
    assert load_ledger(published_only=True).observations == []
    assert json.loads(BUNDLED_PATH.read_text())["observations"] == []


# --- the public aggregate ---------------------------------------------------

def public_json(recs):
    return json.dumps(R.public_report(recs))


def test_an_empty_store_is_uncalibrated_with_zero_records(path):
    rep = R.public_report(store.approved_records(path))
    assert rep["state"] == "uncalibrated" and rep["n_records"] == 0 and rep["n_sites"] == 0
    assert all(s["state"] == "UNCALIBRATED" for s in rep["subsystems"].values())


def test_drafts_and_rejections_change_nothing_not_even_a_count(path):
    put(path, [row(i, site=f"S{i}") for i in range(1, 6)])
    store.review("obs-0001", "rejected", reviewer=REVIEWER, reason="not a metered value", path=path, now=NOW)
    assert R.public_report(store.approved_records(path)) == R.public_report([])


def test_public_report_has_no_ids_free_text_or_raw_measurements(path):
    rows = [row(i, site=f"S{i % 3}", measured=1234.5 + i, predicted=2000.25, configuration=SECRET_TEXT,
                hall_id=f"HALL-X{i}") for i in range(1, 13)]
    put(path, rows)
    for r in rows:
        approve(path, r["observation_id"])
    recs = store.approved_records(path)
    text = public_json(recs)
    for r in rows:
        assert r["observation_id"] not in text and r["site_id"] not in text and r["hall_id"] not in text
    assert SECRET_TEXT not in text and "by_configuration" not in text and SUBMITTER not in text
    for raw in ("1235.5", "1236.5", "2000.25"):
        assert raw not in text
    rep = R.public_report(recs)
    assert rep["n_records"] == 12 and rep["n_sites"] == 3 and rep["state"] == "indicative"
    block = rep["subsystems"]["envelope"]["variables"]["it_load_kW"]
    assert block["state"] == "CALIBRATED" and block["residuals"]["n"] == 12
    # Only one variable has records, so the subsystem is calibrated only if every variable in it is.
    assert rep["subsystems"]["envelope"]["state"] == "INDICATIVE"


def test_small_cells_are_reduced_to_counts(path):
    put(path, [row(1, capacity_mw=0.5), row(2, site="B", capacity_mw=0.5)])
    approve(path, "obs-0001")
    approve(path, "obs-0002")
    rep = R.public_report(store.approved_records(path))
    v = rep["subsystems"]["envelope"]["variables"]["it_load_kW"]
    # The published minimum is five sites (audit D2: three sites with a mean, a median and a maximum were all three sites), so the reason is
    # "fewer than 5 sites"; the old expectation, "fewer than 3 sites", pinned the threshold that was the defect.
    assert v["residuals"] == {"n": 2, "sites": 2, "suppressed": "fewer than 5 sites: no statistic and no interval over sites is published"}
    assert v["by_capacity_bucket"]["<1 MW"]["suppressed"]
    assert "mean_abs_error" not in json.dumps(v)


def test_capex_and_schedule_residuals_are_withheld_from_the_public_report_everywhere(path):
    """The public tier redacts capex and schedule figures; their residuals follow the same rule. Nothing about them may leak through
    a count, a state or the headline, while the private report still carries them."""
    rows = (calibrated_set("capex_total_eur", n=10, sites=3, start=1) + calibrated_set("weeks_to_full", n=10, sites=3, start=101)
            + calibrated_set("it_load_kW", n=10, sites=3, start=201))
    put(path, rows)
    for r in rows:
        approve(path, r["observation_id"])
    recs = store.approved_records(path)
    rep = R.public_report(recs)
    text = json.dumps(rep)
    assert "capex_total_eur" not in json.dumps(rep["subsystems"]) and "weeks_to_full" not in json.dumps(rep["subsystems"])
    assert set(rep["subsystems"]) == {"envelope", "thermal", "power", "grid"}
    assert set(rep["subsystem_states"]) == {"envelope", "thermal", "power", "grid"}
    assert "economics" not in rep["headline"] and "schedule" not in rep["headline"]
    assert rep["withheld_variables"] == ["capex_total_eur", "weeks_to_full"]
    assert rep["n_records"] == 10, "only the published variable's records are counted"
    assert "EUR" not in text.replace("withheld", "")
    private = R.residual_report(recs)
    assert private["subsystems"]["economics"]["approved_observations"] == 10
    assert private["subsystems"]["schedule"]["approved_observations"] == 10


def test_withholding_only_capex_and_schedule_leaves_an_empty_public_report_uncalibrated(path):
    rows = calibrated_set("capex_total_eur", n=10, sites=3)
    put(path, rows)
    for r in rows:
        approve(path, r["observation_id"])
    rep = R.public_report(store.approved_records(path))
    assert rep["state"] == "uncalibrated" and rep["n_records"] == 0 and rep["n_sites"] == 0


# --- disclosure -------------------------------------------------------------

def test_with_zero_approved_records_the_accuracy_block_is_exactly_as_before(path):
    keys = ["envelope.racks", "envelope.it_load_kW"]
    baseline = accuracy_block(keys, load_ledger())
    assert accuracy_block(keys) == baseline                       # no store file at all
    assert accuracy_block(keys, records=[]) == baseline
    put(path, [row(i, site=f"S{i}") for i in range(1, 5)])         # drafts only
    store.review("obs-0001", "rejected", reviewer=REVIEWER, reason="bad", path=path, now=NOW)
    assert accuracy_block(keys) == baseline
    assert "residual_records" not in baseline


def test_approved_records_are_summarised_in_the_residual_vocabulary(path):
    rows = calibrated_set("it_load_kW", 10, 3) + [row(50, site="Z", variable="pue", predicted=1.3, measured=1.25)]
    put(path, rows)
    for r in rows:
        approve(path, r["observation_id"])
    block = accuracy_block(["envelope.racks"])
    rr = block["residual_records"]
    assert rr["n_records"] == 11 and rr["n_sites"] == 4
    assert rr["variables"]["it_load_kW"]["state"] == "CALIBRATED"
    assert rr["variables"]["pue"]["state"] == "INDICATIVE"
    assert rr["variables_without_records"] == len(VARIABLES) - 2
    assert "remain UNCALIBRATED" in block["statement"] and block["statement"].startswith(
        accuracy_block(["envelope.racks"], records=[])["statement"])
    assert "no single accuracy figure" in rr["statement"]
    assert "ACME" not in json.dumps(block) and "obs-" not in json.dumps(block)


def test_minimum_evidence_and_site_rules_are_respected_in_the_summary(path):
    # Ten approved records but from two sites: INDICATIVE, never CALIBRATED.
    put(path, calibrated_set("it_load_kW", 10, 2))
    for i in range(1, 11):
        approve(path, f"obs-{i:04d}")
    assert accuracy_block(["envelope.racks"])["residual_records"]["variables"]["it_load_kW"]["state"] == "INDICATIVE"
    # A record below the evidence floor never reaches a statistic, even if one were handed in directly.
    from gridforge.calibration.records import ObservationRecord
    from gridforge.validation.evidence import EvidenceClass
    ok = ObservationRecord.from_dict(row(1, approval_status="approved", reviewer="R"), now=NOW)
    weak = object.__new__(ObservationRecord)
    for f in ok.__dataclass_fields__:
        object.__setattr__(weak, f, getattr(ok, f))
    object.__setattr__(weak, "evidence", EvidenceClass.E4_VENDOR_DATA if hasattr(EvidenceClass, "E4_VENDOR_DATA")
                       else list(EvidenceClass)[4])
    assert R.public_report([weak])["n_records"] == 0 and R.disclosure_summary([weak]) is None


def test_a_published_only_ledger_view_never_carries_private_records(path):
    rows = calibrated_set("it_load_kW", 10, 3)
    put(path, rows)
    for r in rows:
        approve(path, r["observation_id"])
    assert "residual_records" in accuracy_block(["envelope.racks"])
    assert "residual_records" not in accuracy_block(all_keys(), load_ledger(published_only=True))


def test_a_broken_store_stops_the_deliverable_rather_than_being_skipped(path):
    put(path, [row(1)])
    path.write_text(path.read_text().replace("95.0", "96.0"))
    with pytest.raises(LedgerIntegrityError):
        accuracy_block(["envelope.racks"])


def test_provenance_digest_is_unchanged_by_drafts_and_moves_with_approvals(path):
    from gridforge import provenance
    empty = provenance.calibration_sha256()
    put(path, [row(1)])
    assert provenance.calibration_sha256() == empty
    approve(path, "obs-0001")
    assert provenance.calibration_sha256() != empty


# --- CLI --------------------------------------------------------------------

def cli(path, *args):
    r = subprocess.run([sys.executable, "-m", "gridforge", "calibration", *args], cwd=ROOT, capture_output=True,
                       text=True, env={**os.environ, store.ENV_VAR: str(path)})
    assert "Traceback" not in r.stderr, r.stderr
    return r


def write_rows(tmp_path, rows, name="in.json"):
    p = tmp_path / name
    p.write_text(json.dumps(rows))
    return str(p)


def test_cli_with_nothing_approved_says_plainly_that_no_variable_is_calibrated(path):
    r = cli(path, "report")
    assert r.returncode == 0 and "No variable is calibrated" in r.stdout and "0 approved" in r.stdout
    j = json.loads(cli(path, "report", "--json").stdout)
    assert j["n_records"] == 0 and j["n_sites"] == 0 and j["report"]["subsystem_states"]
    assert set(j["report"]["subsystem_states"].values()) == {"UNCALIBRATED"}
    assert cli(path, "pending").stdout.startswith("0 draft record(s)")


def test_cli_journey_ingest_pending_review_report(path, tmp_path):
    f = write_rows(tmp_path, [row(1), row(2, site="B")])
    assert cli(path, "ingest", f).returncode == 2                       # no submitter
    r = cli(path, "ingest", f, "--submitter", SUBMITTER)
    assert r.returncode == 0 and "ingested 2 record(s) as draft" in r.stdout
    again = cli(path, "ingest", f, "--submitter", SUBMITTER)
    assert again.returncode == 0 and "0 record(s) as draft; 2 duplicate(s) skipped" in again.stdout
    p = cli(path, "pending")
    assert "2 draft record(s)" in p.stdout and "obs-0001" in p.stdout
    # refusals exit 2 and write nothing
    assert cli(path, "review", "obs-0001", "--approve", "--reviewer", SUBMITTER, "--reason", "x").returncode == 2
    assert cli(path, "review", "obs-0001", "--approve", "--reviewer", REVIEWER).returncode == 2
    assert cli(path, "review", "obs-0001", "--reviewer", REVIEWER, "--reason", "x").returncode == 2
    assert cli(path, "review", "obs-0001", "--approve", "--reject", "--reviewer", REVIEWER, "--reason", "x").returncode == 2
    ok = cli(path, "review", "obs-0001", "--approve", "--reviewer", REVIEWER, "--reason", "matches the meter")
    assert ok.returncode == 0 and "draft -> approved" in ok.stdout
    rep = cli(path, "report")
    assert "1 approved, 1 draft, 0 rejected" in rep.stdout and "1 site(s)" in rep.stdout
    assert f"0 of {len(VARIABLES)} variable(s) calibrated; none." in rep.stdout
    assert "No variable is calibrated" not in rep.stdout          # one is approved; the line below says none reach CALIBRATED
    assert "INDICATIVE" in rep.stdout


def test_cli_refuses_a_bad_batch_and_a_bad_file_with_exit_2(path, tmp_path):
    bad = write_rows(tmp_path, [row(1), row(2, variable="it_load_kW", unit="MW")])
    r = cli(path, "ingest", bad, "--submitter", SUBMITTER)
    assert r.returncode == 2 and "whole batch is refused" in r.stderr and not path.exists()
    assert cli(path, "ingest", str(tmp_path / "missing.json"), "--submitter", SUBMITTER).returncode == 2
    notjson = tmp_path / "x.json"
    notjson.write_text("{")
    assert cli(path, "ingest", str(notjson), "--submitter", SUBMITTER).returncode == 2
    obj = write_rows(tmp_path, {"records": "nope"}, "o.json")
    assert cli(path, "ingest", obj, "--submitter", SUBMITTER).returncode == 2


def test_cli_accepts_the_records_wrapper_and_reports_tamper_with_exit_3(path, tmp_path):
    f = write_rows(tmp_path, {"records": [row(1)]})
    assert cli(path, "ingest", f, "--submitter", SUBMITTER).returncode == 0
    path.write_text(path.read_text().replace("95.0", "96.0"))
    for args in (("report",), ("pending",), ("review", "obs-0001", "--reject", "--reviewer", "R", "--reason", "x")):
        r = cli(path, *args)
        assert r.returncode == 3 and "integrity failure" in r.stderr and r.stdout == ""


# --- API --------------------------------------------------------------------

@pytest.fixture()
def server(path, monkeypatch):
    monkeypatch.setattr(S.Handler.limiter, "per_minute", 0)
    httpd = S.make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def get(base, p):
    import urllib.error
    try:
        with urllib.request.urlopen(base + p, timeout=30) as r:
            return r.status, json.loads(r.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_route_is_public_listed_free_and_uncalibrated_when_empty(server):
    status, body = get(server, "/v1/calibration/residuals")
    assert status == 200 and body["state"] == "uncalibrated" and body["n_records"] == 0 and body["n_sites"] == 0
    assert "/v1/calibration/residuals" in S.GET_ROUTES
    assert "/v1/calibration/residuals" in get(server, "/v1/version")[1]["endpoints"]
    from gridforge.api.metering import UNIT_COST
    assert UNIT_COST["/v1/calibration/residuals"] == 0


def test_route_serves_approved_records_only_and_no_identifiers(server, path):
    rows = [row(i, site=f"S{i % 3}", measured=95.0 + 0.01 * i, configuration=SECRET_TEXT) for i in range(1, 11)] + [row(99, site="Q")]
    put(path, rows)
    for r in rows[:-1]:
        approve(path, r["observation_id"])                 # obs-0099 stays a draft
    status, body = get(server, "/v1/calibration/residuals")
    text = json.dumps(body)
    assert status == 200 and body["n_records"] == 10 and body["n_sites"] == 3
    assert body["subsystems"]["envelope"]["variables"]["it_load_kW"]["state"] == "CALIBRATED"
    for r in rows:
        assert r["observation_id"] not in text and r["site_id"] not in text
    assert SECRET_TEXT not in text and SUBMITTER not in text and REVIEWER not in text


def test_route_fails_closed_on_a_broken_store(server, path):
    put(path, [row(1)])
    path.write_text(path.read_text().replace("95.0", "96.0"))
    status, body = get(server, "/v1/calibration/residuals")
    assert status == 503 and body["state"] == "unavailable"


def test_the_existing_calibration_route_stays_published_only(server, path):
    rows = calibrated_set("it_load_kW", 10, 3)
    put(path, rows)
    for r in rows:
        approve(path, r["observation_id"])
    status, body = get(server, "/v1/calibration")
    assert status == 200 and body["state"] == "uncalibrated" and "residual_records" not in body
