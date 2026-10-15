"""Supplier response -> validated quote line -> reviewed and accepted evidence -> a new run that uses it.

Every supplier, price and date here is a SYNTHETIC test fixture (suppliers are named SYNTHETIC-SUPPLIER-x). None is
a real quotation, and nothing here is proof of how a real supplier or provider behaves. The assertions are about the
engine's rules: what may influence a number, what is refused, and what the deliverable says about its own evidence.
"""
import copy
import json
import math
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from gridforge.api.server import ApiError, handle_screen, handle_study, handle_qualify, _invoke
from gridforge.api.tiers import Tier
from gridforge.costs import (CostEntry, active_evidence, cost_overlay, library, without_overlay)
from gridforge.intake.loader import load_document
from gridforge.procurement import ProcurementError, SupplierResponse, build_spec
from gridforge.procurement.evidence import INVALID, VALIDATED, accept, quote_lines, response_digest
from gridforge.scenario.evidence import evidence_effect
from gridforge.scenario.run import run_all
from gridforge.serialize import model_pack

ROOT = Path(__file__).resolve().parents[1]
TODAY = "2026-10-13"


@pytest.fixture(autouse=True)
def pinned_today(monkeypatch):
    monkeypatch.setenv("GRIDFORGE_REPORT_DATE", TODAY)


def doc(name="dublin_hall"):
    return json.loads((ROOT / "examples" / "intake" / f"{name}.json").read_text())


@pytest.fixture(scope="module")
def world():
    intake = load_document(doc())
    results = run_all(intake.context, intake.scenarios)
    best = max(results, key=lambda r: r.unlocked_racks)
    return intake, results, best


def pkg_for(world, constraint="transformer_capacity"):
    intake, _, best = world
    return build_spec(intake, best, constraint_id=constraint)


def response(pkg, supplier="SYNTHETIC-SUPPLIER-A", capex=None, **over):
    spec = {"project": pkg.project, "hall": pkg.hall, "constraint": pkg.constraint_id,
            "sized_for_racks": pkg.sized_for_racks}
    d = {"supplier": supplier, "received_on": "2026-10-01", "valid_until": "2026-12-31", "currency": "EUR",
         "reference": f"SYN-{supplier[-1]}",
         "values": {"capex_eur": capex if capex is not None else round(pkg.budget_eur.value),
                    "lead_time_weeks": 40, "install_weeks": 6},
         "compliance": {q.id: "C" for q in pkg.mandatory()}, "specification": spec}
    d.update(over)
    return SupplierResponse.from_dict(d)


def accepted(line, **kw):
    kw.setdefault("evidence_id", "ev-1")
    kw.setdefault("reviewer", "Test Reviewer")
    kw.setdefault("reviewed_on", TODAY)
    return accept(line, **kw)


# === 1. a response becomes a validated, attributed quote line =======================================================

def test_a_valid_response_becomes_a_validated_line_with_its_scope_quantity_unit_and_currency(world):
    pkg = pkg_for(world)
    (line,) = quote_lines(pkg, [response(pkg, capex=2_000_000)])
    assert line.status == VALIDATED and not line.problems
    assert (line.key, line.unit, line.value, line.currency) == ("transformer.replacement", "EUR", 2_000_000.0, "EUR")
    assert line.quoted_quantity == pytest.approx(23.4) and line.quoted_quantity_unit == "MVA"
    assert line.specification["constraint"] == "transformer_capacity" and line.specification["hall"] == pkg.hall
    assert (line.supplier, line.received_on, line.valid_until) == ("SYNTHETIC-SUPPLIER-A", "2026-10-01", "2026-12-31")
    assert line.comparability == "exact"


