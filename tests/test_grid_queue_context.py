"""The measured queue statistic that sits beside the grid-wait question: what it says, what it refuses to say, and that it never moves a number.

The statistic is LBNL's Queued Up (2026 edition, CC BY 4.0), computed by the independent gridforge-stress harness. These tests pin the
values it carries (so the data file cannot drift silently), the limits every output states, and that adding it to /v1/compare and
/v1/screen changes no figure, date or evidence class in either payload.
"""
import copy
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from gridforge.api.server import ApiError, handle_compare, handle_screen, handle_study
from gridforge.api.tiers import Tier
from gridforge.api.tools import TOOLS_BY_NAME
from gridforge.context import grid_queue as g

EX = Path(__file__).resolve().parent.parent / "examples" / "intake"
DUBLIN = json.loads((EX / "dublin_hall.json").read_text())
REFERENCE = json.loads((EX / "reference_hall.json").read_text())
ASSUMED = {"weeks": 260.0, "band_low_weeks": 150.0, "band_high_weeks": 520.0, "evidence_class": "E0_ASSUMPTION"}


# --- the data and the module ---------------------------------------------------------------------------------------------------

def test_the_data_file_is_the_attributed_lbnl_measurement():
    doc = json.loads(g.DATA_FILE.read_text())
    assert doc["schema"] == "gridforge-stress/queue-context/1" and doc["source_id"] == "lbnl-queued-up"
    assert len(doc["provenance"]["workbook_sha256"]) == 64
    assert "NOT a time-to-power for a load" in doc["definition"]
    assert any("Survivorship" in x for x in doc["limits"])


def test_the_pooled_us_statistic_and_a_region_carry_the_measured_values():
    pooled = g.context(country="US")["observed"]
    assert (pooled["n"], pooled["median_years"], pooled["p25_years"], pooled["p75_years"]) == (1439, 4.394, 3.086, 5.844)
    assert pooled["median_weeks"] == pytest.approx(229.3, abs=0.05)
    ercot = g.context(region="ERCOT", country="US")["observed"]
    assert (ercot["n"], ercot["median_years"]) == (376, 3.791)
    assert g.regions() == ("CAISO", "ERCOT", "MISO", "NYISO", "PJM", "SPP", "Southeast", "West")


def test_survivorship_is_computed_from_the_cohort_counts_and_stated():
    s = g.context()["survivorship"]
    assert (s["entered"], s["operational"], s["withdrawn"], s["unresolved"]) == (5633, 1299, 4153, 181)
    assert s["operational"] + s["withdrawn"] + s["unresolved"] == s["entered"]
    assert s["share_operational_of_entered"] == pytest.approx(0.231, abs=0.0005)
    assert "describe only the operational ones" in s["statement"]


@pytest.mark.parametrize("country,level", [("US", "same_country_context"), ("usa", "same_country_context"), (" United States ", "same_country_context"),
                                           ("IE", "scale_reference_only"), ("", "scale_reference_only"), (None, "scale_reference_only"),
                                           (7, "scale_reference_only"), (["US"], "scale_reference_only")])
def test_a_site_outside_the_observed_country_gets_a_scale_reference_only(country, level):
    assert g.context(country=country)["applicability"]["level"] == level


@pytest.mark.parametrize("region", ["pjm", "", "ISO-NE", "Texas", 1, None.__class__])
def test_an_unknown_region_is_refused_not_guessed(region):
    with pytest.raises(g.QueueContextError):
        g.context(region=region)


def test_every_output_states_the_limits_and_the_claims_it_refuses():
    out = g.context(country="IE")
    text = " ".join(out["statements"])
    assert "not a connection time for a load" in text and "not evidence about this site's network operator" in text
    assert "changes no figure and no evidence class" in text
    assert out["kind"] == "context_only" and out["source"]["licence"] == "CC BY 4.0"
    assert len(out["must_not_claim"]) == 4 and any("validated, confirmed or raised in evidence class" in m for m in out["must_not_claim"])


@pytest.mark.parametrize("weeks,position", [(100, "below_p25"), (200, "between_p25_and_median"), (260, "between_median_and_p75"), (400, "at_or_above_p75")])
def test_the_assumption_is_positioned_inside_the_observed_distribution_and_left_unchanged(weeks, position):
    out = g.context(country="US", assumed={**ASSUMED, "weeks": float(weeks)})
    c = out["comparison"]
    assert c["position_of_assumption"] == position
    assert c["assumed_weeks"] == weeks and c["assumed_evidence_class"] == "E0_ASSUMPTION"
    assert c["assumed_over_observed_median"] == pytest.approx(weeks / out["observed"]["median_weeks"], abs=0.001)


def test_no_comparison_without_an_assumption_and_none_is_invented():
    assert "comparison" not in g.context(country="US")
    assert g.assumption_from_scenarios([]) is None
    assert g.assumption_from_scenarios([{"constraints": [{"id": "grid_firm_capacity", "relief": {"lead_time_weeks": {"value": 1}}}]}]) is None


