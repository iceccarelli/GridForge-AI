"""JSON that says one thing once.

`json.loads` keeps the LAST of two equal keys without a word, so {"contracted_MW": 3, ..., "contracted_MW": 10} meant 10 and the 3 vanished. The HTTP
layer refuses a request that repeats a key (a 422 naming the key); the command line read the same text as the last value and exited 0. This is the
one helper both use, so a document means the same thing wherever it is read. It lives in the intake package because the loader needs it and the API
imports the loader (the other way round would be circular).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class DuplicateKeyError(ValueError):
    """An object in the JSON text repeats a key."""


def refuse_duplicate_keys(pairs):
    """`object_pairs_hook` for `json.loads`: refuse an object that repeats a key, naming the key. A request that says one thing twice is ambiguous."""
    seen: set[str] = set()
    for key, _ in pairs:
        if key in seen:
            raise DuplicateKeyError(f"the object repeats the key {key[:60]!r}; each key may appear once")
        seen.add(key)
    return dict(pairs)


def loads(text: str | bytes, **kwargs: Any) -> Any:
    """`json.loads` that refuses a repeated key (a `DuplicateKeyError`, which is a `ValueError`, as `json.JSONDecodeError` is)."""
    return json.loads(text, object_pairs_hook=refuse_duplicate_keys, **kwargs)


def read_json(path: str | Path) -> Any:
    """The JSON document in a file, refusing a repeated key (`DuplicateKeyError`) as the HTTP layer does."""
    return loads(Path(path).read_text())
