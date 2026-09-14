"""The walkthrough deck.

The Envelope Study includes a 90-minute session with the client's engineering team,
and that session is where the follow-on engagement is won or lost. This generates
the deck for it from the same solved model as the document, so the slide and the
report can never disagree — a walkthrough that contradicts the deliverable is worse
than no walkthrough.

Self-contained HTML: arrow keys to advance, and a print stylesheet that turns each
slide into one landscape page so `Print to PDF` produces something sendable. No
dependencies, no fonts to fetch, no script from anywhere.

Chart colours are deliberately NOT the brand accents. #00E5FF and #FFB020 are
interface colours; as data marks against the panel surface they sit outside the
usable lightness band. The two steps below are the same hues, dimmed until they
pass the lightness, chroma, colour-vision-separation and contrast checks. Every
value they encode is also printed as a label, so nothing depends on colour alone.
"""
from __future__ import annotations

import html
from dataclasses import dataclass, field
from ..clock import report_date_iso

from ..common import ESTIMATED, V
from ..envelope.time_to_power import TimeToPower, schedule
from ..intake.loader import Intake
from ..scenario.run import ScenarioResult
from .study import Objective, _pick_recommended

MARK = "#1193A8"       # capacity — dimmed step of the brand's `power`
MARK_ALT = "#BD8318"   # delay    — dimmed step of the brand's `queue`


@dataclass
class Slide:
    kicker: str
    title: str
    lead: str = ""
    bullets: list[str] = field(default_factory=list)
    figures: list[tuple[str, str, str]] = field(default_factory=list)  # label, value, note
    table: tuple[list[str], list[list[str]]] | None = None
    svg: str = ""
    note: str = ""


@dataclass
class Deck:
    title: str
    subtitle: str
    slides: list[Slide] = field(default_factory=list)
    footer: str = ""


# --- charts ------------------------------------------------------------------
def _energisation_svg(t: TimeToPower) -> str:
    """Racks energised against elapsed weeks. A step chart, because capacity arrives
    in discrete unlocks rather than continuously."""
    # One point per distinct week, keeping the highest rack count at that week.
    # Several ladder steps routinely complete in the same week; plotting each of
    # them stacks a column of dots on one x position, which reads as noise and
    # implies events the client will never experience. What they experience is a
    # date on which capacity arrives.
    by_week: dict[float, float] = {0.0: float(t.racks_now)}
    for p in t.points:
        by_week[p.weeks] = max(by_week.get(p.weeks, 0.0), float(p.racks))
    pts = sorted(by_week.items())
    if len(pts) < 2 or t.max_racks <= 0:
        return ""
    w, h = 900, 350
    ml, mr, mt, mb = 64, 132, 40, 52        # room for the outermost labels
    x_max = max(p[0] for p in pts) or 1.0
    y_max = max(p[1] for p in pts) or 1.0
    px = lambda x: ml + (x / x_max) * (w - ml - mr)          # noqa: E731
    py = lambda y: h - mb - (y / y_max) * (h - mt - mb)      # noqa: E731

    grid, ticks = [], []
    for i in range(5):
        y = y_max * i / 4
        gy = py(y)
        grid.append(f'<line x1="{ml}" y1="{gy:.1f}" x2="{w - mr}" y2="{gy:.1f}" '
                    f'stroke="#1E2942" stroke-width="1"/>')
        ticks.append(f'<text x="{ml - 10}" y="{gy + 4:.1f}" text-anchor="end" '
                     f'class="ax">{y:.0f}</text>')
    for i in range(5):
        x = x_max * i / 4
        ticks.append(f'<text x="{px(x):.1f}" y="{h - mb + 20:.1f}" text-anchor="middle" '
                     f'class="ax">{x:.0f}</text>')

    d = [f"M {px(pts[0][0]):.1f} {py(pts[0][1]):.1f}"]
    for i in range(1, len(pts)):
        d.append(f"H {px(pts[i][0]):.1f}")
        d.append(f"V {py(pts[i][1]):.1f}")
    line = " ".join(d)
    area = (f"{line} L {px(pts[-1][0]):.1f} {h - mb} L {px(pts[0][0]):.1f} {h - mb} Z")

    marks = []
    for x, y in pts:
        if y <= 0:
            continue
        marks.append(f'<circle cx="{px(x):.1f}" cy="{py(y):.1f}" r="5" fill="{MARK}" '
                     f'stroke="#0E1524" stroke-width="2"><title>{y:.0f} racks at week '
                     f'{x:.0f}</title></circle>')

    first = next((p for p in pts if p[1] > 0), None)
    labels = []
    if first:
        labels.append(f'<text x="{px(first[0]) + 12:.1f}" y="{py(first[1]) - 12:.1f}" '
                      f'class="lbl">{first[1]:.0f} racks · week {first[0]:.0f}</text>')
    lx, ly = pts[-1]
    labels.append(f'<text x="{px(lx) + 14:.1f}" y="{py(ly) + 4:.1f}" class="lbl big">'
                  f'{ly:.0f} racks</text>')
    labels.append(f'<text x="{px(lx) + 14:.1f}" y="{py(ly) + 24:.1f}" class="lbl dim">'
                  f'week {lx:.0f}</text>')

    return f'''<svg viewBox="0 0 {w} {h}" role="img"
  aria-label="Racks energised against elapsed weeks. {ly:.0f} racks at week {lx:.0f}.">
  <style>
    .ax{{fill:#5A6478;font:500 12px ui-monospace,monospace}}
    .lbl{{fill:#F5F7FA;font:600 13px ui-monospace,monospace}}
    .lbl.big{{font-size:20px}} .lbl.dim{{fill:#8A94A6;font-weight:500}}
    .cap{{fill:#8A94A6;font:500 12px ui-monospace,monospace}}
  </style>
  {''.join(grid)}
  <path d="{area}" fill="{MARK}" fill-opacity="0.12"/>
  <path d="{line}" fill="none" stroke="{MARK}" stroke-width="2" stroke-linejoin="round"/>
  {''.join(marks)}{''.join(ticks)}{''.join(labels)}
  <text x="{ml}" y="{h - 8}" class="cap">elapsed weeks — reliefs run in parallel</text>
  <text x="{ml - 54}" y="16" class="cap">racks energised</text>
</svg>'''


