"""CORS on the real handler, and the container's privilege model.

Credentials on this API are headers (X-API-Key / Authorization), never cookies, so a wildcard origin does not make a
key ambient. What CORS decides is which pages may READ a response in a visitor's browser. The decision recorded here:
the keyed API answers cross-origin only to GRIDFORGE_ALLOWED_ORIGINS (default: the site); the free keyless routes stay
readable from any origin, but a foreign origin may not send a key to them from a browser. Non-browser clients (MCP,
curl, the site's own server-side calls) are unaffected by CORS.
"""
import json
import os
import re
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from gridforge.api.server import DEFAULT_ALLOWED_ORIGINS, Handler, make_server

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://timetopower.ai"
FOREIGN = "https://evil.example"
GOOD = {"site_name": "T", "metro": "Frankfurt", "contracted_MW": 12, "current_site_peak_MW": 7.4,
        "current_it_load_MW": 4.9, "busway_ampacity_A": 400, "tapoff_max_A": 63, "plant_supply_C": 6,
        "positions_available": 180}


@pytest.fixture(scope="module")
def base():
    os.environ["GRIDFORGE_API_KEYS"] = "cors-test-key"
    Handler.limiter.per_minute = 0
    httpd = make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    os.environ.pop("GRIDFORGE_API_KEYS", None)


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch):
    monkeypatch.delenv("GRIDFORGE_ALLOWED_ORIGINS", raising=False)
    monkeypatch.delenv("GRIDFORGE_PUBLIC_CORS", raising=False)


def send(base, path, method="GET", origin=None, body=None, extra=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    if origin:
        req.add_header("Origin", origin)
    for k, v in (extra or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.headers
    except urllib.error.HTTPError as e:
        return e.code, e.headers


def acao(h):
    return h.get("Access-Control-Allow-Origin")


def test_default_is_the_site_not_a_wildcard():
    assert "*" not in DEFAULT_ALLOWED_ORIGINS and SITE in DEFAULT_ALLOWED_ORIGINS


def test_site_origin_is_allowed_on_keyed_and_public_routes_and_preflight(base):
    for method, path in (("POST", "/v1/qualify"), ("POST", "/v1/compare"), ("GET", "/v1/usage")):
        s, h = send(base, path, "OPTIONS", SITE, extra={"Access-Control-Request-Method": method})
        assert s == 204 and acao(h) == SITE
        assert "X-API-Key" in h["Access-Control-Allow-Headers"]
    s, h = send(base, "/v1/qualify", "POST", SITE, GOOD)
    assert s == 200 and acao(h) == SITE and h["Vary"] == "Origin"


def test_foreign_origin_gets_no_access_to_keyed_routes_actual_or_preflight(base):
    for path in ("/v1/compare", "/v1/screen", "/v1/usage", "/v1/admin/ledger", "/mcp"):
        s, h = send(base, path, "OPTIONS", FOREIGN)
        assert s == 204 and acao(h) is None, path
        s, h = send(base, path, "GET", FOREIGN)
        assert acao(h) is None, path  # whatever the status, the browser may not read it


def test_foreign_origin_may_read_the_free_routes_but_not_send_a_key_from_the_browser(base):
    s, h = send(base, "/v1/qualify", "OPTIONS", FOREIGN, extra={"Access-Control-Request-Method": "POST"})
    assert s == 204 and acao(h) == "*"
    assert h["Access-Control-Allow-Headers"] == "Content-Type"  # no X-API-Key / Authorization from a foreign page
    s, h = send(base, "/v1/qualify", "POST", FOREIGN, GOOD)
    assert s == 200 and acao(h) == "*"
    s, h = send(base, "/health", "GET", FOREIGN)
    assert s == 200 and acao(h) == "*"
    assert h.get("Access-Control-Allow-Credentials") is None


def test_non_browser_clients_are_unaffected(base):
    s, h = send(base, "/v1/qualify", "POST", None, GOOD)
    assert s == 200
    s, _ = send(base, "/health")
    assert s == 200


def test_operator_override_for_previews_and_explicit_wildcard_and_closing_public(base, monkeypatch):
    preview = "https://my-branch.vercel.app"
    monkeypatch.setenv("GRIDFORGE_ALLOWED_ORIGINS", f"{SITE}, {preview}")
    assert acao(send(base, "/v1/compare", "OPTIONS", preview)[1]) == preview
    assert acao(send(base, "/v1/compare", "OPTIONS", FOREIGN)[1]) is None
    monkeypatch.setenv("GRIDFORGE_PUBLIC_CORS", "0")
    assert acao(send(base, "/v1/qualify", "OPTIONS", FOREIGN)[1]) is None
    assert acao(send(base, "/v1/qualify", "OPTIONS", SITE)[1]) == SITE
    monkeypatch.delenv("GRIDFORGE_PUBLIC_CORS")
    monkeypatch.setenv("GRIDFORGE_ALLOWED_ORIGINS", "*")  # still honoured when an operator writes it
    assert acao(send(base, "/v1/compare", "OPTIONS", FOREIGN)[1]) == "*"


def test_deploy_configs_no_longer_ship_a_wildcard():
    for name in ("fly.toml", "render.yaml"):
        text = (ROOT / name).read_text()
        assert not re.search(r'GRIDFORGE_ALLOWED_ORIGINS"?\s*[=:]?\s*(value:\s*)?"\*"', text), name
        assert "https://timetopower.ai" in text, name


# --- container -------------------------------------------------------------------------------------------------------
def test_dockerfile_drops_root_before_python_and_keeps_the_healthcheck_and_data_writable():
    text = (ROOT / "Dockerfile").read_text()
    assert "useradd" in text and "--uid 10001" in text
    assert "HEALTHCHECK" in text
    assert re.search(r"chown\s+gridforge:gridforge\s+/data", text)  # the image's own /data
    cmd = text[text.index("\nCMD"):]
    # a root start chowns the mounted volume and then execs python only through setpriv as the unprivileged user
    assert "chown -R gridforge:gridforge /data" in cmd
    assert "exec setpriv --reuid=gridforge --regid=gridforge --init-groups python" in cmd
    assert cmd.index("setpriv") > cmd.index("chown")
    assert "exec python" in cmd  # a platform that already starts it non-root
    # python is never reachable as root: every `python -m gridforge` in CMD is behind setpriv or the non-root branch
    root_branch = cmd[cmd.index("then"):cmd.index("; fi")]
    assert "setpriv" in root_branch and root_branch.count("python -m gridforge") == 1


def test_every_file_the_engine_writes_is_under_data_in_fly_toml():
    fly = (ROOT / "fly.toml").read_text()
    for var in ("GRIDFORGE_USAGE_FILE", "GRIDFORGE_REVOKED_FILE", "GRIDFORGE_LEDGER_FILE", "GRIDFORGE_COST_FILE"):
        assert re.search(rf'{var}\s*=\s*"/data/', fly), var
    assert 'destination = "/data"' in fly
