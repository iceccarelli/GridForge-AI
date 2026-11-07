#!/usr/bin/env bash
# Regenerate the public worked example under public/reference/.
#
# The reference study is the strongest sales asset we have: a prospect can read
# the exact deliverable before paying for it. That only holds if it is the CURRENT
# output of the engine, so generation is pinned to a fixed date and CI fails when
# the committed files differ from a fresh run. A worked example that has quietly
# drifted from the engine is worse than none — it is a promise we no longer keep.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT="public/reference"
DATE="${GRIDFORGE_REPORT_DATE:-2026-09-14}"
INTAKE="examples/intake/reference_hall.json"

# Approved site observation records are private data: a developer's local store must never reach a public file.
export GRIDFORGE_CALIBRATION_RECORDS="${TMPDIR:-/tmp}/gridforge-reference-no-such-dir/records.jsonl"

rm -rf "$OUT"
mkdir -p "$OUT"

# Hand-authored API examples live outside this generated directory (the line above removes it) and are copied in, so a public example
# is served at /reference/examples/ and is still covered by the drift guard. tests/test_api_examples.py executes them.
mkdir -p "$OUT/examples"
cp examples/api/qualify-request.json "$OUT/examples/qualify-request.json"

GRIDFORGE_REPORT_DATE="$DATE" python3 -m gridforge study "$INTAKE" -o "$OUT" --csv >/dev/null
GRIDFORGE_REPORT_DATE="$DATE" python3 -m gridforge deck "$INTAKE" -o "$OUT" >/dev/null
GRIDFORGE_REPORT_DATE="$DATE" python3 -m gridforge proposal "$INTAKE" -o "$OUT" >/dev/null

# The EUR 4,500 deliverable, as the buyer receives it. lib/deliverables.ts renders a Density Screen by calling the engine's
# /v1/screen handler at the client tier, once with format "html" and once with "md", and stores those two documents; this does the
# same through the same handler (gridforge.api.server.handle_screen), not through a second renderer. The handler returns the
# screening-opinion stamp the buyer's document carries; the reference intake is synthetic, so the engine's own synthetic stamp
# (gridforge.reporting.study.WATERMARK, the one the sibling documents carry) is added ABOVE it and nothing else is changed. The
# buyer receives no JSON or CSV with a Density Screen (lib/products.ts: "HTML + Markdown ... and a data request"), so none is made.
GRIDFORGE_REPORT_DATE="$DATE" python3 - "$INTAKE" "$OUT" <<'PY'
import json, pathlib, sys
from gridforge.api.server import handle_screen
from gridforge.api.tiers import Tier
from gridforge.reporting.screen import WATERMARK as SCREEN_STAMP
from gridforge.reporting.study import WATERMARK as SYNTHETIC_STAMP
import html as _html
intake = json.loads(pathlib.Path(sys.argv[1]).read_text())
out = pathlib.Path(sys.argv[2])
md = handle_screen({"intake": intake, "format": "md"}, Tier.CLIENT)["document"]
page = handle_screen({"intake": intake, "format": "html"}, Tier.CLIENT)["document_full"]
old_md = f"> **{SCREEN_STAMP}**"
old_html = f"<div class='callout warning'>{_html.escape(SCREEN_STAMP)}</div>"
assert md.count(old_md) == 1 and page.count(old_html) == 1, "the screening stamp moved: the synthetic stamp has nowhere to go"
md = md.replace(old_md, f"> **{SYNTHETIC_STAMP}**\n\n{old_md}")
# The assumptions section IS the data request (lib/products.ts: "a data request you can send to your own engineers verbatim"); the
# product page and /reference link straight to it, so the heading gets an id. Nothing else in the body changes.
heading = "<h2>4. What we had to assume"
assert page.count(heading) == 1, "the assumptions section moved: the data-request anchor has nowhere to go"
page = page.replace(heading, "<h2 id='data-request'>4. What we had to assume", 1)
page = page.replace(old_html, f"<div class='callout warning'>{_html.escape(SYNTHETIC_STAMP)}</div>{old_html}")
(out / "density_screen.md").write_text(md if md.endswith("\n") else md + "\n")
(out / "density_screen.html").write_text(page)
PY

