"""HTTP methods: HEAD works on the GET routes, a known route reached by the wrong method is a 405 with Allow, and every error is JSON.

The audit found `HEAD /health` answered with the standard library's HTML 501 (a HEAD-based monitor reads the service as down), PUT and DELETE
answered the same HTML page, and a GET on a POST route answered 404 'not found' as if the route did not exist. Also (J7-4): the operator-only
/v1/revoke, which answers 404 to everyone else, was listed in GET /v1/version `endpoints` and in the 404 body.
"""
from __future__ import annotations

import http.client
import json
import threading

import pytest

from gridforge.api import server as S
from gridforge.api.server import Handler, make_server, public_endpoints


@pytest.fixture(scope="module")
def port():
    mp = pytest.MonkeyPatch()
    mp.setenv("GRIDFORGE_RATE_LIMIT", "0")
    mp.setattr(Handler.limiter, "per_minute", 0)
    httpd = make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield httpd.server_address[1]
    httpd.shutdown()
    mp.undo()


def req(port, method, path, body=None, headers=None):
    c = http.client.HTTPConnection("127.0.0.1", port, timeout=20)
    try:
        c.request(method, path, body=body, headers=headers or {})
        r = c.getresponse()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, r.read()
    finally:
        c.close()


GET_PATHS = ["/health", "/", "/v1/version", "/v1/platforms", "/v1/intake/template", "/v1/calibration", "/v1/calibration/residuals", "/v1/tools"]


@pytest.mark.parametrize("path", GET_PATHS)
def test_head_answers_a_get_route_as_get_does_without_the_body(port, path):
    g_status, g_headers, g_body = req(port, "GET", path)
    h_status, h_headers, h_body = req(port, "HEAD", path)
    assert h_status == g_status == 200
    assert h_body == b"" and g_body
    assert h_headers["content-length"] == g_headers["content-length"] == str(len(g_body))
    assert h_headers["content-type"] == g_headers["content-type"] == "application/json; charset=utf-8"
    assert h_headers["x-gridforge-schema"] == S.API_SCHEMA
    for name in ("cache-control", "x-content-type-options"):
        assert h_headers[name] == g_headers[name]


def test_head_on_a_route_that_needs_a_key_is_the_same_401_as_get_and_head_on_nothing_is_the_404(port):
    g = req(port, "GET", "/v1/usage")
    h = req(port, "HEAD", "/v1/usage")
    assert g[0] == h[0] == 401 and h[2] == b"" and h[1]["content-length"] == g[1]["content-length"]
    h = req(port, "HEAD", "/nope")
    assert h[0] == 404 and h[2] == b""


@pytest.mark.parametrize("path", ["/v1/screen", "/v1/qualify", "/v1/study", "/v1/portfolio", "/v1/compare", "/v1/diff", "/mcp"])
def test_get_head_put_delete_patch_on_a_post_route_are_405_with_allow(port, path):
    for method in ("GET", "HEAD", "PUT", "DELETE", "PATCH"):
        status, headers, body = req(port, method, path)
        assert status == 405, (method, path)
        assert headers["allow"] == "POST, OPTIONS"
        assert headers["content-type"].startswith("application/json")
        if method != "HEAD":
            out = json.loads(body)
            assert out["schema_version"] == S.API_SCHEMA and out["allow"] == ["POST", "OPTIONS"] and method in out["error"] and path in out["error"]
        else:
            assert body == b""


@pytest.mark.parametrize("path", ["/health", "/v1/version", "/v1/tools", "/v1/platforms", "/v1/usage", "/v1/calibration"])
def test_post_put_delete_on_a_get_route_are_405_with_allow(port, path):
    for method in ("POST", "PUT", "DELETE", "PATCH"):
        status, headers, body = req(port, method, path, body=b"{}" if method != "DELETE" else None, headers={"Content-Type": "application/json"})
        assert status == 405, (method, path)
        assert headers["allow"] == "GET, HEAD, OPTIONS"
        assert json.loads(body)["allow"] == ["GET", "HEAD", "OPTIONS"]


def test_estimate_takes_both_and_says_so(port):
    status, headers, body = req(port, "PUT", "/v1/estimate")
    assert status == 405 and headers["allow"] == "GET, HEAD, POST, OPTIONS"
    assert req(port, "HEAD", "/v1/estimate?endpoint=/v1/screen")[0] == 200


