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
from .commercial import ENGAGEMENTS, engagement
from .change import diff as envelope_diff
from .reporting.change_note import build as build_change_note
from .reporting.deck import build as build_deck
from .reporting.deck import to_html as deck_to_html
from .reporting.proposal import build as build_proposal
from .reporting.study import Objective, _pick_recommended, collect_claims
from .reporting.study import build as build_study
from .scenario import run_all, sensitivity
from .scenario.knobs import SENSITIVITY_KNOBS
from .serialize import write_csv_bundle, write_model_pack

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
    if args.csv:
        w.paths.extend(write_csv_bundle(out / "working_files", intake, results))
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
    if args.csv:
        w.paths.extend(write_csv_bundle(out / "working_files", intake, results))
    print(f"Envelope Study — {intake.client}: recommended {rec.spec.name}; "
          f"{rec.unlocked_racks} racks after the ladder.")
    if not intake.report.can_issue:
        print(f"  NOTE: {len(intake.report.required_gaps)} required inputs are assumed. "
              f"Screening mode only — see the evidence disclosure in the report.")
    w.report()
    return 0


def cmd_diff(args) -> int:
    before = json.loads(Path(args.before).read_text()) if Path(args.before).exists() else None
    after = json.loads(Path(args.after).read_text()) if Path(args.after).exists() else None
    if before is None:
        print(f"no such intake file: {args.before}", file=sys.stderr)
        return 2
    if after is None:
        print(f"no such intake file: {args.after}", file=sys.stderr)
        return 2
    d = envelope_diff(before, after, objective=OBJECTIVES[args.objective],
                      attribute=not args.no_attribute)
    project = after.get("project", {}) or {}
    report = build_change_note(
        d,
        site=args.site or str((after.get("site") or {}).get("name") or "Site"),
        hall=args.hall or str((after.get("hall") or {}).get("id") or "Hall"),
        client=args.client or str(project.get("client") or "Client"),
        period=args.period or "")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    w = _emit(report, out, "change_note")
    payload = {
        "headline": d.headline(),
        "material": d.material,
        "before": d.before.__dict__,
        "after": d.after.__dict__,
        "racks_delta": d.racks_delta,
        "weeks_delta": d.weeks_delta,
        "capex_delta_eur": d.capex_delta,
        "binding_moved": d.binding_moved,
        "changed_inputs": d.changed_paths,
        "drivers": [dr.__dict__ for dr in d.drivers],
        "explained_racks": d.explained,
        "unexplained_racks": d.residual,
    }
    (out / "change.json").write_text(json.dumps(payload, indent=2))
    w.paths.append(out / "change.json")
    print(d.headline())
    w.report()
    return 0


def cmd_deck(args) -> int:
    intake = load(args.intake)
    results = _run(intake)
    deck = build_deck(intake, results, objective=OBJECTIVES[args.objective])
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    path = out / "walkthrough.html"
    path.write_text(deck_to_html(deck))
    print(f"Walkthrough deck — {deck.title}: {len(deck.slides)} slides. "
          "Arrow keys to advance; Print to PDF for a sendable copy.")
    print(f"  wrote {path}")
    return 0


def cmd_proposal(args) -> int:
    intake = load(args.intake)
    results = _run(intake)
    try:
        eng = engagement(args.engagement)
    except KeyError as exc:
        print(str(exc), file=sys.stderr)
        return 2
    report = build_proposal(intake, results, eng, objective=OBJECTIVES[args.objective],
                            valid_days=args.valid_days, contact=args.contact or "")
    out = Path(args.out)
    w = _emit(report, out, "proposal", claims=collect_claims(results))
    print(f"Proposal — {eng.name} for {intake.client}: EUR {eng.price_eur:,}, "
          f"{eng.turnaround_days} working days. "
          f"Opens with {results and _pick_recommended(results, OBJECTIVES[args.objective]).envelope.binding.name}.")
    w.report()
    return 0


