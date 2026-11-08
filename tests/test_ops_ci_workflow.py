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


def _code(step: str) -> str:
    """The step without its comment lines, so a pin cannot be satisfied (or tripped) by prose."""
    return "\n".join(ln for ln in step.splitlines() if not ln.lstrip().startswith("#"))


def test_the_site_job_measures_the_bundle_budget_against_a_production_server_after_the_build():
    names = [n for n, _ in _site_steps()]
    build = next(i for i, n in enumerate(names) if n.startswith("Build"))
    perf = next(i for i, n in enumerate(names) if n.startswith(PERF_STEP_NAME))
    assert perf > build, "the budget cannot be measured before there is a production build"
    step = _code(_perf_step())
    # every way the step could stop failing the job
    assert "continue-on-error" not in step, "a budget that cannot fail the job is not a budget"
    assert not re.search(r"\bif:", step), "a step-level `if:` can skip the budget"
    assert re.search(r"^        timeout-minutes: \d+$", step, re.M), "without a timeout a hung browser holds the required check for six hours"
    assert "set -euo pipefail" in step
    assert re.search(r"^\s*PERF_BASE_URL=\"http://127\.0\.0\.1:\$\{PERF_PORT\}\" NODE_PATH=\"\$PW/node_modules\" npx vitest run tests/site/perf-budget\.test\.ts\s*$", step, re.M), (
        "the last command must be exactly the vitest run of the budget file: no `|| true`, `-t`, `--passWithNoTests` or other suffix")
    last = [ln for ln in step.splitlines() if ln.strip()][-1]
    assert "npx vitest run tests/site/perf-budget.test.ts" in last, "nothing may follow the vitest run: its exit status is the step's"
    assert 'next start -p "$PERF_PORT"' in step, "the server must listen on the port the measurement is pointed at"
    assert "next dev" not in step, "the budget is measured on the PRODUCTION server"
    port = re.search(r"PERF_PORT: '(\d+)'", step)
    assert port and port.group(1) not in {"3941", "3009", "3010"}, "a port the other steps or verify:local already use"
    # `|| true` hides a failure; only these two lines may carry it (stopping a server that may already be gone, and a curl probe)
    allowed = ("trap 'kill \"$SERVER_PID\" 2>/dev/null || true' EXIT", "curl -s -o /dev/null --max-time 3 -w '%{http_code}'")
    for ln in step.splitlines():
        if "|| true" in ln:
            assert any(a in ln for a in allowed), f"`|| true` would hide a failure: {ln.strip()}"


def test_the_budget_step_waits_for_http_200_confirms_the_server_is_its_own_and_always_stops_it():
    step = _code(_perf_step())
    assert 'WAIT="${PERF_WAIT_SECONDS:-60}"' in step and 'seq 1 "$WAIT"' in step, "about 60 s to come up"
    assert "%{http_code}" in step and '= "200"' in step, "wait until the server ANSWERS 200, not merely until the port is open"
    # a port that already answers would be measured instead of this build
    assert re.search(r'if curl -s -o /dev/null --max-time \d+ "http://127\.0\.0\.1:\$\{PERF_PORT\}/"; then', step)
    assert "already answers HTTP before the production server was started" in step
    # and the process we started must still be alive after the first 200 (EADDRINUSE kills it while a foreign server keeps answering)
    assert 'kill -0 "$SERVER_PID"' in step and step.count('kill -0 "$SERVER_PID"') >= 3
    assert re.search(r"::error::the production server did not answer HTTP 200 on port \$\{PERF_PORT\} within \$\{WAIT\} s", step)
    assert re.search(r"::error::the production server process exited before it served port", step)
    assert step.count("exit 1") >= 2 and 'tail -40 "$LOG"' in step, "show the server's own log when it does not come up"
    assert re.search(r"trap '.*kill .*' EXIT", step), "the server must be stopped whatever happens"


def test_the_budget_step_gets_its_own_pinned_browser_with_bounded_retries_and_without_touching_package_json():
    step = _code(_perf_step())
    assert re.search(r"PLAYWRIGHT_VERSION: '\d+\.\d+\.\d+'", step), "pin the browser driver: its version changes what a byte count means"
    assert re.search(r'^\s*retry 3 npm install --prefix "\$PW" .* "playwright@\$\{PLAYWRIGHT_VERSION\}"$', step, re.M)
    assert "playwright@latest" not in step
    assert re.search(r'^\s*retry 3 "\$PW/node_modules/\.bin/playwright" install --with-deps chromium$', step, re.M)
    assert "retry()" in step and "return 1" in step, "after the last attempt the step must fail"
    assert 'NODE_PATH="$PW/node_modules"' in step, "scripts/measure-bundles.mjs finds playwright through NODE_PATH"
    assert "playwright" not in (ROOT / "package.json").read_text(), "playwright is installed by this one step only; add it to package.json deliberately"


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


def _realdb_steps() -> dict[str, str]:
    """{step name: its `run:` command line(s)} of the real-database job."""
    out = {}
    for p in re.split(r"^      - (?=name:)", _job("real-database"), flags=re.M)[1:]:
        m = re.match(r"name: (.*)\n(?:        .*\n)*?        run: (.*)", p)
        if m:
            out[m.group(1).strip()] = m.group(2).strip()
    return out


def test_the_salted_site_reference_migration_test_runs_on_real_postgres():
    steps = _realdb_steps()
    hits = {n: r for n, r in steps.items() if n.startswith("Salted site reference (0053)")}
    assert len(hits) == 1, "the real-database job needs exactly one 'Salted site reference (0053)' step"
    (name, run), = hits.items()
    assert run == "python -m pytest tests/test_salted_site_ref_migration.py -q"
    assert "never skips" in name
    assert any("0001-0053" in n for n in steps), "the whole-chain step must say it covers 0001-0053"
    assert not any("0001-0052" in n for n in steps), "a step still claims the chain ends at 0052"
