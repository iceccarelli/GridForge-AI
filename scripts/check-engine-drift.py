#!/usr/bin/env python3
"""Read-only: does the DEPLOYED engine serve what this repository says it serves?

    python3 scripts/check-engine-drift.py [BASE_URL] [--json] [--write-snapshot PATH] [--summary-file PATH]

The version string does not move on every change, so "version 0.9.0" proves nothing about
which routes exist. This compares the repo's ROUTES, UNIT_COST, code digest, ledger flag and
tool names with the deployed engine's public /v1/version and /v1/tools and exits non-zero on
any difference. It sends only GET requests and no credentials, so it is safe against production.

Output: differences are grouped (routes / unit rates / version / provenance / ledger / tools) and
the exact operator step is printed. Nothing is hidden or softened: every assertion is kept.

  --json                 machine-readable result on stdout (same exit code)
  --write-snapshot PATH  also write what the live engine reports, as plain JSON:
                         {fetched_at, base, version, endpoints, unit_rates, code_sha256}.
                         Written even when there is drift (it records what IS deployed);
                         never written when /v1/version could not be read.
  --summary-file PATH    append a Markdown summary (CI: $GITHUB_STEP_SUMMARY)
  --require-clean-tree   exit 2 unless every file under gridforge/ is committed and unmodified. The code digest hashes the files that are
                         on disk; CI hashes a clean checkout. On a dirty tree the two can disagree, so this says so instead of guessing.

The output always names the endpoint, both code digests and whether the working tree is clean, so a local result and a CI result can
be compared line for line. Local and CI run this same script, the same digest function (gridforge.provenance.code_sha256) and the same
default endpoint; the only inputs that can differ are the base URL (argument or GRIDFORGE_API_URL, named in the output when it is not
the default), the state of the working tree (reported), and WHEN the check runs relative to a deploy.

Exit status: 0 no drift, 1 drift, 2 the engine could not be read (or --require-clean-tree was not met).
"""
from __future__ import annotations

import datetime as _dt
import json
import os
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gridforge.api.metering import UNIT_COST  # noqa: E402
from gridforge.provenance import code_sha256  # noqa: E402
from gridforge.api.server import ROUTES, VERSION  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BASE = "https://gridforge-engine.fly.dev"
TOOLS_JSON = ROOT / "public" / "reference" / "tools.json"

# Display order and heading for each group of differences.
GROUPS = [
    ("routes", "Missing routes"),
    ("unit_rates", "Unit rates"),
    ("version", "Version"),
    ("provenance", "Provenance (code digest)"),
    ("ledger", "Usage ledger"),
    ("tools", "Tool names (/v1/tools)"),
]

OPERATOR_STEP = ("Run the 'deploy-engine' GitHub Actions workflow (Actions -> deploy-engine -> Run workflow, type DEPLOY), "
                 "or from a machine with Fly credentials: bash scripts/deploy-engine.sh. "
                 "Needs the repository secret FLY_API_TOKEN (fly tokens create deploy -a gridforge-engine).")


def tree_state(root: Path = ROOT) -> tuple[str, list[str]]:
    """("clean" | "dirty" | "unknown", changed paths) for the files the code digest covers (everything under gridforge/).

    "unknown" means this is not a git checkout or git is unavailable; it is reported, never read as clean."""
    import subprocess
    try:
        out = subprocess.run(["git", "-C", str(root), "status", "--porcelain", "--untracked-files=all", "--", "gridforge"],
                             capture_output=True, text=True, timeout=30, check=True).stdout
    except (OSError, subprocess.SubprocessError):
        return "unknown", []
    changed = [line[3:] for line in out.splitlines() if line.strip()]
    return ("dirty" if changed else "clean"), changed


def repo_tool_names() -> dict[str, str]:
    """endpoint -> tool name, from the committed public/reference/tools.json."""
    data = json.loads(TOOLS_JSON.read_text())
    return {t["endpoint"]: t["name"] for t in data.get("tools", []) if isinstance(t, dict) and "endpoint" in t and "name" in t}


def drift_grouped(deployed: dict, tools: dict | None = None) -> dict[str, list[str]]:
    """Every difference between this repository and the deployed engine, grouped.

    `tools` is the deployed /v1/tools document; None means "not checked" (offline unit tests), never "fine".
    """
    out: dict[str, list[str]] = {key: [] for key, _ in GROUPS}
    served = set(deployed.get("endpoints", []))
    for path in sorted(ROUTES):
        if path not in served:
            out["routes"].append(f"route {path} is in this repository but the deployed engine does not list it")
    remote_rates = deployed.get("unit_rates", {})
    for path, units in sorted(UNIT_COST.items()):
        if path in ROUTES and remote_rates.get(path) != units:
            out["unit_rates"].append(f"unit rate for {path}: repo {units}, deployed {remote_rates.get(path)!r}")
    if deployed.get("version") != VERSION:
        out["version"].append(f"version: repo {VERSION}, deployed {deployed.get('version')!r}")
    # The version string does not move on every change; the code digest does. An engine built from a different tree than this one
    # (or from before the digest was published) is not the engine this repository describes, whatever its routes say.
    prov = deployed.get("provenance")
    if not isinstance(prov, dict) or not prov.get("code_sha256"):
        out["provenance"].append("the deployed engine publishes no code digest (provenance.code_sha256): it was built before the digest existed")
    elif prov["code_sha256"] != code_sha256():
        out["provenance"].append("code digest: the deployed engine was built from a different tree than this repository "
                                 f"(repo {code_sha256()[:12]}, deployed {str(prov['code_sha256'])[:12]})")
    metering = deployed.get("metering") if isinstance(deployed.get("metering"), dict) else {}
    if "ledger_durable" not in metering:
        out["ledger"].append("the deployed engine does not report ledger_durable: it predates the usage ledger")
    if tools is not None:
        out["tools"].extend(tool_drift(served, tools))
    return out