def _architectures_svg(results: list[ScenarioResult]) -> str:
    """One measure across five architectures, so one hue and a value on every bar."""
    def short(name: str) -> str:
        return name if len(name) <= 40 else name[:39].rstrip(" ,-") + "…"

    rows = [(short(r.spec.name), r.unlocked_racks) for r in results]
    if not rows:
        return ""
    top = max(v for _, v in rows) or 1
    bar_h, gap = 34, 14
    w = 900
    ml, mr, mt = 372, 108, 12
    h = mt + len(rows) * (bar_h + gap)
    out = []
    for i, (name, val) in enumerate(rows):
        y = mt + i * (bar_h + gap)
        bw = max(2.0, (val / top) * (w - ml - mr))
        out.append(f'<text x="{ml - 16}" y="{y + bar_h / 2 + 5:.0f}" text-anchor="end" '
                   f'class="cat">{html.escape(name)}</text>')
        out.append(f'<rect x="{ml}" y="{y}" width="{bw:.1f}" height="{bar_h}" rx="4" '
                   f'fill="{MARK}"><title>{name}: {val} racks</title></rect>')
        out.append(f'<text x="{ml + bw + 12:.1f}" y="{y + bar_h / 2 + 5:.0f}" class="val">'
                   f'{val}</text>')
    return f'''<svg viewBox="0 0 {w} {h}" role="img"
  aria-label="Deployable racks by cooling architecture after the headroom ladder.">
  <style>
    .cat{{fill:#8A94A6;font:500 13px ui-monospace,monospace}}
    .val{{fill:#F5F7FA;font:600 15px ui-monospace,monospace}}
  </style>
  {''.join(out)}
</svg>'''


