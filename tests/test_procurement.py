"""The procurement specification, and the flywheel underneath it.

Two claims are being sold here, and each one fails in a specific, expensive way:

  1. "Every requirement is derived from a limit in your hall." If a numeric
     requirement can appear with no constraint behind it, the document is a
     consultancy's wish list with a traceability story bolted on.
  2. "A returned bid makes the next study stronger." If the ingest puts a lump-sum
     price into a per-rack library line, the error is off by the rack count, it
     carries a QUOTATION's evidence class, and every future study inherits it with
     a straight face. That is worse than having no flywheel at all.

The second is the one tested hardest.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

from gridforge.costs import COST_EVIDENCE, declared_unit
from gridforge.intake.loader import load
from gridforge.procurement import (ProcurementError, SupplierResponse, build_spec,
                                   cost_entries_from, rank_bids, relief_steps)
from gridforge.procurement.evaluate import assess, schedule_impact
from gridforge.procurement.ingest import command_lines
from gridforge.procurement.schema import MANDATORY, EvaluationCriterion, SpecPackage
from gridforge.reporting import to_markdown
from gridforge.reporting.gates import ReportMode, run_all_gates
from gridforge.reporting.spec import build as build_spec_report
from gridforge.reporting.study import collect_claims
from gridforge.scenario.run import run_all

ROOT = Path(__file__).resolve().parents[1]
INTAKE = ROOT / "examples" / "intake" / "reference_hall.json"


@pytest.fixture(scope="module")
def solved():
    intake = load(INTAKE)
    results = run_all(intake.context, intake.scenarios)
    best = max(results, key=lambda r: r.unlocked_racks)
    return intake, results, best


def spec_for(solved, constraint_id):
    intake, _, best = solved
    return build_spec(intake, best, constraint_id=constraint_id)


def bid(supplier, capex, lead, install=4, pkg=None, non_compliant=None):
    compliance = {}
    if pkg:
        compliance = {q.id: "C" for q in pkg.mandatory()}
        if non_compliant:
            compliance[non_compliant] = "N"
    return SupplierResponse.from_dict({
        "supplier": supplier, "received_on": "2026-10-01", "valid_until": "2026-12-31",
        "values": {"capex_eur": capex, "lead_time_weeks": lead, "install_weeks": install},
        "compliance": compliance,
    })


# --- traceability ----------------------------------------------------------

def test_every_numeric_requirement_names_a_constraint(solved):
    """The claim the whole product rests on. A number nobody can trace is a number
    somebody invented, and those are how a tender specifies equipment the hall does
    not need."""
    intake, _, best = solved
    for step in relief_steps(best):
        pkg = build_spec(intake, best, constraint_id=step.binding_id)
        for q in pkg.requirements:
            if q.value is not None and q.obligation == MANDATORY:
                assert q.derived_from, f"{pkg.constraint_id}/{q.id} has no constraint behind it"


def test_a_specification_with_an_untraceable_requirement_is_refused():
    from gridforge.procurement.schema import Requirement
    from gridforge.validation import EvidenceClass, Quantity
    pkg = SpecPackage(project="P", hall="H", relief_title="R", constraint_id="c",
                      constraint_name="C", racks_before=0, racks_after=1)
    pkg.requirements = [Requirement(
        id="X-1", clause="Invented", statement="Shall be 400 A.",
        value=Quantity.given(400, "A", "invented", EvidenceClass.E0_ASSUMPTION))]
    with pytest.raises(ProcurementError, match="invented"):
        pkg.validate()


def test_evaluation_weights_must_total_one_hundred(solved):
    pkg = spec_for(solved, "busway_ampacity")
    assert sum(c.weight for c in pkg.criteria) == 100
    pkg.criteria = list(pkg.criteria) + [EvaluationCriterion("C9", "Extra", 5, "x")]
    with pytest.raises(ProcurementError, match="total 105"):
        pkg.validate()


def test_every_constraint_with_a_purchasable_relief_produces_a_specification(solved):
    intake, _, best = solved
    ids = sorted({s.binding_id for s in relief_steps(best)})
    assert len(ids) >= 5
    for cid in ids:
        pkg = build_spec(intake, best, constraint_id=cid)
        pkg.validate()
        assert pkg.requirements
        assert pkg.mandatory()


def test_an_unknown_constraint_says_what_is_available(solved):
    intake, _, best = solved
    with pytest.raises(ProcurementError, match="Available"):
        build_spec(intake, best, constraint_id="not_a_constraint")


# --- sizing ----------------------------------------------------------------

def test_duties_are_sized_for_the_end_state_not_the_rung(solved):
    """A rung often unlocks three racks. Nobody buys a transformer for three racks,
    and a specification that asks them to is traceable and absurd."""
    intake, _, best = solved
    for step in relief_steps(best):
        pkg = build_spec(intake, best, constraint_id=step.binding_id)
        assert pkg.sized_for_racks >= best.unlocked_racks
        assert pkg.sized_for_racks > step.racks_unlocked or step.racks_unlocked == 0
        assert pkg.sized_for_kW > 0


def test_the_duty_figures_are_physically_sensible(solved):
    """A spot check with real arithmetic behind it: a transformer for N racks must
    be larger than the raw IT load and smaller than ten times it."""
    intake, _, best = solved
    pkg = spec_for(solved, "transformer_capacity")
    it_mw = intake.context.cluster.platform.rack_kW.value * pkg.sized_for_racks / 1000.0
    rating = next(q for q in pkg.requirements if q.id == "E-20")
    assert rating.value is not None
    assert it_mw < rating.value.value < it_mw * 3, (
        f"{rating.value.value} MVA for {it_mw:.1f} MW of IT load is not a credible rating")


def test_the_cdu_duty_is_quoted_at_site_water_temperature(solved):
    """The commonest way a liquid retrofit under-delivers is a CDU rated at a 5 K
    approach installed on a site with a far wider one. The specification has to say
    so where a supplier cannot miss it."""
    pkg = spec_for(solved, "cdu_capacity")
    duty = next(q for q in pkg.requirements if q.id == "T-01")
    assert "SITE FACILITY WATER TEMPERATURE" in duty.statement
    conditions = next(q for q in pkg.requirements if q.id == "T-02")
    assert conditions.value is not None


# --- the document ----------------------------------------------------------

def test_the_specification_passes_the_report_gates(solved):
    _, results, _ = solved
    pkg = spec_for(solved, "busway_ampacity")
    report = build_spec_report(pkg, claims=collect_claims(results))
    md = to_markdown(report)
    run_all_gates(report, md, claims=collect_claims(results), mode=ReportMode.SCREENING)


def test_the_document_warns_against_raising_a_purchase_order_on_it(solved):
    """These duties are good enough to get comparable quotations. They are not good
    enough to commit capital against without site measurement, and a document that
    does not say so will eventually be used as though they were."""
    _, results, _ = solved
    pkg = spec_for(solved, "transformer_capacity")
    md = to_markdown(build_spec_report(pkg, claims=collect_claims(results))).lower()
    assert "not sufficient on their own to raise a purchase order" in md
    assert "confirm the governing figures against site measurement" in md


def test_the_document_names_no_make_or_model(solved):
    _, results, _ = solved
    for cid in ("cdu_capacity", "transformer_capacity", "ups_capacity"):
        pkg = spec_for(solved, cid)
        md = to_markdown(build_spec_report(pkg, claims=collect_claims(results))).lower()
        assert "take no margin on hardware" in md
        for brand in ("vertiv", "schneider", "eaton", "abb", "siemens", "motivair"):
            assert brand not in md, f"{cid}: the specification named {brand}"


# --- bid evaluation --------------------------------------------------------

def test_a_non_compliant_bid_never_outranks_a_compliant_one(solved):
    """Whatever its price. That ordering is the entire point of a 'shall'."""
    pkg = spec_for(solved, "busway_ampacity")
    first = pkg.mandatory()[0].id
    ranked = rank_bids(pkg, [
        bid("Cheap", 200_000, 10, pkg=pkg, non_compliant=first),
        bid("Proper", 600_000, 40, pkg=pkg),
    ])
    assert ranked[0].supplier == "Proper"
    assert ranked[1].mandatory_failed == [first]


def test_a_cheaper_slower_bid_is_visible_as_the_expensive_one(solved):
    pkg = spec_for(solved, "busway_ampacity")
    ranked = rank_bids(pkg, [bid("Fast", 500_000, 12, pkg=pkg),
                             bid("Slow", 400_000, 48, pkg=pkg)])
    fast = next(a for a in ranked if a.supplier == "Fast")
    slow = next(a for a in ranked if a.supplier == "Slow")
    assert fast.scores["C2"] > slow.scores["C2"]
    assert fast.total_score > slow.total_score, (
        "a bid 36 weeks slower and 20% cheaper scored higher — the weighting is wrong")


def test_an_incomplete_response_is_not_evaluated(solved):
    pkg = spec_for(solved, "busway_ampacity")
    blank = SupplierResponse.from_dict({
        "supplier": "Vague", "received_on": "2026-10-01",
        "values": {"capex_eur": 100_000}})       # no lead time
    a = assess(pkg, [blank])[0]
    assert a.disqualified
    assert "left blank" in " ".join(a.notes)


def test_the_unscored_points_are_declared_rather_than_invented(solved):
    """Installation method and evidence quality need judgement. Filling those columns
    with a computed number would be the tool pretending to have made a judgement."""
    pkg = spec_for(solved, "busway_ampacity")
    a = assess(pkg, [bid("Alpha", 400_000, 20, pkg=pkg)])[0]
    assert a.scores["C4"] == 0.0 and a.scores["C5"] == 0.0
    assert a.total_score <= 85
    assert any("scored by the engineer" in n for n in a.notes)


def test_schedule_impact_is_stated_against_the_model(solved):
    pkg = spec_for(solved, "busway_ampacity")
    late = assess(pkg, [bid("Late", 400_000, 90, pkg=pkg)])[0]
    assert "later than the modelled" in schedule_impact(pkg, late)
    assert "whole envelope moves with it" in schedule_impact(pkg, late)


def test_per_rack_price_uses_what_the_bid_was_sized_for(solved):
    pkg = spec_for(solved, "busway_ampacity")
    a = assess(pkg, [bid("Alpha", 620_000, 20, pkg=pkg)])[0]
    assert a.eur_per_rack == pytest.approx(620_000 / pkg.sized_for_racks)


def test_a_response_with_a_non_numeric_value_names_the_field():
    with pytest.raises(ProcurementError, match="lead_time_weeks"):
        SupplierResponse.from_dict({
            "supplier": "X", "received_on": "2026-01-01",
            "values": {"lead_time_weeks": "about 20 weeks"}})


def test_an_undated_response_is_refused():
    """An undated price cannot become a dated cost-library entry, and a cost library
    of undated prices is a list of numbers."""
    with pytest.raises(ProcurementError, match="date"):
        SupplierResponse.from_dict({"supplier": "X", "values": {"capex_eur": 1}})


# --- the flywheel ----------------------------------------------------------

def test_a_lump_sum_bid_converts_onto_the_librarys_own_basis(solved):
    """The failure that would do real damage. tapoff.unit is held per rack,
    ups.per_kW per kW and busway.replacement as a lump sum. A supplier quotes one
    number for the job; entering it on the wrong basis is off by the rack count,
    carries a quotation's evidence class, and poisons every future study."""
    intake, _, best = solved
    price = 620_000.0
    cases = {
        "rack_feed_tapoff": "EUR/rack",
        "ups_capacity": "EUR/kW",
        "busway_ampacity": "EUR",
        "cdu_capacity": "EUR",
    }
    for cid, expected_unit in cases.items():
        pkg = build_spec(intake, best, constraint_id=cid)
        entry = cost_entries_from(pkg, bid("Alpha", price, 20, pkg=pkg))[0]
        assert entry["unit"] == expected_unit, f"{cid}: {entry['unit']}"
        assert entry["unit"] == declared_unit(entry["key"], entry["unit"])
        if expected_unit == "EUR/rack":
            assert entry["value"] == pytest.approx(price / pkg.sized_for_racks, rel=1e-3)
        elif expected_unit == "EUR/kW":
            assert entry["value"] == pytest.approx(price / pkg.sized_for_kW, rel=1e-3)
        else:
            assert entry["value"] == pytest.approx(price)


