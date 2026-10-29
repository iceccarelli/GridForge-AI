"""The published engine must be the engine that is deployed, and publishing must stay a deliberate, tokenless act.

These tests read the packaging configuration and the source tree; the built wheel itself is checked by scripts/check-package.py and
the `package` workflow (build, `twine check`, a clean-environment install, a real screen, and a digest comparison).
"""
from __future__ import annotations

import ast
import fnmatch
import re
import sys
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PKG = ROOT / "gridforge"
PYPROJECT = tomllib.loads((ROOT / "pyproject.toml").read_text())


def test_the_package_version_is_the_engine_version():
    m = re.search(r'^VERSION\s*=\s*"([^"]+)"', (PKG / "api" / "server.py").read_text(), re.M)
    assert m, "server.VERSION not found"
    assert PYPROJECT["project"]["version"] == m.group(1), "a release would carry a different version from the one /v1/version reports"


def _import_time_modules(tree: ast.Module) -> list[str]:
    """Modules imported when the file is imported: module-level statements, including those under if/try, but not inside a function or
    class body (a lazy import there is how an optional adapter stays optional)."""
    found: list[str] = []

    def visit(nodes) -> None:
        for node in nodes:
            if isinstance(node, ast.Import):
                found.extend(a.name for a in node.names)
            elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                found.append(node.module)
            elif isinstance(node, (ast.If, ast.Try, ast.With)):
                for field in ("body", "orelse", "finalbody"):
                    visit(getattr(node, field, []))
                for handler in getattr(node, "handlers", []):
                    visit(handler.body)

    visit(tree.body)
    return found


def test_the_engine_has_no_required_dependencies():
    assert PYPROJECT["project"]["dependencies"] == []
    stdlib = set(sys.stdlib_module_names)
    foreign: dict[str, set[str]] = {}
    for path in sorted(PKG.rglob("*.py")):
        for mod in _import_time_modules(ast.parse(path.read_text())):
            top = mod.split(".")[0]
            if top and top not in stdlib and top != "gridforge":
                foreign.setdefault(top, set()).add(path.relative_to(ROOT).as_posix())
    assert not foreign, f"third-party modules imported at import time, which the package declares it does not need: {foreign}"


def test_the_only_optional_third_party_imports_are_lazy_and_named():
    """GridOS and NumPy are used by one adapter, inside functions, with an explicit NotWired when absent. Anything else that appears
    here is a new optional dependency and should be a decision."""
    stdlib = set(sys.stdlib_module_names)
    lazy: set[str] = set()
    for path in sorted(PKG.rglob("*.py")):
        for node in ast.walk(ast.parse(path.read_text())):
            names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.level == 0 and node.module else []
            lazy |= {n.split(".")[0] for n in names if n.split(".")[0] not in stdlib and n.split(".")[0] != "gridforge"}
    assert lazy <= {"gridos", "numpy"}, f"new third-party modules referenced by the engine: {sorted(lazy - {'gridos', 'numpy'})}"


def test_every_file_in_the_code_digest_ships_in_the_wheel():
    """provenance.code_sha256 hashes every non-bytecode file under gridforge/. If one is not packaged, an installed engine reports a
    different fingerprint from the deployed one, and the 'same engine' claim on a deliverable is false."""
    patterns = PYPROJECT["tool"]["setuptools"]["package-data"]["gridforge"]
    missing = []
    for p in sorted(PKG.rglob("*")):
        if not p.is_file() or "__pycache__" in p.parts or p.suffix in (".pyc", ".pyo"):
            continue
        rel = p.relative_to(PKG).as_posix()
        if p.suffix == ".py":
            continue
        if not any(fnmatch.fnmatch(rel, pat) for pat in patterns):
            missing.append(rel)
    assert not missing, f"files hashed into code_sha256 but not shipped by package-data: {missing}"


def test_the_console_script_points_at_a_real_entry_point():
    target = PYPROJECT["project"]["scripts"]["gridforge"]
    assert target == "gridforge.cli:main"
    import importlib

    module, func = target.split(":")
    assert callable(getattr(importlib.import_module(module), func))


def test_the_pypi_readme_exists_and_states_the_limits():
    readme = ROOT / PYPROJECT["project"]["readme"]
    text = readme.read_text()
    for needle in ("calibration ledger shipped in this package is empty", "E0 to E7", "not a design", "No required dependencies"):
        assert needle in text, f"the PyPI description no longer says: {needle}"


#: sha256 of the official FSL-1.1-ALv2 template (https://fsl.software/FSL-1.1-ALv2.template.md), with the notice line left as the
#: template has it. The LICENSE must equal it once the year and licensor are filled in: the legal text is never edited by accident.
FSL_TEMPLATE_SHA256 = "36b6082235c0a2105174927fc57cc6ae9c41f45a08af2bdcaee18a8dace56177"


def test_the_licence_is_the_official_fsl_text_with_only_the_notice_filled_in():
    import hashlib

    text = (ROOT / "LICENSE").read_text()
    assert "${" not in text, "an unfilled placeholder in the LICENSE"
    notice = re.search(r"^Copyright (\d{4}) (\S.*)$", text, re.M)
    assert notice, "the LICENSE has no 'Copyright <year> <licensor>' notice"
    template = text.replace(notice.group(0), "Copyright ${year} ${licensor name}", 1)
    assert hashlib.sha256(template.encode()).hexdigest() == FSL_TEMPLATE_SHA256, "the FSL text differs from the official template"


def test_the_package_metadata_declares_the_licence_the_file_contains():
    project = PYPROJECT["project"]
    assert project["license"] == "FSL-1.1-ALv2"
    assert "FSL-1.1-ALv2" in (ROOT / "LICENSE").read_text().split("## Abbreviation")[1].split("##")[0]
    assert project["license-files"] == ["LICENSE"]
    assert not any(c.startswith("License ::") for c in project.get("classifiers", [])), "PEP 639: no License classifier with an expression"
    assert PYPROJECT["build-system"]["requires"] == ["setuptools>=77"] or "setuptools>=77" in PYPROJECT["build-system"]["requires"][0]


def test_the_pypi_description_says_what_the_licence_allows_and_that_it_is_not_open_source():
    text = (ROOT / PYPROJECT["project"]["readme"]).read_text()
    assert "FSL-1.1-ALv2" in text and "Competing Use" in text and "not open source in the OSI sense" in text


def test_publishing_is_manual_tokenless_and_refuses_without_a_licence_file():
    wf = (ROOT / ".github" / "workflows" / "publish-pypi.yml").read_text()
    assert re.search(r"^on:\s*\n\s+workflow_dispatch:", wf, re.M), "publishing must be a manual dispatch"
    assert "push:" not in wf.split("jobs:")[0] and "pull_request" not in wf.split("jobs:")[0]
    assert "id-token: write" in wf and "pypa/gh-action-pypi-publish" in wf
    assert "environment:" in wf and "pypi" in wf
    for forbidden in ("PYPI_API_TOKEN", "TWINE_PASSWORD", "password:", "pypi-Ag"):
        assert forbidden not in wf, f"a PyPI credential reference ({forbidden}) in the publish workflow"
    assert "LICENSE" in wf, "the workflow must refuse to publish without a LICENSE file"
    assert "confirm" in wf, "the operator must type the version to confirm"


def test_the_source_distribution_leaves_the_repository_wide_tests_out():
    manifest = (ROOT / "MANIFEST.in").read_text()
    assert "prune tests" in manifest, "setuptools adds tests/test*.py to an sdist by default; they are not part of the engine"
