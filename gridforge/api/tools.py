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

from ..compute.library import PLATFORMS
from .metering import MAX_PORTFOLIO_HALLS, UNIT_COST, payg_public
from .tiers import Tier

PROTOCOL_VERSION = "2025-06-18"

_INTAKE_SCHEMA = {
    "type": "object",
    "description": ("A GridForge intake document. GET /v1/intake/template for the blank "
                    "form with every field, or supply a sparse one — anything absent is "
                    "filled from library defaults and reported as an assumption. Optional hall.occupied_positions (a "
                    "non-negative whole number, or {value, evidence, note, source}; E5 when you supply it, never higher) is the "
                    "number of rack positions already occupied. Omitted, the engine does not know it: it is listed as an optional gap, "
                    "and the busway check against the load already in the hall reads every position that is not free as occupied "
                    "and says so as an assumption (E0). Declare 0 to confirm that nothing is occupied. It changes no rack count, "
                    "cost or date."),
    "additionalProperties": True,
}

def _queue_region_schema() -> dict:
    from ..context import grid_queue
    return {"type": "string", "enum": list(grid_queue.regions()),
            "description": ("Optional. Which of LBNL's US regions the measured queue statistic in grid_queue_context is drawn from; omit "
                            "for the pooled US figure. Context only: it changes no number and no date.")}


def _price_state_schema() -> dict:
    from ..context import energy_price
    return {"type": "string", "enum": list(energy_price.states()),
            "description": ("Optional. Which US state's published average electricity price retail_price_context is drawn from; omit for "
                            "the US average. Context only: it changes no price and no cost.")}


_OBJECTIVE = {
    "type": "string",
    "enum": ["max_compute", "min_cost", "fastest"],
    "default": "max_compute",
    "description": "What the recommendation optimises for.",
}


#: The seven figures the free qualifier asks for, in the order it asks them. tests/test_api_published_contract.py fails if this is not
#: the engine's own QUALIFY_FIELDS (server.py), so the published list cannot drift from the handler's.
QUALIFY_FIGURES = ("contracted_MW", "current_site_peak_MW", "current_it_load_MW", "busway_ampacity_A", "tapoff_max_A",
                   "plant_supply_C", "positions_available")


def _label(what: str) -> dict:
    return {"type": "string",
            "description": (f"Optional. {what} A label for your own records: the qualifier writes it into the intake it builds and it "
                            "changes no figure in the result.")}