def tool_drift(served: set[str], tools: dict) -> list[str]:
    """For routes the engine serves, /v1/tools must list exactly the tool names tools.json declares."""
    problems: list[str] = []
    rows = tools.get("tools") if isinstance(tools, dict) else None
    if not isinstance(rows, list):
        return ["/v1/tools did not return a {\"tools\": [...]} document"]
    live = {t.get("endpoint"): t.get("name") for t in rows if isinstance(t, dict)}
    expected = repo_tool_names()
    for endpoint, name in sorted(expected.items()):
        if endpoint not in served:
            continue  # a route the engine does not serve is already reported under "Missing routes"
        if endpoint not in live:
            problems.append(f"tool {name} ({endpoint}): the engine serves the route but /v1/tools does not list it")
        elif live[endpoint] != name:
            problems.append(f"tool name for {endpoint}: repo {name!r}, deployed {live[endpoint]!r}")
    for endpoint, name in sorted(live.items(), key=lambda kv: str(kv[0])):
        if endpoint in served and endpoint not in expected:
            problems.append(f"tool {name!r} ({endpoint}) is listed by the deployed /v1/tools but not in public/reference/tools.json")
    return problems


def drift(deployed: dict, tools: dict | None = None) -> list[str]:
    """Flat list of differences (grouped order); [] means no drift."""
    grouped = drift_grouped(deployed, tools)
    return [p for key, _ in GROUPS for p in grouped[key]]


def snapshot(deployed: dict, base: str, now: _dt.datetime | None = None) -> dict:
    prov = deployed.get("provenance") if isinstance(deployed.get("provenance"), dict) else {}
    endpoints = deployed.get("endpoints")
    return {
        "fetched_at": (now or _dt.datetime.now(_dt.timezone.utc)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "base": base,
        "version": deployed.get("version"),
        "endpoints": sorted(e for e in endpoints if isinstance(e, str)) if isinstance(endpoints, list) else [],
        "unit_rates": deployed.get("unit_rates") if isinstance(deployed.get("unit_rates"), dict) else {},
        "code_sha256": prov.get("code_sha256"),
    }


def write_snapshot(path: str, snap: dict) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(target.name + ".tmp")
    tmp.write_text(json.dumps(snap, indent=2, sort_keys=True) + "\n")
    os.replace(tmp, target)


def digest_line(deployed: dict, tree: tuple[str, list[str]] | None) -> str:
    prov = deployed.get("provenance") if isinstance(deployed.get("provenance"), dict) else {}
    live = prov.get("code_sha256")
    repo = code_sha256()
    state = tree[0] if tree else "not checked"
    verdict = "same" if live == repo else "DIFFERENT"
    return (f"code digest: repo {repo[:12]}, deployed {str(live)[:12] if live else 'none published'} ({verdict}); "
            f"working tree under gridforge/: {state}")


def render_text(base: str, grouped: dict[str, list[str]], deployed: dict | None = None,
                tree: tuple[str, list[str]] | None = None) -> str:
    total = sum(len(v) for v in grouped.values())
    extra = [digest_line(deployed, tree)] if deployed is not None else []
    if tree and tree[0] == "dirty":
        extra.append("note: uncommitted changes under gridforge/ (" + ", ".join(tree[1][:5]) + ("..." if len(tree[1]) > 5 else "")
                     + "). The digest above is of your working files; CI hashes the committed tree.")
    if tree and tree[0] == "unknown":
        extra.append("note: not a git checkout, so whether the working tree matches a commit is unknown.")
    if not total:
        return "\n".join([f"{base}: no drift. Compared: routes, unit rates, version, usage ledger, tool names and code digest "
                          "against this repository.", *extra])
    lines = [f"{base}: DRIFT from this repository ({total}):", *extra]
    for key, title in GROUPS:
        if grouped[key]:
            lines.append(f"  {title} ({len(grouped[key])}):")
            lines.extend(f"    - {p}" for p in grouped[key])
    lines.append("Operator step: " + OPERATOR_STEP)
    lines.append("Do not sell or announce these routes until the engine is redeployed.")
    return "\n".join(lines)


def render_markdown(base: str, grouped: dict[str, list[str]]) -> str:
    total = sum(len(v) for v in grouped.values())
    if not total:
        return f"### Engine drift: none\n\n`{base}` serves every route, unit rate, code digest and tool name in this repository.\n"
    lines = [f"### Engine drift: {total} difference(s)", "",
             f"`{base}` does **not** match this repository. Do not sell or announce the routes below until it is redeployed.", ""]
    for key, title in GROUPS:
        if grouped[key]:
            lines.append(f"**{title}** ({len(grouped[key])})")
            lines.extend(f"- {p}" for p in grouped[key])
            lines.append("")
    lines += ["**The one operator action:** run the `deploy-engine` workflow (Actions, deploy-engine, Run workflow, type `DEPLOY`).",
              "It needs the repository secret `FLY_API_TOKEN` (`fly tokens create deploy -a gridforge-engine`).", ""]
    return "\n".join(lines)


def fetch_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=20) as resp:  # noqa: S310 - GET, no credentials
        return json.load(resp)