def test_the_ingest_raises_the_evidence_class(solved):
    """This is what the engagement pays for twice. A library default is E0 with a
    -50%/+100% band; a returned firm quotation is E5."""
    pkg = spec_for(solved, "busway_ampacity")
    default = COST_EVIDENCE["library_default"]
    for basis in ("budgetary_quote", "firm_quote", "contracted"):
        entry = cost_entries_from(pkg, bid("Alpha", 400_000, 20, pkg=pkg), basis=basis)[0]
        assert COST_EVIDENCE[entry["basis"]] > default


def test_a_benchmark_basis_is_refused_for_a_supplier_response(solved):
    pkg = spec_for(solved, "busway_ampacity")
    for basis in ("library_default", "published_benchmark"):
        with pytest.raises(ProcurementError, match="quotation, not a benchmark"):
            cost_entries_from(pkg, bid("Alpha", 1, 1, pkg=pkg), basis=basis)


def test_the_entry_carries_who_quoted_it_and_when(solved):
    pkg = spec_for(solved, "busway_ampacity")
    e = cost_entries_from(pkg, bid("Alpha", 400_000, 20, pkg=pkg), region="DE")[0]
    assert e["supplier"] == "Alpha"
    assert e["quoted_on"] == "2026-10-01"
    assert e["valid_until"] == "2026-12-31"
    assert e["region"] == "DE"
    assert pkg.constraint_name in e["note"]


