"""Command line: one intake file in, a delivered engagement out.

    python -m gridforge init      > intake.json        # blank pack to send a client
    python -m gridforge gaps        intake.json        # the data request, before any work
    python -m gridforge screen      intake.json -o out # the EUR 4,500 Density Screen
    python -m gridforge study       intake.json -o out # the EUR 22-45k Envelope Study
    python -m gridforge portfolio   *.json       -o out # the EUR 60-140k Portfolio Screen

This module is the automation ledger from docs/01 §7 made real. Everything that used
to be retyped per project - context assembly, scenario set, sensitivity knobs, report
structure, provenance appendix, model pack - happens here once. What is left per
project is the intake and the judgement, which is what the fee is actually for.
"""
from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from pathlib import Path

from .common import ASSUMED, V
from .constraints import EnvelopeContext
from .intake.loader import IntakeError, blank_intake, load as _load_intake
from .reporting import run_all_gates, to_html, to_markdown
from .reporting.gates import GateFailure, ReportMode
from .reporting.portfolio import SiteEntry
from .reporting.portfolio import build as build_portfolio
from .reporting.screen import build as build_screen
from .reporting.study import Objective, _pick_recommended, collect_claims
from .reporting.study import build as build_study
from .scenario import run_all, sensitivity
from .scenario.knobs import SENSITIVITY_KNOBS
from .serialize import write_model_pack

OBJECTIVES = {o.value: o for o in Objective}


def load(path) -> "object":
    """Load an intake, turning filesystem and JSON problems into IntakeError.

    An unmatched shell glob arrives here as a literal path like 'halls/*.json';
    say so instead of raising FileNotFoundError at the user."""
    p = Path(path)
    if not p.exists():
        if any(ch in str(path) for ch in "*?["):
            raise IntakeError(
                f"no intake files matched {path!r}. The shell expands the pattern, so run it from "
                "the directory that holds them, e.g. "
                "'python3 -m gridforge portfolio examples/intake/*.json -o out'.")
        raise IntakeError(f"no such intake file: {path}")
    if p.is_dir():
        raise IntakeError(f"{path} is a directory. Pass the JSON files themselves, "
                          f"e.g. '{path}/*.json'.")
    try:
        return _load_intake(p)
    except json.JSONDecodeError as exc:
        raise IntakeError(f"{path} is not valid JSON: {exc}") from exc


@dataclass
class _Written:
    paths: list[Path]

    def report(self) -> None:
        for p in self.paths:
            print(f"  wrote {p}")


def _emit(report, out: Path, stem: str, *, claims=None) -> _Written:
    out.mkdir(parents=True, exist_ok=True)
    md = to_markdown(report)
    try:
        run_all_gates(report, md, claims=claims, mode=ReportMode.SCREENING)
    except GateFailure as exc:
        print(f"REPORT GATE FAILED: {exc}", file=sys.stderr)
        raise
    p1 = out / f"{stem}.md"
    p2 = out / f"{stem}.html"
    p1.write_text(md)
    p2.write_text(to_html(report))
    return _Written([p1, p2])


def cmd_init(args) -> int:
    doc = blank_intake()
    text = json.dumps(doc, indent=2)
    if args.out:
        Path(args.out).write_text(text)
        print(f"wrote {args.out} — send it to the client; filling it in is milestone one")
    else:
        print(text)
    return 0


def cmd_gaps(args) -> int:
    intake = load(args.intake)
    rep = intake.report
    print(f"Intake completeness: {rep.completeness:.0%}  "
          f"({len(rep.supplied)} supplied, {len(rep.gaps)} assumed, "
          f"{len(rep.required_gaps)} required inputs missing)")
    print(f"Issuable as a full study: {'yes' if rep.can_issue else 'no'}")
    print()
    if rep.gaps:
        print("DATA REQUEST — send this list verbatim:")
        for g in rep.gaps:
            flag = "REQUIRED" if g.required else "optional"
            print(f"  [{flag}] {g.label} ({g.unit})")
            print(f"      assumed for now : {g.fallback_description}")
            if g.why_it_binds:
                print(f"      why it matters  : {g.why_it_binds}")
            if g.how_to_get_it:
                print(f"      where it comes from: {g.how_to_get_it}")
    for w in rep.warnings:
        print(f"  ! {w}")
    print()
    print(rep.engagement_recommendation)
    return 0