def cmd_cost(args) -> int:
    from .costs import (BUNDLED_PATH, COST_EVIDENCE, PUBLISHABLE_BASES, CostEntry,
                        CostLibrary, private_path)

    target = Path(args.library) if args.library else (BUNDLED_PATH if args.bundled
                                                      else private_path())

    if args.cost_cmd == "where":
        print(f"  seed (committed, published figures only) : {BUNDLED_PATH}")
        print(f"  yours (gitignored, quotations)           : {private_path()}"
              f"{'' if private_path().exists() else '   [not created yet]'}")
        merged = CostLibrary.resolved()
        print(f"  lines in effect                          : {len(merged.entries)}")
        bad = CostLibrary.load(BUNDLED_PATH).publishable_violations()
        if bad:
            print(f"  ! the committed seed holds quotations: {', '.join(bad)}")
            return 1
        return 0

    lib = CostLibrary.resolved(args.library) if args.cost_cmd in ("list", "show") \
        else CostLibrary.load(target)
    if args.cost_cmd == "list":
        if not lib.entries:
            print("The cost library is empty: every relief price is a placeholder with a "
                  "-50%/+100% band.")
            print("Add your first quotation:")
            print("  python3 -m gridforge cost add --key tapoff.unit --label 'tap-off unit' "
                  "--unit EUR/rack --value 5200 \\")
            print("      --basis firm_quote --supplier 'Acme' --quoted-on 2026-09-01 "
                  "--valid-until 2026-12-31 --region DE")
            return 0
        print(f"{'key':28s} {'value':>12s}  {'unit':10s} {'basis':20s} {'class':5s} source")
        for e in sorted(lib.entries.values(), key=lambda x: x.key):
            q = e.quantity()
            flag = " (EXPIRED)" if e.stale else ""
            who = e.supplier or e.source or "—"
            print(f"{e.key:28s} {e.value:12,.0f}  {e.unit:10s} {e.basis:20s} "
                  f"{q.evidence.short:5s} {who}{flag}")
        return 0

    if args.cost_cmd == "show":
        e = lib.get(args.key)
        if e is None:
            print(f"{args.key}: not in the library — a placeholder is used instead.")
            return 1
        for k, v in e.__dict__.items():
            if v is not None:
                print(f"  {k:14s} {v}")
        print(f"  {'evidence':14s} {e.quantity().evidence.name}")
        return 0

    if args.cost_cmd == "remove":
        if lib.entries.pop(args.key, None) is None:
            print(f"{args.key}: not in the library")
            return 1
        print(f"removed {args.key} -> {lib.save(args.library)}")
        return 0

    # add
    if args.basis not in COST_EVIDENCE:
        print(f"unknown basis {args.basis!r}. One of: {', '.join(COST_EVIDENCE)}", file=sys.stderr)
        return 2
    if target == BUNDLED_PATH and args.basis not in PUBLISHABLE_BASES:
        print(f"refusing to write a {args.basis} into the committed seed at {BUNDLED_PATH}.\n"
              "A supplier quotation is confidential and frequently under NDA; it must not be "
              "committed to a repository or shipped in an image.\n"
              f"Drop --bundled and it goes to {private_path()}, which is gitignored.",
              file=sys.stderr)
        return 2
    if args.basis != "library_default" and not (args.supplier and args.quoted_on):
        print(f"a {args.basis} needs --supplier and --quoted-on. Without them it is not a "
              "quotation, it is a number someone remembered.", file=sys.stderr)
        return 2
    entry = CostEntry(key=args.key, label=args.label or args.key, unit=args.unit,
                      value=float(args.value), basis=args.basis, supplier=args.supplier,
                      quoted_on=args.quoted_on, valid_until=args.valid_until,
                      region=args.region, project=args.project, note=args.note,
                      source=args.source)
    lib.put(entry)
    path = lib.save(args.library)
    q = entry.quantity()
    print(f"{entry.key} = {q.render()}  [{entry.basis}]")
    print(f"wrote {path}")
    if entry.basis == "library_default":
        print("NOTE: recorded as a library default, so it stays a placeholder. Use "
              "--basis firm_quote once you have a written quotation.")
    elif target != BUNDLED_PATH:
        print("This file is gitignored and is not shipped in the image. Keep it that way: "
              "quotations are confidential.")
    return 0


