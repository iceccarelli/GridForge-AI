"""The ledger is an asset only while it cannot be gamed. These tests attack it the way a hurried or motivated
person would, and each one failed against the ledger as it was before this change.

  * five readings from three halls of ONE site are one site, not three
  * 5% coverage of the model's outputs is not a "calibrated" model
  * a key outside the vocabulary cannot be loaded (it would hide the n=0 sentence)
  * a vendor quote and an assumed value are not measurements
  * the ledger file is append-only: edit, delete, reorder or splice a record and loading fails, naming the record
  * two writers cannot lose each other's records
  * the empty ledger still hashes to the value the rest of the system pins
  * `calibrate import` takes only verified, ledger-eligible rows from an export, atomically, never twice
"""
import hashlib
import json
import multiprocessing
import os
import subprocess
import sys
from pathlib import Path

import pytest

from gridforge.calibration import Observation, ObservationError, accuracy_block, all_keys
from gridforge.calibration.keys import MODEL_KEYS
from gridforge.calibration.ledger import (GENESIS, Ledger, LedgerIntegrityError, _read, append_observation,
                                          import_export, read_chain)
from gridforge.calibration.schema import site_only_ref, site_ref
from gridforge.calibration.stats import CalibrationState, calibration_for
from gridforge.validation.evidence import EvidenceClass

ROOT = Path(__file__).resolve().parents[1]
DIGEST = "a" * 64
SHA = "b" * 64
EMPTY_LEDGER_SHA256 = "225e762caa8cb172d84527d9dafc91d35fa66926b5536689e683325e81945c89"


def obs(key="envelope.racks", predicted=26.0, observed=24.0, on="2026-06-30", site="Client A", hall="DH-02",
        unit="racks", **extra):
    return Observation(key=key, site_ref=site_ref(site, hall), predicted=predicted, observed=observed, unit=unit,
                       observed_on=on, evidence=EvidenceClass.E5_CUSTOMER_DATA, method="half-hourly metering", **extra)


def sourced(n, **kw):
    return obs(source_ref=f"{n:08x}-0000-0000-0000-000000000000:{SHA}", model_digest=DIGEST,
               reviewed_by="A. Reviewer", reviewed_at="2026-07-01T10:00:00+00:00", **kw)


def run_cli(*args, env=None):
    r = subprocess.run([sys.executable, "-m", "gridforge", *args], cwd=ROOT, capture_output=True, text=True,
                       env={**os.environ, **(env or {})})
    assert "Traceback" not in r.stderr, r.stderr
    return r


# --------------------------------------------------------------------------- 1. sites are sites, not halls

def test_five_observations_from_three_halls_of_one_site_are_one_site_not_calibration():
    rows = [obs(site="Only Site", hall=h, on=f"2026-0{m}-15")
            for m, h in [(1, "H1"), (2, "H1"), (3, "H2"), (4, "H3"), (5, "H3")]]
    c = calibration_for("envelope.racks", rows)
    assert c.n == 5 and c.sites == 1 and c.halls == 3
    assert c.state is CalibrationState.INDICATIVE
    assert c.low_ratio is None and c.high_ratio is None
    assert "across 1 site(s)" in c.sentence()


def test_three_distinct_sites_are_enough_and_the_hall_count_is_separate():
    rows = [obs(site=f"Site {i}", hall="H1", on=f"2026-0{i}-15") for i in range(1, 4)]
    rows += [obs(site="Site 1", hall="H2", on="2026-04-15"), obs(site="Site 2", hall="H2", on="2026-05-15")]
    c = calibration_for("envelope.racks", rows)
    assert (c.n, c.sites, c.halls) == (5, 3, 5)
    assert c.state is CalibrationState.CALIBRATED


def test_site_only_ref_is_the_prefix_of_every_hall_ref_and_ignores_case_and_space():
    assert site_ref("Acme", "H1").startswith(site_only_ref("Acme"))
    assert site_only_ref(" acme ") == site_only_ref("ACME")
    assert site_ref("Acme", "H1") != site_ref("Acme", "H2")
    assert "acme" not in site_only_ref("Acme").lower()
    assert site_only_ref("Acme") == "site_" + hashlib.sha256(b"acme").hexdigest()[:12]


