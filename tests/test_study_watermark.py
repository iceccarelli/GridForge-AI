"""A real client's study must never be stamped 'SYNTHETIC REFERENCE DATA — NOT A CUSTOMER ASSET'.

The CLI and the API both built the Envelope Study without choosing a watermark, so the synthetic stamp (meant for
the invented reference intakes only, docs/01 §8) went onto every study -- including a real customer's EUR 22-45k
document. Conversely, a demo that loses its stamp can be mistaken for a real site, so the stamp is kept for any
intake that declares itself synthetic."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

from gridforge.api.server import handle_study
from gridforge.api.tiers import Tier
from gridforge.intake.loader import load_document

ROOT = Path(__file__).resolve().parent.parent
STAMP = "SYNTHETIC REFERENCE DATA"
INTAKES = sorted((ROOT / "examples" / "intake").glob("*.json"))


def real(tmp_path, **project):
    d = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())
    d["project"] = {"client": "Acme Data Centres Ltd", "reference": "ACME-001", "objective": "max_compute", **project}
    d["site"]["name"] = "Acme Dublin 1"
    f = tmp_path / "intake.json"
    f.write_text(json.dumps(d))
    return f, d


def cli_study(f, out):
    r = subprocess.run([sys.executable, "-m", "gridforge", "study", str(f), "-o", str(out)], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0, r.stderr
    return (out / "envelope_study.md").read_text(), (out / "envelope_study.html").read_text()


def test_a_real_clients_study_is_not_stamped_synthetic_by_the_cli(tmp_path):
    f, _ = real(tmp_path)
    md, html = cli_study(f, tmp_path / "o")
    assert STAMP not in md and STAMP not in html
    assert "NOT A CUSTOMER ASSET" not in md
    assert "SCREENING OPINION" in md and "not a measurement of this asset" in md


def test_a_real_clients_study_is_not_stamped_synthetic_by_the_api(tmp_path):
    _, doc = real(tmp_path)
    for fmt in ("md", "html"):
        out = handle_study({"intake": doc, "format": fmt}, Tier.CLIENT)
        text = out["document"] + out.get("document_full", "")
        assert STAMP not in text, fmt
        assert "SCREENING OPINION" in text


@pytest.mark.parametrize("intake", INTAKES, ids=lambda p: p.stem)
def test_the_invented_reference_intakes_keep_their_stamp(tmp_path, intake):
    doc = json.loads(intake.read_text())
    assert load_document(doc).synthetic, "the shipped examples are synthetic and must say so"
    md, html = cli_study(intake, tmp_path / "o")
    assert STAMP in md and STAMP in html
    api = handle_study({"intake": doc, "format": "md"}, Tier.CLIENT)
    assert STAMP in api["document"]


@pytest.mark.parametrize("project, expected", [
    ({"synthetic": True}, True),
    ({"note": "Synthetic demo data"}, True),
    ({"client": "Demo (SYNTHETIC) Ltd"}, True),
    ({"synthetic": False}, False),
    ({}, False),
])
def test_synthetic_is_declared_explicitly_and_defaults_to_a_real_client(tmp_path, project, expected):
    _, doc = real(tmp_path, **project)
    assert load_document(doc).synthetic is expected
