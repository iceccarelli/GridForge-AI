/**
 * The machine-readable surfaces say exactly what the engine and the site do.
 *
 *   engine route tables (gridforge/api/server.py, metering.py, tools.py)
 *      -> lib/engine-deployed.json   (what the DEPLOYED engine listed when last read)
 *      -> /openapi.json              (every deployed route, in its method, with its auth and its unit weight)
 *      -> /llms.txt                  (every deployed route, every MCP tool, the retry rule, the pricing source)
 *      -> /developers                (the same tools, the same retry rule)
 *      -> lib/capability-registry.ts (the same MCP tools)
 *
 * Nothing is documented that the deployed engine does not serve; nothing the deployed engine serves is left out unless it is on the
 * explicit ENGINE_UNDOCUMENTED list with a reason. Every number in the prose comes from the catalogue: the second half of this file
 * re-renders the surfaces with a perturbed catalogue and requires the text to follow it.
 */
import fs from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CAPABILITY_REGISTRY } from "@/lib/capability-registry";
import snapshot from "@/lib/engine-deployed.json";
import {
  ENGINE_DISCOVERY,
  ENGINE_NON_TOOL_PATHS,
  ENGINE_UNDOCUMENTED,
  IDEMPOTENCY_KEY_MAX_CHARS,
  IDEMPOTENCY_WINDOW_HOURS,
  MAX_MCP_BATCH,
  buildOpenApi,
  idempotencyStatement,
  type ToolsFile,
} from "@/lib/openapi";
import { EVIDENCE_CLASSES } from "@/lib/evidence-classes";
import { resetEngineCapabilityCache } from "@/lib/engine-capabilities";
import { FULL_ENGINE, STALE_ENGINE, stubEngine } from "./engine-stub";

// The surfaces cache what they read of the engine per module instance; every test starts from fresh ones so a stub is the only thing it sees.
beforeEach(() => {
  vi.resetModules();
});

const read = (f: string) => fs.readFileSync(f, "utf8");
const server = read("gridforge/api/server.py");
const metering = read("gridforge/api/metering.py");
const toolsPy = read("gridforge/api/tools.py");
const toolsFile = JSON.parse(read("public/reference/tools.json")) as ToolsFile & { mcp: { tools: { name: string }[] } };
const doc = buildOpenApi(toolsFile, "https://engine.invalid") as any;

const deployed: string[] = snapshot.endpoints;
const mcpPath = snapshot.machine_interface.mcp;

