"""The CI workflow must keep running everything this repository can run. A file that exists but is wired into no job is a test nobody
executes, which reads as green. These are text checks on .github/workflows/gridforge.yml (no YAML dependency: the engine has none)."""
from __future__ import annotations

import re
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WF = (ROOT / ".github" / "workflows" / "gridforge.yml").read_text()
PKG_WF = (ROOT / ".github" / "workflows" / "package.yml").read_text()


def _job(name: str) -> str:
    m = re.search(rf"^  {re.escape(name)}:\n(.*?)(?=^  [a-z][\w-]*:\n|\Z)", WF, re.S | re.M)
    assert m, f"job {name} not found"
    return m.group(1)


def test_python_matrix_covers_every_classifier_version():
    declared = re.findall(r"Programming Language :: Python :: (3\.\d+)", (ROOT / "pyproject.toml").read_text())
    assert declared, "no python version classifiers"
    for text, label in ((_job("test"), "gridforge.yml test"), (PKG_WF, "package.yml")):
        m = re.search(r"python-version: \[([^\]]+)\]", text)
        assert m, label
        have = re.findall(r"'(3\.\d+)'", m.group(1))
        assert sorted(have) == sorted(declared), f"{label} tests {have}, pyproject declares {declared}"


def test_the_site_job_runs_every_gate():
    site = _job("site")
    for needle in ("npx tsc --noEmit", "npm run lint", "npm test", "npm run build", "scripts/page-lastmod.mjs --check", "scripts/check-share-cards.mjs", "scripts/check-runtime-files.mjs"):
        assert needle in site, f"site job no longer runs: {needle}"
    assert "python -m pytest tests -q" in _job("test")


def test_every_realdb_vitest_file_runs_once_on_a_fresh_database():
    job = _job("real-database")
    for f in sorted((ROOT / "tests" / "site").glob("*.realdb.test.ts")):
        runs = re.findall(rf"vitest run tests/site/{re.escape(f.name)}", job)
        assert len(runs) == 1, f"{f.name} runs {len(runs)} times in the real-database job (want exactly one)"
    for line in re.findall(r"run: (.*vitest run .*)", job):
        assert line.startswith("bash scripts/realdb-run.sh "), f"a realdb file reuses a database left by the previous one: {line}"
    assert (ROOT / "scripts" / "realdb-run.sh").is_file()


def test_every_real_postgres_migration_test_is_wired_into_ci():
    job = _job("real-database")
    for f in sorted((ROOT / "tests").glob("test_*migration*.py")):
        if f.name == "test_apply_migration.py":  # the production-gate logic: pure, no database, runs in the `test` job
            continue
        assert f.name in job, f"{f.name} is in no real-database step"


def test_the_dependency_audit_is_present_and_non_blocking():
    site = _job("site")
    m = re.search(r"- name: Dependency advisories[^\n]*\n(?P<body>(?:        .*\n)+)", site)
    assert m, "the npm audit step is missing"
    body = m.group("body")
    assert "continue-on-error: true" in body, "the audit step would block on the known PostCSS advisory in next 15.5.x"
    assert "npm audit --omit=dev --audit-level=high" in body
    assert "PostCSS" in body, "the step must say WHY it is non-blocking"


def test_the_workflow_token_is_read_only():
    assert re.search(r"^permissions:\n  contents: read\n", WF, re.M)


def test_pyproject_still_declares_what_the_matrix_assumes():
    assert tomllib.loads((ROOT / "pyproject.toml").read_text())["project"]["requires-python"] == ">=3.11"