@pytest.mark.parametrize("label,over,reason", [
    ("no currency", dict(currency=""), "currency not stated"),
    ("wrong currency", dict(currency="USD"), "currency USD"),
    ("expired", dict(valid_until="2025-01-01"), "expired"),
    ("future-dated", dict(received_on="2030-01-01"), "future"),
    ("wrong hall", dict(specification={"project": "x", "hall": "OTHER-HALL", "constraint": "transformer_capacity", "sized_for_racks": 69}), "hall"),
    ("wrong sizing", dict(specification={"project": "x", "hall": "DUB-01", "constraint": "transformer_capacity", "sized_for_racks": 3}), "re-price"),
])
def test_responses_that_cannot_be_used_are_invalid_lines_with_the_reason_not_silent_drops(world, label, over, reason):
    pkg = pkg_for(world)
    d = dict(over)
    if "specification" in d:
        d["specification"] = {**d["specification"], "project": pkg.project, "hall": d["specification"]["hall"] if d["specification"]["hall"] != "DUB-01" else pkg.hall}
    (line,) = quote_lines(pkg, [response(pkg, **d)])
    assert line.status == INVALID, label
    assert any(reason in p for p in line.problems), (label, line.problems)
    with pytest.raises(ProcurementError, match="only a validated"):
        accepted(line)


@pytest.mark.parametrize("amount", [0, -5, 1e9 * 1000])
def test_invalid_totals_are_invalid_lines(world, amount):
    pkg = pkg_for(world)
    (line,) = quote_lines(pkg, [response(pkg, capex=amount)])
    assert line.status == INVALID and line.problems


@pytest.mark.parametrize("bad", ["nan", "inf"])
def test_non_finite_values_never_reach_a_line(world, bad):
    pkg = pkg_for(world)
    with pytest.raises(ProcurementError, match="finite"):
        response(pkg, capex=bad)


def test_a_price_a_thousand_times_off_the_modelled_budget_is_a_unit_slip_not_evidence(world):
    pkg = pkg_for(world)
    (line,) = quote_lines(pkg, [response(pkg, capex=round(pkg.budget_eur.value / 1000))])
    assert line.status == INVALID and any("confirm the units" in p for p in line.problems)


def test_two_responses_from_one_supplier_in_one_submission_are_both_invalid(world):
    pkg = pkg_for(world)
    lines = quote_lines(pkg, [response(pkg, capex=2_000_000), response(pkg, capex=2_100_000)])
    assert len(lines) == 2 and all(l.status == INVALID for l in lines)


def test_a_missing_price_is_invalid(world):
    pkg = pkg_for(world)
    r = response(pkg)
    r.values.pop("capex_eur")
    (line,) = quote_lines(pkg, [r])
    assert line.status == INVALID and any("not supplied" in p for p in line.problems)


def test_a_non_compliant_or_silent_bid_is_validated_but_visibly_limited(world):
    pkg = pkg_for(world)
    first = pkg.mandatory()[0].id
    (silent,) = quote_lines(pkg, [response(pkg, compliance={})])
    assert silent.status == VALIDATED and silent.comparability == "limited"
    assert any("no compliance statement" in x for x in silent.limitations)
    (non,) = quote_lines(pkg, [response(pkg, compliance={first: "N"})])
    assert non.comparability == "limited" and any("non-compliant" in x for x in non.limitations)


def test_a_line_without_a_stated_package_quantity_is_limited(world):
    pkg = pkg_for(world)
    pkg.scope_quantity = None
    (line,) = quote_lines(pkg, [response(pkg, capex=2_000_000)])
    assert line.status == VALIDATED and line.comparability == "limited" and line.quoted_quantity is None


def test_per_rack_lines_convert_a_lump_to_the_librarys_own_basis_and_lumps_stay_lumps(world):
    intake, results, best = world
    for cid, unit in (("transformer_capacity", "EUR"), ("ups_capacity", "EUR"), ("cdu_capacity", "EUR")):
        pkg = pkg_for(world, cid)
        (line,) = quote_lines(pkg, [response(pkg, capex=round(pkg.budget_eur.value))])
        assert line.unit == unit and line.value == round(pkg.budget_eur.value)
        assert line.quoted_quantity == pkg.scope_quantity