def test_the_commands_are_printed_for_review_not_run(solved):
    """A price that enters the library unreviewed is one nobody can defend when a
    client asks where it came from."""
    pkg = spec_for(solved, "busway_ampacity")
    lines = command_lines(cost_entries_from(pkg, bid("Alpha", 400_000, 20, pkg=pkg)))
    assert lines and all(l.startswith("python3 -m gridforge cost add") for l in lines)
    assert "--supplier 'Alpha'" in lines[0]
    assert "--quoted-on 2026-10-01" in lines[0]


# --- the command line ------------------------------------------------------

def run_cli(*args):
    r = subprocess.run([sys.executable, "-m", "gridforge", *args], cwd=ROOT,
                       capture_output=True, text=True)
    assert "Traceback" not in r.stderr, r.stderr
    return r


def test_spec_lists_what_can_be_tendered():
    r = run_cli("spec", str(INTAKE), "--list")
    assert r.returncode == 0, r.stderr
    assert "busway_ampacity" in r.stdout
    assert "--constraint" in r.stdout


def test_spec_writes_a_document_and_a_response_template(tmp_path):
    out = tmp_path / "spec"
    r = run_cli("spec", str(INTAKE), "--constraint", "cdu_capacity", "-o", str(out))
    assert r.returncode == 0, r.stderr
    assert (out / "specification.md").exists()
    assert (out / "specification.html").exists()
    t = json.loads((out / "response_template.json").read_text())
    assert t["values"]["capex_eur"] is None
    assert t["compliance"], "the template must list the mandatory requirements"
    assert t["specification"]["sized_for_racks"] > 0


