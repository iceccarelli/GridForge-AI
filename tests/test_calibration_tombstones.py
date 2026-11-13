"""D5 on the ledger side: a withdrawn observation is not counted, and cannot be imported again, although the chained ledger file is never edited.

The database keeps a tombstone (the sha256 of the observation id, a time, no content) and stops exporting the observation (tests/test_calibration_publication_gates.py).
That does nothing for a row already imported into the private ledger, which keeps counting in every statistic read from it, or for an old export file imported after
the withdrawal. gridforge/calibration/tombstones.py is a side file beside the ledger, read whenever the ledger is read. Every value is SYNTHETIC.
"""
import json

import pytest

from gridforge.calibration import ObservationError, import_export, load_ledger, release
from gridforge.calibration.ledger import published_source_ref, read_chain
from gridforge.calibration.schema import site_only_ref
from gridforge.calibration import tombstones as T

SHA = "e" * 64
DIGEST = "d" * 64


def row(n, **kw):
    r = {"id": f"{n:08x}-0000-0000-0000-000000000000", "key": "btm.firm_MW", "observed_value": 28.5, "predicted_value": 30.0, "unit": "MW",
         "site_ref": site_only_ref(f"Site {n}"), "measurement_kind": "metered", "evidence_sha256": SHA, "engine_provenance_digest": DIGEST,
         "report_date": "2026-03-01", "observed_on": "2026-06-30", "method": "revenue-grade metering, 30 days", "evidence_class": "E5",
         "reviewed_by": "A. Reviewer", "reviewed_at": "2026-07-02T09:00:00+00:00"}
    r.update(kw)
    return r


def export(rows, **extra):
    return {"schema": "gridforge/calibration-export/1", "rows": rows, **extra}


@pytest.fixture()
def ledger(tmp_path, monkeypatch):
    p = tmp_path / "calibration.local.json"
    monkeypatch.setenv("GRIDFORGE_CALIBRATION_LEDGER", str(p))
    monkeypatch.delenv(T.ENV_VAR, raising=False)
    monkeypatch.delenv("GRIDFORGE_SITE_ALIAS_FILE", raising=False)
    return p


def counted(key="btm.firm_MW"):
    return len(load_ledger().for_key(key))


def test_the_hash_is_the_one_the_database_and_the_ledger_use():
    oid = row(1)["id"]
    assert T.observation_hash(oid) == release.observation_hash(oid)
    assert published_source_ref(oid, SHA).split(":")[0] == T.observation_hash(oid)[:32]


def test_a_missing_file_tombstones_nothing_and_a_malformed_one_stops_the_read(tmp_path):
    assert T.read_tombstones(tmp_path / "none.json") == frozenset()
    good = T.observation_hash("a")
    for bad in ("{", "[]", json.dumps({"schema": "other/1", "tombstones": []}), json.dumps({"schema": T.SCHEMA, "tombstones": "x"}),
                json.dumps({"schema": T.SCHEMA, "tombstones": ["abc"]}), json.dumps({"schema": T.SCHEMA, "tombstones": [{"observation_hash": good.upper()}]}),
                json.dumps({"schema": T.SCHEMA, "tombstones": [5]})):
        f = tmp_path / "t.json"
        f.write_text(bad)
        with pytest.raises(T.TombstoneError):
            T.read_tombstones(f)
    f = tmp_path / "ok.json"
    f.write_text(json.dumps({"schema": T.SCHEMA, "tombstones": [good, {"observation_hash": T.observation_hash("b"), "withdrawn_at": "2026-11-01T00:00:00Z"}]}))
    assert T.read_tombstones(f) == {good, T.observation_hash("b")}


def test_adding_tombstones_keeps_what_is_there_and_says_how_many_were_new(tmp_path):
    f = tmp_path / "t.json"
    a, b, c = (T.observation_hash(x) for x in "abc")
    assert T.add_tombstones(f, [a, b]) == 2
    first = json.loads(f.read_text())
    assert [e["observation_hash"] for e in first["tombstones"]] == sorted([a, b]) and set(first["tombstones"][0]) == {"observation_hash", "withdrawn_at"}
    assert T.add_tombstones(f, [b, c]) == 1
    assert T.read_tombstones(f) == {a, b, c}
    assert {e["observation_hash"]: e["withdrawn_at"] for e in json.loads(f.read_text())["tombstones"]}[a] == first["tombstones"][0]["withdrawn_at"]
    with pytest.raises(T.TombstoneError):
        T.add_tombstones(f, ["not a hash"])
    assert T.read_tombstones(f) == {a, b, c}                                                # the failed add changed nothing
    (tmp_path / "x.json").write_text("{}")
    with pytest.raises(T.TombstoneError):
        T.add_tombstones(tmp_path / "x.json", [a])                                          # a file that is not ours is not extended