def _qualify_schema() -> dict:
    return {
        "type": "object",
        "description": ("Seven figures about one air-cooled hall, and some options. Send at least three of these seven figures; each one "
                        "you omit is an assumption named in the answer (library default, listed under intake.gaps and, with the way you "
                        "left it out, under figures_not_supplied). Fewer than three is refused with 422, and no one figure is required: "
                        "any three are enough. A figure sent as null is not sent: it counts as omitted, and the answer says so. Each "
                        "figure you do send is checked by its own name against the same plausibility bounds the engine's intake uses "
                        "(a refusal names the figure you sent, with the limit). The engine does not validate a request against this "
                        "schema before running it: a key that is not listed here is not read as a figure and is ignored, except "
                        "cost_evidence, which this route does not take and refuses with 422."),
        "properties": {
            "contracted_MW": {"type": "number", "description": "Contracted grid capacity, MW."},
            "current_site_peak_MW": {"type": "number", "description": "Current site peak demand, MW."},
            "current_it_load_MW": {"type": "number", "description": "Current IT load, MW."},
            "busway_ampacity_A": {"type": "number", "description": "Installed busway ampacity, A."},
            "tapoff_max_A": {"type": "number", "description": "Largest installed tap-off rating, A."},
            "plant_supply_C": {"type": "number", "description": "Chilled-water design supply temperature, °C."},
            "positions_available": {"type": "integer", "description": "Rack positions that can be released."},
            "firm_capacity_MVA": {"type": "number",
                                  "description": ("Optional. Firm capacity of the grid connection, MVA, sent as a plain number. It is a "
                                                  "real input: a value below the connection the engine would otherwise derive lowers the "
                                                  "firm-supply headroom. Omit it (and send contracted_MW) and the engine derives one from "
                                                  "contracted_MW, lists it as an assumption (E0) under inputs_derived_assumed in the result, "
                                                  "and adds a required grid.firm_capacity_MVA row to intake.gaps. That list is separate "
                                                  "from inputs_declared_assumed, which holds only what you declared. firm_capacity_MVA "
                                                  "cannot be named in assumed_fields.")},
            "platform": {"type": "string", "enum": list(PLATFORMS), "default": "gb300_nvl72",
                         "description": ("Optional. The rack platform the hall is tested against (GET /v1/platforms lists them). It sets "
                                         "the per-rack electrical and thermal load, so it changes the result. An id the library does not "
                                         "carry is refused with 422.")},
            "objective": _OBJECTIVE,
            "assumed_fields": {
                "type": "array", "items": {"type": "string", "enum": list(QUALIFY_FIGURES)},
                "uniqueItems": True, "maxItems": len(QUALIFY_FIGURES),
                "description": ("Optional. Declares which of the figures above you are sending as ASSUMPTIONS rather than as this hall's "
                                "own data, for example values copied from a reference template. Each entry must be one of the seven "
                                "figures (contracted_MW, current_site_peak_MW, current_it_load_MW, busway_ampacity_A, tapoff_max_A, "
                                "plant_supply_C, positions_available), named at most once, and the same request must also send that "
                                "figure (a figure you did not send cannot be declared assumed). Effect: a named figure is classed E0 "
                                "(assumption) instead of E5 (supplied by the client) in the result's basis and evidence, and is "
                                "listed in the result's inputs_declared_assumed (path, input, unit, value, evidence \"E0\", note); "
                                "intake.assumed_count says how many, while intake.completeness and required_inputs_missing still "
                                "count a declared figure as supplied. It changes the label and not the arithmetic: the racks and the "
                                "binding constraint are the same with or without it, and nothing you send can raise a class above E0. "
                                "Omitted, null or an empty list, the request is answered as if the field did not exist. A name that is "
                                "not one of the seven, a repeat, a value that is not a list, or a figure you did not send is refused "
                                "with 422, naming the entry and listing the allowed names. An engine that serves this field reports "
                                "capabilities.qualify_assumed_fields: true at GET /v1/version.")},
            "client": _label("Your organisation's name."),
            "reference": _label("Your own reference for this hall or request."),
            "site_name": _label("The site's name."),
            "metro": _label("The metro area."),
            "country": _label("The country."),
            "hall_id": _label("The hall's identifier."),
        },
        "additionalProperties": False,
    }


def _tool(name, summary, endpoint, schema, *, tier=Tier.CLIENT, returns="", boundary):
    """`boundary` is the evidence boundary of the result in one sentence: what the answer may and may not be taken for. It is published
    beside the description (GET /v1/tools, public/reference/tools.json) and /developers and /openapi.json render it from there, so the
    sentence is written once, here, next to the tool it describes."""
    return {
        "name": name,
        "description": summary,
        "endpoint": endpoint,
        "method": "POST",
        "tier": tier.value,
        "units": UNIT_COST.get(endpoint, 1),
        "returns": returns,
        "evidence_boundary": boundary,
        "inputSchema": schema,
    }


#: The four deployment-request fields every /v1/power/deploy/* route accepts besides the load profile, the grid figure, the target and the
#: units. gridforge_power_deploy_assess documents them inline; the spec and bids routes parse the same request (they build the same
#: deployment from it) and used to leave them out, so a client that validated against the published schema refused the engine's own valid
#: request. tests/test_api_published_contract.py sends them to every route.
_BTM_SHARED_PROPERTIES = {
    "ride_through_hours": {"type": "number", "description": "the outage duration a battery must be sized against; defaults to 2h if omitted"},
    "redundancy": {"type": "string", "enum": ["N", "N+1", "N+2", "2N"], "default": "N"},
    "interconnection": {"type": "object",
                        "description": "utility, pcc_voltage_kV, import_capacity_MW — feeds the interconnection readiness gate. Omitting it "
                                       "leaves that gate MISSING_DATA, never a guessed PASS.",
                        "properties": {"utility": {"type": "string"}, "pcc_voltage_kV": {"type": "number"},
                                       "import_capacity_MW": {"type": "number"}}},
    "permitting": {"type": "object",
                   "description": "e.g. {emissions_status, noise_status} — feeds the permitting readiness gate.",
                   "additionalProperties": {"type": "string"}},
}