def main(argv: list[str] | None = None, fetch=None, tree=None) -> int:
    """`fetch(url) -> dict` and `tree() -> (state, changed)` are injectable so tests need no network and no git state."""
    fetch = fetch or fetch_json
    tree = tree or tree_state
    args = list(sys.argv[1:] if argv is None else argv)
    as_json = False
    require_clean = False
    snap_path = summary_path = None
    positional: list[str] = []
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--json":
            as_json = True
        elif a == "--require-clean-tree":
            require_clean = True
        elif a in ("--write-snapshot", "--summary-file"):
            if i + 1 >= len(args):
                print(f"{a} needs a path", file=sys.stderr)
                return 2
            i += 1
            if a == "--write-snapshot":
                snap_path = args[i]
            else:
                summary_path = args[i]
        elif a in ("-h", "--help"):
            print(__doc__)
            return 0
        elif a.startswith("-"):
            print(f"unknown option: {a}", file=sys.stderr)
            return 2
        else:
            positional.append(a)
        i += 1
    from_env = not positional and bool(os.environ.get("GRIDFORGE_API_URL"))
    base = (positional[0] if positional else os.environ.get("GRIDFORGE_API_URL") or DEFAULT_BASE).rstrip("/")
    if from_env and base != DEFAULT_BASE:
        # CI runs without GRIDFORGE_API_URL, so a local run that has it set is not checking the same engine as CI. Say so.
        print(f"note: base URL taken from GRIDFORGE_API_URL ({base}); CI checks {DEFAULT_BASE}", file=sys.stderr)
    state = tree()
    if require_clean and state[0] != "clean":
        msg = (f"--require-clean-tree: working tree under gridforge/ is {state[0]}"
               + (f" ({', '.join(state[1][:5])})" if state[1] else "") + ". Nothing was verified.")
        print(json.dumps({"base": base, "ok": False, "error": msg, "tree": state[0], "differences": {}, "count": 0}, indent=2)
              if as_json else msg)
        return 2

    try:
        deployed = fetch(base + "/v1/version")
        if not isinstance(deployed, dict):
            raise ValueError("/v1/version is not a JSON object")
    except Exception as exc:  # noqa: BLE001 - any failure to read the engine is reported, never swallowed into "no drift"
        msg = f"{base}: could not read /v1/version ({type(exc).__name__}: {exc}). Nothing was verified."
        if as_json:
            print(json.dumps({"base": base, "ok": False, "error": msg, "differences": {}, "count": 0}, indent=2))
        else:
            print(msg)
        if summary_path:
            with open(summary_path, "a") as fh:
                fh.write(f"### Engine drift: unreadable\n\n{msg}\n")
        return 2

    tools: dict | None
    tools_error = None
    try:
        tools = fetch(base + "/v1/tools")
    except Exception as exc:  # noqa: BLE001
        tools = None
        tools_error = f"could not read {base}/v1/tools ({type(exc).__name__}: {exc})"
    grouped = drift_grouped(deployed, tools)
    if tools_error:
        grouped["tools"].append(tools_error)

    if snap_path:
        write_snapshot(snap_path, snapshot(deployed, base))

    total = sum(len(v) for v in grouped.values())
    if as_json:
        live_prov = deployed.get("provenance") if isinstance(deployed.get("provenance"), dict) else {}
        print(json.dumps({"base": base, "ok": total == 0, "repo_version": VERSION, "deployed_version": deployed.get("version"),
                          "repo_code_sha256": code_sha256(), "deployed_code_sha256": live_prov.get("code_sha256"),
                          "tree": state[0], "count": total, "differences": {k: v for k, v in grouped.items() if v},
                          "operator_step": None if total == 0 else OPERATOR_STEP}, indent=2))
    else:
        print(render_text(base, grouped, deployed, state))
    if summary_path:
        with open(summary_path, "a") as fh:
            fh.write(render_markdown(base, grouped))
    return 0 if total == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