def test_a_source_reference_is_matched_in_either_form_it_was_written_in():
    oid = row(7)["id"]
    dead = T.heads([T.observation_hash(oid)])
    assert T.is_withdrawn(published_source_ref(oid, SHA), dead)                            # the hashed head
    assert T.is_withdrawn(f"{oid}:{SHA}", dead)                                            # a row imported before the hash existed: the raw id
    assert not T.is_withdrawn(published_source_ref(row(8)["id"], SHA), dead)
    assert not T.is_withdrawn("", dead) and not T.is_withdrawn("cli-entry", dead)           # a hand-entered row has no source


def test_a_withdrawn_observation_stops_counting_without_the_chained_file_changing(ledger):
    import_export(export([row(1), row(2), row(3), row(4)]), ledger, accept_mixed_refs=True)
    before = ledger.read_bytes()
    assert counted() == 4
    T.add_tombstones(T.tombstone_path(ledger), [T.observation_hash(row(2)["id"]), T.observation_hash(row(3)["id"])])
    assert counted() == 2
    assert ledger.read_bytes() == before                                                   # the hash chain is exactly what it was
    assert len(read_chain(ledger)[0]) == 4
    assert {o.site_ref for o in load_ledger().for_key("btm.firm_MW")} == {site_only_ref("Site 1"), site_only_ref("Site 4")}


def test_an_unreadable_tombstone_file_stops_the_read_rather_than_count_a_withdrawn_row_again(ledger):
    import_export(export([row(1), row(2)]), ledger, accept_mixed_refs=True)
    T.tombstone_path(ledger).write_text("{ not json")
    with pytest.raises(T.TombstoneError):
        load_ledger()


def test_the_bundled_ledger_and_the_published_view_are_unchanged_by_a_tombstone_file(ledger):
    T.add_tombstones(T.tombstone_path(ledger), [T.observation_hash(row(1)["id"])])
    assert load_ledger(published_only=True).observations == []
    assert load_ledger().observations == []


def test_a_withdrawn_observation_cannot_be_imported_again_from_the_sidefile_or_from_the_export_itself(ledger):
    import_export(export([row(1)]), ledger, accept_mixed_refs=True)
    T.add_tombstones(T.tombstone_path(ledger), [T.observation_hash(row(2)["id"])])
    before = ledger.read_bytes()
    with pytest.raises(ObservationError, match="withdrawn"):
        import_export(export([row(3), row(2)]), ledger, accept_mixed_refs=True)           # an old export, saved before the withdrawal
    with pytest.raises(ObservationError, match="withdrawn"):
        import_export(export([row(3), row(4)], tombstones=[T.observation_hash(row(4)["id"])]), ledger, accept_mixed_refs=True)
    assert ledger.read_bytes() == before                                                   # all or nothing: row 3, which was fine, was not imported either
    assert import_export(export([row(3)]), ledger, accept_mixed_refs=True)["imported"] == 1
    for bad in ("x", ["short"], [5], {"a": 1}):
        with pytest.raises(ObservationError, match="tombstones"):
            import_export(export([row(5)], tombstones=bad), ledger, accept_mixed_refs=True)
    assert counted() == 2


def test_a_withdrawal_after_import_is_not_undone_by_importing_the_same_export_again(ledger):
    doc = export([row(1), row(2)])
    import_export(doc, ledger, accept_mixed_refs=True)
    T.add_tombstones(T.tombstone_path(ledger), [T.observation_hash(row(1)["id"])])
    assert counted() == 1
    with pytest.raises(ObservationError):
        import_export(doc, ledger, accept_mixed_refs=True)
    assert counted() == 1


def test_the_environment_variable_moves_the_side_file(ledger, tmp_path, monkeypatch):
    elsewhere = tmp_path / "elsewhere" / "t.json"
    monkeypatch.setenv(T.ENV_VAR, str(elsewhere))
    assert T.tombstone_path(ledger) == elsewhere
    monkeypatch.delenv(T.ENV_VAR)
    assert T.tombstone_path(ledger) == ledger.with_name(T.FILENAME)


# ---- C4: the importer RECORDS the export's withdrawals, every read of the ledger honours them, and an operator can record one by hand

def run_cli(*args, env=None):
    import os
    import subprocess
    import sys
    from pathlib import Path
    r = subprocess.run([sys.executable, "-m", "gridforge", *args], cwd=Path(__file__).resolve().parent.parent, capture_output=True, text=True, env={**os.environ, **(env or {})})
    assert "Traceback" not in r.stderr, r.stderr
    return r