// --- what the engine's own route tables say ---------------------------------------------------------------------------------
const POST_ROUTES = new Map<string, "PUBLIC" | "CLIENT" | "INTERNAL">(
  [...server.matchAll(/^\s+"(\/v1\/[^"]+)": \(handle_\w+, Tier\.(PUBLIC|CLIENT|INTERNAL)\),/gm)].map((m) => [m[1], m[2] as "PUBLIC" | "CLIENT" | "INTERNAL"]),
);
const GET_ROUTES: string[] = [...(/GET_ROUTES = \(([^)]*)\)/.exec(server)![1].matchAll(/"([^"]+)"/g))].map((m) => m[1]);
const UNIT_COST = new Map<string, number>([...metering.matchAll(/^\s+"(\/[^"]+)":\s+(\d+),/gm)].map((m) => [m[1], Number(m[2])]));
const PY_TOOLS = [...toolsPy.matchAll(/^\s+"(gridforge_[a-z_]+)",\s*$/gm)].map((m) => m[1]);

describe("the engine route tables, parsed", () => {
  it("find the routes the snapshot lists, so the tests below compare something", () => {
    expect(POST_ROUTES.size).toBe(16);
    expect(GET_ROUTES).toHaveLength(8);
    expect(deployed).toHaveLength(24);
  });

  it("every route in the deployed snapshot exists in the repository's route tables", () => {
    const repo = new Set([...POST_ROUTES.keys(), ...GET_ROUTES]);
    expect(deployed.filter((e) => !repo.has(e))).toEqual([]);
  });
});

describe("OpenAPI parity with the deployed engine", () => {
  it("describes every deployed route except those on the explicit undocumented list, and nothing the deployed engine does not serve", () => {
    const documented = Object.keys(doc.paths).filter((p) => !p.startsWith("/api/"));
    const served = new Set([...deployed, mcpPath]);
    expect(documented.filter((p) => !served.has(p)), "described but not served by the deployed engine").toEqual([]);
    expect(
      [...served].filter((p) => !documented.includes(p) && !(p in ENGINE_UNDOCUMENTED)),
      "served but neither described nor on ENGINE_UNDOCUMENTED",
    ).toEqual([]);
    for (const [route, why] of Object.entries(ENGINE_UNDOCUMENTED)) {
      expect(why.length, route).toBeGreaterThan(30);
      expect(documented, route).not.toContain(route);
      expect(POST_ROUTES.get(route), `${route} is on the undocumented list because it is operator tier`).toBe("INTERNAL");
    }
  });

  it("uses the method the engine uses: POST for the POST route table, GET for GET_ROUTES, and /mcp as POST", () => {
    for (const [route] of POST_ROUTES) {
      if (route in ENGINE_UNDOCUMENTED) continue;
      expect(Object.keys(doc.paths[route]), route).toEqual(["post"]);
    }
    for (const route of GET_ROUTES) expect(Object.keys(doc.paths[route]), route).toEqual(["get"]);
    expect(Object.keys(doc.paths[mcpPath])).toEqual(["post"]);
  });

  it("asks for a key exactly where the engine does (Tier.CLIENT, and GET /v1/usage), and for none on the free routes", () => {
    for (const [route, tier] of POST_ROUTES) {
      if (route in ENGINE_UNDOCUMENTED) continue;
      expect(doc.paths[route].post.security, route).toEqual(tier === "CLIENT" ? [{ ApiKeyAuth: [] }] : []);
    }
    for (const route of GET_ROUTES) expect(doc.paths[route].get.security, route).toEqual(route === "/v1/usage" ? [{ ApiKeyAuth: [] }] : []);
    expect(doc.paths[mcpPath].post.security).toEqual([]);
  });

  it("states the unit weight the engine meters, for every weighted POST route including the deck", () => {
    for (const [route, tier] of POST_ROUTES) {
      if (tier !== "CLIENT" && route !== "/v1/qualify" && route !== "/v1/estimate") continue;
      expect(doc.paths[route].post["x-gridforge-units"], route).toBe(UNIT_COST.get(route));
    }
    expect(doc.paths["/v1/deck"].post["x-gridforge-units"]).toBe(3);
  });

  it("makes /v1/deck REST only: it has a weight and a route but no MCP tool", () => {
    expect(doc.paths["/v1/deck"].post["x-gridforge-mcp-tool"]).toBeUndefined();
    expect(PY_TOOLS).not.toContain("gridforge_deck");
    expect(toolsFile.tools.some((t) => t.endpoint === "/v1/deck")).toBe(false);
  });

  it("describes the explicit non-tool routes it exports, and exactly those", () => {
    expect(ENGINE_NON_TOOL_PATHS.sort()).toEqual([...GET_ROUTES, "/v1/deck", "/mcp"].sort());
    expect(ENGINE_DISCOVERY.map((r) => r.path).sort()).toEqual([...GET_ROUTES].sort());
  });

  it("carries the engine's constants: the longest Idempotency-Key, the body limit and the MCP batch limit", () => {
    expect(server).toMatch(new RegExp(`MAX_IDEM_KEY_CHARS = ${IDEMPOTENCY_KEY_MAX_CHARS}\\b`));
    expect(server).toMatch(new RegExp(`MAX_MCP_BATCH = ${MAX_MCP_BATCH}\\b`));
    expect(server).toMatch(/MAX_BODY_BYTES = 512 \* 1024/);
    expect(doc.paths["/v1/screen"].post.parameters[0].schema.maxLength).toBe(IDEMPOTENCY_KEY_MAX_CHARS);
    expect(doc.paths[mcpPath].post.requestBody.content["application/json"].schema.oneOf[1].maxItems).toBe(MAX_MCP_BATCH);
  });

  it("puts the evidence class, the calibration record and the assumption disclosure where the engine puts them", () => {
    const q = doc.paths["/v1/qualify"].post.responses["200"].content["application/json"].schema.properties;
    expect(Object.keys(q)).toEqual(expect.arrayContaining(["as_found", "after_relief", "intake", "calibration", "notice"]));
    expect(q.calibration.$ref).toBe("#/components/schemas/CalibrationBlock");
    expect(q.after_relief.properties.date_evidence_class).toBeTruthy();
    expect(q.intake.properties.gaps.items.$ref).toBe("#/components/schemas/AssumptionGap");
    const screen = doc.paths["/v1/screen"].post.responses["200"].content["application/json"].schema.properties;
    expect(screen.calibration.$ref).toBe("#/components/schemas/CalibrationBlock");
    expect(doc.components.schemas.CalibrationBlock.properties.state.enum).toEqual(["uncalibrated", "indicative", "calibrated"]);
    expect(doc.paths["/v1/calibration/residuals"].get.responses["200"].content["application/json"].schema.$ref).toBe("#/components/schemas/ResidualReport");
  });
});

describe("the MCP tools: one list of fourteen everywhere", () => {
  const names = toolsFile.tools.map((t) => t.name);
  const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

  it("the live engine serves 14 tools, and the catalogue, the engine source and the MCP block agree on which", () => {
    expect(names).toHaveLength(14);
    expect(sorted(PY_TOOLS)).toEqual(sorted(names));
    expect(sorted(toolsFile.mcp.tools.map((t) => t.name))).toEqual(sorted(names));
    // Every tool's route is a route the deployed engine serves.
    for (const t of toolsFile.tools) expect(deployed, t.name).toContain(t.endpoint);
  });

  it("the capability registry names exactly those tools", () => {
    const inRegistry = CAPABILITY_REGISTRY.map((c) => c.mcp_tool).filter((m): m is string => !!m && m.startsWith("gridforge_"));
    expect(sorted(inRegistry)).toEqual(sorted(names));
  });

  it("OpenAPI names the same tools (x-gridforge-mcp-tool), one per operation", () => {
    const fromDoc = Object.values<any>(doc.paths).flatMap((p) => Object.values<any>(p)).map((op) => op["x-gridforge-mcp-tool"]).filter(Boolean);
    expect(sorted(fromDoc)).toEqual(sorted(names));
    expect(fromDoc).toHaveLength(14);
  });

  it("/llms.txt names the same tools when the engine serves them, and none when it does not", async () => {
    const { GET } = await import("@/app/llms.txt/route");
    const stop = stubEngine(FULL_ENGINE);
    try {
      const body = await (await GET()).text();
      const listed = [...body.matchAll(/`(gridforge_[a-z_]+)`/g)].map((m) => m[1]);
      expect(sorted(listed)).toEqual(sorted(names));
      const toolsSentence = /MCP: the tools are ([^\n]+?)\. The transport/.exec(body.replace(/\n(?=JSON-RPC)/g, " "))!;
      expect(sorted([...toolsSentence[1].matchAll(/`(gridforge_[a-z_]+)`/g)].map((m) => m[1]))).toEqual(sorted(names));
    } finally {
      stop();
    }
    vi.resetModules();
    const down = stubEngine("down");
    try {
      const body = await (await (await import("@/app/llms.txt/route")).GET()).text();
      expect(body).not.toMatch(/`gridforge_(screen|study|compare)`/);
    } finally {
      down();
    }
  });

  it("/developers lists the same tools", async () => {
    const stop = stubEngine(FULL_ENGINE);
    try {
      const html = renderToStaticMarkup(await (await import("@/app/developers/page")).default()).replace(/<!-- -->/g, "");
      const rows = [...html.matchAll(/<tr[^>]*data-availability="available"[^>]*><td[^>]*>(gridforge_[a-z_]+)/g)].map((m) => m[1]);
      expect(sorted(rows)).toEqual(sorted(names));
    } finally {
      stop();
    }
  });

  it("there is no MCP descriptor file on the site that could disagree: none is claimed", () => {
    // If one is ever added under public/.well-known or app/.well-known it must list these tools; until then nothing else may claim one.
    const roots = ["public/.well-known", "app/.well-known", "public/mcp.json", "public/server.json"];
    const found = roots.filter((r) => fs.existsSync(r) && !r.endsWith(".well-known"));
    expect(found).toEqual([]);
    for (const dir of ["public/.well-known", "app/.well-known"]) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!/mcp|ai-plugin|agent/i.test(f)) continue;
        const text = read(`${dir}/${f}`);
        for (const n of names) expect(text, `${dir}/${f} omits ${n}`).toContain(n);
      }
    }
  });
});

