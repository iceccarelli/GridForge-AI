"""Deploy-readiness structure that must not rot (text checks: CI installs pytest only, so no YAML parser is assumed).

* the rollback anchors the deploy workflow records before it changes anything, and the independent one-machine assertion after it;
* the CI checks that can be made REQUIRED in branch protection must report on every pull request (a path filter on pull_request means a
  website-only change never gets the check, and a required check that never reports blocks the merge for ever);
* no script, workflow or site source claims a docs/*.md file that is not in the repository;
* the persisted-format and first-boot facts stay written next to the deploy summary.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WF = ROOT / ".github" / "workflows"


def code_lines(text):
    return [ln for ln in text.splitlines() if not ln.lstrip().startswith("#")]


def steps(name):
    """[(step name, step text)] of the single job in a workflow, in order; comment lines are dropped."""
    lines = code_lines((WF / name).read_text())
    out, cur = [], None
    for ln in lines:
        m = re.match(r"^      - (?:name: (.*)|(uses: .*))$", ln)
        if m:
            cur = [m.group(1) or m.group(2), []]
            out.append(cur)
        if cur is not None:
            cur[1].append(ln)
    return [(n, "\n".join(b)) for n, b in out]


def step(name, label):
    hit = [t for n, t in steps(name) if n.startswith(label)]
    assert len(hit) == 1, f"{name}: want exactly one step named {label!r}, found {len(hit)}"
    return hit[0]


def index_of(name, label):
    return [n for n, _ in steps(name)].index(next(n for n, _ in steps(name) if n.startswith(label)))


# ---- the facts that must stay next to the deploy summary -----------------------------------------------------------------------
def test_the_deploy_script_records_the_persisted_format_and_first_boot_facts():
    s = (ROOT / "scripts" / "deploy-engine.sh").read_text()
    assert "PERSISTED-FORMAT AND FIRST-BOOT FACTS" in s
    for needle in ("GRIDFORGE_USAGE_FILE", "GRIDFORGE_LEDGER_FILE", "GRIDFORGE_REVOKED_FILE", "GRIDFORGE_COST_FILE", "GRIDFORGE_CALIBRATION_RECORDS",
                   "GRIDFORGE_TRUSTED_PROXY_HOPS", "GRIDFORGE_TRUSTED_IP_HEADER", "GRIDFORGE_ENFORCE_SECRET_STRENGTH", "FLY_APP_NAME"):
        assert needle in s, needle
    assert s.index("PERSISTED-FORMAT AND FIRST-BOOT FACTS") < s.index("summary() {")
