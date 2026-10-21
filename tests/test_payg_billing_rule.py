"""The billing rule is one sentence, and the engine's BILLING_RULE is its source.

tests/site/payg-billing-rule.test.ts pins the website's sentence to the committed public/reference/tools.json; this pins that file to
the engine's string (so the chain engine -> reference -> website is closed), and pins what the sentence must say about carrying a
balance forward: including the edge that a balance which never reaches the minimum invoice is never invoiced.
"""
import json
from pathlib import Path

from gridforge.api.metering import BILLING_RULE, payg_public
from gridforge.commercial import PAYG

ROOT = Path(__file__).resolve().parent.parent


def test_the_published_reference_carries_the_engines_sentence():
    published = json.loads((ROOT / "public" / "reference" / "tools.json").read_text())["payg"]["billing_rule"]
    assert published == BILLING_RULE == payg_public()["billing_rule"]


def test_the_rule_states_the_carry_forward_honestly():
    eur = lambda c: f"€{c // 100}" if c % 100 == 0 else f"€{c / 100:.2f}"
    assert f"under the {eur(PAYG.min_invoice_cents)} minimum invoice is not invoiced on its own" in BILLING_RULE
    assert "carried forward and added to the next month, and so on from month to month" in BILLING_RULE
    assert f"A balance that never reaches {eur(PAYG.min_invoice_cents)} is never invoiced." in BILLING_RULE
    assert f"{eur(PAYG.unit_price_cents)} a unit" in BILLING_RULE
    assert "net ledger units" in BILLING_RULE and "refunded and never charged" in BILLING_RULE
