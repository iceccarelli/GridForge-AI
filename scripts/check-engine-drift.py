#!/usr/bin/env python3
"""Read-only: does the DEPLOYED engine serve what this repository says it serves?

    python3 scripts/check-engine-drift.py [https://gridforge-engine.fly.dev]

The version string does not move on every change, so "version 0.9.0" proves nothing about
which routes exist. This compares the repo's ROUTES and UNIT_COST with the deployed
engine's public /v1/version and exits non-zero on any difference. It sends only GET
requests and no credentials, so it is safe against production.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from gridforge.api.metering import UNIT_COST  # noqa: E402
from gridforge.provenance import code_sha256  # noqa: E402
from gridforge.api.server import ROUTES, VERSION  # noqa: E402


def drift(deployed: dict) -> list[str]:
    problems: list[str] = []
    served = set(deployed.get("endpoints", []))
    for path in sorted(ROUTES):
        if path not in served:
            problems.append(f"route {path} is in this repository but the deployed engine does not list it")
    remote_rates = deployed.get("unit_rates", {})
    for path, units in sorted(UNIT_COST.items()):
        if path in ROUTES and remote_rates.get(path) != units:
            problems.append(f"unit rate for {path}: repo {units}, deployed {remote_rates.get(path)!r}")
    if deployed.get("version") != VERSION:
        problems.append(f"version: repo {VERSION}, deployed {deployed.get('version')!r}")
    # The version string does not move on every change; the code digest does. An engine built from a different tree than this one
    # (or from before the digest was published) is not the engine this repository describes, whatever its routes say.
    prov = deployed.get("provenance")
    if not isinstance(prov, dict) or not prov.get("code_sha256"):
        problems.append("the deployed engine publishes no code digest (provenance.code_sha256): it was built before the digest existed")
    elif prov["code_sha256"] != code_sha256():
        problems.append("code digest: the deployed engine was built from a different tree than this repository "
                        f"(repo {code_sha256()[:12]}, deployed {str(prov['code_sha256'])[:12]})")
    metering = deployed.get("metering") if isinstance(deployed.get("metering"), dict) else {}
    if "ledger_durable" not in metering:
        problems.append("the deployed engine does not report ledger_durable: it predates the usage ledger")
    return problems


def main() -> int:
    base = (sys.argv[1] if len(sys.argv) > 1 else os.environ.get("GRIDFORGE_API_URL")
            or "https://gridforge-engine.fly.dev").rstrip("/")
    with urllib.request.urlopen(base + "/v1/version", timeout=20) as resp:  # noqa: S310 - GET, no credentials
        deployed = json.load(resp)
    problems = drift(deployed)
    if not problems:
        print(f"{base}: serves every route and unit rate in this repository")
        return 0
    print(f"{base}: DRIFT from this repository ({len(problems)}):")
    for p in problems:
        print("  -", p)
    print("Redeploy with scripts/deploy-engine.sh (needs Fly credentials) before selling or announcing these routes.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
