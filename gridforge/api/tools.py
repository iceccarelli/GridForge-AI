"""The engine as a tool another machine can call.

The people who need this answer are increasingly not people. A colo operator's
portfolio team runs an agent over two hundred halls; an infrastructure fund's
diligence stack wants the binding constraint on an asset before it bids; a GPU
cloud's siting model wants to know which of eleven candidate buildings can take
130 kW a rack and when. None of them are going to read a PDF.

So the engine publishes itself in the two dialects machines actually speak:

    GET  /v1/tools    JSON Schema for every callable, in OpenAI function-calling
                      shape and in MCP shape, from one definition
    POST /mcp         a Model Context Protocol endpoint over JSON-RPC 2.0

This is the same physics, the same evidence discipline and the same commercial
gate as the website and the CLI. There is no machine-grade shortcut where the
provenance is dropped to make the payload smaller — a number without its evidence
class is exactly as dangerous inside an agent loop as it is in a board pack, and
considerably harder to catch.

Zero dependencies: MCP here is a JSON-RPC dialect, not a package.
"""
from __future__ import annotations

from .metering import UNIT_COST
from .tiers import Tier

PROTOCOL_VERSION = "2025-06-18"

_INTAKE_SCHEMA = {
    "type": "object",
    "description": ("A GridForge intake document. GET /v1/intake/template for the blank "
                    "form with every field, or supply a sparse one — anything absent is "
                    "filled from library defaults and reported as an assumption."),
    "additionalProperties": True,
}

_OBJECTIVE = {
    "type": "string",
    "enum": ["max_compute", "min_capex_per_rack", "fastest_to_power"],
    "default": "max_compute",
    "description": "What the recommendation optimises for.",
}


def _tool(name, summary, endpoint, schema, *, tier=Tier.CLIENT, returns=""):
    return {
        "name": name,
        "description": summary,
        "endpoint": endpoint,
        "method": "POST",
        "tier": tier.value,
        "units": UNIT_COST.get(endpoint, 1),
        "returns": returns,
        "inputSchema": schema,
    }


