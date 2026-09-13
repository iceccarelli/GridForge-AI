"""Renderers. Markdown for the repo and for review; HTML for the customer."""
from __future__ import annotations

import html
from datetime import date

from ..validation import Quantity
from .model import Bullets, Callout, Lit, Para, Report, Section, Statement, Table


def _cell(c) -> str:
    if isinstance(c, Quantity):
        return c.render()
    if isinstance(c, Lit):
        return c.text
    return str(c)


def to_markdown(r: Report) -> str:
    out: list[str] = [f"# {r.title}", "", f"*{r.subtitle}*", "",
                      f"> **{r.watermark}**", ""]
    for s in r.sections:
        out.append("#" * s.level + " " + s.heading)
        out.append("")
        for b in s.blocks:
            if isinstance(b, Para):
                out += [b.text, ""]
            elif isinstance(b, Bullets):
                out += [f"- {i}" for i in b.items] + [""]
            elif isinstance(b, Callout):
                tag = {"warning": "⚠️", "note": "ℹ️", "answer": "➡️"}.get(b.kind, "")
                out += [f"> {tag} {b.text}", ""]
            elif isinstance(b, Statement):
                out += [f"**{b.label}:** {b.value.render()}"]
                if b.basis:
                    out += ["", f"*Limited by: {b.basis}*"]
                out += [""]
            elif isinstance(b, Table):
                out.append("| " + " | ".join(b.headers) + " |")
                out.append("|" + "|".join([" --- "] * len(b.headers)) + "|")
                for row in b.rows:
                    out.append("| " + " | ".join(_cell(c) for c in row) + " |")
                if b.caption:
                    out += ["", f"*{b.caption}*"]
                out.append("")
    out += _appendix_md(r)
    if r.footer:
        out += ["---", "", r.footer]
    return "\n".join(out)


def _appendix_md(r: Report) -> list[str]:
    out = ["## Appendix A — Assumptions, provenance and validation status", "",
           "Every number in this report carries an evidence class. The class of a computed number "
           "is never higher than the weakest of its inputs.", "",
           "| Class | Meaning |", "| --- | --- |"]
    from ..validation import EvidenceClass
    for e in EvidenceClass:
        out.append(f"| {e.short} | {e.verb} |")
    out += ["", "### A.1 Assumptions relied upon", ""]
    for a in r.assumptions():
        out.append(f"- {a}")
    out += ["", "### A.2 Sources", ""]
    for s in r.sources():
        out.append(f"- {s}")
    out += ["", "### A.3 Provenance of headline quantities", "",
            "| Quantity | Evidence | Model | Digest |", "| --- | --- | --- | --- |"]
    for q in r.quantities():
        out.append(f"| {q.prov.label} | {q.evidence.short} | "
                   f"{q.prov.model_id}@{q.prov.model_version} | `{q.prov.digest}` |")
    out.append("")
    return out


_FONTS = ("<link rel='preconnect' href='https://fonts.gstatic.com' crossorigin>"
          "<link rel='stylesheet' href='https://fonts.googleapis.com/css2?"
          "family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600"
          "&family=IBM+Plex+Serif:ital,wght@0,400;1,400&display=swap'>")

