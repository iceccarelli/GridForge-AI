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
from .envelope.time_to_power import date_record
from .reporting.change_note import build as build_change_note
from .reporting.deck import build as build_deck
from .reporting.deck import to_html as deck_to_html
from .reporting.proposal import build as build_proposal
from .reporting.study import Objective, _pick_recommended, collect_claims
from .reporting.board import build as build_board
from .reporting.study import build as build_study, watermark_for
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


def cmd_power_deploy_assess(args) -> int:
    from .reporting.btm_assessment import DeploymentRequestError, assess_deployment, deployment_request
    doc = json.loads(Path(args.request).read_text())
    try:
        kwargs = deployment_request(doc)
    except DeploymentRequestError as exc:
        print(f"invalid deployment request: {exc}", file=sys.stderr)
        return 1
    result = assess_deployment(**kwargs)
    if args.out:
        Path(args.out).write_text(json.dumps(result, indent=2, default=str) + "\n")
        print(f"wrote {args.out}")
    lp = result["load_profile"]
    cap = result["capacity"]
    print(f"BTM Power Deployment Assessment")
    print(f"  Load profile       : {lp['source']} ({lp['evidence']}), peak {lp['peak_MW']} MW, "
          f"load factor {lp['load_factor']}")
    if lp["warnings"]:
        for w in lp["warnings"]:
            print(f"  ! {w}")
    print(f"  Grid-only firm     : {cap['grid_firm_MW']} MW vs target {cap['target_MW']} MW "
          f"(gap {cap['gap_MW']} MW)")
    print(f"  Redundancy policy  : {cap['redundancy']}, ride-through {cap['ride_through_hours']} h")
    print(f"  Objective          : {cap['objective']}")
    print(f"  Architectures compared:")
    for a in result["architectures"]:
        capex = f"EUR {a['capex_eur']:,.0f}" if a["capex_eur"] is not None else "UNKNOWN"
        lead = f"{a['lead_time_weeks']:.0f}w" if a["lead_time_weeks"] is not None else "UNKNOWN"
        if a.get("date_basis") == "assumed":
            lead += " (assumed lead time, not a date)"
        print(f"    {a['status'].upper():25s} {a['label']:28s} capex={capex:>16s}  lead={lead}")
        if a["rfq_ready"]:
            if a["execution_ready"]:
                print(f"      cleared to build — no outstanding external clearance")
            else:
                owners = sorted({c["review_requirement"] for c in a["external_clearances_required"]
                                 if c["review_requirement"]})
                print(f"      RFQ-ready, NOT cleared to build — awaiting: {', '.join(owners)}")
    print(f"  Next action        : {result['next_action']['action']}")
    print(f"                       {result['next_action']['why']}")
    for t in result["next_action"].get("trade_offs", []):
        print(f"  Trade-off          : {t}")
    return 0


def cmd_power_deploy_spec(args) -> int:
    from .procurement.schema import ProcurementError
    from .reporting.btm_assessment import DeploymentRequestError, deployment_request
    from .reporting.btm_spec import build_equipment_spec
    from .reporting.btm_spec_report import build as build_spec_report
    from .reporting import to_markdown, to_html
    doc = json.loads(Path(args.request).read_text())
    try:
        kwargs = deployment_request(doc)
    except DeploymentRequestError as exc:
        print(f"invalid deployment request: {exc}", file=sys.stderr)
        return 1
    try:
        spec = build_equipment_spec(args.architecture, project=args.project,
                                    generation=kwargs["generation"], bess=kwargs["bess"])
    except ProcurementError as exc:
        print(f"cannot build a specification: {exc}", file=sys.stderr)
        return 1
    report = build_spec_report(spec, reference=args.reference or "")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "specification.md").write_text(to_markdown(report))
    (out / "specification.html").write_text(to_html(report, full_document=True))
    print(f"BTM Equipment Specification — {args.project} / {args.architecture}")
    print(f"  Units covered      : {', '.join(spec.units)}")
    print(f"  Requirements       : {len(spec.requirements)} ({len(spec.mandatory())} mandatory)")
    print(f"  wrote {out}/specification.md and {out}/specification.html")
    return 0


def cmd_power_assess(args) -> int:
    from .reporting.readiness import assess
    intake = load(args.intake)
    results = _run(intake)
    case = assess(intake, results, objective=OBJECTIVES[args.objective],
                  target_racks=args.target_racks)
    if args.out:
        Path(args.out).write_text(json.dumps(case, indent=2, default=str) + "\n")
        print(f"wrote {args.out}")
    cap = case["capacity"]
    bind = case["binding_constraint"]
    ttp = case["time_to_power"]
    print(f"Power Readiness Case — {intake.client}")
    print(f"  Current deployable : {cap['current_deployable_racks']} racks "
          f"({cap['current_deployable_MW']} MW)")
    if cap["requested_target_given"]:
        print(f"  Target             : {cap['target_racks']} racks "
              f"(gap {cap['gap_racks']} racks)")
    print(f"  Binding constraint : {bind['name']} ({bind['domain']})")
    print(f"  Headroom ladder    : {len(case['headroom_ladder'])} rungs to "
          f"{case['capacity']['racks_after_full_headroom_ladder']} racks")
    if ttp["weeks_to_full"] is not None:
        print(f"  Time to full power : {ttp['weeks_to_full']:.0f} weeks "
              f"(critical: {ttp['critical_item']})"
              + (f" — {ttp['date_label']}" if ttp.get("date_basis") == "assumed" else ""))
    print(f"  Calibration        : {case['evidence']['calibration']['state']}")
    print(f"  Next action        : {case['next_action']['action']}")
    return 0