def test_bids_reads_back_the_template_it_wrote(tmp_path):
    """The round trip is the product. If the template this tool writes cannot be
    read by the tool that reads templates, the engagement does not work."""
    out = tmp_path / "spec"
    assert run_cli("spec", str(INTAKE), "--constraint", "busway_ampacity",
                   "-o", str(out)).returncode == 0
    template = json.loads((out / "response_template.json").read_text())
    paths = []
    for name, capex, lead in [("Alpha", 480_000, 20), ("Beta", 392_000, 44)]:
        d = json.loads(json.dumps(template))
        d.update(supplier=name, received_on="2026-10-01", valid_until="2026-12-31")
        d["values"].update(capex_eur=capex, lead_time_weeks=lead, install_weeks=6)
        d["compliance"] = {k: "C" for k in d["compliance"]}
        p = out / f"{name}.json"
        p.write_text(json.dumps(d))
        paths.append(str(p))
    r = run_cli("bids", str(INTAKE), *paths, "--constraint", "busway_ampacity",
                "--ingest", "--basis", "firm_quote")
    assert r.returncode == 0, r.stderr
    assert "Alpha" in r.stdout and "Beta" in r.stdout
    assert "cost add" in r.stdout
    assert "--basis firm_quote" in r.stdout
    assert "Review before you run it" in r.stdout


def test_bids_refuses_a_missing_file(tmp_path):
    r = run_cli("bids", str(INTAKE), str(tmp_path / "nope.json"))
    assert r.returncode == 2
    assert "no such response file" in r.stderr