def test_options_lists_what_the_route_takes(port):
    status, headers, _ = req(port, "OPTIONS", "/v1/qualify")
    assert status == 204 and headers["allow"] == "POST, OPTIONS"
    assert headers["access-control-allow-methods"] == "GET, POST, OPTIONS"        # unchanged: the published CORS list


@pytest.mark.parametrize("method", ["PUT", "DELETE", "PATCH", "GET", "POST", "HEAD"])
def test_a_path_that_is_no_route_is_a_json_404_whatever_the_method(port, method):
    status, headers, body = req(port, method, "/v1/no-such-route", body=b"{}" if method in ("POST", "PUT", "PATCH") else None,
                                headers={"Content-Type": "application/json"})
    assert status == 404 and "allow" not in headers
    if method != "HEAD":
        out = json.loads(body)
        assert out["schema_version"] == S.API_SCHEMA and out["error"] == "not found" and "/v1/screen" in out["endpoints"]


@pytest.mark.parametrize("method", ["GET", "POST", "PUT", "DELETE", "HEAD"])
def test_the_operator_route_is_a_404_to_everyone_and_never_a_405_that_would_confirm_it(port, method):
    status, headers, body = req(port, method, "/v1/revoke", body=b"{}" if method in ("POST", "PUT") else None,
                                headers={"Content-Type": "application/json"})
    assert status == 404 and "allow" not in headers
    if method != "HEAD":
        assert "revoke" not in json.dumps(json.loads(body)["endpoints"] if "endpoints" in json.loads(body) else [])


def test_an_unsupported_method_the_library_rejects_itself_is_json_not_html(port):
    status, headers, body = req(port, "TRACE", "/health")
    assert status == 501 and headers["content-type"].startswith("application/json")
    out = json.loads(body)
    assert out["schema_version"] == S.API_SCHEMA and out["status"] == 501 and "TRACE" in out["error"]
    assert b"<html" not in body.lower()


def test_a_malformed_request_line_is_json_too(port):
    import socket
    s = socket.create_connection(("127.0.0.1", port), timeout=10)
    try:
        s.sendall(b"NONSENSE\r\n\r\n")
        raw = b""
        while chunk := s.recv(4096):
            raw += chunk
    finally:
        s.close()
    head, _, body = raw.partition(b"\r\n\r\n")
    assert b"application/json" in head.lower() and b"<html" not in body.lower()
    assert json.loads(body)["schema_version"] == S.API_SCHEMA


def test_the_post_routes_still_answer_post(port):
    status, _, body = req(port, "POST", "/v1/qualify", body=json.dumps({"contracted_MW": 12, "current_site_peak_MW": 7.4, "busway_ampacity_A": 400}).encode(),
                          headers={"Content-Type": "application/json"})
    assert status == 200 and "as_found" in json.loads(body)


# --- J7-4: the operator route is in no listing ---------------------------------------------------------------------------------------------
def test_the_version_listing_and_the_404_body_do_not_name_the_operator_route(port):
    status, _, body = req(port, "GET", "/v1/version")
    listed = json.loads(body)["endpoints"]
    assert status == 200 and "/v1/revoke" not in listed
    assert listed == public_endpoints() and listed == sorted(set(listed), key=listed.index)
    for must in ("/v1/qualify", "/v1/compare", "/v1/estimate", "/v1/screen", "/v1/diff", "/v1/usage", "/health"):
        assert must in listed
    status, _, body = req(port, "GET", "/v1/no-such-route")
    assert "/v1/revoke" not in json.loads(body)["endpoints"] and "/mcp" in json.loads(body)["endpoints"]


def test_every_route_in_the_table_that_is_not_operator_only_is_listed_and_the_operator_ones_are_not():
    internal = {r for r, (_, tier) in S.ROUTES.items() if tier is S.Tier.INTERNAL}
    assert internal == {"/v1/revoke"}
    assert set(public_endpoints()) == (set(S.ROUTES) - internal) | set(S.GET_ROUTES)


def test_the_module_docstring_lists_the_routes_it_used_to_leave_out():
    doc = S.__doc__
    assert "POST /v1/compare" in doc and "/v1/estimate" in doc
    for route in set(S.ROUTES) - {"/v1/revoke"}:
        assert route in doc, f"{route} is routable and is not in the module's endpoint list"
    assert "/v1/revoke" in doc and "no listing" in doc            # named once, as the operator-only exception