describe("/llms.txt parity with the deployed engine", () => {
  it("names every deployed route it can name, with its method, and never the operator route", async () => {
    const { GET } = await import("@/app/llms.txt/route");
    const stop = stubEngine(deployed);
    try {
      const body = await (await GET()).text();
      for (const route of deployed) {
        if (route in ENGINE_UNDOCUMENTED) {
          expect(body, route).not.toContain(route);
          continue;
        }
        const method = GET_ROUTES.includes(route) ? "GET" : "POST";
        expect(body, route).toContain(`${method} https://gridforge-engine.fly.dev${route}`);
      }
      expect(body).toContain("POST https://gridforge-engine.fly.dev/v1/deck");
      expect(body).toContain("REST only, no MCP tool");
      expect(body).toContain("https://gridforge-engine.fly.dev/mcp");
    } finally {
      stop();
    }
  });

  it("advertises no route the engine did not list when it was read", async () => {
    const { GET } = await import("@/app/llms.txt/route");
    const stop = stubEngine(STALE_ENGINE);
    try {
      const body = await (await GET()).text();
      // (/mcp is not in the list: the stub declares it under machine_interface, as the engine does.)
      for (const gone of ["/v1/compare", "/v1/calibration/residuals", "/v1/estimate", "/v1/power/assess", "/v1/power/deploy"]) {
        expect(body, gone).not.toContain(`gridforge-engine.fly.dev${gone}`);
      }
      expect(body).not.toContain("`gridforge_compare`");
      expect(body).not.toContain("`gridforge_power_assess`");
    } finally {
      stop();
    }
  });

  it("says the retry guarantee exactly as the server implements it", async () => {
    const { GET } = await import("@/app/llms.txt/route");
    const stop = stubEngine(FULL_ENGINE);
    try {
      const body = (await (await GET()).text()).replace(/\s+/g, " ");
      expect(body).toContain(idempotencyStatement());
      // header name, scope, window, replay signal, conflict and the narrower facts
      const statement = idempotencyStatement().replace(/\s+/g, " ");
      for (const needed of [
        "Idempotency-Key",
        `at most ${IDEMPOTENCY_KEY_MAX_CHARS} characters`,
        "scoped to your account and to the endpoint",
        `For ${IDEMPOTENCY_WINDOW_HOURS} hours`,
        "X-GridForge-Idempotent-Replay: true",
        "422",
        "never on /v1/estimate",
        "only on a request that carries a valid API key",
      ]) {
        expect(statement).toContain(needed);
      }
    } finally {
      stop();
    }
  });
});