def test_a_caller_cannot_alter_the_shared_data_through_a_result():
    first = g.context()
    first["limits"].append("tampered")
    first["observed"]["n"] = -1
    first["statements"].clear()
    again = g.context()
    assert "tampered" not in again["limits"] and again["observed"]["n"] == 1439 and again["statements"]


# --- /v1/compare ---------------------------------------------------------------------------------------------------------------

def compare(doc, **kw):
    return handle_compare({"intake": doc, **kw}, Tier.CLIENT)


def test_compare_carries_the_context_and_says_it_changes_nothing():
    out = compare(DUBLIN)
    ctx = out["grid_queue_context"]
    assert ctx["kind"] == "context_only" and ctx["observed"]["n"] == 1439
    assert ctx["applicability"]["site_country"] == DUBLIN["site"]["country"]
    assert any(c.startswith("Context only: grid_queue_context") for c in out["caveats"])
    assert any("Grid reinforcement is not dated" in c for c in out["caveats"])  # the refusal is still there, beside the evidence


def test_the_context_moves_no_number_date_digest_or_grade_in_the_comparison():
    plain, regional = compare(DUBLIN), compare(DUBLIN, grid_queue_region="PJM")
    assert regional["grid_queue_context"]["observed"]["n"] == 427 != plain["grid_queue_context"]["observed"]["n"]
    strip = lambda o: {k: v for k, v in o.items() if k not in ("grid_queue_context", "caveats", "provenance")}
    assert strip(plain) == strip(regional)
    assert plain["request_digest"] == regional["request_digest"] and plain["grade"] == regional["grade"]


@pytest.mark.parametrize("region", ["nope", 5, ["PJM"], {"a": 1}, ""])
def test_compare_refuses_a_bad_region_with_the_allowed_names(region):
    with pytest.raises(ApiError) as exc:
        compare(DUBLIN, grid_queue_region=region)
    assert exc.value.status == 422 and exc.value.extra["allowed"] == list(g.regions())


# --- /v1/screen ----------------------------------------------------------------------------------------------------------------

def test_screen_sets_the_measured_statistic_beside_the_assumed_grid_wait():
    out = handle_screen({"intake": REFERENCE}, Tier.CLIENT)
    ctx = out["grid_queue_context"]
    assert "comparison" in ctx, "the client-tier screen carries the grid lead time, so it is compared"
    carried = g.assumption_from_scenarios(out["scenarios"], prefer=out["recommended"])
    assert ctx["comparison"]["assumed_weeks"] == carried["weeks"]
    assert ctx["comparison"]["assumed_evidence_class"] == carried["evidence_class"]  # never raised by the comparison
    assert any("evidence class" in s and "unchanged" in s for s in ctx["statements"])


def test_the_screen_context_moves_nothing_and_a_document_screen_is_untouched():
    plain = handle_screen({"intake": REFERENCE}, Tier.CLIENT)
    regional = handle_screen({"intake": REFERENCE, "grid_queue_region": "ERCOT"}, Tier.CLIENT)
    drop = lambda o: {k: v for k, v in o.items() if k != "grid_queue_context"}
    assert drop(plain) == drop(regional) and regional["grid_queue_context"]["observed"]["n"] == 376
    doc = handle_screen({"intake": REFERENCE, "format": "md"}, Tier.CLIENT)
    assert "grid_queue_context" not in doc and doc["format"] == "md"


def test_screen_refuses_a_bad_region():
    with pytest.raises(ApiError) as exc:
        handle_screen({"intake": REFERENCE, "grid_queue_region": "Mars"}, Tier.CLIENT)
    assert exc.value.status == 422


# --- the published tool definitions -------------------------------------------------------------------------------------------

@pytest.mark.parametrize("tool", ["gridforge_screen", "gridforge_compare"])
def test_the_tool_schema_lists_the_region_parameter_with_exactly_the_known_regions(tool):
    schema = TOOLS_BY_NAME[tool]["input_schema"] if "input_schema" in TOOLS_BY_NAME[tool] else TOOLS_BY_NAME[tool]["inputSchema"]
    prop = schema["properties"]["grid_queue_region"]
    assert prop["enum"] == list(g.regions()) and "changes no number" in prop["description"]
    assert schema["additionalProperties"] is False


# --- the paid documents --------------------------------------------------------------------------------------------------------

BANNED = re.compile(r"\b(proven|guaranteed|certified|will deliver|measured capacity|verified performance|actual performance)\b", re.I)


def screen_md(**kw):
    return handle_screen({"intake": REFERENCE, "format": "md", **kw}, Tier.CLIENT)["document"]


def test_the_density_screen_carries_the_section_before_the_next_step_and_still_passes_every_gate():
    md = screen_md()  # _rendered runs the report gates: a failure would raise, not return
    assert "## 5. Grid wait: what has been observed elsewhere (context only)" in md
    assert md.index("## 5. Grid wait") < md.index("## 6. Recommended next step")
    assert "Context only: this is not a connection time for a load or a data centre" in md
    assert "Only 23% of the 5633 requests that entered a queue in 2010-2015 reached operation" in md
    assert "median of 53 months" in md and "37-70 months" in md
    section = md[md.index("## 5. Grid wait"):md.index("## 6. ")]
    assert not BANNED.search(section), "the new section must not use the language the report gate bans"


