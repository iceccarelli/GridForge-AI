/**
 * Time-to-Power scenario comparison, end to end through the site: the real POST route, the real Python engine
 * (spawned, not stubbed), the real result component. No Stripe, no database, nothing persisted -- so no fetch to a
 * store is expected here, and one would fail the test. Fixtures are SYNTHETIC.
 */
import React from "react";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";
import { ComparisonResults } from "@/components/TtpCompare";
import { compareRequestSchema, toEngineBody, TTP_COMPARE_SCHEMA, type CompareResult } from "@/lib/ttp-compare";
import { CAPABILITY_REGISTRY } from "@/lib/capability-registry";
import { FOOTER_GROUPS } from "@/lib/nav";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const KEY = "ttp-compare-key";
let engine: ChildProcess | null = null;
let ENGINE = "";
const realFetch = globalThis.fetch;
let calls: string[];
let db: PostgrestFake;
let restoreDb: () => void;

async function startEngine(): Promise<string> {
  const code = [
    "import os", `os.environ['GRIDFORGE_API_KEYS']='${KEY}'`, "os.environ['GRIDFORGE_RATE_LIMIT']='0'",
    "from gridforge.api.server import Handler, make_server", "Handler.limiter.per_minute=0",
    "h=make_server('127.0.0.1',0)", "print(h.server_address[1],flush=True)", "h.serve_forever()",
  ].join("\n");
  engine = spawn("python3", ["-c", code], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  return await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("engine did not start")), 20_000);
    engine!.stdout!.once("data", (d) => { clearTimeout(t); res(`http://127.0.0.1:${String(d).trim()}`); });
  });
}
beforeAll(async () => { if (hasPython) ENGINE = await startEngine(); }, 30_000);
afterAll(() => engine?.kill());
beforeEach(() => {
  calls = [];
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = KEY;
  // The public route is guarded by a shared counter in the database (lib/rate-limit.ts), so it needs a store; this is the
  // in-memory PostgREST with the counter function restated. Its ONLY permitted use here is that counter.
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  delete process.env.GF_RATE_LIMIT_COMPARE;
  delete process.env.GF_RATE_LIMIT_COMPARE_ALL;
  db = new PostgrestFake();
  restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    calls.push(url);
    if (ENGINE && url.startsWith(ENGINE)) return realFetch(i as RequestInfo, init);
    return dbFetch(i as RequestInfo, init);
  }) as typeof fetch;
  restoreDb = () => { globalThis.fetch = dbFetch; };
});
afterEach(() => { restoreDb(); globalThis.fetch = realFetch; vi.restoreAllMocks(); });

/** Replace what the engine answers; the rate-limit counter keeps talking to the store, as it does in production. */
function stubEngine(answer: () => Response) {
  const toStore = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    return ENGINE && url.startsWith(ENGINE) ? answer() : toStore(i as RequestInfo, init);
  }) as typeof fetch;
}

const HALL = {
  siteName: "Synthetic Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4,
  currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180,
  plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};
const GAS = { id: "gas1", kind: "gas_engine", capacity_MW: 10, lead_time_weeks: 40 };
const post = async (body: unknown, raw?: string) =>
  (await import("@/app/api/power/compare/route")).POST(
    new Request(siteUrl("/api/power/compare"), { method: "POST", headers: { "content-type": "application/json" }, body: raw ?? JSON.stringify(body) }));

