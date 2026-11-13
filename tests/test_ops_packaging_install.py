"""Build the wheel and sdist, install the wheel into a clean virtualenv away from the source tree, and run the engine with the network
made impossible. tests/test_packaging.py reads the configuration; this builds the thing and uses it.

Slow (a build and a venv, ~20 s), so it is marked `slow`-free but self-skipping when a build backend cannot be had. In CI the
`package` workflow does the same with the real runner; this is the local, offline-after-build equivalent.
"""
from __future__ import annotations

import importlib.util
import json
import shutil
import subprocess
import sys
import tarfile
import zipfile
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
REFERENCE = ROOT / "examples" / "intake" / "reference_hall.json"

# The files a build needs; copying only these keeps the build away from node_modules, .next and the rest of the repository.
BUILD_INPUTS = ("gridforge", "pyproject.toml", "MANIFEST.in", "LICENSE", "docs/pypi-readme.md")

# Run an installed console script with every outbound connection turned into an error: if the engine tried to reach the network
# (an update check, a telemetry call, a font) the command fails instead of quietly succeeding on a connected machine.
NO_NETWORK = (
    "import socket, sys, runpy\n"
    "def _deny(*a, **k): raise OSError('network access attempted by the engine')\n"
    "socket.socket.connect = _deny; socket.socket.connect_ex = _deny; socket.create_connection = _deny; socket.getaddrinfo = _deny\n"
    "sys.argv[0] = 'gridforge'\n"
    "from gridforge.cli import main\n"
    "sys.exit(main())\n"
)

# The distribution is gridforge-engine (pyproject.toml); wheel and sdist file names normalise the hyphen to an underscore.
WHEEL_PREFIX = "gridforge_engine"


def _have_build() -> bool:
    return importlib.util.find_spec("build") is not None


@pytest.fixture(scope="module")
def built(tmp_path_factory):
    src = tmp_path_factory.mktemp("src")
    for name in BUILD_INPUTS:
        p = ROOT / name
        dest = src / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        if p.is_dir():
            shutil.copytree(p, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        else:
            shutil.copy2(p, dest)
    out = src / "dist"
    if _have_build():
        r = subprocess.run([sys.executable, "-m", "build", "--outdir", str(out), str(src)], capture_output=True, text=True, timeout=600)
    else:
        r = subprocess.run([sys.executable, "-m", "pip", "wheel", str(src), "--no-deps", "-w", str(out), "--quiet"], capture_output=True, text=True, timeout=600)
    if r.returncode:
        pytest.skip("no usable build backend here (needs `pip install build` or network for setuptools>=77): " + (r.stderr or r.stdout)[-300:])
    return out


def test_the_wheel_ships_the_engine_and_no_tests(built):
    wheels = list(built.glob(f"{WHEEL_PREFIX}-*.whl"))
    assert len(wheels) == 1, wheels
    names = zipfile.ZipFile(wheels[0]).namelist()
    assert "gridforge/cli.py" in names and "gridforge/data/cost_library.json" in names
    bad = [n for n in names if n.split("/")[0] not in ("gridforge",) and not n.split("/")[0].endswith(".dist-info")]
    assert not bad, f"files outside the package: {bad[:5]}"
    assert not [n for n in names if "/tests/" in n or n.startswith("tests/") or "test_" in n.rsplit("/", 1)[-1]], "a test file shipped in the wheel"
    assert not [n for n in names if n.endswith((".pyc", ".pyo"))]


@pytest.mark.skipif(not _have_build(), reason="the sdist needs the `build` package")
def test_the_sdist_carries_no_tests_or_site(built):
    sdists = list(built.glob(f"{WHEEL_PREFIX}-*.tar.gz"))
    assert len(sdists) == 1, sdists
    with tarfile.open(sdists[0]) as t:
        names = t.getnames()
    root = names[0].split("/")[0]
    rels = [n[len(root) + 1:] for n in names if n != root]
    forbidden = {"tests", "app", "components", "supabase", ".github", "node_modules", "examples"}
    assert not [r for r in rels if r.split("/")[0] in forbidden], [r for r in rels if r.split("/")[0] in forbidden][:5]
    assert "pyproject.toml" in rels and any(r.startswith("gridforge/") for r in rels)


def test_the_installed_wheel_runs_init_and_screen_with_no_network(built, tmp_path):
    venv = tmp_path / "venv"
    subprocess.run([sys.executable, "-m", "venv", str(venv)], check=True, timeout=300)
    py = venv / "bin" / "python"
    wheel = next(built.glob(f"{WHEEL_PREFIX}-*.whl"))
    r = subprocess.run([str(py), "-m", "pip", "install", "--quiet", "--no-index", "--no-deps", "--disable-pip-version-check", str(wheel)], capture_output=True, text=True, timeout=300)
    assert r.returncode == 0, r.stderr[-500:]

    work = tmp_path / "work"  # a directory with no checkout beside it
    work.mkdir()
    probe = subprocess.run([str(py), "-I", "-c", "import gridforge, pathlib; print(pathlib.Path(gridforge.__file__).resolve())"], capture_output=True, text=True, cwd=work, timeout=60)
    assert "site-packages" in probe.stdout, probe.stdout + probe.stderr

    env = {"PATH": "/usr/bin:/bin", "HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9", "NO_PROXY": ""}

    def gf(*args: str) -> subprocess.CompletedProcess:
        return subprocess.run([str(py), "-I", "-c", NO_NETWORK, *args], capture_output=True, text=True, cwd=work, env=env, timeout=300)

    init = gf("init", "-o", str(work / "blank.json"))
    assert init.returncode == 0, init.stdout + init.stderr
    assert (work / "blank.json").stat().st_size > 0

    # The blank pack gives none of the intake fields, so the installed command refuses it as the API does (exit 2, nothing written); the same pack
    # with one figure filled in, and the reference intake, are screened.
    blank_refused = gf("screen", str(work / "blank.json"), "-o", str(work / "out_blank"))
    assert blank_refused.returncode == 2 and "none of the intake fields" in blank_refused.stderr, blank_refused.stdout[-400:] + blank_refused.stderr[-400:]
    assert not (work / "out_blank").exists()
    thin = json.loads((work / "blank.json").read_text())
    thin["grid"]["contracted_MW"] = 12
    (work / "thin.json").write_text(json.dumps(thin))
    for intake, label in ((work / "thin.json", "thin"), (REFERENCE, "reference")):
        out = work / f"out_{label}"
        r = gf("screen", str(intake), "-o", str(out))
        assert r.returncode == 0, f"{label}: " + r.stdout[-400:] + r.stderr[-400:]
        reports = [p for p in out.rglob("*.md") if p.stat().st_size > 0]
        assert reports, f"{label}: the screen wrote no report"

    # The self-check that the network guard is real: the same wrapper must refuse a connection.
    guard = subprocess.run([str(py), "-I", "-c", NO_NETWORK.replace("from gridforge.cli import main\nsys.exit(main())\n", "socket.create_connection(('127.0.0.1', 9))\n")], capture_output=True, text=True, cwd=work, timeout=60)
    assert guard.returncode != 0 and "network access attempted" in guard.stderr