# The procurement specification for the relief that unlocks the most racks. A
# prospect can read the document they would actually send to suppliers, including
# the response schedule — which is the half that makes the bids comparable.
GRIDFORGE_REPORT_DATE="$DATE" python3 -m gridforge spec "$INTAKE" \
  --constraint busway_ampacity --reference "REF-TND-01" -o "$OUT" >/dev/null

# The model pack carries the whole intake; that is the point, and this intake is
# synthetic. Say so in the file itself so a copy of it can never be mistaken for
# a real asset once it is separated from the page it came from.
python3 - "$OUT/model_pack.json" <<'PY'
import json, sys
p = sys.argv[1]
d = json.load(open(p))
d["synthetic"] = True
d["notice"] = ("SYNTHETIC REFERENCE DATA — not a customer asset. Every figure is modelled from "
               "invented inputs and none is a measurement of a real site.")
json.dump(d, open(p, "w"), indent=2)
PY

# The public constraint reference and the platform library. These are the most-read
# pages on the site and they must not depend on the engine being up, so they are
# built to disk and covered by the same drift guard as everything else here.
GRIDFORGE_REPORT_DATE="$DATE" python3 -m gridforge reference constraints \
  -o "$OUT/constraints.json" >/dev/null
GRIDFORGE_REPORT_DATE="$DATE" python3 -m gridforge reference platforms \
  -o "$OUT/platforms.json" >/dev/null

# One file per constraint, so a crawler or an agent can fetch exactly the page it
# wants at a clean, cacheable URL instead of scraping rendered HTML.
python3 - "$OUT" <<'PY'
import json, pathlib, sys
out = pathlib.Path(sys.argv[1]) / "constraints"
out.mkdir(parents=True, exist_ok=True)
doc = json.loads((pathlib.Path(sys.argv[1]) / "constraints.json").read_text())
for c in doc["constraints"]:
    (out / f"{c['slug']}.json").write_text(
        json.dumps({**c, "notice": doc["notice"]}, indent=2) + "\n")
PY

# Public-page treatment for the six published HTML documents. The engine's renderer stays untouched (the same renderer produces
# private customer documents, which must not name a public canonical URL, carry a site bar or load site assets); the public worked
# example gets its additions here, in the one place that writes public/reference, so CI's byte-for-byte diff covers them.
#   1. Discovery tags. Each .html is the canonical copy of its .md twin (same content, two formats), so the page names itself
#      canonical and is indexable.
#   2. Self-hosted fonts. The renderer asks Google Fonts for IBM Plex; the site itself serves Inter and JetBrains Mono from app/fonts,
#      so the public documents use those same files (copied below, byte for byte) and make no request to a third party.
#   3. A small site bar: a way back to the sample deliverables and the next step for the reader, so a document is not a dead end.
# Deterministic; refuses to run twice on one file, because the directory is rebuilt from scratch above.
mkdir -p "$OUT/fonts"
cp app/fonts/inter-400.woff2 app/fonts/inter-500.woff2 app/fonts/inter-600.woff2 app/fonts/inter-700.woff2 \
   app/fonts/jetbrains-mono-400.woff2 app/fonts/jetbrains-mono-500.woff2 app/fonts/jetbrains-mono-600.woff2 "$OUT/fonts/"