def _run(intake):
    return run_all(intake.context, intake.scenarios)


def cmd_screen(args) -> int:
    intake = load(args.intake)
    results = _run(intake)
    objective = OBJECTIVES[args.objective]
    report = build_screen(intake, results, objective=objective)
    out = Path(args.out)
    w = _emit(report, out, "density_screen", claims=collect_claims(results))
    write_model_pack(out / "model_pack.json", intake, results)
    w.paths.append(out / "model_pack.json")
    rec = _pick_recommended(results, objective)
    print(f"Density Screen — {intake.client}: {rec.envelope.max_racks} racks as found, "
          f"{rec.unlocked_racks} after the ladder, binding on {rec.envelope.binding.name}.")
    w.report()
    return 0


def cmd_study(args) -> int:
    intake = load(args.intake)
    results = _run(intake)
    objective = OBJECTIVES[args.objective]
    rec = _pick_recommended(results, objective)
    sens = sensitivity(rec, SENSITIVITY_KNOBS)
    report = build_study(intake.context, results, sens, client=intake.client, objective=objective)
    out = Path(args.out)
    w = _emit(report, out, "envelope_study", claims=collect_claims(results))
    write_model_pack(out / "model_pack.json", intake, results, sens)
    w.paths.append(out / "model_pack.json")
    print(f"Envelope Study — {intake.client}: recommended {rec.spec.name}; "
          f"{rec.unlocked_racks} racks after the ladder.")
    if not intake.report.can_issue:
        print(f"  NOTE: {len(intake.report.required_gaps)} required inputs are assumed. "
              f"Screening mode only — see the evidence disclosure in the report.")
    w.report()
    return 0


def cmd_serve(args) -> int:
    from .api.server import serve
    serve(args.host, args.port)
    return 0


def cmd_portfolio(args) -> int:
    entries = []
    for p in args.intakes:
        intake = load(p)
        entries.append(SiteEntry(intake=intake, results=_run(intake)))
    objective = OBJECTIVES[args.objective]
    report = build_portfolio(entries, client=args.client, objective=objective)
    out = Path(args.out)
    claims = collect_claims([r for e in entries for r in e.results])
    w = _emit(report, out, "portfolio_screen", claims=claims)
    for e in entries:
        stem = f"{e.intake.context.site.id}_{e.intake.context.hall.id}".replace("/", "-")
        write_model_pack(out / f"model_pack_{stem}.json", e.intake, e.results)
        w.paths.append(out / f"model_pack_{stem}.json")
    print(f"Portfolio Screen — {len(entries)} halls, "
          f"{sum(e.racks for e in entries)} deployable racks in total.")
    w.report()
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser("gridforge", description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("init", help="print a blank intake document")
    s.add_argument("-o", "--out")
    s.set_defaults(func=cmd_init)

    s = sub.add_parser("gaps", help="print the data request for an intake")
    s.add_argument("intake")
    s.set_defaults(func=cmd_gaps)

    for name, fn, helptext in (("screen", cmd_screen, "produce a Density Screen"),
                               ("study", cmd_study, "produce a Capacity & Density Envelope Study")):
        s = sub.add_parser(name, help=helptext)
        s.add_argument("intake")
        s.add_argument("-o", "--out", default="out")
        s.add_argument("--objective", default="max_compute", choices=sorted(OBJECTIVES))
        s.set_defaults(func=fn)

    s = sub.add_parser("serve", help="run the HTTP API (stdlib only, no dependencies)")
    s.add_argument("--host", default="0.0.0.0")
    s.add_argument("--port", type=int, default=8080)
    s.set_defaults(func=cmd_serve)

    s = sub.add_parser("portfolio", help="rank several halls with one methodology")
    s.add_argument("intakes", nargs="+")
    s.add_argument("-o", "--out", default="out")
    s.add_argument("--client", default="Portfolio")
    s.add_argument("--objective", default="max_compute", choices=sorted(OBJECTIVES))
    s.set_defaults(func=cmd_portfolio)

    args = p.parse_args(argv)
    try:
        return args.func(args)
    except IntakeError as exc:
        print(f"intake error: {exc}", file=sys.stderr)
        return 2
    except GateFailure:
        return 3


if __name__ == "__main__":
    raise SystemExit(main())
