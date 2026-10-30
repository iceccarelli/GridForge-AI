"""The EIA retail-price context: copied faithfully from the harness fixture, labelled context only, paid tiers only, and moves nothing."""
import copy
import json
from pathlib import Path

import pytest

from gridforge.api.server import ApiError, handle_compare, handle_screen
from gridforge.api.tiers import Tier
from gridforge.context import energy_price

ROOT = Path(__file__).resolve().parents[1]
INTAKE = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())   # declares a tariff (125, object form)
REFERENCE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())   # declares none


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


# --- the paid documents --------------------------------------------------------------------------------------------------------------------
import re  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402

from gridforge.api.server import handle_study  # noqa: E402
from gridforge.reporting.retail_price_section import section as price_section  # noqa: E402

DUBLIN = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())
BANNED = re.compile(r"\b(proven|guaranteed|certified|will deliver|measured capacity|verified performance|actual performance)\b", re.I)
HEAD = "Electricity price: what has been published (context only)"


def screen_md(doc=REFERENCE, **kw):
    return handle_screen({"intake": doc, "format": "md", **kw}, Tier.CLIENT)["document"]


def test_the_density_screen_carries_the_price_section_after_the_grid_wait_and_before_the_next_step():
    md = screen_md()  # _rendered runs the report gates: a failure would raise, not return
    assert f"## 6. {HEAD}" in md
    assert md.index("## 5. Grid wait") < md.index(f"## 6. {HEAD}") < md.index("## 7. Recommended next step")
    section = md[md.index(f"## 6. {HEAD}"):md.index("## 7. ")]
    assert "U.S. Total, 2026-08" in section and "96.4 US dollars per MWh" in section and "144.7 US dollars per MWh" in section
    assert "not converted here" in section and "library placeholder" in section
    assert "Context only: this is not the tariff for this site" in section
    assert not BANNED.search(section), "the new section must not use the language the report gate bans"


def test_the_document_and_the_json_quote_the_same_prices_and_the_same_assumed_price():
    payload = handle_screen({"intake": REFERENCE}, Tier.CLIENT)["retail_price_context"]
    md = screen_md()
    for sector in ("industrial", "commercial"):
        assert f"{payload['observed']['sectors'][sector]['usd_per_MWh']:,.1f} US dollars per MWh" in md
    assert f"uses {payload['assumed']['eur_per_MWh']:,.0f} euros per MWh" in md


def test_the_state_choice_reaches_the_document():
    assert "Virginia, 2026-08" in screen_md(electricity_price_state="Virginia")
    assert "U.S. Total, 2026-08" in screen_md()


def test_a_declared_tariff_is_what_the_document_says_it_used():
    doc = copy.deepcopy(REFERENCE)
    doc.setdefault("economics", {})["electricity_eur_per_MWh"] = 77
    md = screen_md(doc)
    assert "uses 77 euros per MWh (declared by the buyer" in md and "library placeholder" not in md[md.index(f"## 6. {HEAD}"):md.index("## 7. ")]


def test_the_study_closes_its_economics_section_with_the_same_context():
    md = handle_study({"intake": DUBLIN, "format": "md"}, Tier.CLIENT)["document"]
    start = md.index("## 9. Economics")
    section9 = md[start:md.index("## 10. ", start)]
    assert "Electricity price, published elsewhere (context only)" in section9
    assert "96.4 US dollars per MWh" in section9 and "not converted here" in section9
    assert not BANNED.search(section9), "the new section must not use the language the report gate bans"


def test_the_study_still_prints_its_own_price_row_unchanged():
    md = handle_study({"intake": DUBLIN, "format": "md"}, Tier.CLIENT)["document"]
    assert "Grid electricity price used" in md and "declared by the client" in md


def test_a_document_built_without_the_context_is_exactly_what_it_was():
    from gridforge.intake.loader import load_document
    from gridforge.reporting.screen import build
    from gridforge.scenario.run import run_all
    intake = load_document(REFERENCE)
    results = run_all(intake.context, intake.scenarios)
    headings = [sec.heading for sec in build(intake, results).sections]
    assert headings[-1] == "5. Recommended next step" and not any("Electricity price" in h for h in headings)


