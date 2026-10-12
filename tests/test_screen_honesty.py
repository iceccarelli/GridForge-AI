"""The Density Screen is what a buyer pays EUR 4,500 for; its prose must not claim more than the model knows."""
import json
import subprocess
import sys
from pathlib import Path

import pytest

from gridforge.envelope.solver import ladder, solve
from gridforge.intake.loader import load_document
from gridforge.thermal.library import PUE_BY_ARCHITECTURE

ROOT = Path(__file__).resolve().parent.parent
INTAKES = sorted((ROOT / "examples" / "intake").glob("*.json"))


def render(tmp_path, intake):
    out = tmp_path / intake.stem
    r = subprocess.run([sys.executable, "-m", "gridforge", "screen", str(intake), "-o", str(out)], capture_output=True, text=True, cwd=ROOT)
    assert r.returncode == 0, r.stderr
    return (out / "density_screen.md").read_text()


@pytest.mark.parametrize("intake", INTAKES, ids=lambda p: p.stem)
def test_a_complete_intake_never_claims_the_prices_were_supplied(tmp_path, intake):
    md = render(tmp_path, intake)
    assert "Every input below the headline was supplied" not in md
    if "Intake is complete" in md:
        # the sentence that says the site inputs were supplied also says what was NOT: price and schedule
        assert "priced" in md.split("Intake is complete", 1)[1][:400]


def test_no_dangling_reference_or_ambiguous_instruction(tmp_path):
    md = render(tmp_path, INTAKES[0])
    assert "neither is a benchmark" not in md
    assert "Complete intake." not in md          # read as an instruction to the buyer


def _chain(scenario_id):
    intake = load_document(json.loads((ROOT / "examples" / "intake" / "dublin_hall.json").read_text()))
    spec = next(s for s in intake.scenarios if s.id == scenario_id)
    ctx = intake.context.copy()
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


def test_a_charged_rung_that_adds_no_racks_is_genuinely_needed_and_the_document_says_why(tmp_path):
    """The explanation printed next to such a rung must stay true: dropping it must lose racks. If the
    solver ever starts charging for a rung that changes nothing, this fails instead of letting the
    explanation become an excuse for padding."""
    ctx, lad, reliefs = _chain("full_dlc_btm")
    full = lad.final.max_racks
    zero_gain = [i for i, s in enumerate(lad.steps) if s.taken and s.racks_after <= s.racks_before]
    assert zero_gain, "the reference hall is expected to exercise tied constraints"
    for k in zero_gain:
        c = ctx
        for i, r in enumerate(reliefs):
            if i != k:
                c = r.apply(c)
        assert solve(c).max_racks < full, f"rung {k + 1} adds nothing and is not needed -- it would be padding"
    md = render(tmp_path, ROOT / "examples" / "intake" / "dublin_hall.json")
    if any(k < 6 for k in zero_gain):
        assert "adds no racks on its own" in md