# Palette and type are drawn from the subject: engineering record documents.
# Cool drawing-paper neutrals, instrument teal for structure, semantic colours
# reserved for constraint state. IBM Plex Sans / Mono for the body and the
# numbers, Plex Serif italic for annotation - the voice of a drawing note.
_CSS = """
:root{
  --paper:#eef1f3; --surface:#ffffff; --ink:#15191d; --muted:#5b636b;
  --line:#d3dadf; --rule:#b9c3ca;
  --accent:#14606f; --accent-soft:#e2edef;
  --critical:#8f2d2d; --critical-soft:#f7e9e8;
  --caution:#7d6111; --caution-soft:#f7f0dc;
  --ok:#2b6144; --ok-soft:#e5f0e9;
  --sans:"IBM Plex Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
  --mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  --serif:"IBM Plex Serif",Georgia,"Times New Roman",serif;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --paper:#14181b; --surface:#1a1f23; --ink:#e6eaed; --muted:#98a2aa;
  --line:#2c343a; --rule:#3c464e;
  --accent:#5fb3c4; --accent-soft:#17313a;
  --critical:#e08b8b; --critical-soft:#2e1e1e;
  --caution:#d6b45e; --caution-soft:#2c2617;
  --ok:#7dc3a0; --ok-soft:#1a2b23;
}}
:root[data-theme="dark"]{
  --paper:#14181b; --surface:#1a1f23; --ink:#e6eaed; --muted:#98a2aa;
  --line:#2c343a; --rule:#3c464e;
  --accent:#5fb3c4; --accent-soft:#17313a;
  --critical:#e08b8b; --critical-soft:#2e1e1e;
  --caution:#d6b45e; --caution-soft:#2c2617;
  --ok:#7dc3a0; --ok-soft:#1a2b23;
}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);
  font-size:15px;line-height:1.62;-webkit-font-smoothing:antialiased}
.wrap{max-width:68rem;margin:0 auto;padding-block:2rem 5rem;padding-left:1.25rem;
  padding-right:1.25rem;display:flex;flex-direction:column;gap:0}
/* title block - the convention a drawing uses to identify itself */
.titleblock{background:var(--surface);border:1px solid var(--rule);margin-bottom:2.25rem}
.titleblock h1{margin:0;padding:1.25rem 1.4rem .5rem;font-size:1.65rem;line-height:1.18;
  font-weight:600;letter-spacing:-.015em;text-wrap:balance}
.titleblock .sub{margin:0;padding:0 1.4rem 1.1rem;color:var(--muted);font-size:.9rem}
.meta{display:grid;grid-template-columns:repeat(auto-fit,minmax(11rem,1fr));
  border-top:1px solid var(--line)}
.meta div{padding:.6rem 1.4rem;border-right:1px solid var(--line)}
.meta div:last-child{border-right:none}
.meta dt{font-family:var(--mono);font-size:.66rem;text-transform:uppercase;
  letter-spacing:.09em;color:var(--muted);margin:0 0 .15rem}
.meta dd{margin:0;font-size:.86rem;font-weight:500}
.status{display:inline-block;font-family:var(--mono);font-size:.68rem;letter-spacing:.08em;
  text-transform:uppercase;padding:.22rem .5rem;border:1px solid var(--caution);
  color:var(--caution);background:var(--caution-soft)}
h2{font-size:1.08rem;font-weight:600;letter-spacing:.005em;margin:2.6rem 0 .9rem;
  padding-bottom:.4rem;border-bottom:2px solid var(--rule);text-wrap:balance}
h3{font-size:.95rem;font-weight:600;margin:1.6rem 0 .5rem}
p{margin:0 0 .9rem;max-width:66ch}
ul{margin:0 0 1rem;padding-left:1.15rem;max-width:66ch}
li{margin-bottom:.3rem}
/* instrument readout */
.stmt{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.35rem 1.5rem;
  align-items:baseline;background:var(--surface);border:1px solid var(--line);
  border-left:3px solid var(--accent);padding:.75rem 1rem;margin:0 0 .5rem}
.stmt b{grid-column:1;font-size:.72rem;font-weight:600;text-transform:uppercase;
  letter-spacing:.07em;color:var(--muted);font-family:var(--mono)}
.stmt .v{grid-column:2;grid-row:1/3;font-family:var(--mono);font-size:1.3rem;
  font-weight:500;font-variant-numeric:tabular-nums;text-align:right;color:var(--accent)}
.stmt .basis{grid-column:1;font-size:.84rem;color:var(--muted);font-family:var(--serif);
  font-style:italic}
.tablewrap{overflow-x:auto;border:1px solid var(--line);background:var(--surface);
  margin:.4rem 0 .6rem}
table{border-collapse:collapse;width:100%;font-size:.84rem;font-variant-numeric:tabular-nums}
th,td{padding:.48rem .7rem;text-align:left;vertical-align:top;border-bottom:1px solid var(--line)}
th{font-family:var(--mono);font-size:.68rem;text-transform:uppercase;letter-spacing:.07em;
  font-weight:600;color:var(--muted);border-bottom:2px solid var(--rule);white-space:nowrap}
tbody tr:last-child td{border-bottom:none}
td:first-child{font-weight:500}
caption,.cap{caption-side:bottom;text-align:left;color:var(--muted);font-size:.82rem;
  font-family:var(--serif);font-style:italic;margin:0 0 1.2rem}
.callout{padding:.75rem .95rem;margin:.5rem 0 1rem;border:1px solid var(--line);
  background:var(--surface);font-size:.9rem;max-width:70ch}
.callout::before{display:block;font-family:var(--mono);font-size:.66rem;letter-spacing:.09em;
  text-transform:uppercase;margin-bottom:.3rem}
.callout.answer{border-left:3px solid var(--ok);background:var(--ok-soft);color:var(--ink)}
.callout.answer::before{content:"Recommendation";color:var(--ok)}
.callout.warning{border-left:3px solid var(--critical);background:var(--critical-soft)}
.callout.warning::before{content:"Caution";color:var(--critical)}
.callout.note{border-left:3px solid var(--accent);background:var(--accent-soft)}
.callout.note::before{content:"Note";color:var(--accent)}
code{font-family:var(--mono);font-size:.85em;background:var(--accent-soft);padding:.05rem .3rem}
.foot{color:var(--muted);font-size:.82rem;margin-top:3rem;border-top:1px solid var(--rule);
  padding-top:.9rem;font-family:var(--mono)}
@media (max-width:560px){
  .titleblock h1{font-size:1.3rem}
  .stmt{grid-template-columns:1fr}
  .stmt .v{grid-column:1;grid-row:auto;text-align:left}
  .meta div{border-right:none;border-bottom:1px solid var(--line)}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
"""