def test_the_numbering_closes_up_when_only_the_price_is_given():
    from gridforge.api.payloads import retail_price_context_for
    from gridforge.intake.loader import load_document
    from gridforge.reporting.screen import build
    from gridforge.scenario.run import run_all
    intake = load_document(REFERENCE)
    results = run_all(intake.context, intake.scenarios)
    headings = [sec.heading for sec in build(intake, results, retail_price=retail_price_context_for(intake)).sections]
    assert headings[-2:] == [f"5. {HEAD}", "6. Recommended next step"]


def test_the_free_documents_carry_no_price_section():
    assert "Electricity price" not in handle_screen({"intake": INTAKE, "format": "md"}, Tier.PUBLIC)["document"]
    assert "Electricity price, published elsewhere" not in handle_study({"intake": DUBLIN, "format": "md"}, Tier.PUBLIC)["document"]


def test_a_section_for_a_sector_eia_does_not_publish_prints_no_number_for_it():
    ctx = energy_price.context(state="Virginia", country="US", assumed_eur_per_mwh=140.0)
    ctx["observed"]["sectors"]["commercial"] = None
    text = " ".join(str(b) for b in price_section(ctx, "h").blocks)
    assert "commercial customers no published figure" in text


def test_the_command_line_produces_the_same_sections(tmp_path):
    env = {"GRIDFORGE_REPORT_DATE": "2026-10-27", "PATH": "/usr/bin:/bin"}
    subprocess.run([sys.executable, "-m", "gridforge", "screen", str(ROOT / "examples" / "intake" / "reference_hall.json"), "-o", str(tmp_path)],
                   capture_output=True, text=True, check=True, env=env)
    assert f"## 6. {HEAD}" in (tmp_path / "density_screen.md").read_text()
    subprocess.run([sys.executable, "-m", "gridforge", "study", str(ROOT / "examples" / "intake" / "dublin_hall.json"), "-o", str(tmp_path)],
                   capture_output=True, text=True, check=True, env=env)
    assert "Electricity price, published elsewhere (context only)" in (tmp_path / "envelope_study.md").read_text()


# --- the price reported as "used" is the price the model used, in whichever form the buyer declared it -------------------------------------


@pytest.mark.parametrize(
    ("declared", "expected"),
    [(77, 77.0), (77.5, 77.5), ({"value": 77, "note": "contract of 2026-01-01"}, 77.0)],
    ids=["bare-number", "bare-float", "value-and-note"],
)
def test_a_declared_tariff_is_reported_as_declared_in_every_form(declared, expected):
    doc = copy.deepcopy(INTAKE)
    doc.setdefault("economics", {})["electricity_eur_per_MWh"] = declared
    for out in (handle_compare({"intake": doc}, Tier.CLIENT), handle_screen({"intake": doc}, Tier.CLIENT)):
        assumed = out["retail_price_context"]["assumed"]
        assert assumed["eur_per_MWh"] == expected and assumed["source"].startswith("declared by the buyer")


def test_the_dublin_example_that_declares_125_in_object_form_is_not_called_a_placeholder():
    out = handle_compare({"intake": DUBLIN}, Tier.CLIENT)["retail_price_context"]["assumed"]
    assert out["eur_per_MWh"] == 125.0 and out["source"].startswith("declared by the buyer")
    md = handle_screen({"intake": DUBLIN, "format": "md"}, Tier.CLIENT)["document"]
    assert "uses 125 euros per MWh (declared by the buyer" in md


def test_the_price_reported_is_the_price_the_study_used():
    study = handle_study({"intake": DUBLIN, "format": "md"}, Tier.CLIENT)["document"]
    assert "Grid electricity price used | 125 EUR/MWh (E5) | declared by the client" in study
    assert "uses 125 euros per MWh" in study


def test_an_intake_with_no_tariff_is_reported_as_the_placeholder_everywhere():
    for doc in (REFERENCE, ):
        for out in (handle_compare({"intake": doc}, Tier.CLIENT), handle_screen({"intake": doc}, Tier.CLIENT)):
            assert out["retail_price_context"]["assumed"]["source"].startswith("library placeholder")
            assert out["retail_price_context"]["assumed"]["eur_per_MWh"] == 140.0