def test_accuracy_block_does_not_say_calibrated_at_five_percent_coverage():
    keys = all_keys()
    rows = [obs(site=f"Site {i}", hall="H1", observed=24 + i, on=f"2026-0{i}-15") for i in range(1, 6)]
    block = accuracy_block(keys, Ledger(observations=rows))
    assert block["keys_with_site_observations"] == 1 and block["coverage"] < 0.1
    assert block["state"] != "calibrated"
    assert "partial" in block["statement"].lower()
    assert block["keys"][0]["state"] == "calibrated", "the one output that is calibrated is still reported as such"
    assert block["halls"] == 5 and block["sites"] == 5


def test_accuracy_block_says_calibrated_only_when_every_asserted_output_is():
    rows = [obs(site=f"Site {i}", hall="H1", observed=24 + i, on=f"2026-0{i}-15") for i in range(1, 6)]
    block = accuracy_block(["envelope.racks"], Ledger(observations=rows))
    assert block["state"] == "calibrated" and block["coverage"] == 1.0
    two = accuracy_block(["envelope.racks", "envelope.it_load_kW"], Ledger(observations=rows))
    assert two["state"] != "calibrated"


def test_an_observation_with_an_unknown_key_cannot_suppress_the_n0_sentence():
    with pytest.raises(ObservationError, match="vocabulary"):
        obs(key="foo.bar")
    with pytest.raises(ObservationError, match="vocabulary"):
        Observation.from_dict({**obs().to_dict(), "key": "foo.bar"})
    with pytest.raises(ObservationError, match="vocabulary"):
        obs(key="constraint.invented_constraint.racks")


def test_a_ledger_file_holding_an_unknown_key_fails_to_load_instead_of_loading_silently(tmp_path):
    p = tmp_path / "l.json"
    p.write_text(json.dumps({"observations": [{**obs().to_dict(), "key": "foo.bar"}]}))
    with pytest.raises(ObservationError, match="vocabulary"):
        _read(p)


def test_observations_for_keys_outside_the_asserted_set_do_not_count_as_coverage_of_it():
    rows = [obs()]
    block = accuracy_block(["envelope.it_load_kW"], Ledger(observations=rows))
    assert block["observations"] == 0 and block["state"] == "uncalibrated"
    assert "has not been established" in block["statement"]
    assert block["observations_total"] == 1


# --------------------------------------------------------------------------- 2. kind / source / review fields

@pytest.mark.parametrize("kind", ["quoted", "declared"])
def test_a_quote_or_a_declared_value_is_not_a_measurement(kind):
    with pytest.raises(ObservationError, match=kind):
        obs(kind=kind)
    with pytest.raises(ObservationError, match="kind"):
        obs(kind="rumour")
    assert obs(kind="measured").kind == "measured"
    assert obs().kind == "measured"


def test_a_sourced_observation_must_carry_its_model_digest_and_reviewer():
    ok = sourced(1)
    assert ok.source_ref.endswith(SHA)
    for field, bad in [("model_digest", ""), ("model_digest", "xyz"), ("reviewed_by", " "), ("reviewed_at", "yesterday")]:
        kw = dict(source_ref=ok.source_ref, model_digest=DIGEST, reviewed_by="A", reviewed_at="2026-07-01")
        kw[field] = bad
        with pytest.raises(ObservationError):
            obs(**kw)
    with pytest.raises(ObservationError, match="source_ref"):
        obs(source_ref="just-a-note", model_digest=DIGEST, reviewed_by="A", reviewed_at="2026-07-01")


def test_new_fields_round_trip_and_old_dicts_still_load():
    o = sourced(2, platform="p")
    assert Observation.from_dict(o.to_dict()) == o
    legacy = obs().to_dict()
    for k in ("kind", "source_ref", "model_digest", "reviewed_by", "reviewed_at", "source", "published"):
        legacy.pop(k)
    old = Observation.from_dict(legacy)
    assert old.kind == "measured" and old.source_ref == "" and old.published is False


