"""The /v1/spec JSON carries the same site-conditions basis as the rendered document."""
import json
from pathlib import Path

from gridforge.api.server import Tier, handle_spec

ROOT = Path(__file__).resolve().parents[1]


def _intake():
    return json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())


def _spec(intake):
    return handle_spec({"intake": intake, "constraint": "busway_ampacity"}, Tier.CLIENT)["specification"]


def test_spec_json_carries_the_supplied_site_conditions():
    spec = _spec(_intake())
    by_id = {c["id"]: c for c in spec["site_conditions"]}
    assert by_id["SC-01"]["path"] == "site.design_drybulb_C"
    assert (by_id["SC-01"]["status"], by_id["SC-01"]["value"], by_id["SC-01"]["evidence"]) == ("supplied", 34.0, "E3")
    assert (by_id["SC-02"]["status"], by_id["SC-02"]["value"], by_id["SC-02"]["evidence"]) == ("supplied", 21.0, "E5")
    assert (by_id["SC-03"]["value"], by_id["SC-03"]["unit"]) == (6.0, "degC")


def test_a_missing_design_dry_bulb_is_assumed_at_e0_and_listed_as_not_supplied():
    intake = _intake()
    intake["site"].pop("design_drybulb_C")
    spec = _spec(intake)
    dry = next(c for c in spec["site_conditions"] if c["id"] == "SC-01")
    assert dry["status"] == "assumed" and dry["evidence"] == "E0"
    assert any(a["path"] == "site.design_drybulb_C" and "E0" in a["assumed"] for a in spec["assumed_inputs"])


def test_the_document_the_buyer_reads_carries_the_same_section():
    out = handle_spec({"intake": _intake(), "constraint": "busway_ampacity"}, Tier.CLIENT)
    assert "Site conditions and assumptions" in json.dumps(out["document"])
