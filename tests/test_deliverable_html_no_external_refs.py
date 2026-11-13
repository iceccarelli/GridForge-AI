"""Opening a deliverable must request nothing from anyone (audit J3-6).

The engine's HTML linked Google Fonts, so opening a tender specification (a document a client sends to its suppliers) told a third party that
someone was reading it. The deliverables use system font stacks and carry their style inline; this scans what the engine renders, for every
way an HTML document can make the browser fetch something: a stylesheet or script by URL, an image, an @import, a url() in CSS, a form
action, a meta refresh, a preconnect. An ordinary `<a href>` a reader clicks is not a request made by opening the page, and is allowed.
"""
from __future__ import annotations

import json
import re
from html.parser import HTMLParser
from pathlib import Path

import pytest

from gridforge.api import server as S
from gridforge.api.tiers import Tier

ROOT = Path(__file__).resolve().parents[1]
INTAKE = json.loads((ROOT / "examples" / "intake" / "reference_hall.json").read_text())

#: Attributes that make a browser fetch their value on load, on any element.
FETCHING = {"src", "srcset", "data", "poster", "action", "formaction", "ping", "manifest", "background", "codebase", "icon"}
CSS_IMPORT = re.compile(r"@import", re.I)
CSS_URL = re.compile(r"url\(\s*(['\"]?)\s*([^'\")\s]*)", re.I)
SCRIPT_REQUEST = re.compile(r"\b(fetch|XMLHttpRequest|importScripts|sendBeacon|WebSocket|EventSource)\b|\bimport\s*\(|https?://", re.I)


def _css_refs(css: str, where: str) -> list[str]:
    found = [f"{where}: @import" for _ in CSS_IMPORT.finditer(css)]
    for m in CSS_URL.finditer(css):
        target = m.group(2)
        if target and not target.startswith(("data:", "#")):
            found.append(f"{where}: url({target[:60]})")
    return found