def cmd_calibrate(args) -> int:
    """The accuracy record: what the model said, what the site turned out to be.

    This is the one command whose output gets worse before it gets better. With an
    empty ledger it prints zeros, and that is the correct commercial position to be
    honest about — the alternative is a product that cannot ever distinguish itself
    from a spreadsheet, because it has never been checked against anything.
    """
    from .calibration import (Observation, ObservationError, accuracy_block, all_keys,
                              calibration_for, label, load_ledger)
    from .calibration.keys import known
    from .calibration.ledger import BUNDLED_PATH, append_observation, private_path
    from .calibration.schema import site_ref
    from .validation.evidence import EvidenceClass as _EvidenceClass

    if args.cal_cmd == "where":
        print(f"  published ledger (committed, no client data) : {BUNDLED_PATH}")
        print(f"  yours (gitignored, site observations)        : {private_path()}"
              f"{'' if private_path().exists() else '   [not created yet]'}")
        led = load_ledger()
        print(f"  observations in effect                       : {len(led.observations)}")
        print(f"  sites                                        : "
              f"{len({o.site_ref for o in led.observations})}")
        return 0

    if args.cal_cmd == "keys":
        for k in all_keys():
            print(f"  {k:48s} {label(k)}")
        return 0

    if args.cal_cmd == "show":
        led = load_ledger()
        block = accuracy_block(all_keys(), led)
        print(block["statement"])
        print()
        print(f"{'model output':48s} {'state':14s} {'n':>3s}  bias")
        for k in all_keys():
            c = calibration_for(k, led.observations)
            bias = "—" if c.bias_pct is None else f"{c.bias_pct:+.0f}%"
            print(f"{k:48s} {c.state.value:14s} {c.n:3d}  {bias}")
        if not led.observations:
            print()
            print("No site data has been reconciled against this engine yet. Record the first:")
            print("  python3 -m gridforge calibrate add --key envelope.racks \\")
            print("      --site 'Client A' --hall DH-02 --predicted 26 --observed 24 "
                  "--unit racks \\")
            print("      --on 2026-11-30 --method 'half-hourly metering, 3 months post-energisation'")
        return 0

    # add
    if not known(args.key):
        print(f"unknown key {args.key!r}. `gridforge calibrate keys` lists them.", file=sys.stderr)
        print("Keys are fixed on purpose: a renamed key orphans every observation "
              "recorded under the old one.", file=sys.stderr)
        return 2
    if not args.site or not args.hall:
        print("--site and --hall are required: they are hashed into a stable, "
              "non-reversible site reference.", file=sys.stderr)
        return 2
    try:
        obs = Observation(
            key=args.key, site_ref=site_ref(args.site, args.hall),
            predicted=float(args.predicted), observed=float(args.observed),
            unit=args.unit, observed_on=args.on,
            evidence=_EvidenceClass[args.evidence], method=args.method,
            platform=args.platform or "", note=args.note or "")
    except KeyError:
        print(f"unknown evidence class {args.evidence!r}", file=sys.stderr)
        return 2
    except ObservationError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    try:
        path = append_observation(obs, Path(args.ledger) if args.ledger else None)
    except ObservationError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
    # Read back from the file we actually wrote, not from the default ledger: with
    # --ledger pointing elsewhere the default is empty and would report n=0 for an
    # observation that was just recorded.
    from .calibration.ledger import _read
    c = calibration_for(obs.key, _read(path))
    print(f"recorded -> {path}")
    print(f"  {obs.key}: predicted {obs.predicted:g}, observed {obs.observed:g} "
          f"({obs.error_pct:+.1f}%)")
    print(f"  {c.sentence()}")
    return 0