def _with_evidence(fn):
    """Run a command with accepted cost evidence from --cost-evidence layered over the library for this one run."""
    import functools

    @functools.wraps(fn)
    def run(args) -> int:
        path = getattr(args, "cost_evidence", None)
        if not path:
            return fn(args)
        from .costs import CostEntry, cost_overlay, set_evidence_effect
        from .scenario.evidence import evidence_effect
        try:
            raw = json.loads(Path(path).read_text())
            rows = raw.get("entries", raw) if isinstance(raw, dict) else raw
            entries = [CostEntry(**r) for r in rows]
        except (OSError, json.JSONDecodeError, TypeError, ValueError, AttributeError) as exc:
            print(f"refused: cost evidence {path} is unusable: {exc}", file=sys.stderr)
            return 2
        intake = load(args.intake)
        with cost_overlay(entries) as report:
            set_evidence_effect(evidence_effect(intake.context, intake.scenarios, entries))
            print(f"  cost evidence: {len(report.used)} accepted line(s) used, {len(report.ignored)} ignored")
            for ig in report.ignored:
                print(f"    not used: {ig['key']} — {ig['reason']}")
            return fn(args)
    return run


def _queue_for(intake, results, objective) -> dict:
    """The measured queue history beside the recommended scenario's assumed grid wait (context only; the pooled US statistic)."""
    from .api.payloads import grid_queue_context_for
    return grid_queue_context_for(results, objective, country=intake.context.site.country)


def _price_for(intake) -> dict:
    """EIA's published average beside the electricity price the documents use (context only; the US average)."""
    from .api.payloads import retail_price_context_for
    return retail_price_context_for(intake)


def cmd_screen(args) -> int:
    intake = load(args.intake)
    results = _run(intake)
    objective = OBJECTIVES[args.objective]
    report = build_screen(intake, results, objective=objective, grid_queue=_queue_for(intake, results, objective),
                          retail_price=_price_for(intake))
    out = Path(args.out)
    w = _emit(report, out, "density_screen", claims=collect_claims(results))
    write_model_pack(out / "model_pack.json", intake, results)
    w.paths.append(out / "model_pack.json")
    if args.csv:
        w.paths.extend(write_csv_bundle(out / "working_files", intake, results))
    rec = _pick_recommended(results, objective)
    print(f"Density Screen — {intake.client}: {rec.envelope.max_racks} racks as found, "
          f"{rec.unlocked_racks} after the ladder, binding on {rec.envelope.binding.name}.")
    _economics_note(rec)
    w.report()
    return 0


def _economics_note(rec) -> None:
    """One honest line on whether the economics can be relied on, so the terminal never reads cleaner than the report."""
    from .reporting.labels import economics_limitations
    lims = economics_limitations(rec.economics)
    if rec.unlocked_racks <= 0:
        return
    if lims:
        n = len(rec.economics.unpriced_summary())
        print("  ECONOMICS: not decision-grade"
              + (f"; capex is a LOWER BOUND ({n} cost component(s) have no price)" if n else "")
              + f". {len(lims)} reason(s) in the report, section 9.")
    else:
        print("  ECONOMICS: every priced line rests on a quotation or better; nothing is unpriced.")


def cmd_study(args) -> int:
    intake = load(args.intake)
    results = _run(intake)
    objective = OBJECTIVES[args.objective]
    rec = _pick_recommended(results, objective)
    sens = sensitivity(rec, SENSITIVITY_KNOBS)
    report = build_study(intake.context, results, sens, client=intake.client, objective=objective,
                         watermark=watermark_for(intake), grid_queue=_queue_for(intake, results, objective),
                         retail_price=_price_for(intake),
                         date_record=date_record(rec.ladder, document=intake.document), sourced=intake.report.sourced)
    out = Path(args.out)
    w = _emit(report, out, "envelope_study", claims=collect_claims(results))
    write_model_pack(out / "model_pack.json", intake, results, sens)
    w.paths.append(out / "model_pack.json")
    board = build_board(intake, results, sens, objective=objective)
    w.paths.extend(_emit(board, out, "board_summary", claims=collect_claims(results)).paths)
    if args.csv:
        w.paths.extend(write_csv_bundle(out / "working_files", intake, results))
    print(f"Envelope Study — {intake.client}: recommended {rec.spec.name}; "
          f"{rec.unlocked_racks} racks after the ladder.")
    _economics_note(rec)
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
        **d.date_basis(),
        "capex_delta_eur": d.capex_delta,
        "binding_moved": d.binding_moved,
        "changed_inputs": d.changed_paths,
        "drivers": [dr.__dict__ for dr in d.drivers],
        "explained_racks": d.explained,
        "unexplained_racks": d.residual,
        "inputs": d.inputs,
        "model_drift": d.drift,
        "model_drift_known": d.drift_known,
        "unprobed_inputs": d.unprobed,
        "unprobeable_inputs": d.unprobeable,
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
    if args.basis == "published_benchmark":
        if not (args.source and args.quoted_on and args.region):
            print("a published_benchmark needs --source (what was published), --quoted-on (its publication date) "
                  "and --region (the geography it describes), and its unit and scope must match the line it "
                  "prices. A figure that cannot name them is a placeholder.", file=sys.stderr)
            return 2
    elif args.basis == "engineering_estimate":
        if not args.note:
            print("an engineering_estimate needs --note stating its basis (what was assumed, by whom). It is "
                  "weaker than any supplier quotation and is kept in your private library.", file=sys.stderr)
            return 2
    elif args.basis != "library_default" and not (args.supplier and args.quoted_on):
        print(f"a {args.basis} needs --supplier and --quoted-on. Without them it is not a "
              "quotation, it is a number someone remembered.", file=sys.stderr)
        return 2
    try:
        entry = CostEntry(key=args.key, label=args.label or args.key, unit=args.unit,
                          value=float(args.value), basis=args.basis, supplier=args.supplier,
                          quoted_on=args.quoted_on, valid_until=args.valid_until,
                          region=args.region, project=args.project, note=args.note,
                          source=args.source, quoted_quantity=args.quoted_quantity,
                          quoted_quantity_unit=args.quoted_quantity_unit)
    except ValueError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2
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
    """The accuracy record, failing closed: a ledger whose hash chain does not verify is never read."""
    from .calibration.ledger import LedgerIntegrityError
    try:
        return _cmd_calibrate(args)
    except LedgerIntegrityError as exc:
        print(f"ledger integrity failure: {exc}", file=sys.stderr)
        print("Nothing was read or written. Restore the file from a backup or investigate who changed it; "
              "do not edit records by hand.", file=sys.stderr)
        return 3


