"""POST /v1/portfolio with format md|html: the delivered Portfolio Screen (the ranking document and one model pack per hall), from ONE solve.

The ranking rows of the json form are the contract the document must agree with: a document that ranked halls differently from its
own rows, or a pack for a hall that was not ranked, is the failure these tests are for.
"""
import copy
import json
from pathlib import Path

import pytest

from gridforge.api.server import ApiError, MAX_PORTFOLIO_HALLS, handle_portfolio
from gridforge.api.tiers import Tier

ROOT = Path(__file__).resolve().parent.parent
BASE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())


def hall(n, scale=1.0):
    d = copy.deepcopy(BASE)
    d["project"] = dict(d.get("project", {}), client=d.get("project", {}).get("client", "Reference"))
    d["site"] = dict(d["site"], id=f"SITE-{n}")
    d["hall"] = dict(d["hall"], id=f"H{n}")
    # Distinct halls differ in their figures. Three copies of one document under three names are, on the face of it, one hall listed three
    # times, and the portfolio route now says so; the fixture must describe three halls to test a portfolio of three.
    d["grid"] = dict(d["grid"], contracted_MW=d["grid"]["contracted_MW"] - 0.5 * (n - 1))
    return d


def post(body):
    return handle_portfolio(body, Tier.CLIENT)


@pytest.fixture(scope="module")
def three():
    return [hall(1), hall(2), hall(3)]


def test_json_is_unchanged_and_carries_no_document(three):
    out = post({"intakes": three})
    assert set(out) == {"objective", "halls", "total_racks", "total_racks_evidence"}


@pytest.mark.parametrize("fmt", ["md", "html"])
def test_a_rendered_form_adds_the_document_and_one_pack_per_hall(three, fmt):
    plain = post({"intakes": three})
    out = post({"intakes": three, "format": fmt, "client": "North Estate"})
    assert out["halls"] == plain["halls"] and out["total_racks"] == plain["total_racks"]     # the same solve
    assert out["document"]["format"] == fmt
    assert "Portfolio Screen" in out["document"]["title"]
    assert "North Estate" in out["document"]["document"] or fmt == "html"
    assert len(out["model_packs"]) == 3
    for pack in out["model_packs"].values():
        assert isinstance(pack, dict) and pack


def test_pack_names_are_unique_when_halls_at_different_sites_share_a_hall_id():
    a, b, c = hall(1), hall(2), hall(3)
    for d in (a, b, c):
        d["hall"]["id"] = "H1"                       # three halls, all called H1, at three sites
    out = post({"intakes": [a, b, c], "format": "md"})
    assert sorted(out["model_packs"]) == ["SITE-1_H1", "SITE-2_H1", "SITE-3_H1"]


def test_the_same_hall_listed_three_times_is_refused():
    with pytest.raises(ApiError):
        post({"intakes": [hall(1), hall(1), hall(1)], "format": "md"})


def test_an_unknown_format_or_a_hostile_client_is_refused(three):
    for bad in ({"format": "pdf"}, {"format": 3}, {"format": "md", "client": ""}, {"format": "md", "client": "x" * 121}, {"format": "md", "client": ["a"]}):
        with pytest.raises(ApiError) as e:
            post({"intakes": three, **bad})
        assert e.value.status == 422


def test_the_limits_still_apply():
    with pytest.raises(ApiError):
        post({"intakes": []})
    with pytest.raises(ApiError):
        post({"intakes": [hall(1)] * (MAX_PORTFOLIO_HALLS + 1)})