def test_a_duplicate_source_ref_is_refused(tmp_path):
    p = tmp_path / "c.json"
    append_observation(sourced(1, site="S1"), p)
    with pytest.raises(ObservationError, match="source_ref"):
        append_observation(sourced(1, site="S2", on="2026-05-05"), p)
    assert len(_read(p)) == 1


# --------------------------------------------------------------------------- 2. the hash chain

def _appended(tmp_path, n=3):
    p = tmp_path / "chain.json"
    for i in range(1, n + 1):
        append_observation(sourced(i, site=f"S{i}"), p)
    return p


def test_each_record_carries_the_previous_records_hash(tmp_path):
    p = _appended(tmp_path)
    recs = json.loads(p.read_text())["observations"]
    assert recs[0]["prev_hash"] == GENESIS
    assert recs[1]["prev_hash"] == recs[0]["record_hash"] and recs[2]["prev_hash"] == recs[1]["record_hash"]
    assert len({r["record_hash"] for r in recs}) == 3
    obs_list, head = read_chain(p)
    assert len(obs_list) == 3 and head == recs[2]["record_hash"]


def test_editing_a_record_breaks_the_chain_and_names_it(tmp_path):
    p = _appended(tmp_path)
    doc = json.loads(p.read_text())
    doc["observations"][1]["observed"] = 99.0
    p.write_text(json.dumps(doc))
    with pytest.raises(LedgerIntegrityError, match="record 2"):
        _read(p)


def test_deleting_a_middle_record_breaks_the_chain_at_the_next_one(tmp_path):
    p = _appended(tmp_path)
    doc = json.loads(p.read_text())
    del doc["observations"][1]
    p.write_text(json.dumps(doc))
    with pytest.raises(LedgerIntegrityError, match="record 2"):
        _read(p)


def test_reordering_records_breaks_the_chain(tmp_path):
    p = _appended(tmp_path)
    doc = json.loads(p.read_text())
    doc["observations"][0], doc["observations"][1] = doc["observations"][1], doc["observations"][0]
    p.write_text(json.dumps(doc))
    with pytest.raises(LedgerIntegrityError, match="record 1"):
        _read(p)


def test_stripping_the_hashes_from_a_chained_file_is_refused(tmp_path):
    p = _appended(tmp_path)
    doc = json.loads(p.read_text())
    for r in doc["observations"]:
        r.pop("record_hash"), r.pop("prev_hash")
    p.write_text(json.dumps(doc))
    with pytest.raises(LedgerIntegrityError, match="record 1"):
        _read(p)


def test_a_broken_chain_makes_the_whole_ledger_fail_closed_not_partially_load(tmp_path, monkeypatch):
    from gridforge.calibration.ledger import load_ledger
    p = _appended(tmp_path)
    doc = json.loads(p.read_text())
    doc["observations"][2]["predicted"] = 1.0
    p.write_text(json.dumps(doc))
    monkeypatch.setenv("GRIDFORGE_CALIBRATION_LEDGER", str(p))
    with pytest.raises(LedgerIntegrityError, match="record 3"):
        load_ledger()
    with pytest.raises(LedgerIntegrityError):
        append_observation(sourced(9, site="S9"), p)      # and nothing more is appended to a broken file


def test_a_legacy_unchained_file_still_loads_and_the_first_append_chains_onto_it(tmp_path):
    p = tmp_path / "legacy.json"
    p.write_text(json.dumps({"observations": [obs(site="L1").to_dict()]}))
    assert len(_read(p)) == 1
    append_observation(sourced(1, site="S1"), p)
    assert len(_read(p)) == 2
    doc = json.loads(p.read_text())
    assert "record_hash" not in doc["observations"][0] and doc["observations"][1]["prev_hash"] != GENESIS
    doc["observations"][0]["observed"] = 1.0                 # tampering with the legacy prefix is caught by the first chained record
    p.write_text(json.dumps(doc))
    with pytest.raises(LedgerIntegrityError, match="record 2"):
        _read(p)