def test_the_document_and_the_json_quote_the_same_assumed_grid_wait():
    payload = handle_screen({"intake": REFERENCE}, Tier.CLIENT)
    weeks = payload["grid_queue_context"]["comparison"]["assumed_weeks"]
    assert f"assumes is {weeks:.0f} weeks" in screen_md()


def test_the_region_choice_reaches_the_document():
    assert "(ERCOT, requests that reached operation 2018-2025)" in screen_md(grid_queue_region="ERCOT")
    assert "(US, requests that reached operation 2018-2025)" in screen_md()


def test_the_study_closes_its_time_to_power_section_with_the_same_context():
    md = handle_study({"intake": DUBLIN, "format": "md"}, Tier.CLIENT)["document"]
    start = md.index("## 3. Time to power")
    section3 = md[start:md.index("## 4. ", start)]
    assert "Grid wait, observed elsewhere (context only)" in section3
    assert "not as a correction of the assumption" in section3
    assert "Only 23% of the 5633 requests" in section3
    assert not BANNED.search(section3), "the new section must not use the language the report gate bans"


def test_the_document_says_the_two_things_it_compares_are_different_processes():
    md = screen_md()
    assert "The two measure different processes" in md and "not as a correction of the assumption" in md


def test_a_screen_built_without_the_context_is_exactly_what_it_was():
    from gridforge.intake.loader import load_document
    from gridforge.reporting.screen import build
    from gridforge.scenario.run import run_all
    intake = load_document(REFERENCE)
    results = run_all(intake.context, intake.scenarios)
    headings = [sec.heading for sec in build(intake, results).sections]
    assert headings[-1] == "5. Recommended next step" and not any("Grid wait" in h for h in headings)


def test_the_command_line_produces_the_same_section(tmp_path):
    out = subprocess.run([sys.executable, "-m", "gridforge", "screen", str(EX / "reference_hall.json"), "-o", str(tmp_path)],
                         capture_output=True, text=True, check=True, env={"GRIDFORGE_REPORT_DATE": "2026-10-27", "PATH": "/usr/bin:/bin"})
    md = (tmp_path / "density_screen.md").read_text()
    assert "## 5. Grid wait: what has been observed elsewhere (context only)" in md and "wrote" in out.stdout
    study = subprocess.run([sys.executable, "-m", "gridforge", "study", str(EX / "dublin_hall.json"), "-o", str(tmp_path)],
                           capture_output=True, text=True, check=True, env={"GRIDFORGE_REPORT_DATE": "2026-10-27", "PATH": "/usr/bin:/bin"})
    assert "Grid wait, observed elsewhere (context only)" in (tmp_path / "envelope_study.md").read_text() and study.returncode == 0


# --- the free tier carries no schedule figures ------------------------------------------------------------------------------------
# The product's paywall rule: the public tier of a screen shows no weeks, lead times, bands or relief. The queue history is schedule-like
# (months and weeks), so it is paid content too. The independent harness found the first version of this change breaking the rule.

def _leaves(node, path=""):
    if isinstance(node, dict):
        for k, v in node.items():
            yield from _leaves(v, f"{path}.{k}")
    elif isinstance(node, list):
        for v in node:
            yield from _leaves(v, f"{path}[]")
    else:
        yield path


def test_the_public_screen_carries_no_queue_context_and_no_schedule_keys():
    public = handle_screen({"intake": REFERENCE}, Tier.PUBLIC)
    assert "grid_queue_context" not in public
    assert not [p for p in _leaves(public) if re.search(r"relief|lead_time|weeks|band", p, re.I)]


def test_the_public_documents_carry_no_queue_section():
    assert "Grid wait" not in handle_screen({"intake": REFERENCE, "format": "md"}, Tier.PUBLIC)["document"]
    assert "Grid wait, observed elsewhere" not in handle_study({"intake": DUBLIN, "format": "md"}, Tier.PUBLIC)["document"]


def test_the_public_comparison_carries_no_queue_context_or_its_caveat():
    out = handle_compare({"intake": DUBLIN}, Tier.PUBLIC)
    assert "grid_queue_context" not in out and not any("grid_queue_context" in c for c in out["caveats"])


def test_the_client_tier_still_carries_all_of_it():
    assert "grid_queue_context" in handle_screen({"intake": REFERENCE}, Tier.CLIENT)
    assert "grid_queue_context" in handle_compare({"intake": DUBLIN}, Tier.CLIENT)
    assert "## 5. Grid wait" in handle_screen({"intake": REFERENCE, "format": "md"}, Tier.CLIENT)["document"]


def test_the_key_is_declared_paid_so_a_future_payload_cannot_leak_it_by_accident():
    from gridforge.api.tiers import PUBLIC_REDACTED_KEYS, redact
    assert "grid_queue_context" in PUBLIC_REDACTED_KEYS
    assert redact({"x": 1, "grid_queue_context": {"observed": {"median_weeks": 229.3}}}, Tier.PUBLIC) == {"x": 1}
