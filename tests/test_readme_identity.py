"""The root README states the one business, and is the same business the catalogue sells.

The GitHub description once advertised modular behind-the-meter supply systems while the site said the
practice sells no equipment. The README is the first page a GitHub reader or an AI system sees, so it is
held to the catalogue: no equipment-supply claim, the brand/engine split stated, and every price it quotes
present in lib/products.ts.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
README = (ROOT / "README.md").read_text(encoding="utf-8")


def test_brand_and_engine_are_both_named_and_related():
    assert "Time to Power" in README and "GridForge Engine" in README
    assert "timetopower.ai" in README


def test_it_says_it_sells_no_equipment():
    assert re.search(r"sells no equipment", README)


def test_no_equipment_supply_offer():
    offers = re.compile(r"\b(we|time to power) (sell|install|supply|build)s?\b[^.\n]*(microgrid|battery|generator|modular)", re.I)
    assert not offers.search(README)


def test_every_euro_price_quoted_is_in_the_catalogue():
    catalogue = (ROOT / "lib" / "products.ts").read_text(encoding="utf-8")
    cents = {int(n.replace("_", "")) for n in re.findall(r"(\d[\d_]{4,})", catalogue)}
    eur = {c // 100 for c in cents}
    for amount in re.findall(r"EUR ([\d,]+)(?![\d,]*k)", README):
        assert int(amount.replace(",", "")) in eur, f"EUR {amount} is not a catalogue amount"


def test_no_invented_proof():
    assert not re.search(r"testimonial|trusted by|case study of|award", README, re.I) or "no customer names" in README