def test_the_empty_ledger_is_byte_identical_and_still_hashes_to_the_pinned_value(tmp_path, monkeypatch):
    from gridforge import provenance
    monkeypatch.setenv("GRIDFORGE_CALIBRATION_LEDGER", str(tmp_path / "none.json"))
    assert provenance.calibration_sha256() == EMPTY_LEDGER_SHA256
    assert Ledger().to_dict() == {"observations": []}
    assert not (tmp_path / "none.json").exists(), "reading must never create a ledger file"
    (tmp_path / "touched.json").write_text("")
    monkeypatch.setenv("GRIDFORGE_CALIBRATION_LEDGER", str(tmp_path / "touched.json"))
    assert provenance.calibration_sha256() == EMPTY_LEDGER_SHA256


def _writer(args):
    path, i = args
    append_observation(sourced(i, site=f"Site{i}", on=f"2026-06-{i + 1:02d}"), Path(path))


def test_concurrent_writers_do_not_lose_records_and_leave_a_valid_chain(tmp_path):
    p = tmp_path / "race.json"
    ctx = multiprocessing.get_context("spawn")
    with ctx.Pool(6) as pool:
        pool.map(_writer, [(str(p), i) for i in range(1, 13)])
    got, _ = read_chain(p)
    assert len(got) == 12
    assert len({o.source_ref for o in got}) == 12


# --------------------------------------------------------------------------- 2. CLI

def test_cli_add_marks_the_entry_cli_and_unpublished(tmp_path):
    p = tmp_path / "cli.json"
    r = run_cli("calibrate", "add", "--key", "envelope.racks", "--site", "Client A", "--hall", "DH-02",
                "--predicted", "26", "--observed", "24", "--unit", "racks", "--on", "2026-06-30",
                "--method", "metering", "--ledger", str(p))
    assert r.returncode == 0, r.stderr
    rec = json.loads(p.read_text())["observations"][0]
    assert rec["source"] == "cli" and rec["published"] is False and rec["source_ref"] == ""
    assert rec["kind"] == "measured" and rec["prev_hash"] == GENESIS and "Client A" not in p.read_text()
    assert "self-entered" in r.stdout


def test_cli_add_refuses_a_quote_and_an_unknown_key(tmp_path):
    base = ["calibrate", "add", "--site", "A", "--hall", "1", "--predicted", "1", "--observed", "1",
            "--unit", "racks", "--on", "2026-01-01", "--method", "m", "--ledger", str(tmp_path / "c.json")]
    r = run_cli(*base, "--key", "envelope.racks", "--kind", "quoted")
    assert r.returncode == 2 and "quoted" in r.stderr
    r = run_cli(*base, "--key", "foo.bar")
    assert r.returncode == 2
    assert not (tmp_path / "c.json").exists()


def test_cli_show_on_a_broken_chain_fails_closed(tmp_path):
    p = _appended(tmp_path)
    doc = json.loads(p.read_text())
    doc["observations"][0]["observed"] = 5.0
    p.write_text(json.dumps(doc))
    r = run_cli("calibrate", "show", env={"GRIDFORGE_CALIBRATION_LEDGER": str(p)})
    assert r.returncode != 0 and "record 1" in r.stderr


# --------------------------------------------------------------------------- 4(e) import of the admin export

def row(n, **kw):
    r = {
        "id": f"{n:08x}-0000-0000-0000-000000000000", "calibration_key": "btm.firm_MW", "observed_value": 28.5,
        "predicted_value": 30.0, "unit": "MW", "site_ref": site_only_ref(f"Site {n}"), "measurement_kind": "metered",
        "evidence_sha256": SHA, "engine_provenance_digest": DIGEST, "report_date": "2026-03-01",
        "observed_on": "2026-06-30", "method": "revenue-grade metering, 30 days", "evidence_class": "E5",
        "reviewed_by": "A. Reviewer", "reviewed_at": "2026-07-02T09:00:00+00:00",
    }
    r.update(kw)
    return r


