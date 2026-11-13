"""The free qualifier's answer must carry no schedule, cost or money, in its keys or in any sentence.

The independent lab harness scans the free /v1/qualify answer for a number followed by weeks, months or EUR in free text (and for
cost/price/schedule-like key names). A new data-request row worded "run-hours over 12 months" tripped it: a measurement window, not a
delivery time, but a free answer that quotes durations invites being read as a schedule, so the free read says "a full year" instead. This
repeats the harness's own patterns against the whole answer so the next row to be added cannot reintroduce the problem unnoticed.
"""
import json
import re
from pathlib import Path

from gridforge.api import server as S
from gridforge.api.tiers import Tier

ROOT = Path(__file__).resolve().parents[1]
KEY = re.compile(r"capex|lead_time|weeks|cost|price|econom|\beur\b|euro|ladder|annual|schedule", re.I)
TEXT = re.compile(r"(€\s?\d|\d[\d,.]*\s?(weeks?|wks|months?)\b|\bEUR\s?\d|\d[\d,.]*\s?(EUR|euros?)\b)", re.I)


def leaks(node, path=""):
    if isinstance(node, dict):
        for k, v in node.items():
            if KEY.search(str(k)):
                yield f"key {path}.{k}"
            yield from leaks(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from leaks(v, f"{path}[{i}]")
    elif isinstance(node, str) and (m := TEXT.search(node)):
        yield f"text {path}: {node[max(0, m.start() - 40): m.end() + 15]!r}"


def test_the_scan_can_see_a_leak():
    assert list(leaks({"a": "run-hours over 12 months"})) and list(leaks({"capex_eur": 1})) and list(leaks({"c": "EUR 4,500"}))
    assert not list(leaks({"a": "run-hours over a full year", "racks": 28}))


def test_the_free_qualifier_answer_carries_no_duration_or_money_anywhere():
    body = json.loads((ROOT / "public" / "reference" / "examples" / "qualify-request.json").read_text())
    out = S._invoke("/v1/qualify", S.ROUTES["/v1/qualify"][0], body, Tier.PUBLIC)
    assert list(leaks(out)) == []


def test_it_holds_when_every_optional_input_is_left_out_so_every_gap_row_is_in_the_answer():
    """The reference request supplies most inputs; leave out as many as the qualifier allows so the data request is as long as it gets."""
    body = json.loads((ROOT / "public" / "reference" / "examples" / "qualify-request.json").read_text())
    for drop in ("firm_capacity_MVA", "contracted_MW", "design_drybulb_C"):
        body.pop(drop, None)
    out = S._invoke("/v1/qualify", S.ROUTES["/v1/qualify"][0], body, Tier.PUBLIC)
    assert len(out["intake"]["gaps"]) >= 25, len(out["intake"]["gaps"])        # the long list is what is being scanned
    assert list(leaks(out)) == []