describe.runIf(hasPython)("the comparison route runs the real engine and reports what it can defend", () => {
  it("returns the engine's comparison, the request that reproduces it, and persists nothing", async () => {
    const res = await post({ hall: HALL, btm_options: [GAS], objective: "fastest" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body.ok).toBe(true);
    const r = body.result as CompareResult;
    expect(r.schema).toBe(TTP_COMPARE_SCHEMA);
    expect(r.scenarios.map((s) => s.id)).toEqual(["retained_air", "rdhx", "hybrid_dlc", "full_dlc", "full_dlc_btm"]);
    expect(r.request_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(r.provenance.digest).toBeTruthy();
    // the engine, and the one store call the route is allowed: the rate-limit counter. Nothing else is stored.
    expect(calls.every((u) => u.startsWith(ENGINE) || u.endsWith("/rest/v1/rpc/gf_rate_limit_hit"))).toBe(true);
    expect(db.rows("project_comparisons")).toHaveLength(0);
    // the request returned is exactly what the API accepts, and it reproduces the same answer
    const again = await realFetch(`${ENGINE}/v1/compare`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY }, body: JSON.stringify(body.request) });
    const direct = await again.json();
    expect(direct.request_digest).toBe(r.request_digest);
    expect(direct.scenarios).toEqual(r.scenarios);
  });

  it("gives no date to a scenario with nothing deployable, and does not rank it", async () => {
    const r = (await (await post({ hall: HALL, btm_options: [GAS], objective: "fastest" })).json()).result as CompareResult;
    const air = r.scenarios.find((s) => s.id === "retained_air")!;
    expect(air.after_ladder.racks).toBe(0);
    expect(air.time_to_power.weeks).toBeNull();
    expect(air.time_to_power.reason).toBeTruthy();
    expect(r.ranking.order).not.toContain("retained_air");
    expect(r.ranking.excluded.map((e) => e.id)).toContain("retained_air");
  });

  it("states that lead times resting on assumptions make the comparison indicative", async () => {
    const r = (await (await post({ hall: HALL, btm_options: [GAS] })).json()).result as CompareResult;
    expect(r.grade).toBe("indicative");
    expect(r.caveats.join(" ")).toMatch(/indicative/);
    expect(r.caveats.join(" ")).toMatch(/Grid reinforcement is not dated/);
  });

  it("changing an input changes the digest and the result, traceably", async () => {
    const a = (await (await post({ hall: HALL })).json()).result as CompareResult;
    const b = (await (await post({ hall: { ...HALL, contractedMW: 6 } })).json()).result as CompareResult;
    expect(b.request_digest).not.toBe(a.request_digest);
    expect(JSON.stringify(b.scenarios)).not.toBe(JSON.stringify(a.scenarios));
  });

  it("without supply options the on-site scenario is left out and the reason is stated, never silently grid-only", async () => {
    const r = (await (await post({ hall: HALL })).json()).result as CompareResult;
    expect(r.scenarios.map((s) => s.id)).not.toContain("full_dlc_btm");
    expect(r.caveats.join(" ")).toMatch(/full_dlc_btm is not compared/);
  });

  it("matches the Density Screen's rack counts for the same hall", async () => {
    const { toIntakeDocument } = await import("@/lib/engagement-intake");
    const { screenIntakeSchema } = await import("@/lib/engagement-intake");
    const doc = toIntakeDocument(screenIntakeSchema.parse(HALL));
    const screen = await (await realFetch(`${ENGINE}/v1/screen`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY }, body: JSON.stringify({ intake: doc }) })).json();
    const r = (await (await post({ hall: HALL })).json()).result as CompareResult;
    for (const s of r.scenarios) {
      const m = screen.scenarios.find((x: { id: string }) => x.id === s.id);
      expect(s.after_ladder.racks).toBe(m.after_ladder.racks);
      expect(s.as_found.racks).toBe(m.as_found.racks);
    }
  });
});

