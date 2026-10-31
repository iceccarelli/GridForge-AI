"""A figure the client supplies WITH a source is shown with it in the Density Screen.

The loader has always accepted {value, source, note, evidence} for a number, and the Screen printed none of it: a figure confirmed from
the client's own DSO agreement read exactly like one typed from memory, so the file it came from never reached the document the buyer
paid for. Found while building the evidence-confirmation workflow (lib/intake-evidence.ts): provenance that is accepted and dropped is
worse than none, because the input looks as if it was used.
"""
import copy
import json
from pathlib import Path

import pytest

from gridforge.api import server as S
from gridforge.api.tiers import Tier
from gridforge.intake.loader import IntakeError, load_document

ROOT = Path(__file__).resolve().parents[1]
BASE = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())
# The example carries its own sources and notes; strip them so what the tests add is the only provenance.


def bare(doc):
    """The document with every {value, source, note} reduced to its value, so the only provenance is what a test adds."""
    def walk(x):
        if isinstance(x, dict):
            if "value" in x and ("source" in x or "note" in x):
                return x["value"]
            return {k: walk(v) for k, v in x.items()}
        if isinstance(x, list):
            return [walk(v) for v in x]
        return x
    return walk(doc)


def with_firm(value, source="dso_agreement.pdf (sha256 abcdef123456…), clause 4.2", note="Confirmed by the buyer from their own document.", evidence="E5"):
    d = bare(copy.deepcopy(BASE))
    d["grid"]["firm_capacity_MVA"] = {"value": value, "source": source, "note": note, "evidence": evidence}
    return d


def screen(doc, fmt):
    return S.handle_screen({"intake": doc, "format": fmt}, Tier.CLIENT)["document"]


def test_the_loader_records_a_figure_that_has_a_source():
    intake = load_document(with_firm(31.0))
    [x] = intake.report.sourced
    assert (x.path, x.value, x.unit, x.evidence) == ("grid.firm_capacity_MVA", 31.0, "MVA", "E5")
    assert "dso_agreement.pdf" in x.source and "clause 4.2" in x.source


def test_a_bare_number_is_not_recorded_as_sourced():
    assert load_document(bare(copy.deepcopy(BASE))).report.sourced == []


def test_a_figure_is_still_supplied_not_a_gap():
    intake = load_document(with_firm(31.0))
    assert "grid.firm_capacity_MVA" in intake.report.supplied
    assert "grid.firm_capacity_MVA" not in [g.path for g in intake.report.gaps]


@pytest.mark.parametrize("fmt", ["md", "html"])
def test_the_screen_names_the_file_the_place_in_it_and_the_evidence_class(fmt):
    text = screen(with_firm(31.0), fmt)
    for needle in ("Figures supplied with a source", "dso_agreement.pdf", "clause 4.2", "31 MVA", "E5", "not independently verified"):
        assert needle in text, needle


@pytest.mark.parametrize("fmt", ["md", "html"])
def test_a_screen_without_any_source_has_no_such_section(fmt):
    assert "Figures supplied with a source" not in screen(bare(copy.deepcopy(BASE)), fmt)


def test_html_escapes_what_the_client_wrote():
    text = screen(with_firm(31.0, source="a.pdf <script>alert(1)</script>"), "html")
    assert "<script>alert(1)</script>" not in text and "&lt;script&gt;" in text


def test_a_client_cannot_claim_more_than_customer_data():
    """E6 and E7 are earned by the calibration ledger. A confirmed figure declared E7 is capped, and the report says E5."""
    intake = load_document(with_firm(31.0, evidence="E7"))
    assert intake.report.sourced[0].evidence == "E5"
    assert any("capped at E5" in w for w in intake.report.warnings)


def test_a_source_or_note_that_is_not_text_is_still_refused():
    for bad in (["x"], {"a": 1}, 5):
        d = with_firm(31.0)
        d["grid"]["firm_capacity_MVA"]["source"] = bad
        with pytest.raises(IntakeError):
            load_document(d)
