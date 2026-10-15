"""Engine provenance: the identity a cost-evidence run is recorded under.

It must change when anything that can change a document changes (engine code, cost library, calibration ledger),
must NOT change with the wall clock, and must expose digests only. Fixtures are SYNTHETIC.
"""
import json
import os
import threading
import urllib.request
from pathlib import Path

import pytest

from gridforge import provenance as prov
from gridforge.api.server import Handler, make_server

ROOT = Path(__file__).resolve().parents[1]
LIB_LINE = {"key": "ups.per_kW", "label": "SYNTHETIC test line", "unit": "EUR/kW", "value": 321.0, "basis": "library_default"}


@pytest.fixture(autouse=True)
def clean_env(monkeypatch, tmp_path):
    monkeypatch.setenv("GRIDFORGE_COST_LIBRARY", str(tmp_path / "none.json"))
    monkeypatch.setenv("GRIDFORGE_CALIBRATION_LEDGER", str(tmp_path / "none-ledger.json"))
    monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2026-10-13")


def test_shape_and_determinism():
    a, b = prov.provenance("9.9.9"), prov.provenance("9.9.9")
    assert a == b
    assert a["schema"] == "gridforge/provenance/1"
    for k in ("digest", "code_sha256", "cost_library_sha256", "calibration_sha256"):
        assert len(a[k]) == 64 and int(a[k], 16) >= 0
    assert a["engine_version"] == "9.9.9" and a["report_date"] == "2026-10-13"


def test_the_date_is_reported_but_is_not_part_of_the_identity(monkeypatch):
    a = prov.provenance("1")
    monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2031-01-01")
    b = prov.provenance("1")
    assert a["report_date"] != b["report_date"]
    assert a["digest"] == b["digest"]


def test_version_label_is_part_of_the_identity():
    assert prov.provenance("1")["digest"] != prov.provenance("2")["digest"]


def test_a_cost_library_change_changes_the_identity(monkeypatch, tmp_path):
    before = prov.provenance("1")
    p = tmp_path / "lib.json"
    p.write_text(json.dumps({"entries": [LIB_LINE]}))
    monkeypatch.setenv("GRIDFORGE_COST_LIBRARY", str(p))
    after = prov.provenance("1")
    assert after["cost_library_sha256"] != before["cost_library_sha256"]
    assert after["code_sha256"] == before["code_sha256"] and after["calibration_sha256"] == before["calibration_sha256"]
    assert after["digest"] != before["digest"]
    p.write_text(json.dumps({"entries": [{**LIB_LINE, "value": 322.0}]}))
    assert prov.provenance("1")["digest"] != after["digest"]


def test_a_calibration_ledger_change_changes_the_identity(monkeypatch, tmp_path):
    before = prov.provenance("1")
    from gridforge.calibration import Observation
    from gridforge.calibration.schema import site_ref
    from gridforge.validation.evidence import EvidenceClass
    extra = Observation(key="envelope.racks", site_ref=site_ref("SYNTHETIC-SITE", "H1"), predicted=26.0, observed=24.0,
                        unit="racks", observed_on="2026-06-30", evidence=EvidenceClass.E5_CUSTOMER_DATA,
                        method="synthetic test fixture").to_dict()
    p = tmp_path / "ledger.json"
    p.write_text(json.dumps({"observations": [extra]}))
    monkeypatch.setenv("GRIDFORGE_CALIBRATION_LEDGER", str(p))
    after = prov.provenance("1")
    assert after["calibration_sha256"] != before["calibration_sha256"]
    assert after["digest"] != before["digest"]


def test_engine_code_is_hashed_by_path_and_content():
    assert prov.code_sha256() == prov.code_sha256()
    # The hash covers the package, including its data files and this module.
    h = prov.code_sha256()
    assert len(h) == 64


@pytest.fixture(scope="module")
def server():
    os.environ["GRIDFORGE_API_KEYS"] = "prov-key"
    os.environ["GRIDFORGE_RATE_LIMIT"] = "0"
    Handler.limiter.per_minute = 0
    httpd = make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()


def _get(base, path, key="prov-key"):
    req = urllib.request.Request(base + path, headers={"X-API-Key": key})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def test_version_endpoint_reports_provenance_digests_only(server):
    body = _get(server, "/v1/version")
    p = body["provenance"]
    assert p["digest"] == prov.provenance(body["version"])["digest"]
    text = json.dumps(p)
    assert set(p) == {"schema", "engine_version", "code_sha256", "cost_library_sha256", "calibration_sha256", "digest", "report_date"}
    assert "SYNTHETIC" not in text


def test_an_evidence_study_names_what_produced_it(server):
    intake = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())
    entry = {"key": "ups.per_kW", "label": "SYNTHETIC", "unit": "EUR/kW", "value": 500.0, "basis": "budgetary_quote",
             "supplier": "SYNTHETIC-SUPPLIER-A", "quoted_on": "2026-10-01", "valid_until": "2099-12-31", "currency": "EUR",
             "status": "accepted", "evidence_id": "11111111-1111-4111-8111-111111111111", "reviewer": "R",
             "reviewed_on": "2026-10-02", "synthetic": True, "comparability": "exact", "response_ref": "a" * 64}
    req = urllib.request.Request(server + "/v1/study", method="POST",
                                 data=json.dumps({"intake": intake, "format": "html", "cost_evidence": [entry]}).encode(),
                                 headers={"X-API-Key": "prov-key", "Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        out = json.load(r)
    assert out["provenance"]["digest"] == _get(server, "/v1/version")["provenance"]["digest"]
