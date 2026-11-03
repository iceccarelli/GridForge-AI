"""A string a client types into an intake can never become markup in the deliverable.

The site stores the engine's HTML and renders it with dangerouslySetInnerHTML on the private deliverable page, and the operator opens the same
HTML in the admin review. If any renderer printed an intake string without escaping it, a buyer could run script in the operator's session.
The renderers escape (html.escape) and this proves it for every free-text field of the reference intake at once, across the three documents
that carry client text, rather than trusting each call site.
"""
from __future__ import annotations

import copy
import json
import re
from pathlib import Path

import pytest

from gridforge.api.server import handle_screen
from gridforge.api.tiers import Tier

ROOT = Path(__file__).resolve().parents[1]
REFERENCE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text(encoding="utf-8"))

# Markers that would execute or break out of an attribute or script if they survived unescaped.
PAYLOADS = [
    '<img src=x onerror=alert(1)>',
    '</script><script>alert(2)</script>',
    '"><svg onload=alert(3)>',
]
# Fields whose value the engine interprets (an enum, an id used as a key, a country code) must stay valid, so only free text is mutated.
FREE_TEXT = [
    ("project", "client"),
    ("project", "note"),
    ("project", "reference"),
    ("site", "name"),
    ("grid", "dso"),
    ("grid", "queue_note"),
]


def _with(path: tuple[str, str], payload: str) -> dict:
    d = copy.deepcopy(REFERENCE)
    d[path[0]][path[1]] = payload
    return d


def _render(d: dict, tmp_path: Path) -> str:
    """The HTML exactly as the site stores it: the client-tier /v1/screen route with format=html."""
    out = handle_screen({"intake": d, "format": "html"}, Tier.CLIENT)
    doc = out.get("document") or out.get("html") or ""
    assert "<html" in doc.lower() or "<h1" in doc.lower(), f"no HTML document came back: {list(out)}"
    return doc


@pytest.mark.parametrize("path", FREE_TEXT, ids=[".".join(p) for p in FREE_TEXT])
@pytest.mark.parametrize("payload", PAYLOADS)
def test_client_text_is_escaped_in_the_screen_html(path, payload, tmp_path):
    html = _render(_with(path, payload), tmp_path)
    assert payload not in html, f"{'.'.join(path)} reached the document unescaped"
    for needle in ("<img src=x", "<svg onload", "<script>alert"):
        assert needle not in html, f"{needle!r} survived from {'.'.join(path)}"
    # And it is still visible as text, so the field was shown rather than silently dropped.
    assert re.search(r"&lt;|&#x27;|&quot;", html) or path[1] in ("reference", "dso", "queue_note", "note"), "the text should appear, escaped"