def _cmd_calibrate(args) -> int:
    """The accuracy record: what the model said, what the site turned out to be.

    This is the one command whose output gets worse before it gets better. With an
    empty ledger it prints zeros, and that is the correct commercial position to be
    honest about — the alternative is a product that cannot ever distinguish itself
    from a spreadsheet, because it has never been checked against anything.
    """
    from .calibration import (Observation, ObservationError, accuracy_block, all_keys,
                              calibration_for, label, load_ledger)
    from .calibration.keys import known
    from .calibration.ledger import (BUNDLED_PATH, LedgerIntegrityError, append_observation, import_export,
                                     private_path)
    from .calibration import siteref
    from .calibration.ledger import AliasFileUnreadable, _read, site_alias_file, site_aliases
    from .validation.evidence import EvidenceClass as _EvidenceClass

    if args.cal_cmd == "where":
        print(f"  published ledger (committed, no client data) : {BUNDLED_PATH}")
        print(f"  yours (gitignored, site observations)        : {private_path()}"
              f"{'' if private_path().exists() else '   [not created yet]'}")
        alias_note = ""
        try:
            led = load_ledger()
            n_alias = str(len(site_aliases()))
        except AliasFileUnreadable as exc:
            # `where` is how an operator finds out what is wrong, so it must still work: it reports the file and counts WITHOUT the aliases.
            led = load_ledger(use_aliases=False)
            n_alias = "alias file unreadable"
            alias_note = f"  (alias file unreadable: {exc}; the site counts below IGNORE it and may count one site twice)"
        print(f"  observations in effect                       : {len(led.observations)}")
        print(f"  unsalted -> keyed site aliases declared      : {n_alias}")
        if alias_note:
            print(alias_note)
        print(f"  sites                                        : "
              f"{len({o.site for o in led.observations})}"
              f"  (halls: {len({o.site_ref for o in led.observations})})")
        for src, head in led.heads.items():
            if head:
                print(f"  chain head {Path(src).name:24s}    : {head}")
        return 0

    if args.cal_cmd == "import":
        if not args.export:
            print("usage: gridforge calibrate import <export.json> [--ledger PATH]", file=sys.stderr)
            return 2
        try:
            doc = json.loads(Path(args.export).read_text())
        except (OSError, json.JSONDecodeError) as exc:
            print(f"refused: cannot read {args.export}: {exc}", file=sys.stderr)
            return 2
        try:
            out = import_export(doc, Path(args.ledger) if args.ledger else None, accept_mixed_refs=args.accept_mixed_refs)
        except LedgerIntegrityError:
            raise
        except ObservationError as exc:
            print(f"refused: {exc}", file=sys.stderr)
            print("Nothing was imported.", file=sys.stderr)
            return 2
        if out["imported"] == 0:
            print("0 verified rows in the export; nothing imported."
                  + (" The ledger is still empty." if out["ledger_observations"] == 0
                     else f" The ledger is unchanged ({out['ledger_observations']} observation(s))."))
        else:
            print(f"imported {out['imported']} verified observation(s) -> {out['path']} "
                  f"(ledger now holds {out['ledger_observations']})")
            how = {"aliases": f"{out['aliases']} alias(es) declared", "none_needed": "you recorded that no site spans the 0053 boundary",
                   "accept_mixed_refs": "--accept-mixed-refs for this import only"}[out["mixed_ref_decision"]]
            print(f"  counted as: {out['distinct_sites_imported']} distinct site reference(s) in this import; {out['rekeyed']} of {out['imported']} row(s) "
                  f"re-keyed by your alias file ({how}).")
            if out["mixed_ref_decision"] == "accept_mixed_refs":
                print("  NOTE: nothing was merged. A site exported under both an UNSALTED (before 0053) and a KEYED reference is counted as TWO sites; declare it "
                      "with `gridforge calibrate alias` and the ledger will read it as one.", file=sys.stderr)
        return 0

    if args.cal_cmd == "alias":
        where = siteref.alias_path(private=Path(args.ledger) if args.ledger else private_path())
        try:
            if args.none_needed:
                if args.site or args.legacy_ref:
                    print("refused: --none-needed stands alone (it declares that NO site spans the 0053 boundary)", file=sys.stderr)
                    return 2
                new = siteref.acknowledge_none_needed(where)
                print(f"{'recorded' if new else 'already recorded'}: no site spans the migration-0053 boundary, dated in {where}")
                print("  this is your statement, not something the software can check; `calibrate import` will now accept exports without --accept-mixed-refs.")
                return 0
            if not args.site.strip():
                print("usage: gridforge calibrate alias --site 'NAME' [--legacy-ref site_xxxxxxxxxxxx] [--ledger PATH]  declares that the unsalted (pre-0053) "
                      "and the keyed reference of NAME are ONE site; a non-ASCII NAME needs --legacy-ref from the database.\n"
                      "       gridforge calibrate alias --none-needed   declares that no site spans the boundary", file=sys.stderr)
                return 2
            siteref.check_argv_text(args.site)
            key, source = siteref.resolve_key()
            note = siteref.key_warning(source)
            if note:
                siteref.warn(note)
            keyed = siteref.keyed_site_only_ref(args.site, key)
            if args.legacy_ref:
                legacy = siteref.validated_legacy_ref(args.legacy_ref)
                try:
                    computed = siteref.legacy_site_only_ref(args.site)
                except siteref.LegacyRefNeedsDatabase:
                    computed = None
                if computed is not None and computed != legacy:
                    print(f"refused: for this plain-ASCII name the database derives {computed}, not {legacy}; the name or the reference is wrong. "
                          f"Nothing was written.", file=sys.stderr)
                    return 2
            else:
                legacy = siteref.legacy_site_only_ref(args.site)
            added = siteref.add_alias(where, legacy, keyed)
        except (siteref.SiteRefError, AliasFileUnreadable) as exc:
            print(f"refused: {exc}", file=sys.stderr)
            return 2
        print(f"{'recorded' if added else 'already recorded'}: {legacy} (unsalted) -> {keyed} (keyed) in {where}")
        print("  from now on the ledger reads both as one site; the chained ledger file itself is not edited.")
        return 0

    if args.cal_cmd == "keys":
        for k in all_keys():
            print(f"  {k:48s} {label(k)}")
        return 0

    if args.cal_cmd == "show":
        try:
            led = load_ledger()
        except AliasFileUnreadable as exc:           # the site count rests on the aliases; a damaged file stops it rather than count a site twice
            print(f"refused: {exc}\nFix or remove the alias file (`gridforge calibrate where` reports it).", file=sys.stderr)
            return 2
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
        siteref.check_argv_text(args.site)
        siteref.check_argv_text(args.hall)
        key, source = siteref.resolve_key()
        ledger_file = Path(args.ledger) if args.ledger else private_path()
        # The ledger may already hold this site under its UNSALTED reference (a row from before migration 0053). Writing the keyed one beside it would
        # silently make one site count as two, so it is refused until the operator declares them one site. For a name whose unsalted reference cannot
        # be computed here (non-ASCII), the check cannot be made: say so, and let --legacy-ref make it.
        try:
            legacy = siteref.validated_legacy_ref(args.legacy_ref) if args.legacy_ref else siteref.legacy_site_only_ref(args.site)
        except siteref.LegacyRefNeedsDatabase:
            legacy = None
            siteref.warn(f"cannot check whether {args.site!r} is already in this ledger under its UNSALTED reference: the name is not plain ASCII and the "
                         f"database's lower-casing differs from Python's. If it may be, get the reference from the database (--legacy-ref; see "
                         f"`gridforge calibrate alias`) or this row may count the site twice.")
        if legacy and legacy not in site_aliases(ledger_file) and any(o.site == legacy for o in _read(ledger_file)):
            print(f"refused: this ledger already holds {args.site!r} under its UNSALTED site reference ({legacy}). Recording the keyed reference "
                  f"beside it would make one site count as two. Declare them one site first: `gridforge calibrate alias --site {args.site!r}`. "
                  f"Nothing was written.", file=sys.stderr)
            return 2
        note = siteref.key_warning(source)
        if note:
            siteref.warn(note)
        obs = Observation(
            key=args.key, site_ref=siteref.keyed_site_ref(args.site, args.hall, key),
            predicted=float(args.predicted), observed=float(args.observed),
            unit=args.unit, observed_on=args.on,
            evidence=_EvidenceClass[args.evidence], method=args.method,
            platform=args.platform or "", note=args.note or "",
            kind=args.kind, source_ref=args.source_ref or "", model_digest=args.model_digest or "",
            reviewed_by=args.reviewed_by or "", reviewed_at=args.reviewed_at or "",
            # A hand-typed entry is a fixture, not a reviewed measurement: it is marked so, and it is not publishable
            # unless it names the reviewed artifact it came from.
            source="cli", published=bool(args.source_ref))
    except KeyError:
        print(f"unknown evidence class {args.evidence!r}", file=sys.stderr)
        return 2
    except (ObservationError, siteref.SiteRefError) as exc:           # includes AliasFileUnreadable
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
    if not obs.source_ref:
        print("  NOTE: self-entered (source 'cli', published=False): no source reference, so this row cannot be "
              "traced to a reviewed artifact and is not publishable. Reviewed measurements arrive through "
              "`gridforge calibrate import`.")
    return 0