python3 - "$OUT" <<'PY'
import html, pathlib, re, sys
out = pathlib.Path(sys.argv[1])
BASE = "https://timetopower.ai/reference/"
SYNTH = "Synthetic reference hall, not a customer asset."
# What a search result shows: at most 60 characters of title and 160 of description (checked below; the build fails if one is over).
# The title is the page's own, not the engine's document title, which is long and names the invented campus; the document keeps its
# engine title as its heading. Every description says the data is synthetic.
PAGES = {
    "density_screen.html": ("Density Screen sample: synthetic reference hall", "Density Screen: what binds, racks as found and after the ladder, time to power (assumed lead times, not a date). " + SYNTH),
    "envelope_study.html": ("Envelope Study sample: synthetic reference hall", "Envelope Study: binding constraint, headroom ladder, time to power, an evidence class per headline figure. " + SYNTH),
    "board_summary.html": ("Board summary sample: synthetic reference hall", "The board summary of the reference Envelope Study: the answer, what binds, time to power and the evidence. " + SYNTH),
    "proposal.html": ("Density Screen proposal sample: synthetic hall", "The Density Screen proposal, opening with a real finding on a synthetic hall. " + SYNTH),
    "specification.html": ("Procurement specification sample: synthetic hall", "A tender-ready specification for one relief, with its supplier response schedule. " + SYNTH),
    "walkthrough.html": ("Walkthrough deck sample: synthetic reference hall", "The client walkthrough deck for the reference Envelope Study, slide by slide. " + SYNTH),
}
# The next step for a reader of each document: the product whose deliverable it is a sample of. Paths are the product pages
# (lib/product-pages.ts); no price is written here, because the product page states it from the catalogue.
NEXT = {
    "density_screen.html": ("Get the Density Screen for your hall", "/products/density-screen"),
    "proposal.html": ("Get the Density Screen for your hall", "/products/density-screen"),
    "envelope_study.html": ("The Envelope Study for your hall", "/products/envelope-study"),
    "board_summary.html": ("The Envelope Study for your hall", "/products/envelope-study"),
    "walkthrough.html": ("The Envelope Study for your hall", "/products/envelope-study"),
    "specification.html": ("The Procurement Specification for your hall", "/products/procurement-specification"),
}
FONT_FACES = "".join(
    f"@font-face{{font-family:'{fam}';font-style:normal;font-weight:{w};font-display:swap;"
    f"src:url(fonts/{f}-{w}.woff2) format('woff2')}}"
    for fam, f, ws in (("Inter", "inter", (400, 500, 600, 700)), ("JetBrains Mono", "jetbrains-mono", (400, 500, 600)))
    for w in ws)
BAR_CSS = (
    ".gf-bar{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem 1.1rem;padding:.55rem 1rem;background:#0b1220;"
    "color:#e6eaed;font:500 14px/1.3 Inter,system-ui,-apple-system,'Segoe UI',Helvetica,Arial,sans-serif}"
    ".gf-bar a{display:inline-flex;align-items:center;min-height:44px;color:#e6eaed;text-decoration:underline;text-underline-offset:3px}"
    ".gf-bar a:hover,.gf-bar a:focus-visible{color:#00e5ff}"
    ".gf-bar .gf-tag{padding:.15rem .5rem;border:1px solid #3c464e;border-radius:4px;font:500 11px/1.2 'JetBrains Mono',ui-monospace,monospace;letter-spacing:.06em;text-transform:uppercase;color:#98a2aa}"
    ".gf-bar .gf-cta{margin-left:auto;padding:0 .9rem;border-radius:6px;background:#00e5ff;color:#06101c;font-weight:600;text-decoration:none}"
    ".gf-bar .gf-cta:hover,.gf-bar .gf-cta:focus-visible{color:#06101c;background:#5ff0ff}"
    "@media print{.gf-bar{display:none}}")
