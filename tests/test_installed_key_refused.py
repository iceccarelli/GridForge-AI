"""An `installed` key on an equipment list entry is refused, never silently dropped.

Defect (independent harness, RC d23bc81): a CDU entry `{"installed": false, ...}` in thermal.cdus was accepted, the key ignored, and the unit counted
as a CDU already in the hall: hybrid_dlc was dated first_rack_weeks 0.0 with 10 racks. The loader read each equipment list as "what is in the hall"
and let a key that changes that meaning pass unread. The same hazard exists on the other lists (a transformer bank or UPS block with
`installed: false` was counted as installed capacity; a btm option with `installed: true` was treated as a candidate to buy), so all four refuse it.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from gridforge.intake.loader import IntakeError, load_document

ROOT = Path(__file__).resolve().parents[1]
DUBLIN = json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text(encoding="utf-8"))
CDU = {"id": "CDU-ROW", "rated_capacity_kW": 1350, "rated_approach_K": 5, "rated_flow_l_per_min": 2000, "units": 3, "redundancy": "N+1"}


def _with(section: str, item_edit):
    d = copy.deepcopy(DUBLIN)
    if section == "thermal.cdus":
        d["thermal"]["cdus"] = [copy.deepcopy(CDU)]
        item = d["thermal"]["cdus"][0]
    else:
        item = d[section][0]
    item_edit(item)
    return d


@pytest.mark.parametrize("section", ["thermal.cdus", "transformers", "ups", "btm_options"])
@pytest.mark.parametrize("value", [False, True, "false", 0, None])
def test_an_installed_key_is_refused_by_field_name_on_every_equipment_list(section, value):
    with pytest.raises(IntakeError) as e:
        load_document(_with(section, lambda it: it.__setitem__("installed", value)))
    msg = str(e.value)
    assert f"{section}[0].installed" in msg and "installed is not an input" in msg and "refused rather than ignored" in msg


def test_the_cdu_message_says_what_to_do():
    with pytest.raises(IntakeError, match=r"thermal\.cdus\[0\]\.installed is not an input: declare only CDUs that are already installed"):
        load_document(_with("thermal.cdus", lambda it: it.__setitem__("installed", False)))


def test_the_index_of_the_offending_entry_is_named():
    d = copy.deepcopy(DUBLIN)
    d["thermal"]["cdus"] = [copy.deepcopy(CDU), {**copy.deepcopy(CDU), "id": "CDU-2", "installed": False}]
    with pytest.raises(IntakeError, match=r"thermal\.cdus\[1\]\.installed"):
        load_document(d)


def test_the_oracle_the_harness_runs_hybrid_dlc_is_not_dated_at_week_zero_from_a_bank_declared_not_installed():
    """The harness case: declared not installed. It is refused; it can no longer come back dated at week 0 with racks."""
    with pytest.raises(IntakeError):
        load_document(_with("thermal.cdus", lambda it: it.__setitem__("installed", False)))


def test_a_declared_cdu_without_the_key_is_unchanged_and_week_zero():
    from gridforge.envelope.time_to_power import schedule
    from gridforge.scenario import run_all
    d = copy.deepcopy(DUBLIN)
    d["thermal"]["cdus"] = [copy.deepcopy(CDU)]
    intake = load_document(d)
    r = next(x for x in run_all(intake.context, intake.scenarios) if x.spec.id == "hybrid_dlc")
    assert all(c.installed for c in r.ladder.initial_context.thermal.cdus) and schedule(r.ladder).weeks_to_first_rack == 0.0


def test_the_shipped_examples_still_load():
    for p in sorted((ROOT / "examples" / "intake").glob("*.json")):
        load_document(json.loads(p.read_text(encoding="utf-8")))
