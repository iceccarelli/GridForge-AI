"""A malformed ``project`` block is a refusal that names the field, never an AttributeError.

Found by the gridforge-stress fuzz (seed 20261030): 29 /v1/deck requests escaped as server faults because load_document accepted any
``project`` value and Intake.client / .reference / .synthetic then called .get() on it, outside load_document's own error translation.
"""
import copy
import json
from pathlib import Path

import pytest

from gridforge.api import server as S
from gridforge.api.tiers import Tier
from gridforge.intake.loader import IntakeError, load_document

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = sorted((ROOT / "examples" / "intake").glob("*.json"))
BASE = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text())

MALFORMED = [None, True, False, "acme", "", 0, 7, 1.5, float("nan"), float("inf"), [], [[1]], [{"client": "x"}]]


def with_project(value):
    d = copy.deepcopy(BASE)
    d["project"] = value
    return d


@pytest.mark.parametrize("value", MALFORMED, ids=repr)
def test_a_non_object_project_is_refused_by_name(value):
    with pytest.raises(IntakeError, match=r"^project must be an object"):
        load_document(with_project(value))


def test_the_refusal_names_the_type_and_does_not_echo_the_value():
    with pytest.raises(IntakeError) as exc:
        load_document(with_project("secret-client-name"))
    assert "str" in str(exc.value) and "secret-client-name" not in str(exc.value)


@pytest.mark.parametrize("value", MALFORMED, ids=repr)
def test_the_deck_handler_refuses_a_malformed_project_with_an_intake_error(value):
    """Handlers raise IntakeError for a bad intake and do_POST answers it 422 (and refunds the call); anything else is a 500."""
    with pytest.raises(IntakeError, match="project must be an object"):
        S.handle_deck({"intake": with_project(value)}, Tier.CLIENT)


def test_a_missing_project_is_still_an_empty_project_not_an_invented_one():
    d = copy.deepcopy(BASE)
    d.pop("project")
    intake = load_document(d)
    assert intake.project == {}
    assert intake.client == "Unnamed client" and intake.reference == "—"


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda p: p.stem)
def test_every_example_intake_still_loads_with_its_own_project(path):
    doc = json.loads(path.read_text())
    intake = load_document(doc)
    assert intake.project == doc["project"]
    assert intake.client == doc["project"]["client"]
