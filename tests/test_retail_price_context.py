"""The EIA retail-price context: copied faithfully from the harness fixture, labelled context only, paid tiers only, and moves nothing."""
import copy
import json
from pathlib import Path

import pytest

from gridforge.api.server import ApiError, handle_compare, handle_screen
from gridforge.api.tiers import Tier
from gridforge.context import energy_price

ROOT = Path(__file__).resolve().parents[1]
INTAKE = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())


def _strip(o):
    o = copy.deepcopy(o)
    o.pop("retail_price_context", None)
    o["caveats"] = [c for c in o["caveats"] if not c.startswith("Context only: retail_price_context")]
    return o


def test_figures_are_the_published_ones_converted_exactly():
    c = energy_price.context(state="Virginia", country="US")
    s = c["observed"]["sectors"]
    assert s["industrial"]["cents_per_kWh"] == 9.98 and s["industrial"]["usd_per_MWh"] == 99.8
    assert s["commercial"]["cents_per_kWh"] == 11.14 and s["commercial"]["usd_per_MWh"] == 111.4
    us = energy_price.context()["observed"]
    assert us["area"] == "U.S. Total" and us["sectors"]["industrial"]["usd_per_MWh"] == 96.4
    assert us["period"] == "2026-08"


def test_states_exclude_divisions_and_include_the_district():
    names = energy_price.states()
    assert "Virginia" in names and "District of Columbia" in names and len(names) == 51
    assert not set(names) & energy_price.DIVISIONS and "U.S. Total" not in names


def test_unknown_state_is_refused_not_guessed():
    with pytest.raises(energy_price.PriceContextError):
        energy_price.context(state="Narnia")


def test_it_says_what_it_is_not_and_does_not_convert_currency():
    c = energy_price.context(state="Texas", country="United States", assumed_eur_per_mwh=140.0)
    assert c["kind"] == "context_only" and c["applicability"]["level"] == "same_country_context"
    text = " ".join(c["limits"] + c["statements"])
    assert "not converted" in text and "contracted tariff" in text
    assert c["assumed"]["evidence_class_unchanged"] is True and c["assumed"]["eur_per_MWh"] == 140.0
    assert "placeholder" in c["assumed"]["source"]
    assert "eur_per_MWh" not in c["observed"] and not any("eur" in k.lower() for k in c["observed"]["sectors"]["industrial"])


def test_non_us_site_is_scale_only():
    assert energy_price.context(country="Ireland")["applicability"]["level"] == "scale_reference_only"
    assert energy_price.context()["applicability"]["level"] == "scale_reference_only"


def test_declared_tariff_is_reported_back_unchanged_and_outranks():
    c = energy_price.context(assumed_eur_per_mwh=87.5, declared=True)
    assert c["assumed"] == {"eur_per_MWh": 87.5, "source": "declared by the buyer (economics.electricity_eur_per_MWh)",
                            "evidence_class_unchanged": True}


@pytest.mark.parametrize("handler", [handle_compare, handle_screen])
def test_paid_tiers_carry_it_and_the_free_tier_does_not(handler):
    paid = handler({"intake": INTAKE, "electricity_price_state": "Virginia"}, Tier.CLIENT)
    assert paid["retail_price_context"]["observed"]["area"] == "Virginia"
    free = handler({"intake": INTAKE, "electricity_price_state": "Virginia"}, Tier.PUBLIC)
    assert "retail_price_context" not in json.dumps(free)


def test_it_moves_nothing_else_in_a_comparison():
    base = handle_compare({"intake": INTAKE}, Tier.CLIENT)
    with_state = handle_compare({"intake": INTAKE, "electricity_price_state": "Oregon"}, Tier.CLIENT)
    assert base["retail_price_context"]["observed"]["area"] == "U.S. Total"
    assert _strip(base) == _strip(with_state)


def test_a_declared_tariff_in_the_intake_is_what_is_reported_as_assumed():
    doc = copy.deepcopy(INTAKE)
    doc.setdefault("economics", {})["electricity_eur_per_MWh"] = 77
    out = handle_compare({"intake": doc}, Tier.CLIENT)
    assert out["retail_price_context"]["assumed"]["eur_per_MWh"] == 77.0
    assert out["retail_price_context"]["assumed"]["source"].startswith("declared")


@pytest.mark.parametrize("bad", ["Narnia", 5, ["Texas"], "", "texas"])
def test_bad_state_is_a_422_with_the_allowed_names(bad):
    with pytest.raises(ApiError) as e:
        handle_compare({"intake": INTAKE, "electricity_price_state": bad}, Tier.CLIENT)
    assert e.value.status == 422


def test_shipped_copy_is_byte_identical_to_what_the_harness_fixture_declares():
    doc = json.loads(energy_price.DATA_FILE.read_text())
    assert doc["schema"] == energy_price.SOURCE_SCHEMA and doc["source_id"] == "eia-epm"
    assert doc["provenance"]["page_sha256"] == "042269100ad9e52865ce21692337baa25ef0385e653189f51001ba348d7e3603"