def test_an_export_that_lists_a_withdrawal_stops_the_row_imported_before_it_from_counting(ledger):
    """The review's repro (p1): r1 is imported; the next export carries r2 and the tombstone of r1. Before, r1 kept counting in every aggregate and the importer
    wrote no side file (`add_tombstones` had no caller)."""
    import_export(export([row(1)]), ledger, accept_mixed_refs=True)
    assert counted() == 1 and not T.tombstone_path(ledger).exists()
    out = import_export(export([row(2)], tombstones=[T.observation_hash(row(1)["id"])]), ledger, accept_mixed_refs=True)
    assert out["imported"] == 1 and out["tombstones_recorded"] == 1
    assert T.tombstone_path(ledger).exists() and T.read_tombstones(T.tombstone_path(ledger)) == {T.observation_hash(row(1)["id"])}
    assert counted() == 1 and {o.site_ref for o in load_ledger().for_key("btm.firm_MW")} == {site_only_ref("Site 2")}
    assert out["ledger_observations"] == 1, "the total the import reports counts what is in effect"
    assert len(read_chain(ledger)[0]) == 2, "the chained file keeps both rows: only what counts changed"
    again = import_export(export([row(3)], tombstones=[T.observation_hash(row(1)["id"])]), ledger, accept_mixed_refs=True)           # recorded once
    assert again["tombstones_recorded"] == 0 and counted() == 2


def test_every_read_of_the_ledger_leaves_a_withdrawn_row_out_not_only_load_ledger(ledger):
    from gridforge.calibration.ledger import _read
    import_export(export([row(1), row(2), row(3)]), ledger, accept_mixed_refs=True)
    T.add_tombstones(T.tombstone_path(ledger), [T.observation_hash(row(2)["id"])])
    assert counted() == 2 and len(_read(ledger)) == 2                              # `calibrate add` prints its n from this read
    assert len(read_chain(ledger)[0]) == 3                                         # the chain read stays whole: it verifies the file
    r = run_cli("calibrate", "add", "--key", "btm.firm_MW", "--site", "Client Z", "--hall", "H1", "--predicted", "30", "--observed", "28", "--unit", "MW",
                "--on", "2026-06-30", "--method", "metering", "--ledger", str(ledger))
    assert r.returncode == 0, r.stderr
    assert len(_read(ledger)) == 3                                                 # two in effect and the one just added, not four


def test_an_import_that_is_refused_still_records_the_withdrawals_it_carries_and_says_so(ledger):
    import_export(export([row(1)]), ledger, accept_mixed_refs=True)
    before = ledger.read_bytes()
    dead = T.observation_hash(row(1)["id"])
    with pytest.raises(ObservationError, match="WERE recorded"):
        import_export(export([row(2, evidence_class="E4")], tombstones=[dead]), ledger, accept_mixed_refs=True)            # a row that fails the policy
    assert ledger.read_bytes() == before and counted() == 0, "no observation was imported, and the withdrawn one no longer counts"
    assert T.read_tombstones(T.tombstone_path(ledger)) == {dead}


def test_gridforge_calibrate_withdraw_records_hashes_by_hand(ledger):
    import_export(export([row(1), row(2), row(3)]), ledger, accept_mixed_refs=True)
    h1, h2 = T.observation_hash(row(1)["id"]), T.observation_hash(row(2)["id"])
    r = run_cli("calibrate", "withdraw", h1, h2, "--ledger", str(ledger))
    assert r.returncode == 0, r.stderr
    assert "recorded 2 new" in r.stdout and "2 row(s) that no longer count" in r.stdout
    assert counted() == 1 and T.read_tombstones(T.tombstone_path(ledger)) == {h1, h2}
    again = run_cli("calibrate", "withdraw", h1, "--ledger", str(ledger))
    assert again.returncode == 0 and "recorded 0 new" in again.stdout and "1 already recorded" in again.stdout
    where = run_cli("calibrate", "where", env={"GRIDFORGE_CALIBRATION_LEDGER": str(ledger)})
    assert where.returncode == 0 and "withdrawn (tombstoned) observations" in where.stdout and ": 2" in where.stdout
    with pytest.raises(ObservationError, match="withdrawn"):
        import_export(export([row(1)]), ledger, accept_mixed_refs=True)


@pytest.mark.parametrize("args", [["not-a-hash"], ["A" * 64], ["a" * 63], ["a" * 64, "oops"], []])
def test_calibrate_withdraw_refuses_what_is_not_a_hash_and_writes_nothing(ledger, args):
    import_export(export([row(1)]), ledger, accept_mixed_refs=True)
    r = run_cli("calibrate", "withdraw", *args, "--ledger", str(ledger))
    assert r.returncode == 2, (r.stdout, r.stderr)
    assert not T.tombstone_path(ledger).exists() and counted() == 1


def test_calibrate_withdraw_refuses_the_bundled_ledger():
    from gridforge.calibration.ledger import BUNDLED_PATH
    r = run_cli("calibrate", "withdraw", "a" * 64, "--ledger", str(BUNDLED_PATH))
    assert r.returncode == 2 and "bundled" in r.stderr and "Nothing was recorded" in r.stderr


def test_a_damaged_tombstone_file_is_not_overwritten_by_a_withdrawal(ledger):
    T.tombstone_path(ledger).write_text("{ not json")
    r = run_cli("calibrate", "withdraw", "a" * 64, "--ledger", str(ledger))
    assert r.returncode == 2 and T.tombstone_path(ledger).read_text() == "{ not json"