# === 2. idempotency and identity ====================================================================================

def test_the_same_response_always_yields_the_same_line_identity_whatever_its_key_order(world):
    pkg = pkg_for(world)
    a = response(pkg, capex=2_000_000)
    b = response(pkg, capex=2_000_000)
    b.values = dict(reversed(list(b.values.items())))
    assert response_digest(a) == response_digest(b)
    assert quote_lines(pkg, [a])[0].digest == quote_lines(pkg, [b])[0].digest
    assert quote_lines(pkg, [response(pkg, capex=2_000_001)])[0].digest != quote_lines(pkg, [a])[0].digest
    assert quote_lines(pkg, [response(pkg, supplier="SYNTHETIC-SUPPLIER-B", capex=2_000_000)])[0].digest != \
        quote_lines(pkg, [a])[0].digest


# === 3. acceptance is a decision, not a side effect of receipt ======================================================

def test_acceptance_preserves_the_whole_provenance(world):
    pkg = pkg_for(world)
    (line,) = quote_lines(pkg, [response(pkg, capex=2_340_000)])
    e = accepted(line, evidence_id="ev-42", basis="firm_quote", region="IE", project="SYNTHETIC-PROJECT")
    assert e.status == "accepted" and e.basis == "firm_quote"
    assert (e.supplier, e.quoted_on, e.valid_until, e.currency) == ("SYNTHETIC-SUPPLIER-A", "2026-10-01", "2026-12-31", "EUR")
    assert (e.quoted_quantity, e.quoted_quantity_unit, e.unit, e.value) == (pytest.approx(23.4), "MVA", "EUR", 2_340_000.0)
    assert (e.evidence_id, e.reviewer, e.reviewed_on, e.response_ref) == ("ev-42", "Test Reviewer", TODAY, line.response_digest)
    assert e.scope == pkg.relief_title and e.project == "SYNTHETIC-PROJECT"


def test_acceptance_needs_a_named_reviewer_and_a_quotation_basis(world):
    pkg = pkg_for(world)
    (line,) = quote_lines(pkg, [response(pkg)])
    with pytest.raises(ProcurementError, match="name of the person"):
        accept(line, evidence_id="e", reviewer="  ", reviewed_on=TODAY)
    for basis in ("library_default", "published_benchmark", "engineering_estimate"):
        with pytest.raises(ProcurementError, match="budgetary_quote, firm_quote or contracted"):
            accepted(line, basis=basis)


def test_a_reviewer_may_limit_comparability_but_never_upgrade_it(world):
    pkg = pkg_for(world)
    (clean,) = quote_lines(pkg, [response(pkg)])
    assert accepted(clean, comparability="limited").comparability == "limited"
    (silent,) = quote_lines(pkg, [response(pkg, compliance={})])
    with pytest.raises(ProcurementError, match="cannot upgrade"):
        accepted(silent, comparability="exact")
    assert accepted(silent).comparability == "limited"


# === 4. only accepted, current evidence may move a number ===========================================================

def _capex(world_ctx, entries):
    intake, _, _ = world_ctx
    with cost_overlay(entries):
        return {r.spec.id: r.economics.capex_total_eur.value for r in run_all(intake.context, intake.scenarios)}


def test_nothing_but_accepted_unexpired_evidence_influences_a_run(world):
    pkg = pkg_for(world)
    (line,) = quote_lines(pkg, [response(pkg, capex=900_000)])
    good = accepted(line)
    with without_overlay():
        base = _capex(world, [])
    for status in ("received", "validated", "rejected", "superseded", "withdrawn"):
        e = CostEntry(**{**good.__dict__, "status": status})
        with cost_overlay([e]) as rep:
            assert [i["reason"] for i in rep.ignored] == [f"status is {status}, not accepted"]
            assert rep.used == []
        assert _capex(world, [e]) == base, status
    expired = CostEntry(**{**good.__dict__, "valid_until": "2026-01-01"})
    with cost_overlay([expired]) as rep:
        assert "expired" in rep.ignored[0]["reason"]
    assert _capex(world, [expired]) == base
    assert _capex(world, [good]) != base


