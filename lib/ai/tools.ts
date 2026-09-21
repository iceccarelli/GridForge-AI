// The GridForge tool registry — a typed mirror of gridforge/api/tools.py.
//
// The physics, the tier gate and the metering all live in the Python engine.
// This file does not reimplement any of that; it names the same eight
// endpoints, with the same request shape, so the orchestration loop in
// agent.ts can hand a model's tool call straight to the real engine instead
// of narrating an answer.
//
// If gridforge/api/tools.py ever adds, removes or renames a tool, this file
// must be updated by hand to match — there is deliberately no runtime
// codegen step here. tests/site/ai-tools.test.ts checks the two lists of
// names line up as a guardrail against silent drift.

import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

export type ToolTier = "public" | "client" | "internal";

export interface ToolDef {
  /** Name the model calls, exactly as gridforge/api/tools.py registers it. */
  name: string;
  description: string;
  /** Engine path, relative to GRIDFORGE_API_URL. */
  endpoint: string;
  method: "POST";
  /** Who may call it without a key. Only "public" tools run with no entitlement check. */
  tier: ToolTier;
  /** Metering cost in engine units — mirrors gridforge/api/metering.py UNIT_COST. */
  units: number;
  /** JSON Schema, matching gridforge/api/tools.py's inputSchema for this tool. */
  inputSchema: Record<string, unknown>;
}

const OBJECTIVE_SCHEMA = {
  type: "string",
  enum: ["max_compute", "min_capex_per_rack", "fastest_to_power"],
  default: "max_compute",
  description: "What the recommendation optimises for.",
} as const;

const INTAKE_SCHEMA = {
  type: "object",
  description:
    "A GridForge intake document. GET /v1/intake/template for the blank form with " +
    "every field, or supply a sparse one — anything absent is filled from library " +
    "defaults and reported as an assumption.",
  additionalProperties: true,
} as const;

