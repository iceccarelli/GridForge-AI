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

rm -rf "$OUT"
mkdir -p "$OUT"

GRIDFORGE_REPORT_DATE="$DATE" python3 -m gridforge study "$INTAKE" -o "$OUT" --csv >/dev/null
GRIDFORGE_REPORT_DATE="$DATE" python3 -m gridforge deck "$INTAKE" -o "$OUT" >/dev/null
GRIDFORGE_REPORT_DATE="$DATE" python3 -m gridforge proposal "$INTAKE" -o "$OUT" >/dev/null

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