TOOLS: list[dict] = [
    _tool(
        "gridforge_qualify",
        ("Free. Seven numbers about an existing air-cooled hall in, one answer out: which "
         "physical constraint binds first when you try to deploy AI racks in it, how many "
         "racks fit as found, and which item sets the time to power (labelled 'assumed lead time, not a date' "
         "when that item's lead time is an assumption). Use this to triage "
         "a portfolio before paying for anything."),
        "/v1/qualify",
        _qualify_schema(),
        tier=Tier.PUBLIC,
        returns=("binding constraint, racks as found and after relief, the item that sets the "
                 "date (null, with sets_the_date_reason, when no date can be given: nothing is deployable, or a lead time on the path is "
                 "missing because transformers or UPS were not declared), and the inputs nobody has measured (when you send assumed_fields, also inputs_declared_assumed, which lists only what you "
                 "declared; when you send contracted_MW and no firm_capacity_MVA, inputs_derived_assumed, the firm capacity the qualifier "
                 "derived, as an assumption). No capital cost or "
                 "dated lead times in this free read: the metered /v1/compare (it needs an API key) returns indicative capital and weeks "
                 "with evidence classes, and the paid documents add the full costed ladder."),
        boundary=("Directional only: a figure you send is treated as yours (E5) unless you name it in assumed_fields (E0), what you leave "
                  "out is assumed and disclosed in intake.gaps, and this free answer carries no capital cost and no dated lead time."),
    ),
    _tool(
        "gridforge_estimate",
        ("Free, no API key, never metered. What would a call cost? Name an endpoint (and, for the "
         "portfolio, how many halls) and get the units, the unit price and the cost in euro cents "
         "BEFORE spending anything. With an API key it also says whether the call fits what is left of "
         "the key's allowance or cap. Use it before any paid tool, especially in a loop."),
        "/v1/estimate",
        {"type": "object", "required": ["endpoint"],
         "properties": {"endpoint": {"type": "string",
                                     "description": "The engine route to price, e.g. /v1/study."},
                        "hall_count": {"type": "integer", "minimum": 1,
                                       "description": (f"Halls in a /v1/portfolio request (one unit each). A portfolio request ranks at most "
                                                       f"{MAX_PORTFOLIO_HALLS} halls: a larger hall_count is refused with 422, as the request would be.")},
                        "body": {"type": "object", "additionalProperties": True,
                                 "description": "Optional: the request body you intend to send; the "
                                                "units are read from it exactly as the meter would."}},
         "additionalProperties": False},
        tier=Tier.PUBLIC,
        returns=("endpoint, units, unit_price_cents, estimated_cents, billable, free, the rule that "
                 "produced the units, and (with a key) the remaining allowance and whether the call fits."),
        boundary=("Arithmetic on the published rate card, not an engineering result: it prices a call and says whether it fits an allowance, and it "
                  "runs no model."),
    ),
    _tool(
        "gridforge_screen",
        ("Density Screen. A full intake in, a screening read out: every constraint evaluated, "
         "and the headroom ladder: each relief in binding order, with its cost, lead time and the racks it unlocks."),
        "/v1/screen",
        {"type": "object", "required": ["intake"],
         "properties": {"intake": _INTAKE_SCHEMA, "objective": _OBJECTIVE,
                        "format": {"type": "string", "enum": ["json", "md", "html"],
                                   "default": "json"},
                        "grid_queue_region": _queue_region_schema(),
                        "electricity_price_state": _price_state_schema()},
         "additionalProperties": False},
        returns="screen payload (with grid_queue_context: the measured US queue statistic beside the assumed grid wait), or the rendered "
                "screening document.",
        boundary=("Screening mode: the constraints are solved from the intake you send, anything you leave out is filled from library defaults and "
                  "disclosed as an assumption, and each figure carries its evidence class (E0 to E7)."),
    ),
    _tool(
        "gridforge_compare",
        ("Time-to-Power scenario comparison. A full intake in; the scenarios it defines out, side by side: racks "
         "as found and after relief, the constraint that binds, the time to full capacity with its low/high "
         "band and evidence class (and, in date_basis / date_label, whether an assumed lead time sits behind it: "
         "'assumed lead time, not a date'), capital and what is unpriced, and how each differs from the baseline. "
         "A scenario with an unknown lead time gets no date and a reason, never a small number; nothing is "
         "ranked on a figure it does not have. Same solve as gridforge_screen, same inputs, same numbers."),
        "/v1/compare",
        {"type": "object", "required": ["intake"],
         "properties": {"intake": _INTAKE_SCHEMA, "objective": _OBJECTIVE,
                        "scenarios": {"type": "array", "items": {"type": "string"}, "minItems": 2,
                                      "description": "Scenario ids to compare, from the intake's own set "
                                                     "(retained_air, rdhx, hybrid_dlc, full_dlc, full_dlc_btm). "
                                                     "Default: all the intake defines."},
                        "baseline": {"type": "string",
                                     "description": "Scenario id the others are compared with. Default: the first."},
                        "grid_queue_region": _queue_region_schema(),
                        "electricity_price_state": _price_state_schema()},
         "additionalProperties": False},
        returns="gridforge/ttp-compare/1: scenarios[], ranking, grade, caveats, grid_queue_context (measured US queue statistic, context "
                "only), request_digest, provenance.",
        boundary=("Same solve as the screen: a scenario with an unknown lead time gets no date and a reason, nothing is ranked on a figure it does "
                  "not have, and a date that rests on an assumed lead time is labelled 'assumed lead time, not a date'."),
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
        boundary=("Screening mode, not an issued engineering opinion: five architectures solved from your intake, with the provenance and evidence "
                  "class of every number in the pack."),
    ),
    _tool(
        "gridforge_portfolio",
        (f"Rank halls. Many intakes in (at most {MAX_PORTFOLIO_HALLS} halls in one request; a larger estate is several requests), "
         "an ordered list out: racks, weeks to power, capex per "
         "rack and what binds first for each. A hall that is not ranked on a figure (no deployable rack, a required input missing or an "
         "equipment bank undeclared) is listed after the ranked ones with rank null. Bills one unit per hall."),
        "/v1/portfolio",
        {"type": "object", "required": ["intakes"],
         "properties": {"intakes": {"type": "array", "items": _INTAKE_SCHEMA, "minItems": 1, "maxItems": MAX_PORTFOLIO_HALLS,
                                    "description": (f"The halls to rank, one intake each: at most {MAX_PORTFOLIO_HALLS} per request (more is "
                                                    "refused with 422 and nothing is charged; send the rest as further requests).")},
                        "objective": _OBJECTIVE,
                        "format": {"type": "string", "enum": ["json", "md", "html"], "default": "json",
                                   "description": "json: the ranking rows. md or html: also the rendered Portfolio Screen "
                                                  "document and one model pack per hall, from the same solve."},
                        "client": {"type": "string", "maxLength": 120,
                                   "description": "the name printed on the rendered document (format md or html)"}},
         "additionalProperties": False},
        returns="halls ranked against the objective, each marked rankable or not (a hall with a required input missing or an equipment bank "
                "undeclared is ranked on assumptions and kept out of the comparable total), with the comparable total of deployable racks, "
                "an upper-bound total that counts halls on one connection once each, the halls left out and a constraint roll-up; with format "
                "md or html, also the rendered document and a model pack per hall.",
        boundary=("Each hall is solved from its own intake in screening mode, so a ranking is only as good as those intakes; it is not a measured "
                  "comparison of the sites, and a total that includes halls on a shared connection is an upper bound."),
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
                                           "description": ("A recorded envelope state from an earlier run. It keeps fingerprints of that run's inputs, "
                                                           "not the inputs: a change is detected (inputs: changed) but no driver can be named, and "
                                                           "drivers_note says so. Send before to get the drivers.")},
                        "after": _INTAKE_SCHEMA, "objective": _OBJECTIVE,
                        "attribute": {"type": "boolean", "default": True},
                        "format": {"type": "string", "enum": ["json", "md", "html"],
                                   "default": "json"}},
         "additionalProperties": False},
        returns=("headline, racks/weeks/capex deltas, ranked drivers, explained and residual; changed_inputs_known and drivers_note say when the "
                 "inputs moved but cannot be named (a diff against previous_state), evidence_changed_inputs names the inputs whose declared evidence "
                 "class moved."),
        boundary=("Attributes a change to the inputs that moved it using single-input probes, and reports what the probes do not explain as a "
                  "residual rather than distributing it."),
    ),
    _tool(
        "gridforge_spec",
        ("Turn a binding constraint into a tender-ready technical specification: every "
         "numeric requirement derived from the capacity model and naming the constraint it "
         "came from, quoted at the site's own conditions rather than a manufacturer's "
         "reference condition, plus a machine-readable response schedule. Pass list=true to "
         "see which reliefs on the ladder can be tendered."),
        "/v1/spec",
        {"type": "object", "required": ["intake"],
         "properties": {"intake": _INTAKE_SCHEMA,
                        "constraint": {"type": "string",
                                       "description": "constraint id to tender for"},
                        "scenario": {"type": "string"},
                        "list": {"type": "boolean", "default": False},
                        "reference": {"type": "string"},
                        "objective": _OBJECTIVE,
                        "format": {"type": "string", "enum": ["html", "md"],
                                   "default": "html"}},
         "additionalProperties": False},
        returns=("the specification document, what it is sized for, and the response "
                 "template a supplier fills in."),
        boundary=("Every numeric requirement is derived from the capacity model, at the site's own conditions, and names the constraint it came "
                  "from; it is a specification to tender against, not a supplier's quotation."),
    ),
    _tool(
        "gridforge_bids",
        ("Compare supplier responses against the capacity model: what each bid does to the "
         "energisation date and to deployable rack count, not only what it costs. A "
         "non-compliant bid is never ranked above a compliant one."),
        "/v1/bids",
        {"type": "object", "required": ["intake", "responses"],
         "properties": {"intake": _INTAKE_SCHEMA,
                        "responses": {"type": "array", "minItems": 1,
                                      "items": {"type": "object",
                                                "additionalProperties": True}},
                        "constraint": {"type": "string"},
                        "scenario": {"type": "string"},
                        "ingest": {"type": "boolean", "default": False,
                                   "description": "also return the cost-library lines the "
                                                  "winning response implies"},
                        "evidence_only": {"type": "boolean", "default": False,
                                          "description": "return the validated or invalid quote "
                                                         "lines instead of a ranking; nothing is "
                                                         "accepted until a person reviews it"},
                        "basis": {"type": "string",
                                  "enum": ["budgetary_quote", "firm_quote", "contracted"],
                                  "default": "budgetary_quote"},
                        "region": {"type": "string"},
                        "objective": _OBJECTIVE},
         "additionalProperties": False},
        returns="ranked bids with scores, schedule impact, and optional cost-library lines.",
        boundary=("Ranks only the supplier responses you send, against the capacity model; a non-compliant bid is never ranked above a compliant "
                  "one, and quote lines returned with evidence_only are not accepted until a person reviews them."),
    ),
    _tool(
        "gridforge_power_assess",
        ("The Power Readiness Case: what is stopping this site reaching the target capacity, "
         "what fixes it, what that costs, what it does to the schedule, and what to do next. "
         "Composes the same solved scenario as gridforge_screen/gridforge_study into one "
         "decision object: current deployable racks vs. the target, the binding constraint, "
         "every priced and dated rung on the headroom ladder, the critical-path dependencies "
         "that set the earliest time to power (each marked when its lead time is only assumed), the calibration state behind every "
         "number, and one deterministic next action. Never invents a price, a lead time or a "
         "date — every figure traces to the engine or an explicit input, with its evidence "
         "class attached."),
        "/v1/power/assess",
        {"type": "object", "required": ["intake"],
         "properties": {"intake": _INTAKE_SCHEMA,
                        "target_racks": {"type": "integer",
                                         "description": "the rack count the customer actually "
                                                        "needs; omit to size the gap against "
                                                        "what the full headroom ladder itself "
                                                        "can reach"},
                        "objective": _OBJECTIVE},
         "additionalProperties": False},
        returns=("capacity (current/target/gap; target_reachable and gap_racks_after_ladder say whether the full headroom ladder reaches the "
                 "target, and what is still missing when it does not), binding_constraint, headroom_ladder (every "
                 "relief priced and dated), time_to_power (critical item and dependencies), "
                 "evidence (calibration state, evidence classes used), and next_action (which leads with the fact when the target is not "
                 "reachable)."),
        boundary=("Composed from the same solved scenario as the screen and the study: no price, lead time or date is invented, every figure "
                  "traces to the engine or an explicit input with its evidence class, and the calibration state is stated."),
    ),
    _tool(
        "gridforge_power_deploy_assess",
        ("The BTM Power Deployment Assessment: given a real load profile and the generation/"
         "BESS units actually on the table, compares GRID ONLY, GRID + GENERATION, GRID + BESS "
         "and GRID + BESS + GENERATION under one deterministic N/N+1/N+2/2N contingency test "
         "each, with CAPEX and lead time read from whatever the request declared (never priced "
         "at zero when a unit is uncosted — that architecture is marked not-yet-comparable "
         "instead). Answers 'what combination of grid, generation and storage gets this load to "
         "firm power by this date, and what does each option cost.' Never invents a price, a "
         "lead time, or a PASS — a generator with no declared availability escalates a would-be "
         "PASS to REQUIRES_ENGINEERING_STUDY rather than assuming perfect reliability."),
        "/v1/power/deploy/assess",
        {"type": "object", "required": ["load_profile", "grid_firm_MW", "target_MW"],
         "properties": {
             "load_profile": {
                 "type": "object",
                 "description": "either {csv: 'timestamp,kW\\n...'} from a real interval "
                                "export, or {flat_kW: n} for a screening-level single-figure "
                                "assumption (explicitly weaker evidence).",
                 "properties": {"csv": {"type": "string"}, "source": {"type": "string"},
                               "flat_kW": {"type": "number"}, "flat_hours": {"type": "number"}},
             },
             "grid_firm_MW": {"type": "number", "description": "firm import available from the "
                                                                "grid connection today"},
             "target_MW": {"type": "number", "description": "the firm power required"},
             "ride_through_hours": {"type": "number", "description": "the outage duration a "
                                                                     "battery must be sized "
                                                                     "against; defaults to 2h "
                                                                     "if omitted"},
             "redundancy": {"type": "string", "enum": ["N", "N+1", "N+2", "2N"], "default": "N"},
             "objective": {"type": "string",
                          "enum": ["max_compute", "min_cost", "fastest"],
                          "default": "max_compute",
                          "description": "What the architecture ranking optimises for: "
                                         "max_compute (most firm capacity), min_cost (lowest "
                                         "CAPEX among architectures that pass their own "
                                         "contingency test), or fastest (shortest critical-path "
                                         "lead time). The winner is never chosen by lowest cost "
                                         "silently — next_action always states which objective "
                                         "was used and the trade-off against the runner-up."},
             "generation": {"type": "array", "items": {
                 "type": "object", "required": ["id", "nameplate_MW"],
                 "properties": {"id": {"type": "string"}, "kind": {"type": "string"},
                               "nameplate_MW": {"type": "number"},
                               "capex_eur": {"type": "number"},
                               "lead_time_weeks": {"type": "number"},
                               "operating_mode": {"type": "string", "enum": ["continuous", "standby"],
                                                  "description": "how you run this unit. 'continuous': it is "
                                                                 "already running, so its start-up is never on the "
                                                                 "critical path. 'standby': it is offline until "
                                                                 "needed, so declared storage must carry the load "
                                                                 "it is relied on for until it is up, or the "
                                                                 "result is flagged for engineering study. Omit it "
                                                                 "and nothing about start-up is assumed or checked "
                                                                 "(the result says so)."},
                               "startup_time_min": {"type": "number", "minimum": 0, "maximum": 1440,
                                                    "description": "start-up time from offline to carrying "
                                                                   "load, minutes; replaces the library default "
                                                                   "for the technology"},
                               "fuel_type": {"type": "string",
                                            "description": "e.g. 'natural gas' — feeds the "
                                                           "fuel readiness gate; omitting it "
                                                           "leaves that gate MISSING_DATA"}}}},
             "bess": {"type": "array", "items": {
                 "type": "object", "required": ["id", "power_MW", "energy_MWh"],
                 "properties": {"id": {"type": "string"}, "power_MW": {"type": "number"},
                               "energy_MWh": {"type": "number"},
                               "capex_eur": {"type": "number"},
                               "lead_time_weeks": {"type": "number"},
                               "grid_forming": {"type": "boolean",
                                                "description": "feeds the electrical readiness "
                                                               "gate — more than one grid-"
                                                               "forming source across the "
                                                               "architecture requires a "
                                                               "controls arbitration study"}}}},
             "interconnection": {"type": "object",
                                 "description": "utility, pcc_voltage_kV, import_capacity_MW — "
                                                "feeds the interconnection readiness gate. "
                                                "Omitting it leaves that gate MISSING_DATA, "
                                                "never a guessed PASS.",
                                 "properties": {"utility": {"type": "string"},
                                               "pcc_voltage_kV": {"type": "number"},
                                               "import_capacity_MW": {"type": "number"}}},
             "permitting": {"type": "object",
                           "description": "e.g. {emissions_status, noise_status} — feeds the "
                                          "permitting readiness gate.",
                           "additionalProperties": {"type": "string"}},
         },
         "additionalProperties": False},
        returns=("load_profile summary (peak/mean/load-factor/ramp/step-events, with its own "
                 "evidence class), capacity (grid-only vs. target, the gap), architectures "
                 "(each with contingency status, CAPEX, lead time, whether fully costed, "
                 "readiness_gates — interconnection/protection/fuel/permitting/electrical/"
                 "reliability, each PASS/FAIL/MISSING_DATA/REQUIRES_ENGINEERING_STUDY/"
                 "REQUIRES_LICENSED_REVIEW/NOT_APPLICABLE with its reason and what's missing "
                 "— plus rfq_ready [enough data to prepare an RFQ], external_clearances_"
                 "required [who still has to sign off — protection, utility, permitting], "
                 "and execution_ready [cleared to build, which on-site generation/storage "
                 "architectures will almost never show as true from screening alone]), and "
                 "next_action, which names a missing readiness field before it ever says "
                 "'proceed to RFQ', always separates RFQ-readiness from build clearance, and "
                 "states which objective was used, why, and the trade-off against the "
                 "runner-up architecture — never a silent 'cheapest wins'."),
        boundary=("Compares architectures only on the load profile and units you declare: a unit with no declared cost leaves its architecture "
                  "not-yet-comparable rather than priced at zero, and a generator with no declared availability can never yield a plain PASS "
                  "(it is escalated to REQUIRES_ENGINEERING_STUDY)."),
    ),
    _tool(
        "gridforge_power_deploy_spec",
        ("A tender-ready technical specification for a BTM architecture's generation and "
         "storage units: every numeric requirement (nameplate rating, availability/forced-"
         "outage rate, start-up time, ramp rate, fuel, BESS power/energy/SOC window) derived "
         "from the declared unit and traceable to it, plus a weighted evaluation matrix and a "
         "machine-readable response schedule. Same request shape as "
         "gridforge_power_deploy_assess — this is what 'proceed to procurement' in that tool's "
         "next_action actually produces."),
        "/v1/power/deploy/spec",
        {"type": "object", "required": ["load_profile", "grid_firm_MW", "target_MW"],
         "properties": {
             "architecture": {"type": "string", "description": "one of the compared "
                                                                "architecture labels, e.g. "
                                                                "'GRID + BESS + GENERATION'; "
                                                                "selects the units tendered"},
             "require_rfq_ready": {"type": "boolean", "description": "refuse unless the "
                                                                       "engine itself finds "
                                                                       "this architecture "
                                                                       "RFQ-ready"},
             "project": {"type": "string"},
             "load_profile": {"type": "object", "description": "unused by this tool but part "
                                                                "of the shared request shape; "
                                                                "pass {flat_kW: 0} if omitting "
                                                                "a real profile"},
             "grid_firm_MW": {"type": "number"}, "target_MW": {"type": "number"},
             **_BTM_SHARED_PROPERTIES,
             "generation": {"type": "array", "items": {"type": "object"}},
             "bess": {"type": "array", "items": {"type": "object"}},
             "format": {"type": "string", "enum": ["json", "html", "md"], "default": "html"},
             "reference": {"type": "string"}, "return_by": {"type": "string"},
             "contact": {"type": "string"},
         },
         "additionalProperties": False},
        returns="the specification document, or its summary and response template as JSON.",
        boundary=("Every numeric requirement is derived from the generation or storage unit you declared and traceable to it; it is a tender "
                  "specification, not a supplier's quotation."),
    ),
    _tool(
        "gridforge_power_deploy_bids",
        ("Rank supplier responses to a BTM tender package (gridforge_power_deploy_spec) with the "
         "same comparison rules as gridforge_bids: mandatory non-compliance is never outranked "
         "by price, incomplete responses are disqualified not guessed at, and installation "
         "method and evidence quality are left to an engineer. Send the same deployment request "
         "and architecture the package was built from, plus the completed response schedules."),
        "/v1/power/deploy/bids",
        {"type": "object", "required": ["load_profile", "grid_firm_MW", "target_MW", "responses"],
         "properties": {
             "architecture": {"type": "string"}, "project": {"type": "string"},
             "load_profile": {"type": "object"},
             "grid_firm_MW": {"type": "number"}, "target_MW": {"type": "number"},
             **_BTM_SHARED_PROPERTIES,
             "generation": {"type": "array", "items": {"type": "object"}},
             "bess": {"type": "array", "items": {"type": "object"}},
             "responses": {"type": "array", "items": {"type": "object"}},
         },
         "additionalProperties": False},
        returns="the ranked comparison, the leading compliant supplier (or null) and the note.",
        boundary=("Ranks only the responses you send: mandatory non-compliance is never outranked by price, incomplete responses are disqualified "
                  "rather than guessed at, and installation method and evidence quality are left to an engineer."),
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
        boundary=("Built from what the engine already found for this intake; the price it states is the named engagement's catalogue price."),
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


#: Every route with a unit weight, tool or no tool. `/v1/deck` has a weight and a route but is deliberately
#: not an agent tool (a human walkthrough); an integrator pricing a deployment still needs its weight.
def rate_card() -> list[dict]:
    by_endpoint = {t["endpoint"]: t["name"] for t in TOOLS}
    return [{"endpoint": e, "units": u, "tool": by_endpoint.get(e),
             # additive, on the one row it applies to: a request over this many halls is refused (422), not priced
             **({"max_halls_per_request": MAX_PORTFOLIO_HALLS} if e == "/v1/portfolio" else {})}
            for e, u in sorted(UNIT_COST.items())]


def catalogue() -> dict:
    return {
        "tools": [{k: v for k, v in t.items() if k != "inputSchema"} | {"inputSchema": t["inputSchema"]}
                  for t in TOOLS],
        "openai": openai_tools(),
        "mcp": {"endpoint": "/mcp", "protocol": "jsonrpc-2.0",
                "protocolVersion": PROTOCOL_VERSION, "tools": mcp_tools()},
        "auth": {"header": "X-API-Key",
                 "note": ("gridforge_qualify and gridforge_estimate are free and need no key. "
                          "Everything else meters.")},
        "payg": payg_public(),
        "rate_card": rate_card(),
        "evidence_note": (
            "Every numeric field in a response carries an evidence class (E0 assumed … E7 "
            "observed in operation) and a provenance digest. An agent consuming these must "
            "not present an E0 or E1 figure as a property of the physical asset. The "
            "calibration block states how far this engine has been reconciled against site "
            "data; where it says uncalibrated, it means uncalibrated."),
    }
