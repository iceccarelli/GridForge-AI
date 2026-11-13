"""Resolve the request examples in lib/openapi-examples.json into the plain bodies they stand for.

An example value of the form {"$from": "<repository path>" | "#bases/<name>", "$set": {"<dotted path>": <value>}} is that file (or named base)
with the listed fields replaced. lib/openapi-examples.ts resolves the same markers for /openapi.json; this is the python side, used by the tests
that send the examples to the engine.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXAMPLES = json.loads((ROOT / "lib" / "openapi-examples.json").read_text())


def set_path(target, dotted, value):
    parts = dotted.split(".")
    cur = target
    for p in parts[:-1]:
        cur = cur.setdefault(p, {})
    cur[parts[-1]] = value


def resolve(node):
    if isinstance(node, list):
        return [resolve(x) for x in node]
    if isinstance(node, dict):
        if "$from" in node:
            assert set(node) <= {"$from", "$set"}, node
            src = node["$from"]
            base = EXAMPLES["bases"][src[len("#bases/"):]] if src.startswith("#bases/") else json.loads((ROOT / src).read_text())
            out = copy.deepcopy(base)
            for dotted, value in node.get("$set", {}).items():
                set_path(out, dotted, copy.deepcopy(value))
            return out
        return {k: resolve(v) for k, v in node.items()}
    return node


def example_bodies(path: str) -> dict[str, dict]:
    """The named, resolved request examples for one path."""
    return {name: resolve(e["value"]) for name, e in EXAMPLES["requests"][path].items()}