for name, (title, desc) in PAGES.items():
    assert len(title) <= 60 and len(desc) <= 160, (name, len(title), len(desc))
    f = out / name
    text = f.read_text()
    if "rel='canonical'" in text:
        raise SystemExit(f"{name}: discovery tags already present")
    # 2. fonts: drop the third-party stylesheet, name the self-hosted families, add their @font-face rules.
    text, n = re.subn(r"<link rel='preconnect' href='https://fonts\.gstatic\.com' crossorigin><link rel='stylesheet' href='https://fonts\.googleapis\.com/[^']*'>", "", text)
    if ("IBM Plex" in text) != bool(n):
        raise SystemExit(f"{name}: the Google Fonts links and the IBM Plex families disagree; the font treatment needs revisiting")
    text = text.replace('"IBM Plex Sans"', '"Inter"').replace('"IBM Plex Mono"', '"JetBrains Mono"').replace('"IBM Plex Serif",', "")
    if "IBM Plex" in text or "fonts.g" in text:
        raise SystemExit(f"{name}: a third-party font reference survived")
    # 3. the site bar and its style, then the discovery tags.
    back, (cta, href) = "Back to the sample deliverables", NEXT[name]
    bar = (f"<nav class='gf-bar' aria-label='Time to Power'><a href='/reference'>&larr; {back}</a>"
           f"<span class='gf-tag'>Synthetic reference data</span>"
           f"<a href='/qualify'>Free capacity check</a><a class='gf-cta' href='{href}'>{html.escape(cta)}</a></nav>")
    # The document itself becomes the page's one <main> landmark (the engine's markup has none), so a screen reader can skip the bar to it.
    text, n = re.subn(r"</style></head><body>", lambda m: FONT_FACES + BAR_CSS + "</style></head><body>" + bar + "<main>", text, count=1)
    if n != 1 or text.count("</body>") != 1:
        raise SystemExit(f"{name}: no </style></head><body> to anchor the site bar on, or more than one </body>")
    text = text.replace("</body>", "</main></body>", 1)
    text, n = re.subn(r"<title>[^<]*</title>", lambda m: f"<title>{html.escape(title)}</title>", text, count=1)
    if n != 1:
        raise SystemExit(f"{name}: no <title> to replace")
    if "<html>" in text:
        text = text.replace("<html>", "<html lang='en'>", 1)
    tags = (f"<link rel='canonical' href='{BASE}{name}'>"
            f"<meta name='description' content='{html.escape(desc, quote=True)}'>"
            "<meta name='robots' content='index,follow'>")
    new, n = re.subn(r"(<meta name='viewport' content='[^']*'>)", lambda m: m.group(1) + tags, text, count=1)
    if n != 1:
        raise SystemExit(f"{name}: no viewport meta to anchor the discovery tags on")
    f.write_text(new)
PY

# The machine-callable surface, committed so /developers renders the same schema the
# server validates against, and so CI notices when a tool, a unit rate or a schema
# changes without the published contract changing with it.
GRIDFORGE_REPORT_DATE="$DATE" python3 -m gridforge tools --json -o "$OUT/tools.json" >/dev/null

# The accuracy record, published whether or not it flatters us.
python3 - "$OUT/calibration.json" <<'PY'
import json, sys
from gridforge.calibration import accuracy_block, all_keys
from gridforge.calibration.ledger import load_ledger
# published_only: a local ledger of client site data must never reach public/.
json.dump(accuracy_block(all_keys(), load_ledger(published_only=True)),
          open(sys.argv[1], "w"), indent=2)
PY

# Byte-identical across runs, so CI can diff it. zipfile stamps each entry with
# the source file's mtime by default, which would make every rebuild differ.
python3 - "$OUT" <<'PY'
import pathlib, sys, zipfile
out = pathlib.Path(sys.argv[1])
src = out / "working_files"
with zipfile.ZipFile(out / "working_files.zip", "w", zipfile.ZIP_DEFLATED) as z:
    for f in sorted(src.iterdir()):
        info = zipfile.ZipInfo("working_files/" + f.name, date_time=(1980, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, f.read_bytes())
PY

echo "wrote:"
find "$OUT" -type f | sort | sed 's/^/  /'