describe.runIf(hasPython)("a request that cannot be answered honestly is refused before or at the engine", () => {
  it.each([
    ["a missing required figure", { hall: { ...HALL, contractedMW: undefined } }],
    ["a battery without its energy", { hall: HALL, btm_options: [{ id: "b", kind: "bess", capacity_MW: 5, lead_time_weeks: 30 }] }],
    ["a supply option with no lead time", { hall: HALL, btm_options: [{ id: "g", kind: "gas_engine", capacity_MW: 5 }] }],
    ["solar presented as firm supply", { hall: HALL, btm_options: [{ id: "p", kind: "pv", capacity_MW: 5, lead_time_weeks: 30 }] }],
    ["the on-site scenario with no supply declared", { hall: HALL, scenarios: ["full_dlc", "full_dlc_btm"] }],
    ["a baseline outside the compared set", { hall: HALL, scenarios: ["rdhx", "full_dlc"], baseline: "hybrid_dlc" }],
    ["an unknown objective", { hall: HALL, objective: "cheapest" }],
    ["a single scenario", { hall: HALL, scenarios: ["rdhx"] }],
  ])("%s -> 422, nothing sent to the engine", async (_n, body) => {
    const res = await post(body);
    expect(res.status).toBe(422);
    expect((await res.json()).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("rejects malformed and oversized bodies without touching the engine", async () => {
    expect((await post(null, "{not json")).status).toBe(400);
    expect((await post(null, JSON.stringify({ hall: HALL, pad: "x".repeat(70_000) }))).status).toBe(413);
    expect((await post(null, JSON.stringify({ hall: HALL, pad: "é".repeat(40_000) }))).status).toBe(413);   // bytes, not characters
    expect(calls).toHaveLength(0);
  });

  it("names the failing field, with its row, in a list the page can show", async () => {
    const res = await post({ hall: HALL, btm_options: [GAS, { id: "b", kind: "bess", capacity_MW: 5, lead_time_weeks: 30 }] });
    const b = await res.json();
    expect(res.status).toBe(422);
    expect(b.problems.some((p: { path: string }) => p.path === "btm_options.1.energy_MWh")).toBe(true);
  });

  it("passes an engine refusal through when it is the person's to fix", async () => {
    stubEngine(() =>
      new Response(JSON.stringify({ error: "unknown scenario(s): x", available: ["rdhx"], schema_version: "gridforge/api/1" }), { status: 422 }));
    const res = await post({ hall: HALL });
    expect(res.status).toBe(422);
    const b = await res.json();
    expect(b.error).toMatch(/unknown scenario/);
    expect(b.detail.available).toEqual(["rdhx"]);
  });

  it("reports an unconfigured, unreachable or key-rejecting engine as a clean 502 with no internals", async () => {
    delete process.env.GRIDFORGE_API_KEY;
    let res = await post({ hall: HALL });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toMatch(/GRIDFORGE_API|127\.0\.0\.1|X-API-Key/);
    process.env.GRIDFORGE_API_KEY = KEY;
    stubEngine(() => new Response(JSON.stringify({ error: "invalid key" }), { status: 401 }));
    res = await post({ hall: HALL });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).not.toMatch(/invalid key/);
  });

  it("refuses an engine answer in a form it does not understand instead of rendering it", async () => {
    stubEngine(() => new Response(JSON.stringify({ schema: "something/else" }), { status: 200 }));
    expect((await post({ hall: HALL })).status).toBe(502);
  });
});

describe.runIf(hasPython)("what the page shows is what the engine said", () => {
  const render = async (extra: object = {}) => {
    const body = await (await post({ hall: HALL, btm_options: [GAS], objective: "fastest", ...extra })).json();
    return { body, markup: renderToStaticMarkup(React.createElement(ComparisonResults, { out: { result: body.result, request: body.request, synthetic: false }, cli: "curl", copied: false, onCopy: () => {} })) };
  };

  it("shows an explicit 'No date' with the engine's reason for a scenario it could not date", async () => {
    const { markup } = await render();
    expect(markup).toMatch(/No date\./);
    expect(markup).toMatch(/nothing to date/);
    expect(markup).toMatch(/indicative/);
  });

  it("shows each dated scenario's band and evidence class, and the digest that reproduces the run", async () => {
    const { body, markup } = await render();
    const dated = (body.result as CompareResult).scenarios.find((s) => s.time_to_power.status === "dated")!;
    expect(markup).toContain(`${dated.time_to_power.weeks!.toLocaleString()} wk`);
    expect(markup).toContain(dated.time_to_power.evidence!);
    expect(markup).toContain(body.result.request_digest.slice(0, 16));
  });

  it("labels a synthetic example as one", () => {
    const out = { result: { schema: TTP_COMPARE_SCHEMA, objective: "max_compute", baseline: "a", scenarios: [], ranking: { objective: "", metric: "", order: [], values: {}, excluded: [], leader: null, tie: false, note: "Nothing can be ranked on this objective with the inputs supplied." }, grade: "indicative", caveats: [], request_digest: "0".repeat(64), intake_completeness: 1, provenance: { digest: "d".repeat(64), engine_version: "x", code_sha256: "c", report_date: "2026-01-01" } } as unknown as CompareResult, request: {}, synthetic: true };
    const markup = renderToStaticMarkup(React.createElement(ComparisonResults, { out, cli: "", copied: false, onCopy: () => {} }));
    expect(markup).toMatch(/Synthetic example/);
    expect(markup).toMatch(/No leader\./);
  });
});

describe("the product is wired in only where it works", () => {
  it("is in the capability registry with a real endpoint, tool, CLI command and route -- and no price", () => {
    const c = CAPABILITY_REGISTRY.find((x) => x.capability_id === "ttp_compare")!;
    expect(c).toMatchObject({ rest_endpoint: "/v1/compare", mcp_tool: "gridforge_compare", cli_command: "gridforge compare", web_route: "/power/compare", stripe_product_or_price: "none", status: "free" });
  });

  it("is reachable from the footer navigation to a route that exists", async () => {
    const link = FOOTER_GROUPS.flatMap((g) => g.links).find((l) => l.href === "/power/compare");
    expect(link).toBeTruthy();
    const page = await import("@/app/power/compare/page");
    expect(typeof page.default).toBe("function");
  });

  it("the form schema maps onto the same intake document the Screen uses", () => {
    const parsed = compareRequestSchema.parse({ hall: HALL, btm_options: [GAS] });
    const body = toEngineBody(parsed) as { intake: Record<string, unknown> };
    expect(body.intake.btm_options).toHaveLength(1);
    expect((body.intake.grid as Record<string, unknown>).contracted_MW).toBe(12);
  });
});