export const TOOLS: ToolDef[] = [
  {
    name: "gridforge_qualify",
    description:
      "Free. Seven numbers about an existing air-cooled hall in, one answer out: which " +
      "physical constraint binds first when you try to deploy AI racks in it, how many " +
      "racks fit as found, and which item sets the energisation date. Use this to triage " +
      "a portfolio before paying for anything.",
    endpoint: "/v1/qualify",
    method: "POST",
    tier: "public",
    units: 0,
    inputSchema: {
      type: "object",
      required: ["contracted_MW", "current_site_peak_MW", "busway_ampacity_A", "tapoff_max_A"],
      properties: {
        contracted_MW: { type: "number", description: "Contracted grid capacity, MW." },
        current_site_peak_MW: { type: "number", description: "Current site peak demand, MW." },
        current_it_load_MW: { type: "number", description: "Current IT load, MW." },
        busway_ampacity_A: { type: "number", description: "Installed busway ampacity, A." },
        tapoff_max_A: { type: "number", description: "Largest installed tap-off rating, A." },
        plant_supply_C: { type: "number", description: "Chilled-water design supply temperature, °C." },
        positions_available: { type: "integer", description: "Rack positions that can be released." },
        objective: OBJECTIVE_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: "gridforge_screen",
    description:
      "Density Screen. A full intake in, a screening read out: every constraint evaluated, " +
      "the headroom ladder, and which relief unlocks the most racks per euro.",
    endpoint: "/v1/screen",
    method: "POST",
    tier: "client",
    units: 1,
    inputSchema: {
      type: "object",
      required: ["intake"],
      properties: {
        intake: INTAKE_SCHEMA,
        objective: OBJECTIVE_SCHEMA,
        format: { type: "string", enum: ["json", "md", "html"], default: "json" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gridforge_study",
    description:
      "Capacity & Density Envelope Study. Five architectures compared, the full headroom " +
      "ladder with costs and lead times, time-to-power, sensitivity, economics, and the " +
      "provenance of every number. format='csv' returns the working files a client's own " +
      "engineer can rebuild the answer from.",
    endpoint: "/v1/study",
    method: "POST",
    tier: "client",
    units: 5,
    inputSchema: {
      type: "object",
      required: ["intake"],
      properties: {
        intake: INTAKE_SCHEMA,
        objective: OBJECTIVE_SCHEMA,
        format: { type: "string", enum: ["json", "md", "html", "csv"], default: "json" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gridforge_portfolio",
    description:
      "Rank halls. Many intakes in, an ordered list out: racks, weeks to power, capex per " +
      "rack and what binds first for each. Bills one unit per hall.",
    endpoint: "/v1/portfolio",
    method: "POST",
    tier: "client",
    units: 1,
    inputSchema: {
      type: "object",
      required: ["intakes"],
      properties: {
        intakes: { type: "array", items: INTAKE_SCHEMA, minItems: 1 },
        objective: OBJECTIVE_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: "gridforge_diff",
    description:
      "What moved, and which input moved it. Two intakes (or a recorded envelope state and " +
      "a new intake) in, an attributed change note out, including the part the single-input " +
      "probes do not explain, reported as a residual rather than distributed.",
    endpoint: "/v1/diff",
    method: "POST",
    tier: "client",
    units: 2,
    inputSchema: {
      type: "object",
      required: ["after"],
      properties: {
        before: INTAKE_SCHEMA,
        previous_state: {
          type: "object",
          additionalProperties: true,
          description: "A recorded envelope state from an earlier run.",
        },
        after: INTAKE_SCHEMA,
        objective: OBJECTIVE_SCHEMA,
        attribute: { type: "boolean", default: true },
        format: { type: "string", enum: ["json", "md", "html"], default: "json" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gridforge_spec",
    description:
      "Turn a binding constraint into a tender-ready technical specification: every " +
      "numeric requirement derived from the capacity model and naming the constraint it " +
      "came from, quoted at the site's own conditions rather than a manufacturer's " +
      "reference condition, plus a machine-readable response schedule. Pass list=true to " +
      "see which reliefs on the ladder can be tendered.",
    endpoint: "/v1/spec",
    method: "POST",
    tier: "client",
    units: 3,
    inputSchema: {
      type: "object",
      required: ["intake"],
      properties: {
        intake: INTAKE_SCHEMA,
        constraint: { type: "string", description: "constraint id to tender for" },
        scenario: { type: "string" },
        list: { type: "boolean", default: false },
        reference: { type: "string" },
        objective: OBJECTIVE_SCHEMA,
        format: { type: "string", enum: ["html", "md"], default: "html" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "gridforge_bids",
    description:
      "Compare supplier responses against the capacity model: what each bid does to the " +
      "energisation date and to deployable rack count, not only what it costs. A " +
      "non-compliant bid is never ranked above a compliant one.",
    endpoint: "/v1/bids",
    method: "POST",
    tier: "client",
    units: 2,
    inputSchema: {
      type: "object",
      required: ["intake", "responses"],
      properties: {
        intake: INTAKE_SCHEMA,
        responses: { type: "array", minItems: 1, items: { type: "object", additionalProperties: true } },
        constraint: { type: "string" },
        scenario: { type: "string" },
        ingest: {
          type: "boolean",
          default: false,
          description: "also return the cost-library lines the winning response implies",
        },
        basis: { type: "string", enum: ["budgetary_quote", "firm_quote", "contracted"], default: "budgetary_quote" },
        region: { type: "string" },
        objective: OBJECTIVE_SCHEMA,
      },
      additionalProperties: false,
    },
  },
  {
    name: "gridforge_proposal",
    description: "A priced proposal for a named engagement, built from what the engine already found.",
    endpoint: "/v1/proposal",
    method: "POST",
    tier: "client",
    units: 2,
    inputSchema: {
      type: "object",
      required: ["intake"],
      properties: {
        intake: INTAKE_SCHEMA,
        engagement: { type: "string", default: "density_screen" },
        objective: OBJECTIVE_SCHEMA,
        valid_days: { type: "integer", default: 30 },
        format: { type: "string", enum: ["html", "md"], default: "html" },
      },
      additionalProperties: false,
    },
  },
];

export const TOOLS_BY_NAME: Record<string, ToolDef> = Object.fromEntries(
  TOOLS.map((t) => [t.name, t])
);

/** Anthropic / OpenAI function-calling shape, straight off the registry above. */
export function anthropicTools(): Anthropic.Tool[] {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
  }));
}

/** The subset of required top-level keys per tool, for a cheap pre-flight check
 *  before ever calling the engine — so a missing input produces a missingInput
 *  block instead of a wasted (and possibly billable) round trip. */
export function requiredKeys(tool: ToolDef): string[] {
  const req = (tool.inputSchema as { required?: unknown }).required;
  return Array.isArray(req) ? req.filter((k): k is string => typeof k === "string") : [];
}

export type EngineCallOutcome =
  | { ok: true; status: number; body: unknown }
  | { ok: false; reason: "unconfigured" | "unreachable" | "quota_exceeded" | "rejected"; status: number; detail: string };

/**
 * Call the real engine for one tool. Follows the exact pattern established in
 * lib/qualify.ts's callEngine(): reads GRIDFORGE_API_URL / GRIDFORGE_API_KEY,
 * a 20s AbortSignal timeout, and never invents a result if the engine cannot
 * be reached — it returns a typed failure instead.
 *
 * The engine returns 402 (not 429) once a metered caller is over quota; that
 * status is passed straight through as reason "quota_exceeded" rather than
 * translated into anything else.
 */
export async function callEngineTool(tool: ToolDef, args: Record<string, unknown>): Promise<EngineCallOutcome> {
  const base = process.env.GRIDFORGE_API_URL;
  if (!base) {
    return {
      ok: false,
      reason: "unconfigured",
      status: 503,
      detail: "The capacity engine is not connected to this deployment.",
    };
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.GRIDFORGE_API_KEY) headers["X-API-Key"] = process.env.GRIDFORGE_API_KEY;

  try {
    const res = await fetch(`${base.replace(/\/$/, "")}${tool.endpoint}`, {
      method: tool.method,
      headers,
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 402) {
      return {
        ok: false,
        reason: "quota_exceeded",
        status: 402,
        detail:
          typeof (body as { error?: string })?.error === "string"
            ? (body as { error: string }).error
            : "Over quota for this engagement tier.",
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        reason: "rejected",
        status: res.status,
        detail:
          typeof (body as { error?: string })?.error === "string"
            ? (body as { error: string }).error
            : `engine returned ${res.status}`,
      };
    }
    return { ok: true, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      reason: "unreachable",
      status: 502,
      detail: err instanceof Error ? err.message : "engine unreachable",
    };
  }
}

/** Loose runtime shape check for tool call arguments — not a full schema
 *  validator (the engine is the authority on that), just enough to catch a
 *  malformed tool_use block from the model before it reaches the network. */
export const toolCallArgsSchema = z.record(z.string(), z.unknown());