def cmd_calibration(args) -> int:
    """Observation records for the residual framework: ingest as draft, review by a second person, report.

    Output is counts and states only. With nothing approved it says so plainly; it never invents a number.
    Exit 0 ok, 2 refusal (nothing written), 3 the store failed its hash-chain check (nothing read or written).
    """
    from .calibration import residuals, store
    from .calibration.ledger import LedgerIntegrityError
    from .calibration.records import VARIABLES
    from .calibration.schema import ObservationError
    try:
        path = store.store_path()
        if args.cal_action == "ingest":
            try:
                doc = json.loads(Path(args.file).read_text(encoding="utf-8"))
            except (OSError, ValueError) as exc:
                print(f"refused: cannot read {args.file}: {exc}", file=sys.stderr)
                return 2
            rows = doc.get("records") if isinstance(doc, dict) else doc
            if not isinstance(rows, list):
                print("refused: expected a JSON list of records, or {\"records\": [...]}", file=sys.stderr)
                return 2
            out = store.ingest(rows, submitter=args.submitter)
            print(f"ingested {out['stored']} record(s) as draft; {out['duplicates_skipped']} duplicate(s) skipped "
                  f"(of {out['submitted']} submitted) -> {out['path']}")
            print("Drafts change no statistic. A second person must approve each with `gridforge calibration review`.")
            return 0
        if args.cal_action == "review":
            decision = "approved" if args.approve else "rejected"
            out = store.review(args.id, decision, reviewer=args.reviewer, reason=args.reason)
            print(f"{out['observation_id']}: {out['previous_status']} -> {out['status']} "
                  f"(recorded as a new entry; history is not edited)")
            return 0
        stored = store.load_all()
        counts = residuals.pending_counts([s.record for s in stored])
        if args.cal_action == "pending":
            drafts = [s for s in stored if s.record.approval_status == "draft"]
            print(f"{len(drafts)} draft record(s) awaiting review "
                  f"({counts['approved']} approved, {counts['rejected']} rejected).")
            for s in drafts:
                print(f"  {s.record.observation_id}  variable={s.record.variable}  site={s.record.site_id}  "
                      f"submitted_by={s.submitted_by}")
            return 0
        # report
        approved = residuals.approved([s.record for s in stored])
        rep = residuals.residual_report(approved)
        n_sites = len({r.site_id for r in approved})
        if args.json:
            print(json.dumps({"n_records": len(approved), "n_sites": n_sites, "record_counts": counts,
                              "report": rep}, indent=2, sort_keys=True))
            return 0
        print(f"records: {counts['approved']} approved, {counts['draft']} draft, {counts['rejected']} rejected "
              f"({n_sites} site(s) among the approved).")
        if not approved:
            print("No variable is calibrated: there are no approved records, so accuracy is unquantified and every "
                  "figure remains modelled.")
        calibrated = sorted(v for sub in rep["subsystems"].values() for v, b in sub["variables"].items()
                            if b["state"] == residuals.CALIBRATED)
        for sub, body in rep["subsystems"].items():
            print(f"  {body['statement']}")
            for v, b in body["variables"].items():
                if b["approved_observations"]:
                    print(f"    {v:24s} {b['state']:12s} n={b['approved_observations']}  "
                          f"sites={b['distinct_sites']}  still needed: {b['still_needed']['observations']} "
                          f"observation(s), {b['still_needed']['sites']} site(s)")
        if approved:
            print(f"{len(calibrated)} of {len(VARIABLES)} variable(s) calibrated"
                  + (f": {', '.join(calibrated)}." if calibrated else "; none."))
        return 0
    except LedgerIntegrityError as exc:
        print(f"record store integrity failure: {exc}", file=sys.stderr)
        print("Nothing was read or written. Restore the file from a backup or investigate who changed it; "
              "do not edit it by hand.", file=sys.stderr)
        return 3
    except ObservationError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        print("Nothing was written.", file=sys.stderr)
        return 2


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


