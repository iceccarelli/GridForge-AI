"""The discovery kit may not become a second price list or a claim of validation."""
import csv
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOC = (ROOT / "docs" / "11_CUSTOMER_DISCOVERY.md").read_text()


def test_the_kit_types_no_price():
    assert not re.search(r"[€$]\s?\d", DOC)
    assert not re.search(r"\b\d[\d,]*\s?(EUR|euro)", DOC, re.I)


def test_the_kit_never_claims_demand_is_validated():
    text = DOC.lower()
    assert "willingness to pay is not validated" in text
    for banned in ("market leader", "customers use", "trusted by", "guarantee"):
        assert banned not in text.replace("guarantees", "").replace("a guarantee", "")  # only the prohibition list may mention them


def test_the_log_header_matches_the_fields_the_kit_names():
    with (ROOT / "docs" / "templates" / "discovery-log.csv").open() as f:
        header = next(csv.reader(f))
    named = re.search(r"Fields: `([^`]+)`", DOC.replace("\n", " "))
    assert named
    assert header == [x.strip() for x in named.group(1).split(",")]