class _Scanner(HTMLParser):
    """Collects every reference that would be requested when the page is opened."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.found: list[str] = []
        self._style = self._script = False

    def handle_starttag(self, tag, attrs):
        a = {k: (v or "") for k, v in attrs}
        for name, value in a.items():
            if name in FETCHING and value.strip() and not value.lstrip().lower().startswith("data:"):
                self.found.append(f"<{tag} {name}={value[:60]!r}>")       # a remote OR a relative reference: either is fetched when the page opens
            elif name == "href" and tag not in ("a", "area") and value.strip():
                self.found.append(f"<{tag} href={value[:60]!r}>")      # link, base: a stylesheet, a preconnect, a base that redirects every relative URL
            if name == "style":
                self.found += _css_refs(value, f"<{tag} style>")
        if tag == "meta" and a.get("http-equiv", "").lower() == "refresh":
            self.found.append("<meta http-equiv=refresh>")
        if tag == "link":
            self.found.append(f"<link rel={a.get('rel', '')!r}>")
        if tag == "style":
            self._style = True
        if tag == "script":
            self._script = True

    def handle_endtag(self, tag):
        if tag == "style":
            self._style = False
        if tag == "script":
            self._script = False

    def handle_data(self, data):
        if self._style:
            self.found += _css_refs(data, "<style>")
        elif self._script and SCRIPT_REQUEST.search(data):
            self.found.append("<script> makes a request: " + SCRIPT_REQUEST.search(data).group(0))


def external_references(document: str) -> list[str]:
    s = _Scanner()
    s.feed(document)
    s.close()
    found = list(s.found)
    for host in ("fonts.googleapis.com", "fonts.gstatic.com", "googleapis", "gstatic", "cdn.", "cloudflare"):
        if host in document:
            found.append(f"mentions {host}")
    return found


# --- the scanner itself: each way a page reaches out is caught, and a plain link is not -------------------------------------------

@pytest.mark.parametrize("snippet, expected", [
    ("<link rel='stylesheet' href='https://fonts.googleapis.com/css2?family=IBM+Plex+Sans'>", "link"),
    ("<link rel='preconnect' href='https://fonts.gstatic.com' crossorigin>", "link"),
    ("<script src='https://cdn.example.com/x.js'></script>", "script src"),
    ("<script src='x.js'></script>", "script src"),
    ("<img src='https://example.com/p.png'>", "img src"),
    ("<img src='//example.com/p.png'>", "img src"),
    ("<iframe src='https://example.com'></iframe>", "iframe src"),
    ("<style>@import url(https://example.com/a.css);</style>", "@import"),
    ("<style>body{background:url(https://example.com/a.png)}</style>", "url(https"),
    ("<style>@font-face{src:url(fonts/a.woff2)}</style>", "url(fonts"),
    ("<div style=\"background:url('http://example.com/a.png')\">x</div>", "style"),
    ("<meta http-equiv='refresh' content='0;url=https://example.com'>", "refresh"),
    ("<base href='https://example.com/'>", "base"),
    ("<form action='https://example.com/collect'></form>", "form"),
    ("<script>fetch('/x')</script>", "script"),
    ("<script>var u='https://example.com/t.gif'</script>", "script"),
])
def test_the_scanner_catches_every_way_a_page_reaches_out(snippet, expected):
    assert external_references(f"<html><head>{snippet}</head><body></body></html>"), snippet


def test_the_scanner_allows_a_link_a_reader_clicks_and_inline_style_and_data_uris():
    ok = ("<html><head><title>t</title><style>:root{--a:#fff}body{font-family:system-ui}.x{fill:url(#g)}</style></head>"
          "<body><a href='https://example.com/source'>a source</a><img src='data:image/png;base64,AAAA'>"
          "<script>document.querySelectorAll('section').forEach(function(s){s.hidden=false})</script></body></html>")
    assert external_references(ok) == []


# --- what the engine renders ----------------------------------------------------------------------------------------------------

def _documents() -> dict[str, str]:
    t = Tier.CLIENT
    docs = {
        "specification": S.handle_spec({"intake": INTAKE, "constraint": "busway_ampacity", "format": "html"}, t),
        "study": S.handle_study({"intake": INTAKE, "format": "html"}, t),
        "board summary": S.handle_study({"intake": INTAKE, "format": "html", "view": "board"}, t),
        "screen": S.handle_screen({"intake": INTAKE, "format": "html"}, t),
        "proposal": S.handle_proposal({"intake": INTAKE, "format": "html"}, t),
        "deck": S.handle_deck({"intake": INTAKE}, t),
    }
    out = {}
    for name, payload in docs.items():
        out[f"{name} (full document)"] = payload["document_full"]
        out[f"{name} (fragment)"] = payload["document"]
    return out


@pytest.fixture(scope="module")
def documents():
    return _documents()


@pytest.mark.parametrize("name", ["specification", "study", "board summary", "screen", "proposal", "deck"])
def test_a_rendered_deliverable_requests_nothing_from_anyone(documents, name):
    for form in ("full document", "fragment"):
        doc = documents[f"{name} ({form})"]
        assert len(doc) > 2000, f"{name} ({form}) rendered nothing to scan"
        assert external_references(doc) == [], f"{name} ({form})"


def test_the_full_documents_are_complete_pages_and_the_scan_saw_their_style(documents):
    for name in ("specification", "study", "screen", "proposal"):
        doc = documents[f"{name} (full document)"]
        assert doc.startswith("<!doctype html>") and "<style>" in doc and "<title>" in doc


def test_the_font_stacks_are_system_stacks_that_end_in_a_generic_family(documents):
    css = documents["specification (full document)"]
    for var, generic in (("--sans", "sans-serif"), ("--mono", "monospace"), ("--serif", "serif")):
        stack = re.search(rf"{var}:([^;]+);", css).group(1)
        assert stack.rstrip().endswith(generic), (var, stack)
    assert "IBM Plex" not in css and "@font-face" not in css, "nothing is fetched or declared: faces are used only if installed on the reader's machine"