// --- the numbers come from the catalogue ------------------------------------------------------------------------------------
describe("every number in the prose is derived from the catalogue", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/products");
    vi.resetModules();
    resetEngineCapabilityCache();
  });

  async function renderWith(perturb: boolean): Promise<{ llms: string; devs: string; open: string }> {
    vi.resetModules();
    if (perturb) {
      vi.doMock("@/lib/products", async (orig) => {
        const real = await orig<typeof import("@/lib/products")>();
        return {
          ...real,
          PAYG: { ...real.PAYG, unitPriceCents: 275, minInvoiceCents: 725, freeAllowanceUnits: 31, minCapEur: 25, maxCapEur: 1_900, defaultCapEur: 140 },
        };
      });
    }
    const stop = stubEngine(FULL_ENGINE);
    try {
      const llms = await (await (await import("@/app/llms.txt/route")).GET()).text();
      const devs = renderToStaticMarkup(await (await import("@/app/developers/page")).default()).replace(/<!-- -->/g, "");
      const open = JSON.stringify((await import("@/lib/openapi")).buildOpenApi(toolsFile, "https://engine.invalid"));
      return { llms, devs, open };
    } finally {
      stop();
    }
  }

  it("/llms.txt carries the catalogue's unit price, minimum invoice, free allowance and cap range, and follows them when they change", async () => {
    const base = await renderWith(false);
    const { PAYG } = await import("@/lib/products");
    const E = "\u20ac"; // the euro sign, spelled so this file holds no price literal (tests/test_one_company.py)
    const eur = (c: number) => (c % 100 === 0 ? `${E}${c / 100}` : `${E}${(c / 100).toFixed(2)}`);
    expect(base.llms).toContain(`${eur(PAYG.unitPriceCents)} per unit`);
    expect(base.llms).toContain(`under the ${eur(PAYG.minInvoiceCents)} minimum invoice`);
    expect(base.llms).toContain(`${PAYG.freeAllowanceUnits} units a month`);
    expect(base.llms).toContain("carried forward");
    for (const c of EVIDENCE_CLASSES) expect(base.llms, c.code).toContain(`${c.code} ${c.verb}`);
    expect(base.llms).toContain("answers 402");

    const moved = await renderWith(true);
    expect(moved.llms).toContain(`${E}2.75 per unit`);
    expect(moved.llms).toContain(`under the ${E}7.25 minimum invoice`);
    expect(moved.llms).toContain("31 units a month");
    expect(moved.llms).toContain(`from ${E}25 to ${E}1,900 a month (default ${E}140)`);
    expect(moved.llms).not.toContain(`${E}2 per unit`);
    expect(moved.llms).not.toContain("25 units a month");
  });

  it("/developers follows the same catalogue", async () => {
    const moved = await renderWith(true);
    expect(moved.devs).toContain("31 units a month");
    expect(moved.devs).not.toContain("25 units a month");
  });

  it("/openapi.json states no price at all, so it cannot drift from one", async () => {
    const base = await renderWith(false);
    expect(base.open).not.toMatch(/[\u20ac$]\s?\d|\bEUR\b|\b\d+\s?(?:euro|cents?) (?:a|per) unit/i);
  });

  it("no source that writes these surfaces types a euro amount or the free allowance as a literal", () => {
    const sources = ["app/llms.txt/route.ts", "lib/openapi.ts", "app/developers/page.tsx"].map((f) => [f, read(f)] as const);
    for (const [f, text] of sources) {
      const code = text.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code, `${f}: a euro amount typed in the source`).not.toMatch(/\u20ac\s?\d|\bEUR\s?\d|\d\s?EUR\b/);
      expect(code, `${f}: the free allowance typed in the source`).not.toMatch(/\b25 (?:free )?units\b/);
      expect(code, `${f}: a unit price typed in the source`).not.toMatch(/\b(?:200|500|2,?000) ?(?:euro )?cents\b/);
    }
  });

  it("the unit weights on the surfaces are the engine's (UNIT_COST), not copies", () => {
    for (const t of toolsFile.tools) expect(t.units, t.name).toBe(UNIT_COST.get(t.endpoint));
    for (const r of toolsFile.rate_card ?? []) expect(r.units, r.endpoint).toBe(UNIT_COST.get(r.endpoint));
  });
});

describe("/developers follows the engine it read", () => {
  it("lists no route the engine did not name when it is stale", async () => {
    const stop = stubEngine(STALE_ENGINE);
    try {
      const html = renderToStaticMarkup(await (await import("@/app/developers/page")).default()).replace(/<!-- -->/g, "");
      const list = /data-testid="engine-other-routes">([\s\S]*?)<\/ul>/.exec(html)![1];
      expect(list).not.toContain("/v1/calibration/residuals");
      expect(list).toContain("GET /v1/calibration");
      expect(list).toContain("POST /v1/deck");
    } finally {
      stop();
    }
  });

  it("lists nothing it could not confirm when the engine cannot be read", async () => {
    const stop = stubEngine("down");
    try {
      const html = renderToStaticMarkup(await (await import("@/app/developers/page")).default()).replace(/<!-- -->/g, "");
      const list = /data-testid="engine-other-routes">([\s\S]*?)<\/ul>/.exec(html)![1];
      expect(list).not.toContain("<li");
    } finally {
      stop();
    }
  });
});