def _spec_lead_basis(pkg) -> dict:
    """date_basis / date_evidence_class / date_binding_item / date_label for the specification's modelled lead
    time: an assumed lead time (E0) is labelled as one."""
    from .envelope.time_to_power import NO_DATE, date_basis_of
    if pkg.lead_time_weeks is None:
        return NO_DATE.to_dict()
    return date_basis_of(pkg.lead_time_weeks.evidence, pkg.constraint_name).to_dict()


def cmd_spec(args) -> int:
    """A tender-ready specification for one relief, and the template for responses."""
    from .procurement import ProcurementError, build_spec, relief_steps
    from .reporting.spec import build as build_spec_report

    intake = load(args.intake)
    results = _run(intake)
    objective = OBJECTIVES[args.objective]
    rec = _pick_recommended(results, objective)
    result = next((r for r in results if r.spec.id == args.scenario), rec) \
        if args.scenario else rec

    if args.list:
        steps = relief_steps(result)
        if not steps:
            print(f"{result.spec.name}: no relief on this ladder is a purchase.")
            return 0
        # Aggregated by constraint, not one line per rung. The same constraint
        # binds several times as the ladder climbs, and you tender for the
        # constraint once — for the hall's end state — not once per rung.
        agg: dict[str, dict] = {}
        for st in steps:
            a = agg.setdefault(st.binding_id, {
                "racks": 0, "rungs": 0, "key": st.cost_key or "—",
                "relief": st.relief_description or "", "capex": 0.0})
            a["racks"] += st.racks_unlocked
            a["rungs"] += 1
            if st.capex_eur is not None:
                a["capex"] += st.capex_eur.value
        print(f"{result.spec.name} — reliefs that can be tendered:")
        print(f"  {'constraint':26s} {'unlocks':>8s} {'rungs':>6s}  {'cost key':24s} relief")
        for cid, a in sorted(agg.items(), key=lambda kv: -kv[1]["racks"]):
            print(f"  {cid:26s} {a['racks']:8d} {a['rungs']:6d}  "
                  f"{a['key']:24s} {a['relief']}")
        print(f"\n  gridforge spec {args.intake} --constraint <id> -o out")
        return 0

    try:
        pkg = build_spec(intake, result, constraint_id=args.constraint)
    except ProcurementError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2

    out = Path(args.out)
    report = build_spec_report(pkg, reference=args.reference, return_by=args.return_by,
                               contact=args.contact, claims=collect_claims(results))
    w = _emit(report, out, "specification", claims=collect_claims(results))

    # The machine-readable response template. A supplier fills this in and
    # `gridforge bids` reads it back — which is how a quotation becomes a dated,
    # attributable cost-library line instead of a PDF in somebody's inbox.
    template = {
        "specification": {"project": pkg.project, "hall": pkg.hall,
                          "constraint": pkg.constraint_id,
                          "sized_for_racks": pkg.sized_for_racks,
                          "reference": args.reference,
                          **_spec_lead_basis(pkg),
                          "site_conditions": [c.to_dict() for c in pkg.site_conditions],
                          "assumed_inputs": [a.to_dict() for a in pkg.assumed_inputs]},
        "supplier": "",
        "received_on": "",
        "reference": "",
        "valid_until": "",
        "currency": "",          # a priced response names its currency; one without is disqualified (same slot as the API template)
        "values": {f.key: None for f in pkg.response_fields},
        "compliance": {q.id: "" for q in pkg.mandatory()},
        "text": {"exclusions": "", "long_lead_item": ""},
    }
    tpath = out / "response_template.json"
    tpath.write_text(json.dumps(template, indent=2) + "\n")
    w.paths.append(tpath)

    print(f"Specification — {pkg.relief_title}: {len(pkg.requirements)} requirements "
          f"({len(pkg.mandatory())} mandatory), sized for {pkg.sized_for_racks} racks.")
    if pkg.budget_eur is not None:
        print(f"  modelled budget {pkg.budget_eur.render()}; a response far from this is "
              f"answering a different question.")
    w.report()
    return 0