# --- the deck ----------------------------------------------------------------
def build(intake: Intake, results: list[ScenarioResult], *,
          objective: Objective = Objective.MAX_COMPUTE) -> Deck:
    ctx = intake.context
    rec = _pick_recommended(results, objective)
    t = schedule(rec.ladder)
    plat = ctx.cluster.platform
    econ = rec.economics
    d = Deck(
        title=f"{ctx.site.name} · hall {ctx.hall.id}",
        subtitle=(f"Capacity and density envelope · target platform {plat.name} · "
                  f"{len(results)} architectures compared"),
        footer=(f"{intake.client} · prepared {report_date_iso()} · modelled, not measured"),
    )

    d.slides.append(Slide(
        kicker="Walkthrough",
        title=f"How much AI compute can {ctx.hall.id} carry?",
        lead=("Thirteen constraints across electrical, thermal and physical domains, solved over "
              "one model of this hall. The envelope is the minimum; the binding constraint is the "
              "one that produced it."),
        note="Every figure in this deck carries an evidence class and comes from the same solved "
             "model as the written study."))

    d.slides.append(Slide(
        kicker="The answer",
        title=rec.envelope.binding.name,
        lead=rec.envelope.binding.basis + ".",
        figures=[
            ("Deployable today", str(rec.envelope.max_racks), "racks, as the hall stands"),
            ("After the ladder", str(rec.unlocked_racks), f"racks · {rec.spec.name}"),
            ("Time to full capacity",
             "—" if t.weeks_to_full is None else f"{t.weeks_to_full:.0f}",
             f"weeks · set by {t.critical_item.lower()}"),
        ]))

    ladder_rows = [[str(s.step), s.binding_name,
                    f"{s.racks_before} → {s.racks_after}",
                    (s.relief_description or "no relief available")[:64],
                    "—" if s.capex_eur is None else s.capex_eur.render(with_class=False),
                    "—" if s.lead_time_weeks is None else s.lead_time_weeks.render(with_class=False)]
                   for s in rec.ladder.steps[:8]]
    d.slides.append(Slide(
        kicker="What stops it",
        title="The headroom ladder",
        lead="Each row is what binds next, what moves it, and what that costs.",
        table=(["#", "Constraint", "Racks", "Relief", "Capex", "Lead time"], ladder_rows)))

    d.slides.append(Slide(
        kicker="When",
        title="Time to power",
        lead=("Reliefs run in parallel, so the racks unlocked by the first N steps arrive at the "
              f"longest lead time among them. One item sets the date: {t.critical_item.lower()}."),
        svg=_energisation_svg(t),
        note="Capacity arrives in steps, not continuously — each step is a constraint relieved."))

    d.slides.append(Slide(
        kicker="Architecture",
        title="The same connection, more compute",
        lead=("Every kilowatt the cooling architecture consumes is a kilowatt of contracted "
              "capacity that cannot be sold as compute."),
        svg=_architectures_svg(results)))

    mix = econ.cost_basis_mix or {}
    placeholders = mix.get("library_default", 0)
    total_lines = sum(mix.values())
    d.slides.append(Slide(
        kicker="Cost",
        title="What it takes, and how well we know it",
        figures=[
            ("Indicative capex", econ.capex_total_eur.render(with_band=False, with_class=False), ""),
            ("Per kW of IT", econ.capex_eur_per_kW_it.render(with_band=False, with_class=False), ""),
            ("Accuracy class", econ.aace_class.split(":")[0], econ.aace_class.split(":", 1)[-1]),
        ],
        lead=(f"{placeholders} of {total_lines} priced lines are library placeholders rather than "
              "quotations. That is why the accuracy class reads as it does — it follows the "
              "weakest line, not the average."
              if placeholders else
              "Every priced line rests on a quotation rather than a placeholder."),
        note="Excludes IT hardware, migration and lost tenancy revenue."))

    gaps = intake.report.gaps
    d.slides.append(Slide(
        kicker="Evidence",
        title="What nobody has measured yet",
        lead=(f"Intake is {intake.report.completeness:.0%} complete. Each of these moves the "
              "answer and is currently a library default."
              if gaps else "Every input below the headline was supplied rather than assumed."),
        table=(["Input", "Assumed", "Where it comes from"],
               [[g.label, g.fallback_description, g.how_to_get_it] for g in gaps[:8]])
        if gaps else None))

    d.slides.append(Slide(
        kicker="Recommendation",
        title=rec.spec.name,
        lead=rec.spec.rationale,
        bullets=[
            "Get the DSO position in writing on firm capacity and any flexibility product. It "
            "costs nothing but time and it can end the question.",
            "Commission a structural assessment of the floor and a hydraulic model of the "
            "secondary loop. Both are cheap relative to the decision and both can invalidate it.",
            "Place long-lead orders only after those clear — lead time, not construction, governs "
            "the programme.",
            "Instrument the hall and reconcile this model against twelve months of measured data "
            "before phase two. That is what moves these numbers from estimated to field-validated.",
        ]))

    d.slides.append(Slide(
        kicker="Boundary",
        title="What this is, and what it is not",
        bullets=[
            "An engineering opinion supported by a documented model. Not a design package, and it "
            "confers no design liability.",
            "No stamped drawings, no CFD of this hall, no equipment selection or bill of materials.",
            "The floor-loading check is a screening calculation; a structural engineer must sign "
            "it off.",
            "We quote no equipment and take no margin on hardware. Nothing here routes you to a "
            "supplier we are paid by.",
        ],
        note="Nothing in this deck is a measurement of this asset unless it is labelled E5 or "
             "above."))
    return d