def export(rows):
    return {"schema": "gridforge/calibration-export/1", "rows": rows}


def test_import_appends_only_verified_rows_hash_chained_with_source_refs(tmp_path):
    p = tmp_path / "imp.json"
    out = import_export(export([row(1), row(2), row(3)]), p)
    assert out["imported"] == 3
    got, _ = read_chain(p)
    assert [o.source for o in got] == ["import"] * 3 and all(o.published for o in got)
    assert got[0].source_ref == f"{row(1)['id']}:{SHA}" and got[0].model_digest == DIGEST
    assert got[0].reviewed_by == "A. Reviewer" and got[0].evidence is EvidenceClass.E5_CUSTOMER_DATA
    c = calibration_for("btm.firm_MW", got)
    assert c.n == 3 and c.sites == 3 and c.state is CalibrationState.INDICATIVE


def test_import_refuses_duplicates_by_source_ref_and_changes_nothing(tmp_path):
    p = tmp_path / "imp.json"
    import_export(export([row(1)]), p)
    before = p.read_text()
    with pytest.raises(ObservationError, match="already"):
        import_export(export([row(1)]), p)
    with pytest.raises(ObservationError, match="duplicate"):
        import_export(export([row(2), row(2)]), p)
    assert p.read_text() == before


@pytest.mark.parametrize("bad", [
    {"evidence_class": "E6"}, {"evidence_class": "E7"}, {"evidence_class": "E4"},
    {"measurement_kind": "quoted"}, {"measurement_kind": "declared"}, {"measurement_kind": "simulated"},
    {"calibration_key": "foo.bar"}, {"unit": "kW"}, {"observed_value": float("nan")}, {"observed_value": -1},
    {"engine_provenance_digest": "short"}, {"evidence_sha256": "nothex"}, {"reviewed_by": ""},
    {"site_ref": "Acme Datacentres Ltd"}, {"predicted_value": 0},
])
def test_import_refuses_any_row_that_fails_the_policy_and_is_all_or_nothing(tmp_path, bad):
    p = tmp_path / "imp.json"
    with pytest.raises(ObservationError):
        import_export(export([row(1), row(2, **bad)]), p)
    assert not p.exists() or _read(p) == []


def test_import_refuses_a_malformed_export(tmp_path):
    p = tmp_path / "imp.json"
    for doc in ({}, {"rows": "x"}, {"schema": "other/1", "rows": []}, [], "x"):
        with pytest.raises(ObservationError):
            import_export(doc, p)


def test_importing_zero_rows_leaves_the_ledger_empty_and_says_so(tmp_path):
    p = tmp_path / "zero.json"
    ex = tmp_path / "export.json"
    ex.write_text(json.dumps(export([])))
    r = run_cli("calibrate", "import", str(ex), "--ledger", str(p))
    assert r.returncode == 0, r.stderr
    assert "0 verified" in r.stdout and "empty" in r.stdout
    assert not p.exists()


def test_cli_import_round_trip_and_refusal(tmp_path):
    p = tmp_path / "imp.json"
    ex = tmp_path / "export.json"
    ex.write_text(json.dumps(export([row(1), row(2)])))
    r = run_cli("calibrate", "import", str(ex), "--ledger", str(p))
    assert r.returncode == 0 and "imported 2" in r.stdout, r.stderr
    again = run_cli("calibrate", "import", str(ex), "--ledger", str(p))
    assert again.returncode == 2 and "already" in again.stderr
    assert len(_read(p)) == 2


def test_import_never_writes_the_bundled_ledger():
    from gridforge.calibration.ledger import BUNDLED_PATH
    with pytest.raises(ObservationError, match="published with the engine"):
        import_export(export([row(1)]), BUNDLED_PATH)
    assert json.loads(BUNDLED_PATH.read_text())["observations"] == []


def test_the_vocabulary_keys_import_can_accept_are_the_engines():
    assert "btm.firm_MW" in MODEL_KEYS
