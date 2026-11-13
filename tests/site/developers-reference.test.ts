/**
 * /developers states, for every tool and engine endpoint, the key it needs, what a call weighs, what its result may be taken for and how it
 * can fail. The rows are generated (lib/api-reference.ts) from the same data as /openapi.json and are compared here with the engine's own
 * tables, parsed from source (server.py ROUTES and SOLVING_ROUTES, metering.py UNIT_COST), so a row cannot drift from the engine.
 */
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { endpointReference } from "@/lib/api-reference";
import { buildOpenApi, ERROR_STATUSES, failureStatuses, mcpCodesFor, type ToolsFile } from "@/lib/openapi";
import { FULL_ENGINE, STALE_ENGINE, stubEngine } from "./engine-stub";

const read = (f: string) => fs.readFileSync(f, "utf8");
const server = read("gridforge/api/server.py");
const metering = read("gridforge/api/metering.py");
const toolsFile = JSON.parse(read("public/reference/tools.json")) as ToolsFile;
const doc = buildOpenApi(toolsFile, "https://engine.invalid") as any;

const TIER = new Map<string, string>([...server.matchAll(/^\s+"(\/v1\/[^"]+)": \(handle_\w+, Tier\.(PUBLIC|CLIENT|INTERNAL)\),/gm)].map((m) => [m[1], m[2]]));
const UNITS = new Map<string, number>([...metering.matchAll(/^\s+"(\/[^"]+)":\s+(\d+),/gm)].map((m) => [m[1], Number(m[2])]));
const SOLVING = new Set([...(/SOLVING_ROUTES = frozenset\(\{([^}]*)\}\)/.exec(server)![1].matchAll(/"([^"]+)"/g))].map((m) => m[1]));

const escapeHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

async function page(routes: string[] | "down" = FULL_ENGINE): Promise<string> {
  const stop = stubEngine(routes);
  try {
    return renderToStaticMarkup(await (await import("@/app/developers/page")).default()).replace(/<!-- -->/g, "");
  } finally {
    stop();
  }
}

function rows(html: string): Map<string, string> {
  const table = /data-testid="endpoint-reference">([\s\S]*?)<\/table>/.exec(html)![1];
  return new Map([...table.matchAll(/<tr [^>]*data-endpoint="([^"]+)"[^>]*>([\s\S]*?)<\/tr>/g)].map((m) => [m[1], m[2]]));
}
const field = (row: string, name: string) => new RegExp(`data-field="${name}"[^>]*>([\\s\\S]*?)</td>`).exec(row)![1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

describe("the reference rows, from the data", () => {
  const ref = endpointReference(toolsFile);

  it("has a row for every tool, the REST-only deck and the MCP transport, and no other", () => {
    expect(ref.map((r) => r.endpoint).sort()).toEqual([...toolsFile.tools.map((t) => t.endpoint), "/v1/deck", "/mcp"].sort());
    expect(ref).toHaveLength(16);
  });

  it("each tool row agrees with the engine's route tables: key iff Tier.CLIENT, units = UNIT_COST, 503 iff the route solves or needs a key", () => {
    for (const t of toolsFile.tools) {
      const r = ref.find((x) => x.endpoint === t.endpoint)!;
      expect(r.needsKey, t.name).toBe(TIER.get(t.endpoint) === "CLIENT");
      expect(r.units, t.name).toBe(UNITS.get(t.endpoint));
      expect(r.statuses.includes(503), t.name).toBe(SOLVING.has(t.endpoint) || r.needsKey);
      expect(r.statuses.includes(402) && r.statuses.includes(401), t.name).toBe(r.needsKey);
      expect(r.statuses.every((s) => ERROR_STATUSES.some((e) => e.status === s)), t.name).toBe(true);
      expect(r.mcpCodes.includes(-32001), t.name).toBe(r.needsKey);
      expect(r.mcpCodes.includes(-32003), t.name).toBe(r.statuses.includes(503));
      expect(r.boundary, t.name).toBe(t.evidence_boundary);
      expect(r.boundary.length, t.name).toBeGreaterThan(40);
    }
    expect(ref.find((r) => r.endpoint === "/v1/portfolio")!.perHall).toBe(true);
    expect(ref.filter((r) => r.perHall)).toHaveLength(1);
    const deck = ref.find((r) => r.id === "deck")!;
    expect(deck.units).toBe(UNITS.get("/v1/deck"));
    expect(deck.needsKey).toBe(TIER.get("/v1/deck") === "CLIENT");
    expect(deck.mcpCodes).toEqual([]);
  });

  it("follows the data: change a weight, a tier or a boundary in the catalogue and the row changes", () => {
    const moved = JSON.parse(JSON.stringify(toolsFile)) as ToolsFile;
    const study = moved.tools.find((t) => t.name === "gridforge_study")!;
    study.units = 99;
    study.evidence_boundary = "A different boundary.";
    moved.tools.find((t) => t.name === "gridforge_qualify")!.tier = "client";
    const r = endpointReference(moved);
    expect(r.find((x) => x.id === "gridforge_study")).toMatchObject({ units: 99, boundary: "A different boundary." });
    expect(r.find((x) => x.id === "gridforge_qualify")!.needsKey).toBe(true);
    expect(r.find((x) => x.id === "gridforge_qualify")!.statuses).toContain(402);
  });

  it("is the same list the OpenAPI responses are built from", () => {
    for (const r of ref.filter((x) => x.id !== "mcp")) {
      const op = doc.paths[r.endpoint].post;
      expect(Object.keys(op.responses).filter((k) => /^\d{3}$/.test(k) && k !== "200").map(Number).sort(), r.endpoint).toEqual(
        r.statuses.filter((s) => [401, 402, 429, 503].includes(s)).sort(),
      );
      expect(op["x-gridforge-units"]).toBe(r.units);
    }
    expect(failureStatuses("/v1/screen", true)).toEqual(ref.find((r) => r.id === "gridforge_screen")!.statuses);
    expect(mcpCodesFor("/v1/screen", true)).toEqual(ref.find((r) => r.id === "gridforge_screen")!.mcpCodes);
  });
});

describe("the rendered page", () => {
  it("prints every row's key, units, boundary and failures as the data gives them", async () => {
    const table = rows(await page());
    const ref = endpointReference(toolsFile);
    expect(table.size).toBe(ref.length);
    for (const r of ref) {
      const row = table.get(r.endpoint)!;
      expect(row, r.endpoint).toBeTruthy();
      expect(field(row, "boundary"), r.endpoint).toBe(escapeHtml(r.boundary));
      expect(field(row, "units"), r.endpoint).toBe(r.id === "mcp" ? "0" : `${r.units}${r.perHall ? " per hall" : ""}`);
      expect(field(row, "key"), r.endpoint).toBe(r.id === "mcp" ? "none; each tool keeps its own" : r.needsKey ? "required" : "none");
      expect(field(row, "fails"), r.endpoint).toBe([r.statuses.join(" "), r.mcpCodes.join(" ")].filter(Boolean).join(" "));
    }
  });

  it("the free tools show no key and the metered ones do, matching tools.json tiers", async () => {
    const table = rows(await page());
    for (const t of toolsFile.tools) expect(field(table.get(t.endpoint)!, "key"), t.name).toBe(t.tier === "public" ? "none" : "required");
  });

  it("a route the deployed engine does not serve shows the unavailable label and no weight, boundary or failures", async () => {
    const table = rows(await page(STALE_ENGINE));
    const compare = table.get("/v1/compare")!;
    expect(compare).toContain("Not yet available");
    expect(compare).not.toContain('data-field="boundary"');
    expect(table.get("/v1/screen")).toContain('data-field="boundary"');
  });

  it("an unreadable engine confirms nothing", async () => {
    const table = rows(await page("down"));
    for (const [endpoint, row] of table) expect(row, endpoint).not.toContain('data-field="boundary"');
  });
});