# --- rendering ---------------------------------------------------------------
_CSS = """
*{box-sizing:border-box}
body{margin:0;background:#070B14;color:#F5F7FA;
  font:16px/1.55 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif}
.deck{max-width:1180px;margin:0 auto;padding:24px 20px 96px}
.slide{background:#0E1524;border:1px solid #1E2942;border-radius:10px;
  padding:40px 44px;margin-bottom:24px;min-height:560px;display:flex;flex-direction:column;gap:18px}
.kicker{font:600 11px/1 ui-monospace,monospace;letter-spacing:.18em;text-transform:uppercase;
  color:#00E5FF;margin:0}
h1{font-size:2rem;line-height:1.15;margin:0;font-weight:650;letter-spacing:-.015em;
  text-wrap:balance;max-width:24ch}
.slide h2{font-size:1.6rem;line-height:1.2;margin:0;font-weight:650;letter-spacing:-.01em;
  text-wrap:balance;max-width:32ch}
.lead{color:#8A94A6;margin:0;max-width:74ch;font-size:1.02rem}
.figs{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px;margin:4px 0}
.fig{border:1px solid #1E2942;background:#131C2E;border-radius:8px;padding:16px 18px}
.fig .k{font:600 10px/1 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;
  color:#5A6478}
.fig .v{font:650 2.1rem/1.1 ui-monospace,monospace;margin-top:8px;color:#F5F7FA;
  font-variant-numeric:tabular-nums}
.fig .n{color:#8A94A6;font-size:.85rem;margin-top:6px}
ul{margin:0;padding-left:1.1rem;max-width:76ch;color:#F5F7FA}
li{margin-bottom:.5rem}
.tw{overflow-x:auto;border:1px solid #1E2942;border-radius:8px;background:#131C2E}
table{border-collapse:collapse;width:100%;font-size:.86rem;font-variant-numeric:tabular-nums}
th{font:600 10px/1 ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase;
  color:#5A6478;text-align:left;padding:10px 14px;border-bottom:1px solid #1E2942;white-space:nowrap}
td{padding:9px 14px;border-bottom:1px solid #1E2942;color:#8A94A6;vertical-align:top}
td:nth-child(2){color:#F5F7FA}
tr:last-child td{border-bottom:none}
svg{width:100%;height:auto;max-width:100%}
.note{margin-top:auto;color:#5A6478;font-size:.8rem;border-top:1px solid #1E2942;padding-top:14px}
.deckhead{padding:44px 44px 8px}
.deckhead p{color:#8A94A6;margin:.6rem 0 0}
.count{position:fixed;right:16px;bottom:14px;font:600 11px ui-monospace,monospace;color:#5A6478;
  background:#0E1524;border:1px solid #1E2942;border-radius:99px;padding:6px 12px}
@media (max-width:700px){.slide{padding:26px 20px;min-height:0}h1{font-size:1.5rem}
  .slide h2{font-size:1.25rem}.fig .v{font-size:1.6rem}}
@media print{
  body{background:#fff;color:#111}
  .deck{max-width:none;padding:0}
  .slide{break-after:page;border:none;border-radius:0;background:#fff;min-height:0;
    padding:22mm 20mm;page-break-after:always}
  .slide:last-child{break-after:auto;page-break-after:auto}
  .kicker{color:#0a6f7f}.lead,.fig .n,td{color:#444}.fig .k,.note{color:#666}
  .fig,.tw{background:#fff;border-color:#ccc}th,td{border-color:#ddd}
  .count{display:none}
  @page{size:A4 landscape;margin:0}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
"""