def test_a_non_eur_line_cannot_even_be_constructed():
    with pytest.raises(ValueError, match="not EUR"):
        CostEntry(key="transformer.replacement", label="x", unit="EUR", value=1.0, basis="firm_quote", supplier="s",
                  quoted_on="2026-10-01", currency="USD")


def test_evidence_from_a_response_must_carry_its_reviewer(world):
    with pytest.raises(ValueError, match="reviewer"):
        CostEntry(key="transformer.replacement", label="x", unit="EUR", value=1.0, basis="firm_quote",
                  evidence_id="ev", supplier="s", quoted_on="2026-10-01")


def test_two_accepted_lines_for_one_key_cannot_both_apply_the_newer_wins_and_the_other_is_reported(world):
    pkg = pkg_for(world)
    (l1,) = quote_lines(pkg, [response(pkg, capex=1_000_000)])
    (l2,) = quote_lines(pkg, [response(pkg, supplier="SYNTHETIC-SUPPLIER-B", capex=1_500_000, received_on="2026-10-10")])
    old, new = accepted(l1, evidence_id="old"), accepted(l2, evidence_id="new")
    with cost_overlay([new, old]) as rep:
        assert [e.evidence_id for e in rep.used] == ["new"]
        assert rep.ignored == [{"key": "transformer.replacement", "evidence_id": "old",
                                "reason": "superseded within this request by a more recent accepted quotation"}]


# === 5. lump vs per-unit, evidence class ============================================================================

def test_an_accepted_lump_is_the_quote_once_and_a_per_unit_line_scales_with_the_step(world):
    intake, _, _ = world
    pkg = pkg_for(world)
    (line,) = quote_lines(pkg, [response(pkg, capex=2_340_000)])
    lump = accepted(line)
    with cost_overlay([lump]):
        r = {x.spec.id: x for x in run_all(intake.context, intake.scenarios)}["full_dlc_btm"]
    tr = [s for s in r.ladder.taken_steps if s.binding_id == "transformer_capacity"]
    assert sum(s.capex_eur.value for s in tr) == pytest.approx(2_340_000)           # once, not per step
    # the two steps together are exactly the package the supplier priced: an allocation, not an extrapolation
    assert all(s.cost_kind == "quoted_allocation" and not s.limited for s in tr), [s.cost_kind for s in tr]

    per_unit = CostEntry(key="transformer.replacement", label="u", unit="EUR/MVA", value=100_000.0,
                         basis="budgetary_quote", supplier="SYNTHETIC-SUPPLIER-A", quoted_on="2026-10-01")
    with cost_overlay([per_unit]):
        r = {x.spec.id: x for x in run_all(intake.context, intake.scenarios)}["full_dlc_btm"]
    tr = [s for s in r.ladder.taken_steps if s.binding_id == "transformer_capacity"]
    assert [round(s.capex_eur.value) for s in tr] == [900_000, 1_440_000]


def test_an_accepted_quote_raises_the_evidence_class_and_a_scaled_one_is_weaker(world):
    intake, _, _ = world
    pkg = pkg_for(world)
    (line,) = quote_lines(pkg, [response(pkg, capex=2_340_000)])
    firm = accepted(line, basis="firm_quote")
    with cost_overlay([firm]):
        r = {x.spec.id: x for x in run_all(intake.context, intake.scenarios)}["full_dlc_btm"]
        assert library().weakest(["transformer.replacement"]).name == "E5_CUSTOMER_DATA"
    d = doc()
    d["transformers"][0]["unit_rating_MVA"] = 4.0                          # a hall of a different size from the one quoted
    other = load_document(d)
    with cost_overlay([firm]):
        scaled = {x.spec.id: x for x in run_all(other.context, other.scenarios)}["full_dlc_btm"]
    assert all(s.limited and s.cost_kind == "quoted_scaled"
               for s in scaled.ladder.taken_steps if s.binding_id == "transformer_capacity")
    assert any("limited comparability" in x for x in scaled.economics.limitations)
    assert not scaled.economics.decision_grade


