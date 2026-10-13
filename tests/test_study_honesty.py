"""The Capacity & Density Envelope Study is an engineering opinion a buyer will use to decide tens of millions of
euros. Its prose and labels must not claim more than the model knows, and must not contradict the solver.

Every assertion here was found as a defect by reading the generated Dublin study as a skeptical buyer, and was
verified against the solver before the generator was changed."""
import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

from gridforge.envelope.solver import ladder, solve
from gridforge.intake.loader import load_document
from gridforge.reporting.labels import rack_class
from gridforge.scenario.objective import Objective, pick_recommended
from gridforge.scenario.run import run_all
from gridforge.thermal.library import PUE_BY_ARCHITECTURE

ROOT = Path(__file__).resolve().parent.parent
INTAKES = sorted((ROOT / "examples" / "intake").glob("*.json"))
DUBLIN = ROOT / "examples" / "intake" / "dublin_hall.json"
INF = float("inf")


def gen(tmp_path, intake, what):
    out = tmp_path / f"{intake.stem}-{what}"
    r = subprocess.run([sys.executable, "-m", "gridforge", what, str(intake), "-o", str(out), *(["--csv"] if what == "study" else [])],
                       capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0, r.stderr
    return out


def study(tmp_path, intake=DUBLIN):
    return (gen(tmp_path, intake, "study") / "envelope_study.md").read_text()


def sections(md):
    parts = re.split(r"^## ", md, flags=re.M)
    return {p.split("\n", 1)[0].strip(): p for p in parts[1:]}


def solved(intake=DUBLIN):
    doc = load_document(json.loads(intake.read_text()))
    results = run_all(doc.context, doc.scenarios)
    return doc, results, pick_recommended(results, Objective.MAX_COMPUTE)


def sec(md, number):
    return next(v for k, v in sections(md).items() if k.startswith(f"{number}."))


# ------------------------------------------------------------------ a passing gate is not "0 racks"

@pytest.mark.parametrize("intake", INTAKES, ids=lambda p: p.stem)
def test_a_constraint_that_does_not_limit_the_hall_is_never_printed_as_zero_racks(tmp_path, intake):
    md = study(tmp_path, intake)
    _, _, rec = solved(intake)
    for number in (5, 6, 7):
        for line in sec(md, number).splitlines():
            if not line.startswith("| ") or line.startswith("| Constraint") or line.startswith("| ---"):
                continue
            cells = [c.strip() for c in line.strip("|").split("|")]
            name, racks = cells[0], cells[2]
            c = next((x for x in rec.envelope.constraints if x.name == name), None)
            if c is None:
                continue
            if c.max_racks.value == INF:
                assert racks.startswith(("not limiting", "passes")), f"{name}: solver says it does not limit, report says {racks!r}"
            elif c.gate:
                assert racks.startswith("0 racks"), f"{name}: a failed gate permits 0 racks, report says {racks!r}"


# ------------------------------------------------------------------ provenance is a min-operator

def test_rack_counts_never_carry_a_higher_evidence_class_than_the_constraints_they_come_from(tmp_path):
    md = study(tmp_path)
    _, results, rec = solved()
    ceiling = max(int(rack_class(r).name[1]) for r in results)
    for number in (1, 2, 3, 8, 9, 10):
        for k in re.findall(r"racks \(E(\d)\)", sec(md, number)):
            assert int(k) <= ceiling, f"section {number}: a rack count claims E{k} but the weakest constraint is E{ceiling}"
    assert f"({rack_class(rec).short})" in sec(md, 1).split("\n\n")[1]
    # the dishonest label that used to appear on the headline
    assert not re.search(r"(?<![\d,])(0|69) racks \(E3\)", sec(md, 1) + sec(md, 2))


# ------------------------------------------------------------------ no invented bands

def test_time_to_full_capacity_is_banded_by_the_lead_time_that_sets_it_not_by_a_multiplier(tmp_path):
    md = study(tmp_path)
    head = re.search(r"Time to full capacity:\*\* (\d+) \[(\d+)–(\d+)\] weeks", md)
    crit = re.search(r"Critical-path lead time:\*\* (\d+) \[(\d+)–(\d+)\] weeks", md)
    assert head and crit, "both statements must carry a range"
    assert head.groups() == crit.groups(), "the headline and the critical path are one number and must agree"
    w = int(head.group(1))
    assert (int(head.group(2)), int(head.group(3))) != (round(w * 0.7), round(w * 1.6)), "the old fixed multiplier is back"
    # and it is the transformer's own range
    _, _, rec = solved()
    tx = max((s.lead_time_weeks for s in rec.ladder.taken_steps), key=lambda q: q.value)
    assert (int(head.group(2)), int(head.group(3))) == (round(tx.band[0]), round(tx.band[1]))


# ------------------------------------------------------------------ zero-gain rungs

def _chain(scenario_id):
    doc = load_document(json.loads(DUBLIN.read_text()))
    spec = next(s for s in doc.scenarios if s.id == scenario_id)
    ctx = doc.context.copy()
    ctx.architecture = spec.architecture
    ctx.pue = PUE_BY_ARCHITECTURE[spec.architecture]
    if spec.overrides is not None:
        ctx = spec.overrides(ctx)
    lad = ladder(ctx)
    reliefs, cur, res = [], ctx, solve(ctx)
    for st in lad.steps:
        if not st.taken:
            break
        reliefs.append(res.binding.relief)
        cur = res.binding.relief.apply(cur)
        res = solve(cur)
    return ctx, lad, reliefs


def test_every_charged_rung_that_adds_no_racks_is_needed_and_the_study_says_so(tmp_path):
    ctx, lad, reliefs = _chain("full_dlc_btm")
    full = lad.final.max_racks
    zero = [i for i, s in enumerate(lad.steps) if s.taken and s.racks_after <= s.racks_before]
    assert zero, "the Dublin hall is expected to exercise tied constraints"
    for k in zero:
        c = ctx
        for i, r in enumerate(reliefs):
            if i != k:
                c = r.apply(c)
        assert solve(c).max_racks < full, f"rung {k + 1} adds nothing and is not needed -- it would be padding"
    md = study(tmp_path)
    assert f"Rungs {', '.join(str(k + 1) for k in zero)} are charged but add no racks on their own" in sec(md, 2)
    assert sec(md, 2).count("adds no racks on its own") >= len(zero)


# ------------------------------------------------------------------ economics

def test_undefined_economics_are_dashes_not_zeros(tmp_path):
    md = study(tmp_path)
    s9 = sec(md, 9)
    assert "0 EUR/rack" not in s9 and "0 EUR/gpu*h" not in s9
    assert "undefined rather than zero" in s9
    row = next(l for l in s9.splitlines() if l.startswith("| Retained air"))
    assert row.count("—") >= 5


def test_the_headline_capex_reconciles_to_the_ladder_and_says_how(tmp_path):
    md = study(tmp_path)
    _, _, rec = solved()
    e = rec.economics
    assert abs(e.capex_relief_eur.value + e.capex_conversion_eur.value - e.capex_total_eur.value) < 1.0
    s9 = sec(md, 9)
    assert "How the recommended capex is built" in s9
    for label in ("Relief works along the headroom ladder", "In-hall conversion of the", "Total (the headline capex)"):
        assert label in s9
    assert e.capex_conversion_eur.value > 0           # the gap between 15.9 M and 19.7 M is real and now explained


# ------------------------------------------------------------------ risk register, sensitivity, units, baseline

def test_the_risk_register_lists_each_risk_once(tmp_path):
    rows = [l for l in sec(study(tmp_path), 11).splitlines() if l.startswith("| ") and not l.startswith(("| Risk", "| ---"))]
    keys = [tuple(c.strip() for c in l.strip("|").split("|")[:2]) for l in rows]
    assert len(keys) == len(set(keys)), "a constraint relieved on several rungs is one risk"


def test_a_cliff_in_the_sensitivity_is_called_out_in_the_headline_and_the_section(tmp_path):
    md = study(tmp_path)
    assert "Dominant sensitivity:" in sec(md, 1)
    assert "The answer is a cliff, not a slope" in sec(md, 10)


def test_no_unit_algebra_leaks_into_prose_and_enums_are_words(tmp_path):
    md = study(tmp_path)
    assert "m*m" not in md and "kg/m*m" not in md
    assert "cold_aisle" not in md.split("## 5.")[0] and "| Floor | slab |" in md


def test_client_supplied_is_not_described_as_measured(tmp_path):
    md = study(tmp_path)
    assert "everything else is assumed" not in md
    assert "not measured or surveyed by us" in sec(md, 4)
    assert "E5 means supplied by the client" in md.split("## Appendix A")[1]


# ------------------------------------------------------------------ the deck and the screen agree with the study

def test_the_deck_does_not_claim_labels_it_does_not_print_and_does_not_hide_the_ladder(tmp_path):
    out = gen(tmp_path, DUBLIN, "deck")
    html = (out / "walkthrough.html").read_text()
    text = re.sub(r"<[^>]+>", " ", html)
    _, _, rec = solved()
    assert "carries an evidence class and comes from" not in text
    assert f"{len(rec.envelope.constraints)} constraints across" in text
    taken = len(rec.ladder.taken_steps)
    assert taken > 8 and f"first 8 of the {taken} rungs taken" in re.sub(r"\s+", " ", text)
    # The intake leaves two optional inputs to library defaults (the CDU schedule and the TCS target
    # temperature); the slide must name exactly those, not claim nothing was supplied.
    assert "What nobody has measured yet" in text
    assert "Installed CDU schedule" in text and "TCS target supply temperature" in text
    assert "tied constraint" in text


def test_study_screen_and_deck_state_the_same_headline(tmp_path):
    s = study(tmp_path)
    screen = (gen(tmp_path, DUBLIN, "screen") / "density_screen.md").read_text()
    deck = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", (gen(tmp_path, DUBLIN, "deck") / "walkthrough.html").read_text()))
    _, _, rec = solved()
    racks = f"{rec.unlocked_racks} racks (E0)"
    assert racks in s and racks in screen
    assert f"After the ladder {rec.unlocked_racks} racks" in deck
    weeks = re.search(r"Time to full capacity:\*\* (\d+ \[\d+–\d+\] weeks \(E0\))", s).group(1)
    assert weeks in screen