_JS = """
(function(){
  var slides = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var counter = document.getElementById('count');
  function current(){
    var best = 0, bestTop = Infinity;
    slides.forEach(function(s, i){
      var top = Math.abs(s.getBoundingClientRect().top);
      if (top < bestTop) { bestTop = top; best = i; }
    });
    return best;
  }
  function show(i){
    i = Math.max(0, Math.min(slides.length - 1, i));
    slides[i].scrollIntoView({behavior: 'smooth', block: 'start'});
  }
  function paint(){ if (counter) counter.textContent = (current() + 1) + ' / ' + slides.length; }
  document.addEventListener('keydown', function(e){
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); show(current() + 1); }
    if (e.key === 'ArrowLeft'  || e.key === 'PageUp')   { e.preventDefault(); show(current() - 1); }
    if (e.key === 'Home') { e.preventDefault(); show(0); }
    if (e.key === 'End')  { e.preventDefault(); show(slides.length - 1); }
  });
  window.addEventListener('scroll', paint, {passive: true});
  paint();
})();
"""


def to_html(deck: Deck, *, full_document: bool = True) -> str:
    e = html.escape
    parts: list[str] = []
    if full_document:
        parts += ["<!doctype html><html lang='en'><head><meta charset='utf-8'>",
                  "<meta name='viewport' content='width=device-width,initial-scale=1'>"]
    parts.append(f"<title>{e(deck.title)}</title><style>{_CSS}</style>")
    if full_document:
        parts.append("</head><body>")
    parts.append("<div class='deck'>")

    for i, s in enumerate(deck.slides):
        parts.append("<section class='slide'>")
        parts.append(f"<p class='kicker'>{e(s.kicker)}</p>")
        parts.append(f"<h1>{e(s.title)}</h1>" if i == 0 else f"<h2>{e(s.title)}</h2>")
        if i == 0:
            parts.append(f"<p class='lead'>{e(deck.subtitle)}</p>")
        if s.lead:
            parts.append(f"<p class='lead'>{e(s.lead)}</p>")
        if s.figures:
            parts.append("<div class='figs'>")
            for k, v, n in s.figures:
                parts.append(f"<div class='fig'><div class='k'>{e(k)}</div>"
                             f"<div class='v'>{e(v)}</div>"
                             + (f"<div class='n'>{e(n)}</div>" if n else "") + "</div>")
            parts.append("</div>")
        if s.svg:
            parts.append(s.svg)
        if s.bullets:
            parts.append("<ul>" + "".join(f"<li>{e(b)}</li>" for b in s.bullets) + "</ul>")
        if s.table:
            head, rows = s.table
            th = "".join(f"<th scope='col'>{e(h)}</th>" for h in head)
            tr = "".join("<tr>" + "".join(f"<td>{e(str(c))}</td>" for c in r) + "</tr>"
                         for r in rows)
            parts.append(f"<div class='tw'><table><thead><tr>{th}</tr></thead>"
                         f"<tbody>{tr}</tbody></table></div>")
        parts.append(f"<p class='note'>{e(s.note or deck.footer)}</p>")
        parts.append("</section>")

    parts.append("</div>")
    parts.append(f"<div class='count' id='count'>1 / {len(deck.slides)}</div>")
    parts.append(f"<script>{_JS}</script>")
    if full_document:
        parts.append("</body></html>")
    return "".join(parts)
