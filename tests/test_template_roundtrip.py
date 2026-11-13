"""The engine's own template can be posted back, and the policy for a top-level key the engine does not read (review E1).

`GET /v1/intake/template` carries a top-level `schema_version` (the API adds it to every object it sends). Filling the template in and posting it
unchanged, bare or as {"intake": ...}, to /v1/screen, /v1/compare and /v1/study was refused ("schema_version is not a section of the intake"), and so
was a template saved from the API and handed to the command line. The policy for a top-level key that is not a section of the intake:

  (a) `schema_version` and `$schema` are the document's envelope: accepted and ignored without a word;
  (b) a key starting with `_` or `$`, and the metadata keys `notes`, `note`, `comment`, `comments`, `metadata`, `meta`, `title`, `description` and `name`,
      are ignored with a named warning ("<key> is not read by the engine");
  (c) any other key that is a near miss of a section or request option (one letter off, a case slip, two adjacent letters swapped, a close difflib
      match) is REFUSED with the did-you-mean: a silently ignored misspelt section is the defect (`gird` dropped the whole grid section);
  (d) any other key, far from every section, is ignored with the same named warning, never refused.
"""
from __future__ import annotations

import copy
import json
import os
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from gridforge.api import server as S
from gridforge.cli import main as cli_main
from gridforge.intake.loader import IntakeError, load_document
from gridforge.scenario.run import run_all

ROOT = Path(__file__).resolve().parents[1]
KEY = "sk_template_roundtrip"


def example(name: str = "dublin_hall") -> dict:
    return json.loads((ROOT / "examples" / "intake" / f"{name}.json").read_text())


DUBLIN = example()


@pytest.fixture(scope="module")
def base():
    os.environ["GRIDFORGE_API_KEYS"] = f"{KEY}::500"
    S.Handler.limiter.per_minute = 0
    httpd = S.make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    os.environ.pop("GRIDFORGE_API_KEYS", None)


