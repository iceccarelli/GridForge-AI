"""The free tier has to be reachable by a machine, or the paid tiers never sell.

The MCP transport was key-gated end to end. Every paid tool inside it already
checked its own tier, so the only thing that gate protected was the free tier from
being used — and with it the single best distribution channel this product has: a
stranger adding GridForge to their AI client and getting a real answer about their
own hall in thirty seconds.

This file holds that open, and holds the paid tools closed, which are the same test
from two directions.
"""
import json
import os
import re
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

from gridforge.api.server import Handler, make_server
from gridforge.api.tools import TOOLS_BY_NAME
from gridforge.api.tiers import Tier

ROOT = Path(__file__).resolve().parents[1]
KEY = "agent-dist-key"

QUALIFY = {
    "contracted_MW": 12, "current_site_peak_MW": 7.4, "current_it_load_MW": 4.9,
    "busway_ampacity_A": 400, "tapoff_max_A": 63, "plant_supply_C": 6,
    "positions_available": 180,
}


@pytest.fixture(scope="module")
def server():
    os.environ["GRIDFORGE_API_KEYS"] = KEY
    os.environ["GRIDFORGE_RATE_LIMIT"] = "0"
    Handler.limiter.per_minute = 0
    httpd = make_server("127.0.0.1", 0)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    os.environ.pop("GRIDFORGE_API_KEYS", None)


def rpc(base, method, params=None, key=None, rpc_id=1):
    body = {"jsonrpc": "2.0", "method": method}
    if rpc_id is not None:
        body["id"] = rpc_id
    if params is not None:
        body["params"] = params
    req = urllib.request.Request(f"{base}/mcp", data=json.dumps(body).encode(),
                                 method="POST")
    req.add_header("Content-Type", "application/json")
    if key:
        req.add_header("X-API-Key", key)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")


# --- the transport is open -------------------------------------------------

def test_an_agent_with_no_key_can_complete_the_handshake(server):
    status, body = rpc(server, "initialize", {})
    assert status == 200, body
    assert body["result"]["serverInfo"]["name"] == "gridforge"


def test_an_agent_with_no_key_can_list_every_tool(server):
    """Including the paid ones. An agent that cannot see a paid tool cannot tell its
    user the answer exists, which costs us more than it costs them."""
    status, body = rpc(server, "tools/list")
    assert status == 200
    listed = {t["name"] for t in body["result"]["tools"]}
    assert listed == set(TOOLS_BY_NAME)
    tiers = {t["name"]: t["_meta"]["gridforge/tier"] for t in body["result"]["tools"]}
    assert tiers["gridforge_qualify"] == Tier.PUBLIC.value
    assert any(v == Tier.CLIENT.value for v in tiers.values())


def test_the_free_tool_answers_with_no_key_at_all(server):
    status, body = rpc(server, "tools/call",
                       {"name": "gridforge_qualify", "arguments": QUALIFY})
    assert status == 200, body
    r = body["result"]
    assert r["isError"] is False
    assert r["structuredContent"]["as_found"]["binding_constraint"]
    assert "binds first on" in r["content"][0]["text"].lower()


def test_the_free_tool_still_leaks_nothing_priced(server):
    status, body = rpc(server, "tools/call",
                       {"name": "gridforge_qualify", "arguments": QUALIFY})
    blob = json.dumps(body)
    assert "EUR" not in blob and "capex" not in blob and "lead_time" not in blob


def test_every_paid_tool_still_refuses_without_a_key(server):
    paid = [n for n, t in TOOLS_BY_NAME.items() if t["tier"] == Tier.CLIENT.value]
    assert len(paid) >= 5
    for name in paid:
        status, body = rpc(server, "tools/call", {"name": name, "arguments": {}})
        assert status == 200, f"{name}: transport error instead of a JSON-RPC refusal"
        assert "error" in body, f"{name} answered without a key"
        assert body["error"]["code"] == -32001
        assert body["error"]["data"]["free_tool"] == "gridforge_qualify", (
            f"{name} refuses without telling the agent what it CAN call")


