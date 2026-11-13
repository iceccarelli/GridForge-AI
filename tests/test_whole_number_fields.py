"""A number the caller sent that is not a whole number is refused BY NAME, never as the raw `ValueError: invalid literal for int()` text
(found by the journey audit: `valid_days: "abc"` on /v1/proposal and `target_racks: "abc"` on /v1/power/assess escaped through the catch-all)."""
import json
from pathlib import Path

import pytest

from gridforge.api.server import ApiError, _whole_number, handle_power_assess, handle_proposal
from gridforge.api.tiers import Tier

ROOT = Path(__file__).resolve().parents[1]
HALL = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("raw", ["abc", [], {}, True, 3.5, 10**400, -1, 4000])
def test_a_bad_value_is_refused_by_field_name(raw):
    with pytest.raises(ApiError) as e:
        _whole_number({"valid_days": raw}, "valid_days", 30, 1, 3650)
    assert e.value.status == 422 and e.value.extra.get("field") == "valid_days"
    assert "ValueError" not in e.value.message and "valid_days" in e.value.message


@pytest.mark.parametrize("raw,expect", [(None, 30), ("", 30), (12, 12), ("12", 12), (12.0, 12), ("12.0", 12)])
def test_accepted_forms_are_unchanged(raw, expect):
    assert _whole_number({"valid_days": raw}, "valid_days", 30, 1, 3650) == expect


def test_the_proposal_and_power_assess_handlers_refuse_by_name():
    with pytest.raises(ApiError) as e:
        handle_proposal({"intake": HALL, "valid_days": "abc"}, Tier.PUBLIC)
    assert e.value.status == 422 and e.value.extra.get("field") == "valid_days"
    with pytest.raises(ApiError) as e2:
        handle_power_assess({"intake": HALL, "target_racks": "abc"}, Tier.PUBLIC)
    assert e2.value.status == 422 and e2.value.extra.get("field") == "target_racks"