TOOLS: list[dict] = [
    _tool(
        "gridforge_qualify",
        ("Free. Seven numbers about an existing air-cooled hall in, one answer out: which "
         "physical constraint binds first when you try to deploy AI racks in it, how many "
         "racks fit as found, and which item sets the energisation date. Use this to triage "
         "a portfolio before paying for anything."),
        "/v1/qualify",
        {
            "type": "object",
            "required": ["contracted_MW", "current_site_peak_MW", "busway_ampacity_A",
                         "tapoff_max_A"],
            "properties": {
                "contracted_MW": {"type": "number", "description": "Contracted grid capacity, MW."},
                "current_site_peak_MW": {"type": "number", "description": "Current site peak demand, MW."},
                "current_it_load_MW": {"type": "number", "description": "Current IT load, MW."},
                "busway_ampacity_A": {"type": "number", "description": "Installed busway ampacity, A."},
                "tapoff_max_A": {"type": "number", "description": "Largest installed tap-off rating, A."},
                "plant_supply_C": {"type": "number", "description": "Chilled-water design supply temperature, °C."},
                "positions_available": {"type": "integer", "description": "Rack positions that can be released."},
                "objective": _OBJECTIVE,
            },
            "additionalProperties": False,
        },
        tier=Tier.PUBLIC,
        returns=("binding constraint, racks as found and after relief, the item that sets the "
                 "date, and the inputs nobody has measured. No capital cost, no lead times: "
                 "those are the paid engagement."),
    ),
    _tool(
        "gridforge_screen",
        ("Density Screen. A full intake in, a screening read out: every constraint evaluated, "
         "the headroom ladder, and which relief unlocks the most racks per euro."),
        "/v1/screen",
        {"type": "object", "required": ["intake"],
         "properties": {"intake": _INTAKE_SCHEMA, "objective": _OBJECTIVE,
                        "format": {"type": "string", "enum": ["json", "md", "html"],
                                   "default": "json"}},
         "additionalProperties": False},
        returns="screen payload, or the rendered screening document.",
    ),
    _tool(
        "gridforge_study",
        ("Capacity & Density Envelope Study. Five architectures compared, the full headroom "
         "ladder with costs and lead times, time-to-power, sensitivity, economics, and the "
         "provenance of every number. format='csv' returns the working files a client's own "
         "engineer can rebuild the answer from."),
        "/v1/study",
        {"type": "object", "required": ["intake"],
         "properties": {"intake": _INTAKE_SCHEMA, "objective": _OBJECTIVE,
                        "format": {"type": "string", "enum": ["json", "md", "html", "csv"],
                                   "default": "json"}},
         "additionalProperties": False},
        returns="the model pack, a rendered document, or the CSV working files.",
    ),
    _tool(
        "gridforge_portfolio",
        ("Rank halls. Many intakes in, an ordered list out: racks, weeks to power, capex per "
         "rack and what binds first for each. Bills one unit per hall."),
        "/v1/portfolio",
        {"type": "object", "required": ["intakes"],
         "properties": {"intakes": {"type": "array", "items": _INTAKE_SCHEMA, "minItems": 1},
                        "objective": _OBJECTIVE},
         "additionalProperties": False},
        returns="halls ranked against the objective, with the total deployable rack count.",
    ),
    _tool(
        "gridforge_diff",
        ("What moved, and which input moved it. Two intakes (or a recorded envelope state and "
         "a new intake) in, an attributed change note out, including the part the single-input "
         "probes do not explain, reported as a residual rather than distributed."),
        "/v1/diff",
        {"type": "object", "required": ["after"],
         "properties": {"before": _INTAKE_SCHEMA,
                        "previous_state": {"type": "object", "additionalProperties": True,
                                           "description": "A recorded envelope state from an earlier run."},
                        "after": _INTAKE_SCHEMA, "objective": _OBJECTIVE,
                        "attribute": {"type": "boolean", "default": True},
                        "format": {"type": "string", "enum": ["json", "md", "html"],
                                   "default": "json"}},
         "additionalProperties": False},
        returns="headline, racks/weeks/capex deltas, ranked drivers, explained and residual.",
    ),
    _tool(
        "gridforge_proposal",
        "A priced proposal for a named engagement, built from what the engine already found.",
        "/v1/proposal",
        {"type": "object", "required": ["intake"],
         "properties": {"intake": _INTAKE_SCHEMA,
                        "engagement": {"type": "string", "default": "density_screen"},
                        "objective": _OBJECTIVE,
                        "valid_days": {"type": "integer", "default": 30},
                        "format": {"type": "string", "enum": ["html", "md"], "default": "html"}},
         "additionalProperties": False},
        returns="the proposal document and the engagement's catalogue price.",
    ),
]

TOOLS_BY_NAME = {t["name"]: t for t in TOOLS}


def openai_tools() -> list[dict]:
    """OpenAI / Anthropic function-calling shape."""
    return [{"type": "function",
             "function": {"name": t["name"], "description": t["description"],
                          "parameters": t["inputSchema"]}}
            for t in TOOLS]


def mcp_tools() -> list[dict]:
    return [{"name": t["name"], "description": t["description"],
             "inputSchema": t["inputSchema"],
             "_meta": {"gridforge/units": t["units"], "gridforge/tier": t["tier"],
                       "gridforge/endpoint": t["endpoint"]}}
            for t in TOOLS]


def catalogue() -> dict:
    return {
        "tools": [{k: v for k, v in t.items() if k != "inputSchema"} | {"inputSchema": t["inputSchema"]}
                  for t in TOOLS],
        "openai": openai_tools(),
        "mcp": {"endpoint": "/mcp", "protocol": "jsonrpc-2.0",
                "protocolVersion": PROTOCOL_VERSION, "tools": mcp_tools()},
        "auth": {"header": "X-API-Key",
                 "note": "gridforge_qualify is free and needs no key. Everything else meters."},
        "evidence_note": (
            "Every numeric field in a response carries an evidence class (E0 assumed … E7 "
            "observed in operation) and a provenance digest. An agent consuming these must "
            "not present an E0 or E1 figure as a property of the physical asset. The "
            "calibration block states how far this engine has been reconciled against site "
            "data; where it says uncalibrated, it means uncalibrated."),
    }
