"""The supplier response template must carry the currency slot the engine now requires, wherever it is produced.

A priced bid with no currency is disqualified (a price in an unstated currency cannot be compared: a 30k bid and a 30M bid could otherwise
swap places). The API's `response_template` always had a `currency` slot after that change, but `gridforge spec` wrote its own copy of the
template, which is the file `scripts/build-reference.sh` publishes and a buyer actually fills in, and it had none. A buyer who filled in
every field the template showed would have had the bid disqualified with nothing in the template saying why.
"""
import json
from pathlib import Path

import pytest

from gridforge.api import server as S
from gridforge.api.tiers import Tier
from gridforge.cli import main
from gridforge.intake.loader import load
from gridforge.procurement import SupplierResponse, build_spec, rank_bids
from gridforge.scenario.run import run_all

ROOT = Path(__file__).resolve().parents[1]
INTAKE = ROOT / "examples" / "intake" / "reference_hall.json"


@pytest.fixture(autouse=True)
def pinned_today(monkeypatch):
    monkeypatch.setenv("GRIDFORGE_REPORT_DATE", "2026-10-13")      # bids carry a validity date; do not let the fixture expire


def _cli_template(tmp_path) -> dict:
    code = main(["spec", str(INTAKE), "-o", str(tmp_path / "out"), "--constraint", "busway_ampacity"])
    assert code == 0
    return json.loads((tmp_path / "out" / "response_template.json").read_text())


def _api_template() -> dict:
    out = S._invoke("/v1/spec", S.ROUTES["/v1/spec"][0],
                    {"intake": json.loads(INTAKE.read_text()), "constraint": "busway_ampacity", "format": "md"}, Tier.CLIENT)
    return out["response_template"]


def test_the_cli_template_has_the_same_top_level_shape_as_the_api_template(tmp_path):
    cli, api = _cli_template(tmp_path), _api_template()
    assert "currency" in cli and "currency" in api
    # every key the API's template asks the supplier for is asked for by the CLI's too (the CLI adds only its free-text `reference`/`text`)
    assert set(api) - {"specification"} <= set(cli), sorted(set(api) - set(cli))


def _bid(template: dict, supplier: str, capex: float, currency: str | None):
    data = json.loads(json.dumps(template))
    data.update(supplier=supplier, received_on="2026-10-01", valid_until="2026-12-31")
    data["values"] = {**{k: v for k, v in data["values"].items() if v is not None},
                      "capex_eur": capex, "lead_time_weeks": 30, "install_weeks": 4}
    data["compliance"] = {k: "C" for k in data["compliance"]}
    if currency is None:
        data.pop("currency", None)
    else:
        data["currency"] = currency
    return SupplierResponse.from_dict(data)


def test_a_bid_filled_from_the_template_is_disqualified_without_a_currency_and_ranked_with_one(tmp_path):
    template = _cli_template(tmp_path)
    intake = load(INTAKE)
    results = run_all(intake.context, intake.scenarios)
    best = max(results, key=lambda r: r.unlocked_racks)
    pkg = build_spec(intake, best, constraint_id="busway_ampacity")

    with_currency = _bid(template, "Synthetic Supplier A", 1_000_000, "EUR")
    without = _bid(template, "Synthetic Supplier B", 900_000, None)
    ranked = rank_bids(pkg, [with_currency, without])

    by_name = {a.supplier: a for a in ranked}
    assert by_name["Synthetic Supplier A"].disqualified is False
    assert by_name["Synthetic Supplier B"].disqualified is True
    # the cheaper bid with no currency never leads, and the one that names its currency does
    assert ranked[0].supplier == "Synthetic Supplier A"