def cmd_tools(args) -> int:
    """Print the machine-callable surface: what an agent can call, and what it costs.

    Written to a file and committed, this is what the /developers page renders, so
    an integrator reads the same schema the server will actually validate against.
    """
    from .api.tools import catalogue
    cat = catalogue()
    if args.json:
        out = json.dumps(cat, indent=2)
        if args.out:
            Path(args.out).parent.mkdir(parents=True, exist_ok=True)
            Path(args.out).write_text(out + "\n")
            print(f"wrote {args.out}")
        else:
            print(out)
        return 0
    print(f"{'tool':22s} {'units':>5s}  {'tier':7s} endpoint")
    for t in cat["tools"]:
        print(f"{t['name']:22s} {t['units']:5d}  {t['tier']:7s} {t['endpoint']}")
    print()
    print(f"MCP: POST {cat['mcp']['endpoint']}  (JSON-RPC 2.0, protocol "
          f"{cat['mcp']['protocolVersion']})")
    print(f"Auth: {cat['auth']['header']}. {cat['auth']['note']}")
    return 0


def cmd_key(args) -> int:
    """Mint and inspect signed API keys.

    Self-serve issuance happens on the website when a subscription starts; this is
    for the cases a webhook cannot cover — a trial for a prospect on a call, a
    replacement after a leak, or working out why a customer's key stopped.
    """
    from .api.keys import KeyError_, inspect, issue
    from .commercial import API_PLANS

    if args.key_cmd == "plans":
        print(f"{'plan':16s} {'EUR/month':>10s} {'units':>8s} {'EUR/unit':>9s}  audience")
        for pl in sorted(API_PLANS.values(), key=lambda x: x.price_eur_month):
            print(f"{pl.id:16s} {pl.price_eur_month:10,} {pl.monthly_units:8,} "
                  f"{pl.eur_per_unit:9.2f}  {pl.audience}")
        return 0

    if args.key_cmd == "inspect":
        d = inspect(args.token)
        for k, v in d.items():
            print(f"  {k:14s} {v}")
        return 0 if d.get("valid") else 1

    # issue
    quota = args.quota
    if args.plan:
        if args.plan not in API_PLANS:
            print(f"unknown plan {args.plan!r}. One of: {', '.join(sorted(API_PLANS))}",
                  file=sys.stderr)
            return 2
        quota = API_PLANS[args.plan].monthly_units
    try:
        token = issue(args.account, quota=int(quota), scope=args.scope, days=int(args.days))
    except KeyError_ as exc:
        print(f"refused: {exc}", file=sys.stderr)
        if "SECRET" in str(exc):
            print("\nGenerate one, and set the SAME value on the engine and the website:",
                  file=sys.stderr)
            print("  python3 -c \"import secrets; print(secrets.token_hex(32))\"",
                  file=sys.stderr)
        return 2
    d = inspect(token)
    print(token)
    print(f"\n  account   {d['account']}")
    print(f"  key id    {d['key_id']}   (put this in GRIDFORGE_REVOKED_KEYS to kill it)")
    print(f"  quota     {d['monthly_quota'] or 'unlimited'} units/month")
    print(f"  expires   {d['expires']}")
    print("\nThe engine verifies this offline — it needs no database and no record of it. "
          "Show it to the customer once; we do not store it either.")
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
        s.add_argument("--csv", action="store_true",
                       help="also write the working files, so the client's engineers can check "
                            "the arithmetic in a spreadsheet")
        s.set_defaults(func=fn)

    s = sub.add_parser("diff", help="what changed between two intakes, and which input changed it")
    s.add_argument("before")
    s.add_argument("after")
    s.add_argument("-o", "--out", default="out")
    s.add_argument("--objective", default="max_compute", choices=sorted(OBJECTIVES))
    s.add_argument("--no-attribute", action="store_true",
                   help="skip the per-input probes (faster, but no driver table)")
    s.add_argument("--site", default="")
    s.add_argument("--hall", default="")
    s.add_argument("--client", default="")
    s.add_argument("--period", default="")
    s.set_defaults(func=cmd_diff)

    s = sub.add_parser("deck", help="the walkthrough deck for the client session")
    s.add_argument("intake")
    s.add_argument("-o", "--out", default="out")
    s.add_argument("--objective", default="max_compute", choices=sorted(OBJECTIVES))
    s.set_defaults(func=cmd_deck)

    s = sub.add_parser("proposal", help="a priced proposal that opens with a real finding")
    s.add_argument("intake")
    s.add_argument("-o", "--out", default="out")
    s.add_argument("--engagement", default="density_screen", choices=sorted(ENGAGEMENTS))
    s.add_argument("--objective", default="max_compute", choices=sorted(OBJECTIVES))
    s.add_argument("--valid-days", dest="valid_days", type=int, default=30)
    s.add_argument("--contact", default="")
    s.set_defaults(func=cmd_proposal)

    s = sub.add_parser("cost", help="the cost library: what a relief actually costs")
    s.add_argument("cost_cmd", choices=["list", "show", "add", "remove", "where"])
    s.add_argument("--key", default="")
    s.add_argument("--label", default="")
    s.add_argument("--unit", default="EUR")
    s.add_argument("--value", default="0")
    s.add_argument("--basis", default="library_default",
                   help="library_default | published_benchmark | budgetary_quote | "
                        "firm_quote | contracted")
    s.add_argument("--supplier")
    s.add_argument("--quoted-on", dest="quoted_on", help="ISO date of the quotation")
    s.add_argument("--valid-until", dest="valid_until")
    s.add_argument("--region")
    s.add_argument("--project")
    s.add_argument("--note")
    s.add_argument("--source")
    s.add_argument("--library",
                   help="path to a cost library JSON (default: your private, gitignored one)")
    s.add_argument("--bundled", action="store_true",
                   help="write to the committed seed instead. Refuses quotations: the seed may "
                        "hold only placeholders and published benchmarks.")
    s.set_defaults(func=cmd_cost)

    s = sub.add_parser("calibrate",
                       help="the accuracy record: model vs what the site turned out to be")
    s.add_argument("cal_cmd", choices=["show", "add", "keys", "where"])
    s.add_argument("--key", default="", help="`gridforge calibrate keys` lists them")
    s.add_argument("--site", default="", help="client site name — hashed, never stored")
    s.add_argument("--hall", default="", help="hall id — hashed with the site name")
    s.add_argument("--predicted", default="0", help="what this engine said")
    s.add_argument("--observed", default="0", help="what the site turned out to be")
    s.add_argument("--unit", default="")
    s.add_argument("--on", default="", help="ISO date the site data covers")
    s.add_argument("--method", default="",
                   help="how it was obtained: metering, BMS trend, commissioning record")
    s.add_argument("--evidence", default="E5_CUSTOMER_DATA",
                   help="E5_CUSTOMER_DATA | E6_FIELD_VALIDATED | E7_DEPLOYED")
    s.add_argument("--platform", default="")
    s.add_argument("--note", default="")
    s.add_argument("--ledger", help="path to a ledger JSON (default: your private, gitignored one)")
    s.set_defaults(func=cmd_calibrate)

    s = sub.add_parser("tools", help="the machine-callable surface: tools, units, MCP")
    s.add_argument("--json", action="store_true", help="print the full catalogue as JSON")
    s.add_argument("-o", "--out", help="write the JSON catalogue to this path")
    s.set_defaults(func=cmd_tools)

    s = sub.add_parser("key", help="signed API keys: mint, inspect, and the plan list")
    s.add_argument("key_cmd", choices=["issue", "inspect", "plans"])
    s.add_argument("token", nargs="?", default="", help="the key, for `inspect`")
    s.add_argument("--account", default="", help="who this bills to; usage aggregates here")
    s.add_argument("--plan", default="", help="api_triage | api_scale | api_platform")
    s.add_argument("--quota", default="0", help="monthly units; 0 is unlimited")
    s.add_argument("--scope", default="machine", choices=["machine", "client", "trial"])
    s.add_argument("--days", default="35",
                   help="validity. 35 by default so a monthly renewal never leaves a "
                        "customer's agents dark while the webhook lands.")
    s.set_defaults(func=cmd_key)

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
