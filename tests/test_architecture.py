"""Dependency rule enforcement. This test is the reason DERIM and GridOS cannot
quietly become the product."""
from __future__ import annotations

import ast
import pathlib

ROOT = pathlib.Path(__file__).resolve().parents[1] / "gridforge"
KERNEL = {"validation", "common", "constraints", "costs"}

ALLOWED: dict[str, set[str]] = {
    "site": set(),
    "power": {"site", "compute", "thermal"},
    "compute": set(),
    "thermal": {"site", "compute"},
    "scenario": {"site", "power", "compute", "thermal", "economics", "envelope"},
    "economics": {"envelope", "scenario"},
    "envelope": {"site", "power", "compute", "thermal"},
    "reporting": {"site", "power", "compute", "thermal", "scenario", "economics", "envelope",
                  "intake", "change", "calibration"},
    "intake": {"site", "power", "compute", "thermal", "scenario"},
    "change": {"site", "power", "compute", "thermal", "scenario", "envelope", "intake"},
    "serialize": {"site", "power", "compute", "thermal", "scenario", "economics", "envelope",
                  "intake", "change", "calibration"},
    "cli": {"site", "power", "compute", "thermal", "scenario", "economics", "envelope",
            "reporting", "intake", "serialize", "api", "change", "calibration"},
    "api": {"site", "power", "compute", "thermal", "scenario", "economics", "envelope",
            "reporting", "intake", "serialize", "change", "calibration"},
    "calibration": set(),
    "integrations": set(),
}
DOMAINS = set(ALLOWED) - {"integrations"}


def _package_of(path: pathlib.Path) -> str:
    rel = path.relative_to(ROOT)
    return rel.parts[0] if len(rel.parts) > 1 else rel.stem


def _imports(path: pathlib.Path) -> set[str]:
    tree = ast.parse(path.read_text())
    out: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and node.module:
            out.add(node.module.lstrip("."))
        elif isinstance(node, ast.ImportFrom):
            # `from ..power.schema import X` -> module is "power.schema"
            pass
        if isinstance(node, ast.ImportFrom) and node.level and node.module:
            out.add(node.module.split(".")[0])
    return out


def test_domain_dependency_rule():
    violations = []
    for path in ROOT.rglob("*.py"):
        pkg = _package_of(path)
        if pkg not in ALLOWED:
            continue
        for mod in _imports(path):
            head = mod.split(".")[0]
            if head in DOMAINS and head != pkg and head not in ALLOWED[pkg] and head not in KERNEL:
                violations.append(f"{path.relative_to(ROOT)} imports {head}")
    assert not violations, "dependency rule violated:\n" + "\n".join(violations)


def test_no_domain_module_imports_integrations():
    violations = []
    for path in ROOT.rglob("*.py"):
        pkg = _package_of(path)
        if pkg == "integrations":
            continue
        if "integrations" in _imports(path):
            violations.append(str(path.relative_to(ROOT)))
    assert not violations, (
        "a domain module imports gridforge.integrations. Adapters are called INTO the domain "
        "through ports; they are never imported by it. See docs/03 §6.\n" + "\n".join(violations))


def test_integrations_have_no_implementations_yet():
    """GridOS stays dormant until a customer-facing workflow pulls it (docs/03 §6)."""
    for name in ("thermalforge", "derim", "gridos"):
        mod = ROOT / "integrations" / name / "__init__.py"
        assert mod.exists()
        assert "EXTRACTION_CANDIDATES" in mod.read_text()


def test_no_third_party_dependencies():
    """The engine must run anywhere, including inside a customer's air-gapped review.

    Adapters under gridforge/integrations/ may import an external package, but only
    lazily - inside a function body - so importing gridforge never pulls it in.
    """
    stdlib_ok = {"__future__", "argparse", "ast", "collections", "copy", "csv", "dataclasses",
                 "datetime", "enum", "hashlib", "html", "http", "io", "json", "math", "os",
                 "pathlib", "re", "sys", "threading", "time", "typing", "urllib"}
    bad = []
    for path in ROOT.rglob("*.py"):
        tree = ast.parse(path.read_text())
        in_integrations = _package_of(path) == "integrations"
        module_level = {id(n) for n in ast.walk(tree)
                        if isinstance(n, (ast.Module,))}
        lazy: set[int] = set()
        for fn in ast.walk(tree):
            if isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for n in ast.walk(fn):
                    lazy.add(id(n))
        del module_level
        for node in ast.walk(tree):
            if isinstance(node, (ast.Import, ast.ImportFrom)):
                names = ([a.name for a in node.names] if isinstance(node, ast.Import)
                         else [node.module or ""])
                for name in names:
                    head = name.split(".")[0]
                    if not head or head in stdlib_ok:
                        continue
                    if isinstance(node, ast.ImportFrom) and node.level:
                        continue          # relative import inside gridforge
                    if in_integrations and id(node) in lazy:
                        continue          # guarded lazy import in an adapter
                    bad.append(f"{path.relative_to(ROOT)}: {name}")
    assert not bad, "unexpected module-level third-party import: " + ", ".join(bad)