# === 6. a new run consumes the evidence; the old run and the library are untouched ==============================

def test_the_evidence_run_is_new_the_historical_run_is_unchanged_and_the_library_is_not_rewritten(world):
    intake, results, _ = world
    pkg = pkg_for(world)
    (line,) = quote_lines(pkg, [response(pkg, capex=2_340_000)])
    keys_before = dict(library().entries)
    history = {r.spec.id: (r.economics.capex_total_eur.value, r.economics.capex_total_eur.prov.digest) for r in results}
    with cost_overlay([accepted(line)]):
        evidenced = {r.spec.id: r.economics.capex_total_eur.value for r in run_all(intake.context, intake.scenarios)}
    assert dict(library().entries) == keys_before and "transformer.replacement" not in library().entries
    assert {r.spec.id: (r.economics.capex_total_eur.value, r.economics.capex_total_eur.prov.digest) for r in results} == history
    again = run_all(intake.context, intake.scenarios)
    assert {r.spec.id: (r.economics.capex_total_eur.value, r.economics.capex_total_eur.prov.digest) for r in again} == history
    assert evidenced["full_dlc_btm"] != history["full_dlc_btm"][0]


def test_the_effect_is_independently_checkable_and_says_what_changed(world):
    intake, _, _ = world
    pkg = pkg_for(world)
    (line,) = quote_lines(pkg, [response(pkg, capex=2_340_000)])
    e = accepted(line)
    fx = evidence_effect(intake.context, intake.scenarios, [e])
    assert fx["used"] == ["ev-1"]
    row = next(x for x in fx["scenarios"] if x["scenario"] == "full_dlc_btm")
    placeholder = 1_200_000 + 1_920_000                                   # the two transformer steps, 9 and 14.4 MVA
    assert row["capex_after_eur"] - row["capex_before_eur"] == pytest.approx(2_340_000 - placeholder)
    assert row["capex_delta_eur"] == pytest.approx(row["capex_after_eur"] - row["capex_before_eur"])
    assert {c["constraint"] for c in row["steps_changed"]} == {"transformer_capacity"}
    assert all(c["basis_before"] == "library_default" and c["basis_after"] == "firm_quote" or c["basis_after"] == "budgetary_quote"
               for c in row["steps_changed"])
    assert row["racks_before"] == row["racks_after"]                      # cost evidence never moves the physics
    assert row["placeholder_lines_after"] < row["placeholder_lines_before"]


def test_overlays_are_isolated_between_concurrent_runs(world):
    intake, _, _ = world
    pkg = pkg_for(world)
    (line,) = quote_lines(pkg, [response(pkg, capex=2_340_000)])
    e = accepted(line)
    out, barrier = {}, threading.Barrier(2)

    def worker(name, entries):
        barrier.wait()
        for _ in range(3):
            if entries:
                with cost_overlay(entries):
                    out[name] = {r.spec.id: r.economics.capex_total_eur.value for r in run_all(intake.context, intake.scenarios)}
            else:
                out[name] = {r.spec.id: r.economics.capex_total_eur.value for r in run_all(intake.context, intake.scenarios)}

    ts = [threading.Thread(target=worker, args=("with", [e])), threading.Thread(target=worker, args=("without", []))]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert out["with"]["full_dlc_btm"] != out["without"]["full_dlc_btm"]
    assert out["without"] == {r.spec.id: r.economics.capex_total_eur.value for r in run_all(intake.context, intake.scenarios)}


# === 7. the API, the reports and the model pack tell the same story ===============================================

def _evidence_payload(world):
    pkg = pkg_for(world)
    (line,) = quote_lines(pkg, [response(pkg, capex=2_340_000)])
    e = accepted(line, evidence_id="ev-api-1")
    return [e.__dict__ | {"includes_keys": list(e.includes_keys)}]