def test_a_paid_tool_works_with_a_key(server):
    status, body = rpc(server, "tools/call",
                       {"name": "gridforge_screen",
                        "arguments": {"intake": {"grid": {"contracted_MW": 12}}}},
                       key=KEY)
    assert status == 200 and "result" in body, body


def test_the_handshake_tells_a_model_what_not_to_do(server):
    """A modelled figure loose inside an agent loop is more dangerous than one in a
    board pack: nobody downstream reads the footnote."""
    _, body = rpc(server, "initialize", {})
    instructions = body["result"]["instructions"].lower()
    assert "free and needs no api key" in instructions
    assert "do not present" in instructions
    assert "modelled, not measured" in instructions
    assert "uncalibrated" in instructions
    assert "gridforge_qualify" in instructions


# --- the crawler surface ---------------------------------------------------

LLMS = (ROOT / "app" / "llms.txt" / "route.ts").read_text()
#: The same text with line wrapping removed. The assertions below are about what the
#: file SAYS, and a phrase that happens to straddle a line break says the same thing.
LLMS_FLAT = re.sub(r"\s+", " ", LLMS)
ROBOTS = (ROOT / "app" / "robots.ts").read_text()
REFERENCE = ROOT / "public" / "reference"


def test_llms_txt_is_generated_from_the_catalogue_not_typed_out():
    assert "constraintReference()" in LLMS
    assert "platformLibrary()" in LLMS
    assert "LADDER_PRODUCTS" in LLMS
    assert "API_PRODUCTS" in LLMS


def test_llms_txt_teaches_the_evidence_ladder():
    """If a model is going to answer from our numbers, it has to carry the caveat
    with them. That is the whole reason to publish the file."""
    for needed in ["E0 assumed", "E7 observed in operation",
                   "Do not present an E0 or E1 figure",
                   "zero reconciled site", "never stronger than the weakest input"]:
        assert needed in LLMS_FLAT, f"llms.txt does not say {needed!r}"


def test_llms_txt_points_at_the_free_tool_first():
    assert "/mcp" in LLMS_FLAT
    assert "gridforge_qualify" in LLMS_FLAT
    assert "free and needs no API key" in LLMS_FLAT


def test_ai_crawlers_are_allowed_deliberately():
    for bot in ["GPTBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "CCBot"]:
        assert bot in ROBOTS, f"{bot} has no explicit rule"
    assert "PRIVATE_PATHS" in ROBOTS


def test_no_crawler_may_reach_a_token_addressed_path():
    """A crawler indexing one would publish a customer's deliverable to anyone who
    searches for it."""
    for path in ["/deliverable/", "/watch/", "/intake/", "/api-access/", "/admin"]:
        assert f'"{path}"' in ROBOTS, f"{path} is not disallowed"


def test_every_constraint_has_a_machine_readable_twin():
    published = json.loads((REFERENCE / "constraints.json").read_text())
    for c in published["constraints"]:
        f = REFERENCE / "constraints" / f"{c['slug']}.json"
        assert f.exists(), f"no JSON twin for {c['slug']}"
        twin = json.loads(f.read_text())
        assert twin["id"] == c["id"]
        assert twin["worked_example"] == c["worked_example"]
        assert twin["notice"], "a twin that travels without the notice is a naked number"


def test_the_citation_carries_the_caveat():
    src = (ROOT / "app" / "api" / "cite" / "route.ts").read_text()
    assert "required_caveat" in src
    assert "measurement of any customer's asset" in src
    assert "bibtex" in src


def test_the_developers_page_offers_a_one_paste_install():
    src = (ROOT / "components" / "McpInstall.tsx").read_text()
    assert "claude mcp add" in src
    assert "mcpServers" in src
    page = (ROOT / "app" / "developers" / "page.tsx").read_text()
    assert "McpInstall" in page


def test_the_shareable_capacity_read_is_closed_to_crawlers():
    """It is somebody's hall, shared by them, with whoever they choose. A crawler
    indexing one would publish a customer's site figures to anyone who searches."""
    assert '"/q/"' in ROBOTS
    page = (ROOT / "app" / "q" / "[token]" / "page.tsx").read_text()
    assert "robots: { index: false, follow: false }" in page
