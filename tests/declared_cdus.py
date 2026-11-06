"""A declared CDU schedule for tests that need a liquid scenario to be DATED.

The shipped example intakes leave ``thermal.cdus`` empty, so the loader assumes a kit (``installed=False``) and, since the week-zero fix
(tests/test_week_zero_assumed_equipment.py), every liquid scenario of those halls is undated: "not declared: CDUs". A test about how a
date is built, banded, labelled or ranked needs a dated scenario, so it declares the same hardware the loader would have assumed
(3 x 1,350 kW, N+1). That is a fixture for the test, never a statement about the example hall.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

DECLARED_CDUS = [{"id": "CDU-ROW", "rated_capacity_kW": 1350, "rated_approach_K": 5, "rated_flow_l_per_min": 2000,
                  "units": 3, "redundancy": "N+1"}]


def with_declared_cdus(doc: dict) -> dict:
    """A deep copy of ``doc`` with the CDU schedule declared."""
    d = copy.deepcopy(doc)
    d.setdefault("thermal", {})["cdus"] = copy.deepcopy(DECLARED_CDUS)
    return d


def declared_copy(path: Path, into: Path) -> Path:
    """Write ``path`` (an example intake) with the CDU schedule declared to ``into`` and return that path (for CLI tests that take a file)."""
    into.write_text(json.dumps(with_declared_cdus(json.loads(Path(path).read_text(encoding="utf-8")))), encoding="utf-8")
    return into