def test_the_study_api_applies_names_and_explains_the_evidence(world):
    ev = _evidence_payload(world)
    out = call_study({"intake": doc(), "cost_evidence": ev})
    block = out["cost_evidence"]
    assert [u["evidence_id"] for u in block["used"]] == ["ev-api-1"] and block["ignored"] == []
    assert block["used"][0]["reviewer"] == "Test Reviewer" and block["used"][0]["supplier"] == "SYNTHETIC-SUPPLIER-A"
    row = next(x for x in block["effect"]["scenarios"] if x["scenario"] == "full_dlc_btm")
    assert row["capex_delta_eur"] < 0
    # the same evidence is in the model pack the deliverable carries
    sc = next(s for s in out["scenarios"] if s["id"] == "full_dlc_btm")
    assert sc["economics"]["capex_total_eur"]["value"] > 0
    assert any(s["cost_basis"] == "firm_quote" or s["cost_basis"] == "budgetary_quote" for s in sc["ladder"] if s["taken"])


def test_the_rendered_study_names_the_evidence_and_what_it_changed(world):
    ev = _evidence_payload(world)
    out = call_study({"intake": doc(), "cost_evidence": ev, "format": "md"})
    md = out["document"] if "document" in out else out.get("markdown") or json.dumps(out)
    assert "Accepted supplier evidence used in this run" in md
    assert "SYNTHETIC-SUPPLIER-A" in md and "Test Reviewer" in md and "23.4 MVA" in md
    assert "What the accepted evidence changed" in md


def test_a_run_without_evidence_says_so_explicitly_in_the_model_pack(world):
    intake, results, _ = world
    assert model_pack(intake, results)["cost_evidence"] == {"used": [], "ignored": [], "effect": None}


def test_the_model_pack_of_an_evidence_run_lists_what_it_used(world):
    intake, _, _ = world
    pkg = pkg_for(world)
    (line,) = quote_lines(pkg, [response(pkg, capex=2_340_000)])
    e = accepted(line)
    with cost_overlay([e]):
        pack = model_pack(intake, run_all(intake.context, intake.scenarios))
    assert [u["evidence_id"] for u in pack["cost_evidence"]["used"]] == ["ev-1"]


def test_unreviewed_evidence_sent_to_the_api_is_named_and_ignored(world):
    ev = _evidence_payload(world)
    ev[0]["status"] = "validated"
    out = _invoke("/v1/screen", handle_screen, {"intake": doc(), "cost_evidence": ev}, Tier.CLIENT)
    assert out["cost_evidence"]["used"] == []
    assert "not accepted" in out["cost_evidence"]["ignored"][0]["reason"]
    row = next(x for x in out["cost_evidence"]["effect"]["scenarios"] if x["scenario"] == "full_dlc_btm")
    assert row["capex_delta_eur"] == 0


def test_the_api_refuses_malformed_evidence_and_routes_that_do_not_take_it(world):
    with pytest.raises(ApiError, match=r"cost_evidence\[0\]"):
        handle_study_wrapped({"intake": doc(), "cost_evidence": [{"key": "x"}]})
    with pytest.raises(ApiError, match="does not take"):
        _invoke("/v1/portfolio", lambda b, t: {}, {"cost_evidence": []}, Tier.CLIENT)
    with pytest.raises(ApiError, match="at most"):
        handle_study_wrapped({"intake": doc(), "cost_evidence": [{}] * 500})
    with pytest.raises(ApiError, match="does not take"):
        _invoke("/v1/qualify", handle_qualify, {"cost_evidence": []}, Tier.PUBLIC)


def handle_study_wrapped(body):
    return _invoke("/v1/study", handle_study, body, Tier.CLIENT)


def call_study(body):
    return _invoke("/v1/study", handle_study, body, Tier.CLIENT)


