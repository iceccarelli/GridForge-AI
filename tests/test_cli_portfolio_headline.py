"""The CLI's portfolio headline must state the COMPARABLE total, never a bare sum.

`gridforge portfolio` used to print "N deployable racks in total" from a plain sum over every hall. A hall with a required input missing or
an equipment bank undeclared (the London example has no UPS declared) is ranked on assumptions, and the engine's own portfolio answer
(`/v1/portfolio`, reporting/portfolio.py) no longer counts it in `comparable_total_racks`. The CLI is the same methodology and has to say the
same thing, or a reader of the terminal gets the number the engine no longer stands behind.
"""
from pathlib import Path

import pytest

from gridforge.cli import main

EX = Path(__file__).resolve().parents[1] / "examples" / "intake"


def run(tmp_path, capsys, *names):
    code = main(["portfolio", *[str(EX / n) for n in names], "-o", str(tmp_path / "out")])
    cap = capsys.readouterr()
    return code, cap.out, cap.err


def test_a_hall_that_cannot_be_compared_is_named_and_left_out_of_the_headline(tmp_path, capsys):
    code, out, err = run(tmp_path, capsys, "reference_hall.json", "dublin_hall.json", "london_hall.json", "nordic_hall.json")
    assert code == 0
    headline = next(line for line in out.splitlines() if line.startswith("Portfolio Screen"))
    assert "comparable" in headline and "left out of that total" in headline
    assert "deployable racks in total" not in headline        # the old bare-sum wording
    assert "not comparable" in err and "upper bound" in err    # and the warning reaches stderr, where a script can see it


def test_the_headline_total_is_the_engines_comparable_total_not_the_plain_sum(tmp_path, capsys):
    from gridforge.intake.loader import load
    from gridforge.reporting.portfolio import SiteEntry, portfolio_summary
    from gridforge.scenario.objective import Objective
    from gridforge.cli import _run

    names = ("reference_hall.json", "dublin_hall.json", "london_hall.json", "nordic_hall.json")
    entries = []
    for n in names:
        intake = load(EX / n)
        entries.append(SiteEntry(intake=intake, results=_run(intake), objective=Objective.MAX_COMPUTE))
    summary = portfolio_summary(entries, Objective.MAX_COMPUTE)
    plain = sum(e.racks for e in entries)
    assert summary["comparable_total_racks"] < plain, "the example set must contain a hall that is not comparable"
    _, out, _ = run(tmp_path, capsys, *names)
    assert f"{summary['comparable_total_racks']} deployable racks" in out
    assert f"{plain} deployable racks" not in out


def test_fully_comparable_separate_halls_say_nothing_is_left_out(tmp_path, capsys):
    code, out, err = run(tmp_path, capsys, "reference_hall.json", "dublin_hall.json", "nordic_hall.json")
    assert code == 0
    headline = next(line for line in out.splitlines() if line.startswith("Portfolio Screen"))
    assert "left out" not in headline
    assert "not comparable" not in err


@pytest.mark.parametrize("names", [("london_hall.json",)])
def test_when_no_hall_is_comparable_no_total_is_stated(tmp_path, capsys, names):
    code, out, err = run(tmp_path, capsys, *names)
    assert code == 0
    headline = next(line for line in out.splitlines() if line.startswith("Portfolio Screen"))
    assert "no portfolio total is stated" in headline        # no total is not zero racks
    assert "deployable racks" not in headline