def cmd_bids(args) -> int:
    """Compare responses in racks and weeks, and turn them into cost-library lines."""
    from .procurement import ProcurementError, SupplierResponse, build_spec, rank_bids
    from .procurement.evaluate import schedule_impact
    from .procurement.ingest import command_lines, cost_entries_from

    intake = load(args.intake)
    results = _run(intake)
    objective = OBJECTIVES[args.objective]
    result = next((r for r in results if r.spec.id == args.scenario),
                  _pick_recommended(results, objective)) if args.scenario \
        else _pick_recommended(results, objective)
    try:
        pkg = build_spec(intake, result, constraint_id=args.constraint)
    except ProcurementError as exc:
        print(f"refused: {exc}", file=sys.stderr)
        return 2

    responses = []
    for path in args.responses:
        p = Path(path)
        if not p.exists():
            print(f"no such response file: {path}", file=sys.stderr)
            return 2
        try:
            responses.append(SupplierResponse.from_dict(json.loads(p.read_text())))
        except json.JSONDecodeError as exc:
            print(f"{path}: not valid JSON ({exc})", file=sys.stderr)
            return 2
        except ProcurementError as exc:
            print(f"{path}: {exc}", file=sys.stderr)
            return 2

    ranked = rank_bids(pkg, responses)
    print(f"{pkg.relief_title} — {len(ranked)} response(s), sized for "
          f"{pkg.sized_for_racks} racks\n")
    for i, a in enumerate(ranked, 1):
        print(f"{i}. {a.headline()}")
        print(f"     {schedule_impact(pkg, a)}")
        if a.eur_per_rack:
            print(f"     EUR {a.eur_per_rack:,.0f} per rack enabled")
        for n in a.notes:
            print(f"     - {n}")
        print()

    best = next((a for a in ranked if not a.disqualified and a.compliant), None)
    if best is None:
        print("No compliant response. Nothing here can be recommended.")
        return 0

    print(f"On the numbers this tool can judge, {best.supplier} leads. Installation "
          f"method and evidence quality are 15 points that an engineer scores, not this.")

    if args.ingest:
        try:
            entries = cost_entries_from(pkg, next(r for r in responses
                                                  if r.supplier == best.supplier),
                                        basis=args.basis, region=args.region)
        except ProcurementError as exc:
            print(f"\ncannot make a cost-library line from it: {exc}", file=sys.stderr)
            return 2
        print("\nThis response is a dated, attributable price. Putting it in the library "
              "raises the evidence class of every study that touches this line:\n")
        for line in command_lines(entries, library=args.library or ""):
            print(line)
            print()
        print("Review before you run it. A price that enters the library unreviewed is "
              "one nobody can defend when a client asks where it came from.")
    return 0


def cmd_reference(args) -> int:
    """The public constraint reference, as data the website renders.

    Emitting it as a file rather than serving it live is deliberate: the pages are
    the most-read thing we publish and they must not depend on the engine being up.
    The drift guard in CI keeps the committed copy honest.
    """
    from .reference import platform_payload, reference_payload

    if args.ref_cmd == "platforms":
        payload = platform_payload()
    else:
        payload = reference_payload()

    out = json.dumps(payload, indent=2) + "\n"
    if args.out:
        Path(args.out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.out).write_text(out)
        print(f"wrote {args.out}")
        return 0
    if args.json:
        print(out)
        return 0

    if args.ref_cmd == "platforms":
        print(f"{'platform':22s} {'rack kW':>8s} {'liquid':>7s} {'air kW':>7s} "
              f"{'inlet C':>8s} {'kg/m2':>7s} status")
        for pl in payload["platforms"]:
            print(f"{pl['name']:22s} {pl['rack_kW']:8} {pl['liquid_fraction']:7} "
                  f"{pl['residual_air_kW']:7} {pl['max_inlet_liquid_C']:8} "
                  f"{pl['floor_loading_kg_per_m2']:7} {pl['status']}")
        print("\nDeliberately absent:")
        for k, why in payload["deliberately_absent"].items():
            print(f"  {k}: {why}")
        return 0

    print(f"{payload['count']} constraints published\n")
    for c in payload["constraints"]:
        lead = c["lead_time_weeks"]
        weeks = f"{lead['low']}-{lead['high']}w" if lead else "—"
        print(f"  {c['domain']:10s} {c['id']:24s} {weeks:>9s}  {c['headline'][:70]}")
    return 0


def cmd_serve(args) -> int:
    from .api.server import serve
    serve(args.host, args.port)
    return 0


def cmd_compare(args) -> int:
    """Time-to-Power scenario comparison. Calls the very handler POST /v1/compare calls, so the terminal, the API and
    the website cannot disagree: same inputs, same numbers, same digest."""
    from .api.server import ApiError, handle_compare
    from .api.tiers import Tier
    doc = json.loads(Path(args.intake).read_text())
    # Accepts a bare intake, or the request document the website and the API use ({"intake": {...}, ...}), so the
    # request.json the site offers for download reproduces here unchanged. Flags given on the command line win.
    body = dict(doc) if isinstance(doc.get("intake"), dict) else {"intake": doc}
    if args.objective:
        body["objective"] = args.objective
    if args.scenarios:
        body["scenarios"] = args.scenarios
    if args.baseline:
        body["baseline"] = args.baseline
    try:
        out = handle_compare(body, Tier.CLIENT)
    except ApiError as exc:
        print(f"cannot compare: {exc.message}" + (f" {json.dumps(exc.extra)}" if exc.extra else ""), file=sys.stderr)
        return 2
    path = Path(args.out)
    path.mkdir(parents=True, exist_ok=True)
    (path / "ttp_compare.json").write_text(json.dumps(out, indent=2, sort_keys=True) + "\n")
    print(f"Time-to-Power comparison — {out['project'].get('client', '')} ({out['grade']}; baseline {out['baseline']})")
    for r in out["scenarios"]:
        t = r["time_to_power"]
        date = (f"{t['weeks']:g} wk ({t['low']:g}-{t['high']:g}, {t['evidence']})"
                + (" — assumed lead time, not a date" if t.get("date_basis") == "assumed" else "")
                if t["weeks"] is not None else f"no date — {t['reason']}")
        print(f"  {r['id']:<13} {r['after_ladder']['racks']:>4} racks  {date}")
    rk = out["ranking"]
    print(f"  ranking on {rk['objective']}: " + (", ".join(rk["order"]) or "nothing can be ranked") +
          (f"  — leader {rk['leader']}" if rk["leader"] else ""))
    print(f"  digest {out['request_digest'][:16]}  wrote {path / 'ttp_compare.json'}")
    return 0


