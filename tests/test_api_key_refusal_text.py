"""A caller who SENT a key that is not recognised is not told that a key is required.

The audit found an unrecognised X-API-Key answered 401 'an API key is required for this endpoint', which sends the caller looking for a key they
already hold (a typo, a rotated key, a key from another deployment). When a key was sent, the answer says so; when none was, it still says one is
required. The key is never echoed.
"""
from __future__ import annotations

from gridforge.api.metering import refusal
from payg_rig import INTAKE, rig  # noqa: F401

NOT_RECOGNISED = "the API key sent was not recognised"
REQUIRED = "an API key is required for this endpoint"
WRONG = "sk_not_one_of_ours_0123456789"


def test_refusal_says_which_of_the_two_situations_it_is():
    assert refusal("")["error"] == REQUIRED
    assert refusal("   ")["error"] == REQUIRED
    assert refusal(WRONG)["error"] == NOT_RECOGNISED
    assert WRONG not in str(refusal(WRONG))


def test_a_paid_route_with_an_unrecognised_key_says_it_was_not_recognised_and_does_not_echo_it(rig):  # noqa: F811
    status, out, _ = rig.post("/v1/screen", {"intake": INTAKE}, key=WRONG)
    assert status == 401 and out["error"] == NOT_RECOGNISED
    assert WRONG not in str(out)
    assert out["public_endpoint"] == "/v1/qualify"          # the pointer to the free route is unchanged


def test_a_bearer_token_that_is_not_recognised_gets_the_same_answer(rig):  # noqa: F811
    status, out, _ = rig.post("/v1/screen", {"intake": INTAKE}, headers={"Authorization": f"Bearer {WRONG}"})
    assert status == 401 and out["error"] == NOT_RECOGNISED and WRONG not in str(out)


def test_no_key_at_all_is_still_told_that_one_is_required(rig):  # noqa: F811
    status, out, _ = rig.post("/v1/screen", {"intake": INTAKE})
    assert status == 401 and out["error"] == REQUIRED


def test_usage_with_an_unrecognised_key_and_with_none(rig):  # noqa: F811
    status, out, _ = rig.get("/v1/usage", key=WRONG)
    assert status == 401 and out["error"] == NOT_RECOGNISED and WRONG not in str(out)
    status, out, _ = rig.get("/v1/usage")
    assert status == 401 and out["error"] == REQUIRED


def test_an_estimate_with_an_unrecognised_key_says_so_in_key_error(rig):  # noqa: F811
    status, out, _ = rig.get("/v1/estimate?endpoint=/v1/screen", key=WRONG)
    assert status == 200 and out["key_error"] == NOT_RECOGNISED and WRONG not in str(out)
