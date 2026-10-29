#!/usr/bin/env python3
"""Inspect a built wheel and sdist before anything is installed or published.

    python scripts/check-package.py dist/

Standard library only. It checks the built artefacts, not the source tree: the name and version, that the engine's data files and
entry point are really inside the wheel, that nothing from the website, tests, secrets or other projects came along, and that the
runtime needs no third-party package. Exit 0 only when every check passes.
"""
from __future__ import annotations

import re
import sys
import tarfile
import zipfile
from email.parser import Parser
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
NAME = "gridforge"
MAX_FILE_BYTES = 5_000_000

WHEEL_MUST_HAVE = (
    "gridforge/__init__.py",
    "gridforge/cli.py",
    "gridforge/__main__.py",
    "gridforge/README.md",
    "gridforge/data/cost_library.json",
    "gridforge/data/calibration.json",
)
# Anything under these prefixes in the wheel (or sdist) is something that does not belong in a published engine.
FORBIDDEN_DIRS = {"tests", "examples", "app", "components", "node_modules", "supabase", ".github", "inbox", "observatory-broadcast"}


def _forbidden(path: str) -> bool:
    parts = path.split("/")
    return any(p in FORBIDDEN_DIRS or p.startswith(".env") for p in parts)


def engine_version() -> str:
    m = re.search(r'^VERSION\s*=\s*"([^"]+)"', (ROOT / "gridforge/api/server.py").read_text(), re.M)
    if not m:
        raise SystemExit("cannot read VERSION from gridforge/api/server.py")
    return m.group(1)


def check_wheel(path: Path, version: str, problems: list[str]) -> None:
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        for need in WHEEL_MUST_HAVE:
            if need not in names:
                problems.append(f"wheel lacks {need}")
        for n in names:
            top = n.split("/")[0]
            if top != "gridforge" and not top.endswith(".dist-info"):
                problems.append(f"wheel contains {n!r}, which is outside the gridforge package")
            if _forbidden(n):
                problems.append(f"wheel contains a path that must not ship: {n}")
            if n.endswith((".pyc", ".pyo")):
                problems.append(f"wheel contains bytecode: {n}")
        for info in z.infolist():
            if info.file_size > MAX_FILE_BYTES:
                problems.append(f"{info.filename} is {info.file_size} bytes (limit {MAX_FILE_BYTES})")
        meta_name = next((n for n in names if n.endswith(".dist-info/METADATA")), None)
        if not meta_name:
            problems.append("wheel has no METADATA")
            return
        meta = Parser().parsestr(z.read(meta_name).decode("utf-8"))
        if meta["Name"] != NAME:
            problems.append(f"metadata name is {meta['Name']!r}, expected {NAME!r}")
        if meta["Version"] != version:
            problems.append(f"metadata version is {meta['Version']!r} but the engine reports {version!r}")
        if not (meta["Requires-Python"] or "").startswith(">=3.11"):
            problems.append(f"Requires-Python is {meta['Requires-Python']!r}, expected >=3.11")
        for req in meta.get_all("Requires-Dist") or []:
            if "extra ==" not in req:
                problems.append(f"runtime dependency declared: {req} (the engine has none)")
        body = meta.get_payload() or ""
        if "gridforge" not in body[:200].lower() or "empty" not in body:
            problems.append("the long description is missing or is not the PyPI readme (expected the evidence limits section)")
        if meta["License"] or any(c.startswith("License ::") for c in meta.get_all("Classifier") or []):
            if not any((ROOT / f).exists() for f in ("LICENSE", "LICENSE.txt", "LICENSE.md")):
                problems.append("metadata declares a licence but the repository has no LICENSE file")
        eps = next((n for n in names if n.endswith(".dist-info/entry_points.txt")), None)
        if not eps or "gridforge = gridforge.cli:main" not in z.read(eps).decode():
            problems.append("the gridforge console script is missing from entry_points.txt")


def check_sdist(path: Path, problems: list[str]) -> None:
    with tarfile.open(path) as t:
        names = [m.name.split("/", 1)[1] for m in t.getmembers() if "/" in m.name]
    for need in ("pyproject.toml", "docs/pypi-readme.md", "gridforge/__init__.py", "gridforge/data/cost_library.json"):
        if need not in names:
            problems.append(f"sdist lacks {need}")
    for n in names:
        if _forbidden(n):
            problems.append(f"sdist contains a path that must not ship: {n}")


def main(argv: list[str]) -> int:
    dist = Path(argv[1]) if len(argv) > 1 else ROOT / "dist"
    wheels, sdists = sorted(dist.glob("*.whl")), sorted(dist.glob("*.tar.gz"))
    problems: list[str] = []
    if len(wheels) != 1 or len(sdists) != 1:
        problems.append(f"expected exactly one wheel and one sdist in {dist}, found {len(wheels)} and {len(sdists)}")
    else:
        version = engine_version()
        check_wheel(wheels[0], version, problems)
        check_sdist(sdists[0], problems)
        print(f"checked {wheels[0].name} and {sdists[0].name} against engine version {version}")
    for p in problems:
        print("FAIL:", p)
    print("PACKAGE OK" if not problems else f"{len(problems)} problem(s)")
    return 0 if not problems else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