def cmd_portfolio(args) -> int:
    objective = OBJECTIVES[args.objective]
    entries = []
    from .reporting.portfolio_guard import hall_key, identical_physics_warning, is_repeat, physics_fingerprint
    seen: dict[tuple[str, str], tuple[str, dict]] = {}
    prints: dict[str, int] = {}
    for p in args.intakes:
        intake = load(p)
        raw = json.loads(Path(p).read_text(encoding="utf-8"))
        key = hall_key(intake.context.site.id, intake.context.hall.id)
        if key in seen and is_repeat(raw, seen[key][1]):
            print(f"error: {p} repeats site {key[0]!r} hall {key[1]!r} (already {seen[key][0]}): a hall counts once, so its capacity would be "
                  "added twice. Remove the repeat, or give genuinely different halls different site.id and hall.id.", file=sys.stderr)
            return 2
        seen.setdefault(key, (p, raw))
        fp = physics_fingerprint(raw)
        if fp is not None:
            if fp in prints:
                print("warning: " + identical_physics_warning(len(entries), prints[fp]).replace("intakes[", "input #["), file=sys.stderr)
            else:
                prints[fp] = len(entries)
        entries.append(SiteEntry(intake=intake, results=_run(intake), objective=objective))
    report = build_portfolio(entries, client=args.client, objective=objective)
    out = Path(args.out)
    claims = collect_claims([r for e in entries for r in e.results])
    w = _emit(report, out, "portfolio_screen", claims=claims)
    for e in entries:
        stem = f"{e.intake.context.site.id}_{e.intake.context.hall.id}".replace("/", "-")
        write_model_pack(out / f"model_pack_{stem}.json", e.intake, e.results)
        w.paths.append(out / f"model_pack_{stem}.json")
    # The headline is the COMPARABLE total, never a bare sum: a hall with a required input missing or an equipment bank undeclared is
    # ranked on assumptions, and a hall on a connection another hall shares is counted once per hall (reporting/portfolio.py).
    from .reporting.portfolio import portfolio_summary, portfolio_warnings, rank, sharing_statements
    summary = portfolio_summary(entries, objective)
    shares_a_connection = bool(sharing_statements(rank(entries, objective)))
    left_out = len(summary["incomparable_halls"])
    if summary["comparable_total_racks"] is None:
        headline = (f"Portfolio Screen — {len(entries)} halls; none can be compared yet (a required input or an equipment bank is "
                    "missing), so no portfolio total is stated.")
    else:
        headline = (f"Portfolio Screen — {len(entries)} halls, {summary['comparable_total_racks']} deployable racks across the "
                    f"{len(entries) - left_out} comparable"
                    + (f"; {left_out} not comparable and left out of that total." if left_out else "."))
    if shares_a_connection:
        headline += (" That is an upper bound: halls on one grid connection are counted once each, and the engine does not model the shared "
                     "connection (see the warnings below).")
    print(headline)
    for message in portfolio_warnings(entries, objective):
        print("warning: " + message, file=sys.stderr)
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
        s.add_argument("--cost-evidence", dest="cost_evidence", metavar="FILE",
                       help="accepted supplier cost evidence (JSON list of cost lines) to apply to THIS run only; "
                            "lines that are not accepted, have expired or are superseded are named and ignored")
        s.add_argument("intake")
        s.add_argument("-o", "--out", default="out")
        s.add_argument("--objective", default="max_compute", choices=sorted(OBJECTIVES))
        s.add_argument("--csv", action="store_true",
                       help="also write the working files, so the client's engineers can check "
                            "the arithmetic in a spreadsheet")
        s.set_defaults(func=_with_evidence(fn))

    s = sub.add_parser("power-assess",
                       help="the Power Readiness Case: current capacity, binding constraint, "
                            "priced headroom ladder, time to power, evidence and next action")
    s.add_argument("intake")
    s.add_argument("-o", "--out")
    s.add_argument("--objective", default="max_compute", choices=sorted(OBJECTIVES))
    s.add_argument("--target-racks", type=int, default=None,
                   help="the rack count the customer needs; omit to size the gap against "
                        "what the full headroom ladder itself can reach")
    s.set_defaults(func=cmd_power_assess)

    s = sub.add_parser("power-deploy-assess",
                       help="the BTM Power Deployment Assessment: architectures (grid/BESS/"
                            "generation) compared under a real load profile and a real "
                            "contingency test, each priced and dated where declared")
    s.add_argument("request", help="a deployment request JSON file (the same body the "
                                   "Power Deployment Assessment endpoint accepts)")
    s.add_argument("-o", "--out")
    s.set_defaults(func=cmd_power_deploy_assess)

    s = sub.add_parser("power-deploy-spec",
                       help="a tender-ready specification for a BTM architecture's "
                            "generation and storage units — what 'proceed to procurement' "
                            "in power-deploy-assess's next action produces")
    s.add_argument("request", help="a deployment request JSON file (same shape as "
                                   "power-deploy-assess)")
    s.add_argument("-o", "--out", default="out")
    s.add_argument("--architecture", default="Declared architecture",
                   help="label for the document title only")
    s.add_argument("--project", default="Power Deployment Case")
    s.add_argument("--reference", default="")
    s.set_defaults(func=cmd_power_deploy_spec)

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
                   help="library_default | published_benchmark | engineering_estimate | "
                        "budgetary_quote | firm_quote | contracted")
    s.add_argument("--supplier")
    s.add_argument("--quoted-on", dest="quoted_on", help="ISO date of the quotation")
    s.add_argument("--valid-until", dest="valid_until")
    s.add_argument("--region")
    s.add_argument("--project")
    s.add_argument("--note")
    s.add_argument("--source")
    s.add_argument("--quoted-quantity", dest="quoted_quantity", type=float,
                   help="for a lump (EUR) quotation: the quantity it covers, in the unit the engine prices the line in")
    s.add_argument("--quoted-quantity-unit", dest="quoted_quantity_unit")
    s.add_argument("--library",
                   help="path to a cost library JSON (default: your private, gitignored one)")
    s.add_argument("--bundled", action="store_true",
                   help="write to the committed seed instead. Refuses quotations: the seed may "
                        "hold only placeholders and published benchmarks.")
    s.set_defaults(func=cmd_cost)

    s = sub.add_parser("calibrate",
                       help="the accuracy record: model vs what the site turned out to be")
    s.add_argument("cal_cmd", choices=["show", "add", "keys", "where", "import", "alias"])
    s.add_argument("--legacy-ref", default="",
                   help="alias/add: the site's UNSALTED reference (site_ + 12 hex) as the DATABASE derives it. Required for a non-ASCII --site (Python cannot know "
                        "how the database lower-cases it); the database expression is printed when it is needed.")
    s.add_argument("--none-needed", action="store_true",
                   help="alias: record, dated, that no site spans the migration-0053 boundary, so `import` needs no further decision")
    s.add_argument("--accept-mixed-refs", action="store_true",
                   help="import: for THIS import only, accept that a site under both an unsalted and a keyed reference counts as two sites")
    s.add_argument("export", nargs="?", default="",
                   help="import: the admin calibration export (GET /api/admin/calibration-export), saved as JSON")
    s.add_argument("--kind", default="measured",
                   help="measured only: 'quoted' and 'declared' are refused (a quote or an assumption is not a "
                        "measurement)")
    s.add_argument("--source-ref", default="",
                   help="'<observation id>:<evidence sha256>'; without it the entry is self-entered and unpublished")
    s.add_argument("--model-digest", default="", help="engine provenance digest of the prediction checked")
    s.add_argument("--reviewed-by", default="", help="self-asserted reviewer name")
    s.add_argument("--reviewed-at", default="", help="ISO date or timestamp of the review")
    s.add_argument("--key", default="", help="`gridforge calibrate keys` lists them")
    s.add_argument("--site", default="",
                   help="client site name — hashed with a secret (GRIDFORGE_SITE_REF_SECRET, else GRIDFORGE_KEY_SECRET), never stored. "
                        "alias: declares the site's unsalted (pre-0053) and keyed references to be one site. Rotating the secret changes every reference.")
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

    s = sub.add_parser("calibration",
                       help="observation records: ingest as draft, review by a second person, report residuals")
    cal = s.add_subparsers(dest="cal_action", required=True)
    c = cal.add_parser("ingest", help="validate a JSON file of records and store them as draft (all or nothing)")
    c.add_argument("file")
    c.add_argument("--submitter", default="", help="who is submitting; they cannot later approve these records")
    c = cal.add_parser("review", help="approve or reject one stored record (appends; never edits history)")
    c.add_argument("id", help="the record's observation_id")
    g = c.add_mutually_exclusive_group(required=True)
    g.add_argument("--approve", action="store_true")
    g.add_argument("--reject", action="store_true")
    c.add_argument("--reviewer", default="", help="the reviewer's name (required; not the submitter, to approve)")
    c.add_argument("--reason", default="", help="why (required)")
    c = cal.add_parser("report", help="residual statistics over APPROVED records, per subsystem")
    c.add_argument("--json", action="store_true")
    cal.add_parser("pending", help="records still awaiting review")
    s.set_defaults(func=cmd_calibration)

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
    s.add_argument("--scope", default="machine", choices=["machine", "client", "trial", "payg"])
    s.add_argument("--days", default="35",
                   help="validity. 35 by default so a monthly renewal never leaves a "
                        "customer's agents dark while the webhook lands.")
    s.set_defaults(func=cmd_key)

    s = sub.add_parser("spec", help="a tender-ready specification for one relief")
    s.add_argument("intake")
    s.add_argument("-o", "--out", default="out")
    s.add_argument("--constraint", default="",
                   help="which constraint to tender for (default: the first purchasable rung)")
    s.add_argument("--scenario", default="", help="scenario id (default: the recommended one)")
    s.add_argument("--objective", default="max_compute", choices=sorted(OBJECTIVES))
    s.add_argument("--reference", default="", help="your tender reference")
    s.add_argument("--return-by", dest="return_by", default="")
    s.add_argument("--contact", default="")
    s.add_argument("--list", action="store_true",
                   help="list the reliefs on this ladder that can be tendered, and stop")
    s.set_defaults(func=cmd_spec)

    s = sub.add_parser("bids", help="compare supplier responses in racks, weeks and euros")
    s.add_argument("intake")
    s.add_argument("responses", nargs="+", help="completed response_template.json files")
    s.add_argument("--constraint", default="")
    s.add_argument("--scenario", default="")
    s.add_argument("--objective", default="max_compute", choices=sorted(OBJECTIVES))
    s.add_argument("--ingest", action="store_true",
                   help="print the cost-library commands the winning response implies")
    s.add_argument("--basis", default="budgetary_quote",
                   help="budgetary_quote | firm_quote | contracted")
    s.add_argument("--region", default="")
    s.add_argument("--library", default="")
    s.set_defaults(func=cmd_bids)

    s = sub.add_parser("reference",
                       help="the public constraint reference and platform library")
    s.add_argument("ref_cmd", nargs="?", default="constraints",
                   choices=["constraints", "platforms"])
    s.add_argument("--json", action="store_true")
    s.add_argument("-o", "--out", help="write the JSON payload here")
    s.set_defaults(func=cmd_reference)

    s = sub.add_parser("serve", help="run the HTTP API (stdlib only, no dependencies)")
    s.add_argument("--host", default="0.0.0.0")
    s.add_argument("--port", type=int, default=8080)
    s.set_defaults(func=cmd_serve)

    s = sub.add_parser("compare", help="Time-to-Power scenario comparison: dates only where lead times support them")
    s.add_argument("intake")
    s.add_argument("-o", "--out", default="out")
    s.add_argument("--objective", default=None, choices=sorted(OBJECTIVES),
                   help="what to rank by (default: max_compute, or the objective in a request file)")
    s.add_argument("--scenarios", nargs="+", metavar="ID", help="scenario ids to compare (default: all the intake defines)")
    s.add_argument("--baseline", metavar="ID", help="scenario the others are compared with (default: the first)")
    s.set_defaults(func=cmd_compare)

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
