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


# ---- the per-route JavaScript budget is enforced on every pull request, not only by whoever remembers to run it ---------------------

PERF_STEP_NAME = "No route may ship more first-load JavaScript than scripts/perf-budget.json allows"


def _site_steps() -> list[tuple[str, str]]:
    """[(step name, step text)] of the `site` job; a step starts at a `      - ` line."""
    parts = re.split(r"^      - (?=name:|run:|uses:)", _job("site"), flags=re.M)[1:]
    out = []
    for p in parts:
        m = re.match(r"name: (.*)", p)
        out.append((m.group(1).strip() if m else "", p))
    return out


def _perf_step() -> str:
    hits = [t for n, t in _site_steps() if n.startswith(PERF_STEP_NAME)]
    assert len(hits) == 1, f"the site job must have exactly one step named {PERF_STEP_NAME!r}..., found {len(hits)}"
    return hits[0]


def test_the_site_job_measures_the_bundle_budget_against_a_production_server_after_the_build():
    names = [n for n, _ in _site_steps()]
    build = next(i for i, n in enumerate(names) if n.startswith("Build"))
    perf = next(i for i, n in enumerate(names) if n.startswith(PERF_STEP_NAME))
    assert perf > build, "the budget cannot be measured before there is a production build"
    step = _perf_step()
    assert "next start" in step, "the budget is measured on the PRODUCTION server, not `next dev`"
    assert "next dev" not in step
    assert "continue-on-error" not in step, "a budget that cannot fail the job is not a budget"
    assert "vitest run tests/site/perf-budget.test.ts" in step
    assert re.search(r'PERF_BASE_URL="http://127\.0\.0\.1:\$\{PERF_PORT\}"', step), "the live comparison must be switched on by this step"
    port = re.search(r"PERF_PORT: '(\d+)'", step)
    assert port and port.group(1) not in {"3941", "3009", "3010"}, "a port the other steps or verify:local already use"


def test_the_budget_step_waits_for_http_200_and_always_stops_the_server():
    step = _perf_step()
    assert "curl" in step and "%{http_code}" in step and '= "200"' in step, "wait until the server ANSWERS 200, not merely until the port is open"
    assert re.search(r"seq 1 60", step), "about 60 s to come up"
    assert re.search(r"::error::.*did not answer HTTP 200", step) and "exit 1" in step, "a server that never comes up must fail the step, with a message"
    assert "tail -40 /tmp/perf-next-start.log" in step, "show the server's own log when it does not come up"
    assert re.search(r"trap '.*kill .*' EXIT", step), "the server must be stopped whatever happens"
    assert "set -euo pipefail" in step


def test_the_budget_step_gets_its_own_pinned_browser_without_touching_package_json():
    step = _perf_step()
    assert re.search(r"PLAYWRIGHT_VERSION: '\d+\.\d+\.\d+'", step), "pin the browser driver: its version changes what a byte count means"
    assert "playwright@${PLAYWRIGHT_VERSION}" in step and "playwright@latest" not in step
    assert "install --with-deps chromium" in step
    assert 'NODE_PATH="$PW/node_modules"' in step, "scripts/measure-bundles.mjs finds playwright through NODE_PATH"
    pkg = (ROOT / "package.json").read_text()
    assert "playwright" not in pkg, "playwright is installed by this one step only; add it to package.json deliberately, not by accident"


def test_only_the_whole_suite_step_may_defer_the_budget_and_it_says_so():
    """tests/site/perf-budget.test.ts fails in CI unless PERF_BASE_URL is set. `npm test` runs before there is a build, so it defers
    explicitly; nothing else may, and the measuring step must not."""
    users = [n for n, t in _site_steps() if "PERF_BUDGET_DEFERRED" in t and not t.lstrip().startswith("#")]
    assert len(users) == 1, f"PERF_BUDGET_DEFERRED appears in steps {users}"
    deferring = next(t for n, t in _site_steps() if "PERF_BUDGET_DEFERRED" in t)
    assert "npm test" in deferring and "PERF_BUDGET_DEFERRED: '1'" in deferring
    assert "PERF_BUDGET_DEFERRED" not in _perf_step(), "the step that measures must not be able to defer"
    for job in ("test", "deliverables", "reference", "observatory", "api", "real-database", "real-storage"):
        assert "PERF_BUDGET_DEFERRED" not in _job(job)
        assert "perf-budget" not in _job(job), f"{job} runs the perf test, where there is no production server to measure"