def to_html(r: Report, *, full_document: bool = True) -> str:
    """`full_document=False` emits fonts + title + style + body content only, for hosts
    that supply their own document skeleton."""
    e = html.escape
    head = f"{_FONTS}<title>{e(r.title)}</title><style>{_CSS}</style>"
    if full_document:
        parts = ["<!doctype html><html><head><meta charset='utf-8'>",
                 "<meta name='viewport' content='width=device-width,initial-scale=1'>",
                 head, "</head><body>"]
    else:
        parts = [head]

    meta = "".join(f"<div><dt>{e(k)}</dt><dd>{e(v)}</dd></div>" for k, v in r.meta)
    parts += ["<div class='wrap'>",
              "<header class='titleblock'>",
              f"<h1>{e(r.title)}</h1>",
              f"<p class='sub'>{e(r.subtitle)}</p>",
              f"<dl class='meta'>{meta}</dl>" if meta else "",
              "</header>",
              f"<div class='callout warning'>{e(r.watermark)}</div>"]

    for s in r.sections:
        parts.append(f"<h{s.level}>{e(s.heading)}</h{s.level}>")
        for b in s.blocks:
            if isinstance(b, Para):
                parts.append(f"<p>{e(b.text)}</p>")
            elif isinstance(b, Bullets):
                parts.append("<ul>" + "".join(f"<li>{e(i)}</li>" for i in b.items) + "</ul>")
            elif isinstance(b, Callout):
                parts.append(f"<div class='callout {e(b.kind)}'>{e(b.text)}</div>")
            elif isinstance(b, Statement):
                basis = f"<div class='basis'>Limited by: {e(b.basis)}</div>" if b.basis else ""
                parts.append(f"<div class='stmt'><b>{e(b.label)}</b>"
                             f"<div class='v'>{e(b.value.render())}</div>{basis}</div>")
            elif isinstance(b, Table):
                parts.append(_table_html(b))
    parts.append(_appendix_html(r))
    parts.append(f"<div class='foot'>{e(r.footer)}<br>Generated {date.today().isoformat()} "
                 f"by the GridForge-AI envelope engine.</div></div>")
    if full_document:
        parts.append("</body></html>")
    return "".join(parts)


def _table_html(b: Table, caption: str | None = None) -> str:
    e = html.escape
    th = "".join(f"<th scope='col'>{e(h)}</th>" for h in b.headers)
    tr = "".join("<tr>" + "".join(f"<td>{e(_cell(c))}</td>" for c in row) + "</tr>"
                 for row in b.rows)
    cap = caption if caption is not None else b.caption
    cap_html = f"<p class='cap'>{e(cap)}</p>" if cap else ""
    return (f"<div class='tablewrap'><table><thead><tr>{th}</tr></thead>"
            f"<tbody>{tr}</tbody></table></div>{cap_html}")


def _appendix_html(r: Report) -> str:
    from ..validation import EvidenceClass
    e = html.escape
    rows = "".join(f"<tr><td>{e(q.prov.label)}</td><td>{q.evidence.short}</td>"
                   f"<td>{e(q.prov.model_id)}</td><td><code>{q.prov.digest}</code></td></tr>"
                   for q in r.quantities())
    cls = "".join(f"<tr><td>{x.short}</td><td>{e(x.verb)}</td></tr>" for x in EvidenceClass)
    ass = "".join(f"<li>{e(a)}</li>" for a in r.assumptions())
    src = "".join(f"<li>{e(str(s))}</li>" for s in r.sources())
    return ("<h2>Appendix A — Assumptions, provenance and validation status</h2>"
            "<p>Every number in this report carries an evidence class. The class of a computed "
            "number is never higher than the weakest of its inputs, so a model applied to "
            "measured data yields a modelled number and never a measurement.</p>"
            "<div class='tablewrap'><table><thead><tr><th scope='col'>Class</th>"
            f"<th scope='col'>Meaning</th></tr></thead><tbody>{cls}</tbody></table></div>"
            f"<h3>A.1 Assumptions relied upon</h3><ul>{ass}</ul>"
            f"<h3>A.2 Sources</h3><ul>{src}</ul>"
            "<h3>A.3 Provenance of headline quantities</h3>"
            "<div class='tablewrap'><table><thead><tr><th scope='col'>Quantity</th>"
            "<th scope='col'>Evidence</th><th scope='col'>Model</th><th scope='col'>Digest</th>"
            f"</tr></thead><tbody>{rows}</tbody></table></div>")
