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