def _request(base: str, path: str, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(base + path, data=data, method="GET" if body is None else "POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("X-API-Key", KEY)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


def filled(template: dict) -> dict:
    """The template as the engine sent it (every key, `schema_version` included), with the sections a customer fills in set to a real hall."""
    out = copy.deepcopy(template)
    for section, value in DUBLIN.items():
        out[section] = copy.deepcopy(value)
    return out


def refusal(d: dict) -> str:
    with pytest.raises(IntakeError) as exc:
        load_document(d)
    return str(exc.value)


def racks_by_scenario(d: dict) -> dict:
    i = load_document(copy.deepcopy(d))
    return {r.spec.id: r.ladder.final.max_racks for r in run_all(i.context, i.scenarios)}


# -------------------------------------------------------------------------------------------------------- the round trip
def test_the_template_the_engine_sends_carries_schema_version(base):
    status, template = _request(base, "/v1/intake/template")
    assert status == 200 and template["schema_version"] == "gridforge/api/1"          # the premise of the defect: the key is really there


#: /v1/compare takes the intake only inside {"intake": ...} (it never took a bare body); /v1/screen and /v1/study take either.
@pytest.mark.parametrize("route,wrapped", [("/v1/screen", False), ("/v1/screen", True), ("/v1/study", False), ("/v1/study", True), ("/v1/compare", True)],
                         ids=lambda v: str(v))
def test_a_filled_template_is_accepted_unchanged_bare_or_wrapped(base, route, wrapped):
    status, template = _request(base, "/v1/intake/template")
    assert status == 200
    doc = filled(template)
    assert "schema_version" in doc
    body = {"intake": doc} if wrapped else doc
    status, out = _request(base, route, body)
    assert status == 200, out
    assert "schema_version is not a section" not in json.dumps(out)


def test_the_round_trip_answer_is_the_answer_for_the_same_hall_without_the_envelope(base):
    """The envelope key changes nothing: the template route and the plain document give the same racks."""
    _, template = _request(base, "/v1/intake/template")
    with_envelope = filled(template)
    plain = copy.deepcopy(DUBLIN)
    assert racks_by_scenario(with_envelope) == racks_by_scenario(plain)
    _, screened = _request(base, "/v1/screen", {"intake": with_envelope})
    _, screened_plain = _request(base, "/v1/screen", {"intake": plain})
    assert [(s["id"], s["after_ladder"]["racks"]) for s in screened["scenarios"]] == [(s["id"], s["after_ladder"]["racks"]) for s in screened_plain["scenarios"]]
    assert not any("schema_version" in w for w in screened["intake"]["warnings"])        # silent: it is the envelope, not an unread key


def test_a_template_saved_from_the_api_is_read_by_the_command_line(base, tmp_path, capsys):
    status, template = _request(base, "/v1/intake/template")
    assert status == 200
    saved = tmp_path / "from_api.json"
    saved.write_text(json.dumps(filled(template), indent=2))
    assert cli_main(["screen", str(saved), "-o", str(tmp_path / "out")]) == 0
    assert (tmp_path / "out").exists()
    capsys.readouterr()
    assert cli_main(["gaps", str(saved)]) == 0


def test_the_blank_template_itself_is_still_refused_as_a_hall_nobody_described(base):
    """Accepting the envelope is not accepting emptiness: the unfilled template carries no figure, and a solve of it is refused as before."""
    _, template = _request(base, "/v1/intake/template")
    status, out = _request(base, "/v1/screen", {"intake": template})
    assert status == 422 and "none of the intake fields" in out["error"]


# -------------------------------------------------------------------------------------------------------- (a) the envelope
@pytest.mark.parametrize("key,value", [("schema_version", "gridforge/api/1"), ("$schema", "https://example.org/gridforge-intake.schema.json"),
                                       ("schema_version", 7), ("$schema", None)])
def test_a_the_envelope_keys_are_accepted_and_ignored_without_a_word(key, value):
    intake = load_document({**copy.deepcopy(DUBLIN), key: value})
    assert not any(key in w for w in intake.report.warnings)
    assert racks_by_scenario({**copy.deepcopy(DUBLIN), key: value}) == racks_by_scenario(DUBLIN)


# -------------------------------------------------------------------------------------------------------- (b) metadata
@pytest.mark.parametrize("key", ["notes", "note", "comment", "comments", "metadata", "meta", "title", "description", "name",
                                 "_private", "_", "_generated_by", "$comment", "$id"])
def test_b_metadata_keys_are_ignored_with_a_named_warning(key):
    intake = load_document({**copy.deepcopy(DUBLIN), key: "for the next reader"})
    assert any(w.startswith(f"{key} is not read by the engine") for w in intake.report.warnings), intake.report.warnings
    assert racks_by_scenario({**copy.deepcopy(DUBLIN), key: "for the next reader"}) == racks_by_scenario(DUBLIN)


def test_b_metadata_may_be_any_json_value():
    d = {**copy.deepcopy(DUBLIN), "metadata": {"tool": "x", "n": [1, 2]}, "comments": ["a", "b"], "title": None}
    assert {w.split(" ")[0] for w in load_document(d).report.warnings if "is not read by the engine" in w} == {"metadata", "comments", "title"}


# -------------------------------------------------------------------------------------------------------- (c) near misses
@pytest.mark.parametrize("typo,section", [("gird", "grid"), ("Grid", "grid"), ("GRID", "grid"), ("grd", "grid"), ("gridd", "grid"), ("halls", "hall"),
                                          ("hal", "hall"), ("thermall", "thermal"), ("thermals", "thermal"), ("transformer", "transformers"),
                                          ("up", "ups"), ("scenerios", "scenarios"), ("scenario", None), ("economic", "economics"),
                                          ("btm_option", "btm_options"), ("compte", "compute"), ("sitee", "site"), ("proect", "project"),
                                          ("objectve", "objective"), ("formt", "format")])
def test_c_a_near_miss_of_a_section_or_option_is_refused_with_the_did_you_mean(typo, section):
    if section is None:
        # `scenario` is a request option (/v1/spec takes it): a REAL key, so it loads
        load_document({**copy.deepcopy(DUBLIN), typo: "full_dlc"})
        return
    d = copy.deepcopy(DUBLIN)
    d[typo] = d.pop(section) if section in d else {"x": 1}
    text = refusal(d)
    assert text.startswith(f"{typo} is not a section of the intake"), text
    assert f"Did you mean `{section}`?" in text, text
    assert "refused rather than ignored" in text


def test_c_the_adjacent_letter_swap_is_a_near_miss():
    d = copy.deepcopy(DUBLIN)
    d["gird"] = d.pop("grid")
    assert "Did you mean `grid`?" in refusal(d)


def test_c_two_misspelt_sections_are_both_named():
    d = copy.deepcopy(DUBLIN)
    d["gird"], d["hal"] = d.pop("grid"), d.pop("hall")
    text = refusal(d)
    assert text.startswith("gird is not a section") and "'hal'" in text


def test_c_a_misspelling_is_refused_even_beside_ignorable_keys_and_the_envelope():
    d = {**copy.deepcopy(DUBLIN), "schema_version": "gridforge/api/1", "notes": "x", "extra": 1}
    d["gird"] = d.pop("grid")
    assert refusal(d).startswith("gird is not a section")


# -------------------------------------------------------------------------------------------------------- (d) far keys
@pytest.mark.parametrize("key", ["contracted_MW", "site_name", "extra", "zzz", "my_internal_id", "customer_po_number", "x"])
def test_d_a_key_far_from_every_section_is_ignored_with_a_named_warning_never_refused(key):
    d = {**copy.deepcopy(DUBLIN), key: 12}
    intake = load_document(d)
    assert any(w.startswith(f"{key} is not read by the engine") for w in intake.report.warnings), intake.report.warnings
    assert racks_by_scenario(d) == racks_by_scenario(DUBLIN)


def test_d_the_warning_says_what_to_do():
    w = next(w for w in load_document({**copy.deepcopy(DUBLIN), "customer_po": 1}).report.warnings if w.startswith("customer_po"))
    assert "ignored and changes no result" in w and "sections" in w and "send it under that name" in w


def test_d_a_body_of_only_unread_keys_is_still_the_api_refusal_for_giving_no_intake_field_and_names_them(base):
    """The qualifier's short form sent to an intake route: nothing to solve (as it always was), and the keys sent are named."""
    status, out = _request(base, "/v1/screen", {"contracted_MW": 12, "site_name": "x", "current_site_peak_MW": 7.4})
    assert status == 422 and "none of the intake fields, so there is nothing to solve" in out["error"]
    assert "contracted_MW" in out["error"] and "POST /v1/qualify" in out["error"]


# -------------------------------------------------------------------------------------------------------- the sync pins stay
def test_every_request_option_a_route_reads_is_still_a_known_top_level_key():
    """The pin on REQUEST_OPTION_KEYS (tests/test_intake_audit_fixes.py) holds under the new policy: an option is a section-like key, not an ignored one."""
    from gridforge.intake.loader import REQUEST_OPTION_KEYS, TOP_LEVEL_KEYS, ignored_top_level_keys
    assert REQUEST_OPTION_KEYS <= TOP_LEVEL_KEYS
    assert ignored_top_level_keys({k: 1 for k in REQUEST_OPTION_KEYS}) == []