def test_the_cli_applies_evidence_to_one_run_and_names_what_it_ignored(world, tmp_path):
    ev = _evidence_payload(world)
    rejected = dict(ev[0], status="rejected", evidence_id="ev-rej")
    f = tmp_path / "evidence.json"
    f.write_text(json.dumps(ev + [rejected]))
    out = tmp_path / "o"
    r = subprocess.run([sys.executable, "-m", "gridforge", "study", str(ROOT / "examples/intake/dublin_hall.json"), "-o", str(out),
                        "--cost-evidence", str(f)], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0, r.stderr
    assert "1 accepted line(s) used, 1 ignored" in r.stdout and "status is rejected" in r.stdout
    pack = json.loads((out / "model_pack.json").read_text())
    assert [u["evidence_id"] for u in pack["cost_evidence"]["used"]] == ["ev-api-1"]
    bad = tmp_path / "bad.json"
    bad.write_text("{not json")
    r = subprocess.run([sys.executable, "-m", "gridforge", "study", str(ROOT / "examples/intake/dublin_hall.json"), "-o", str(out),
                        "--cost-evidence", str(bad)], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 2 and "unusable" in r.stderr


# === 8. confidentiality ===========================================================================================

def test_no_synthetic_or_private_evidence_is_in_any_public_artefact():
    for f in (ROOT / "public").rglob("*"):
        if f.is_file() and f.suffix in (".json", ".md", ".html", ".csv", ".txt"):
            text = f.read_text(errors="ignore")
            assert "SYNTHETIC-SUPPLIER" not in text and "ev-api-1" not in text, f
    pack = json.loads((ROOT / "public" / "reference" / "model_pack.json").read_text())
    assert pack["cost_evidence"] == {"used": [], "ignored": [], "effect": None}


def test_the_public_qualifier_neither_accepts_nor_echoes_evidence(world):
    with pytest.raises(ApiError):
        _invoke("/v1/qualify", handle_qualify, {"cost_evidence": _evidence_payload(world)}, Tier.PUBLIC)


# === 9. synthetic evidence is never mistaken for a quotation ======================================================

def test_synthetic_evidence_is_labelled_everywhere_and_is_never_decision_grade(world):
    intake, _, _ = world
    pkg = pkg_for(world)
    (line,) = quote_lines(pkg, [response(pkg, capex=2_340_000)])
    e = CostEntry(**{**accepted(line).__dict__, "synthetic": True})
    with cost_overlay([e]) as rep:
        assert rep.to_dict()["used"][0]["synthetic"] is True
        r = {x.spec.id: x for x in run_all(intake.context, intake.scenarios)}["full_dlc_btm"]
    assert any("synthetic cost evidence" in x for x in r.economics.limitations) and not r.economics.decision_grade
    out = call_study({"intake": doc(), "cost_evidence": [e.__dict__ | {"includes_keys": []}], "format": "md"})
    md = out["document"] if "document" in out else json.dumps(out)
    assert "SYNTHETIC COST EVIDENCE" in md


def test_the_bids_endpoint_in_evidence_mode_returns_json_safe_lines_and_ranks_nothing(world):
    from gridforge.api.server import handle_bids
    pkg = pkg_for(world)
    good = response(pkg).__dict__ | {}
    bad = dict(good, supplier="SYNTHETIC-SUPPLIER-B", currency="USD", values={"capex_eur": None})
    out = handle_bids({"intake": doc(), "constraint": "transformer_capacity", "evidence_only": True,
                       "responses": [good, bad]}, Tier.PUBLIC)
    assert "ranked" not in out and out["scope_quantity_unit"]
    by = {l["supplier"]: l for l in out["lines"]}
    assert by["SYNTHETIC-SUPPLIER-A"]["status"] == "validated" and by["SYNTHETIC-SUPPLIER-B"]["status"] == "invalid"
    json.dumps(out, allow_nan=False)            # an unreadable amount is null, never NaN
    assert by["SYNTHETIC-SUPPLIER-B"]["value"] is None and by["SYNTHETIC-SUPPLIER-B"]["submitted_value"] is None
