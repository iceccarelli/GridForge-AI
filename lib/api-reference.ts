// The per-endpoint reference /developers prints: for every tool and engine endpoint, whether it needs a key, what a call weighs, what its result
// may be taken for, and how it can fail. Generated from the same data as /openapi.json (public/reference/tools.json for the tools, lib/openapi.ts
// for the refusals), never typed beside it, so the page and the document cannot say different things.
// tests/site/developers-reference.test.ts compares every row with the engine's own tables (server.py ROUTES, metering.py UNIT_COST).

import { PER_HALL_ENDPOINTS } from "@/lib/payg-pricing";
import { DECK_EVIDENCE_BOUNDARY, failureStatuses, mcpCodesFor, type ToolsFile } from "@/lib/openapi";

export interface EndpointReference {
  /** The tool name, or "deck" for the REST-only deck and "mcp" for the transport. */
  id: string;
  method: "POST";
  endpoint: string;
  /** Whether a call needs an API key. The MCP transport itself needs none: each tool keeps its own tier. */
  needsKey: boolean;
  /** Units one call weighs; for a per-hall route, units for each hall in the request. */
  units: number;
  perHall: boolean;
  /** The evidence boundary of the result, in one sentence. */
  boundary: string;
  /** HTTP statuses the route can answer with besides 200. */
  statuses: number[];
  /** JSON-RPC error codes a call through /mcp can come back with; empty for a route that is not an MCP tool. */
  mcpCodes: number[];
}

/** What the MCP transport says of its own boundary: it runs nothing itself. */
export const MCP_TRANSPORT_BOUNDARY = "The transport runs nothing itself: each tool keeps its own authentication, unit weight and evidence boundary.";

export function endpointReference(file: ToolsFile): EndpointReference[] {
  const rows: EndpointReference[] = file.tools.map((t) => {
    const needsKey = t.tier !== "public";
    return {
      id: t.name,
      method: "POST",
      endpoint: t.endpoint,
      needsKey,
      units: t.units,
      perHall: PER_HALL_ENDPOINTS.includes(t.endpoint),
      boundary: t.evidence_boundary ?? "",
      statuses: failureStatuses(t.endpoint, needsKey),
      mcpCodes: mcpCodesFor(t.endpoint, needsKey),
    };
  });
  const deckUnits = file.rate_card?.find((r) => r.endpoint === "/v1/deck")?.units;
  if (deckUnits !== undefined) {
    rows.push({ id: "deck", method: "POST", endpoint: "/v1/deck", needsKey: true, units: deckUnits, perHall: false, boundary: DECK_EVIDENCE_BOUNDARY, statuses: failureStatuses("/v1/deck", true), mcpCodes: [] });
  }
  rows.push({
    id: "mcp", method: "POST", endpoint: file.mcp?.endpoint ?? "/mcp", needsKey: false, units: 0, perHall: false, boundary: MCP_TRANSPORT_BOUNDARY,
    // The transport's own HTTP refusals: the body (400, 413, 415) and the per-client rate limit (429).
    statuses: [400, 413, 415, 429], mcpCodes: [-32600, -32601],
  });
  return rows;
}
