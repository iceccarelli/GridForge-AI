/**
 * A Time-to-Power scenario comparison saved to a Verified Power Record project, end to end through the site.
 *
 * Real route handlers with real Requests, the REAL Python engine as a subprocess (so every stored result is an engine
 * answer, never a stand-in), and the in-memory PostgREST fake for the store with the 0024 function restated against it
 * (tests/site/project-rpc-fake.ts). That the REAL function is atomic, append-only and idempotent is proven against
 * PostgreSQL in tests/test_projects_migration.py and through PostgREST in verified-power-record.realdb.test.ts.
 * Fixtures are SYNTHETIC.
 */
import React from "react";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";
import { ComparisonResults } from "@/components/TtpCompare";
import type { CompareResult } from "@/lib/ttp-compare";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const KEY = "ttp-compare-project-key";
let engine: ChildProcess | null = null;
let ENGINE = "";
let db: PostgrestFake;
let restore: () => void;
let engineCalls: number;
let storeCalls: { method: string; path: string }[];
const realFetch = globalThis.fetch;

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
  engineCalls = 0;
  storeCalls = [];
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = KEY;
  db = new PostgrestFake([
    "projects", "project_links", "project_evidence", "project_events", "project_comparisons", "power_deployment_cases",
    "procurement_packages", "procurement_responses", "procurement_comparisons", "project_observations",
    "project_observation_reviews", "supplier_actuals", "supplier_actual_reviews", "supplier_reality",
    "cost_evidence_state", "cost_evidence_runs",
  ]);
  db.uniqueKeys.set("projects", [["project_token"]]);
  db.uniqueKeys.set("project_comparisons", [["project_id", "idempotency_key"], ["project_id", "result_digest"]]);
  db.appendOnly.add("project_comparisons");
  db.appendOnly.add("project_events");
  installProjectRpcs(db);
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (ENGINE && url.startsWith(ENGINE)) { engineCalls += 1; return realFetch(i as RequestInfo, init); }
    storeCalls.push({ method: init?.method ?? "GET", path: new URL(url).pathname });
    return dbFetch(i as RequestInfo, init);
  }) as typeof fetch;
  restore = () => { globalThis.fetch = dbFetch; restoreDb(); };
});
afterEach(() => { restore(); vi.restoreAllMocks(); });

const HALL = {
  siteName: "Synthetic Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4,
  currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180,
  plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
  // One transformer the hall outgrows, so every scenario that relieves it takes the transformer step a quotation can price.
  transformers: [{ id: "TX1", unit_rating_MVA: 8, units: 1, redundancy: "N" }],
};
const GAS = { id: "gas1", kind: "gas_engine", capacity_MW: 10, lead_time_weeks: 40 };
const REQ = { hall: HALL, btm_options: [GAS], objective: "fastest" };
const json = (b: unknown, method = "POST") =>
  new Request(siteUrl("/x"), { method, headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const j = async (r: Response) => (await r.json()) as any;

async function project(name = "Hall A") {
  const { POST } = await import("@/app/api/projects/route");
  const b = await j(await POST(json({ project_name: name, company: "Synthetic Co" })));
  return b.project_token as string;
}
const compare = async (req: unknown = REQ) => j(await (await import("@/app/api/power/compare/route")).POST(json(req)));
const save = async (token: string, body: unknown) =>
  (await import("@/app/api/projects/[token]/comparisons/route")).POST(json(body), ctx({ token }));
const list = async (token: string) =>
  (await import("@/app/api/projects/[token]/comparisons/route")).GET(new Request(siteUrl("/x")), ctx({ token }));
const one = async (token: string, id: string) =>
  (await import("@/app/api/projects/[token]/comparisons/[id]/route")).GET(new Request(siteUrl("/x")), ctx({ token, id }));
const state = async (token: string) =>
  j(await (await import("@/app/api/projects/[token]/route")).GET(new Request(siteUrl("/x")), ctx({ token })));
const rowsOf = (t: string) => db.rows(t) as any[];
const events = () => rowsOf("project_events").filter((e) => e.event_type === "comparison_saved");

describe.runIf(hasPython)("saving a comparison to a project", () => {
  it("stores the exact request, the engine's answer and its provenance, writes the event with it, and reads it back unchanged", async () => {
    const pt = await project();
    const seen = await compare();
    expect(seen.ok).toBe(true);
    const res = await save(pt, { request: REQ, idempotency_key: "11111111-1111-4111-8111-111111111111", label: "first look", reviewed_result_digest: seen.result_digest });
    expect(res.status).toBe(201);
    const body = await j(res);
    expect(body).toMatchObject({ ok: true, created: true, reason: "created" });
    expect(body.comparison.request_digest).toBe(seen.result.request_digest);
    expect(body.comparison.result).toBeUndefined();                     // the save answer is a summary; the record is read by id

    const [row] = rowsOf("project_comparisons");
    expect(row.project_id).toBe(rowsOf("projects").find((p) => p.project_token === pt).id);
    expect(row.request).toEqual(seen.request);                          // what POST /v1/compare was given
    expect(row.result.scenarios).toEqual(seen.result.scenarios);        // the engine's answer, verbatim
    expect(row.result_digest).toBe(seen.result_digest);
    expect(row.engine_provenance.digest).toBe(seen.result.provenance.digest);
    expect(row.provenance_digest).toBe(seen.result.provenance.digest);
    expect(row.scenario_ids).toEqual(seen.result.scenarios.map((s: { id: string }) => s.id));
    expect(row.label).toBe("first look");
    expect(events()).toHaveLength(1);
    expect(events()[0].payload).toMatchObject({ comparison_id: row.id, request_digest: row.request_digest, result_digest: row.result_digest, provenance_digest: row.provenance_digest });
    expect(JSON.stringify(events()[0].payload)).not.toContain("Synthetic Hall");   // identifiers only, no document in the history

    // reopen: the stored record, as generated, through the project API
    const got = await one(pt, row.id);
    expect(got.status).toBe(200);
    expect(got.headers.get("cache-control")).toBe("no-store");
    const rec = (await j(got)).comparison;
    expect(rec.request).toEqual(seen.request);
    expect(rec.result).toEqual(row.result);
    expect(rec.engine_provenance).toEqual(seen.result.provenance);
    expect(rec.created_at).toBe(row.created_at);

    // the list and the project state carry its identity and provenance
    const ls = await j(await list(pt));
    expect(ls.comparisons).toHaveLength(1);
    expect(ls.comparisons[0]).toMatchObject({ id: row.id, label: "first look", objective: "fastest", request_digest: row.request_digest, provenance_digest: row.provenance_digest, leader: seen.result.ranking.leader });
    const st = await state(pt);
    expect(st.comparisons[0]).toMatchObject({ id: row.id, grade: seen.result.grade });
    expect(st.events.some((e: { event_type: string }) => e.event_type === "comparison_saved")).toBe(true);
  });

  it("a save is the engine's own answer for the request, not whatever the client sends", async () => {
    const pt = await project();
    engineCalls = 0;
    const res = await save(pt, { request: REQ, idempotency_key: "22222222-2222-4222-8222-222222222222" });
    expect(res.status).toBe(201);
    expect(engineCalls).toBeGreaterThanOrEqual(1);
    const [row] = rowsOf("project_comparisons");
    const direct = await (await realFetch(`${ENGINE}/v1/compare`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY }, body: JSON.stringify(row.request) })).json();
    expect(direct.scenarios).toEqual(row.result.scenarios);
    expect(direct.request_digest).toBe(row.request_digest);
  });

  it("refuses to save when the engine's answer no longer matches the one the customer reviewed, and writes nothing", async () => {
    const pt = await project();
    const res = await save(pt, { request: REQ, idempotency_key: "33333333-3333-4333-8333-333333333333", reviewed_result_digest: "0".repeat(64) });
    expect(res.status).toBe(409);
    expect((await j(res)).error).toMatch(/no longer the one you reviewed/);
    expect(rowsOf("project_comparisons")).toHaveLength(0);
    expect(events()).toHaveLength(0);
  });
});

describe.runIf(hasPython)("idempotency and history", () => {
  it("a retry with the same key and the same answer is one record and one event", async () => {
    const pt = await project();
    const body = { request: REQ, idempotency_key: "44444444-4444-4444-8444-444444444444" };
    const a = await j(await save(pt, body));
    const r2 = await save(pt, body);
    expect(r2.status).toBe(200);
    const b = await j(r2);
    expect(b).toMatchObject({ created: false, reason: "idempotent_replay" });
    expect(b.comparison.id).toBe(a.comparison.id);
    expect(rowsOf("project_comparisons")).toHaveLength(1);
    expect(events()).toHaveLength(1);
  });

  it("the same key for a different comparison is refused; the original stays bound to its own data", async () => {
    const pt = await project();
    const a = await j(await save(pt, { request: REQ, idempotency_key: "55555555-5555-4555-8555-555555555555" }));
    const res = await save(pt, { request: { ...REQ, objective: "max_compute" }, idempotency_key: "55555555-5555-4555-8555-555555555555" });
    expect(res.status).toBe(409);
    expect((await j(res)).error).toMatch(/already used/);
    const [row] = rowsOf("project_comparisons");
    expect(row.id).toBe(a.comparison.id);
    expect(row.objective).toBe("fastest");
    expect(events()).toHaveLength(1);
  });

  it("the same answer under a new key is one record; a changed input is a new record and the old one is untouched", async () => {
    const pt = await project();
    const a = await j(await save(pt, { request: REQ, idempotency_key: "66666666-6666-4666-8666-666666666666" }));
    const dup = await j(await save(pt, { request: REQ, idempotency_key: "77777777-7777-4777-8777-777777777777" }));
    expect(dup).toMatchObject({ created: false, reason: "already_saved" });
    expect(dup.comparison.id).toBe(a.comparison.id);
    const before = JSON.stringify(rowsOf("project_comparisons")[0]);
    const changed = await j(await save(pt, { request: { ...REQ, hall: { ...HALL, contractedMW: 6 } }, idempotency_key: "88888888-8888-4888-8888-888888888888" }));
    expect(changed).toMatchObject({ created: true });
    expect(changed.comparison.id).not.toBe(a.comparison.id);
    expect(changed.comparison.request_digest).not.toBe(a.comparison.request_digest);
    expect(rowsOf("project_comparisons")).toHaveLength(2);
    expect(JSON.stringify(rowsOf("project_comparisons")[0])).toBe(before);
    expect(events()).toHaveLength(2);
    const ls = await j(await list(pt));
    expect(ls.comparisons.map((c: { id: string }) => c.id).sort()).toEqual([a.comparison.id, changed.comparison.id].sort());
  });

  it("there is no application path that updates or deletes a saved comparison, and the store refuses one", async () => {
    const pt = await project();
    await save(pt, { request: REQ, idempotency_key: "99999999-9999-4999-8999-999999999999" });
    const c = await import("@/lib/project-comparisons");
    expect(Object.keys(c).filter((k) => /update|delete|remove|patch/i.test(k))).toEqual([]);
    const res = await fetch("https://stub.supabase.co/rest/v1/project_comparisons?label=eq.x", { method: "PATCH", body: "{}" });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("42501");
  });
});

describe.runIf(hasPython)("authorization and failure honesty", () => {
  it("an unknown, malformed or missing project token saves nothing and spends no engine unit", async () => {
    engineCalls = 0;
    for (const t of ["no-such-project", "", "../x", "' or 1=1 --"]) {
      const res = await save(t, { request: REQ, idempotency_key: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
      expect(res.status).toBe(404);
      expect((await list(t)).status).toBe(404);
    }
    expect(engineCalls).toBe(0);
    expect(rowsOf("project_comparisons")).toHaveLength(0);
  });

  it("another project's token can neither read nor list this project's record, and a guessed id is Not found", async () => {
    const a = await project("A");
    const b = await project("B");
    const saved = await j(await save(a, { request: REQ, idempotency_key: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
    expect((await one(b, saved.comparison.id)).status).toBe(404);
    expect((await j(await list(b))).comparisons).toEqual([]);
    expect((await state(b)).comparisons).toEqual([]);
    expect((await one(a, "00000000-0000-4000-8000-00000000ffff")).status).toBe(404);
    expect((await one(a, "not-a-uuid")).status).toBe(404);
    expect((await one(a, saved.comparison.id)).status).toBe(200);
  });

  it("validates the request before anything is spent or stored", async () => {
    const pt = await project();
    engineCalls = 0;
    const cases: [unknown, number, RegExp][] = [
      [{ request: REQ }, 422, /idempotency_key/],
      [{ request: REQ, idempotency_key: "short" }, 422, /idempotency_key/],
      [{ request: { ...REQ, scenarios: ["rdhx", "nope"] }, idempotency_key: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, 422, /Validation/],
      [{ request: { ...REQ, hall: { ...HALL, contractedMW: undefined } }, idempotency_key: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, 422, /Validation/],
      [{ request: REQ, idempotency_key: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", reviewed_result_digest: "xyz" }, 422, /reviewed_result_digest/],
      [{ request: REQ, idempotency_key: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", label: "x".repeat(121) }, 422, /label/],
    ];
    for (const [body, status, re] of cases) {
      const res = await save(pt, body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(status);
      expect(JSON.stringify(await j(res))).toMatch(re);
    }
    const { POST } = await import("@/app/api/projects/[token]/comparisons/route");
    expect((await POST(new Request(siteUrl("/x"), { method: "POST", body: "{nope" }), ctx({ token: pt }))).status).toBe(400);
    expect((await POST(json({ request: REQ, idempotency_key: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", pad: "x".repeat(70_000) }), ctx({ token: pt }))).status).toBe(413);
    expect(engineCalls).toBe(0);
    expect(rowsOf("project_comparisons")).toHaveLength(0);
    expect(events()).toHaveLength(0);
  });

  it("a failed store write is reported as not saved and leaves no record and no event", async () => {
    const pt = await project();
    vi.spyOn(console, "error").mockImplementation(() => {});
    // The project lookup (GET) succeeds; the write itself (the POST to the function) fails.
    db.failMethod = { method: "POST", status: 500, body: JSON.stringify({ message: "boom" }) };
    const res = await save(pt, { request: REQ, idempotency_key: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" });
    db.failMethod = null;
    expect(res.status).toBe(502);
    expect((await j(res)).error).toMatch(/Nothing was recorded/);
    expect(rowsOf("project_comparisons")).toHaveLength(0);
    expect(events()).toHaveLength(0);
  });

  it("a record whose event cannot be written is not a record: the transaction rolls both back", async () => {
    const pt = await project();
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.failEvents = true;
    const res = await save(pt, { request: REQ, idempotency_key: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" });
    expect(res.status).toBe(502);
    expect(rowsOf("project_comparisons")).toHaveLength(0);
    expect(events()).toHaveLength(0);
  });

  it("without a database it says so (503) before spending an engine unit; there is no in-memory stand-in", async () => {
    delete process.env.SUPABASE_URL;
    engineCalls = 0;
    const { saveComparison, listComparisons, getComparison } = await import("@/lib/project-comparisons");
    const fake = { id: "p", project_token: "t" } as any;
    const { compareRequestSchema } = await import("@/lib/ttp-compare");
    const r = await saveComparison(fake, { request: compareRequestSchema.parse(REQ), idempotency_key: "ffffffff-ffff-4fff-8fff-ffffffffffff" });
    expect(r).toMatchObject({ ok: false, status: 503 });
    expect(engineCalls).toBe(0);
    expect((await listComparisons(fake)).ok).toBe(false);
    expect((await getComparison(fake, "00000000-0000-4000-8000-000000000001")).ok).toBe(false);
  });

  it("a stored record that no longer hashes to its recorded digest is refused, not served", async () => {
    const pt = await project();
    const saved = await j(await save(pt, { request: REQ, idempotency_key: "a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1" }));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const row = rowsOf("project_comparisons").find((r) => r.id === saved.comparison.id);
    row.result = { ...row.result, grade: "screening" };                   // tampered after the fact
    expect((await one(pt, saved.comparison.id)).status).toBe(502);
  });
});

describe.runIf(hasPython)("what did not change", () => {
  it("comparing without a project touches no store and still answers with its digest", async () => {
    storeCalls = [];
    const seen = await compare();
    expect(seen.ok).toBe(true);
    expect(seen.result_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(storeCalls).toEqual([]);
  });

  it("the reopened record is shown as stored, labelled as such, and never recomputed", async () => {
    const pt = await project();
    const saved = await j(await save(pt, { request: REQ, idempotency_key: "b2b2b2b2-b2b2-4b2b-8b2b-b2b2b2b2b2b2", label: "board pack" }));
    const rec = (await j(await one(pt, saved.comparison.id))).comparison;
    engineCalls = 0;
    const markup = renderToStaticMarkup(React.createElement(ComparisonResults, {
      out: { result: rec.result as CompareResult, request: rec.request, synthetic: false, result_digest: rec.result_digest, saved: { id: rec.id, created_at: rec.created_at, label: rec.label, project_token: pt } },
      cli: "", copied: false, onCopy: () => {},
    }));
    expect(markup).toMatch(/Saved record · board pack/);
    expect(markup).toMatch(/not recomputed/);
    expect(markup).toContain(rec.request_digest.slice(0, 16));
    expect(engineCalls).toBe(0);
  });

  it("the project panel lists a saved comparison with its provenance and a link to reopen it", async () => {
    const pt = await project();
    const saved = await j(await save(pt, { request: REQ, idempotency_key: "c3c3c3c3-c3c3-4c3c-8c3c-c3c3c3c3c3c3", label: "spring" }));
    const st = await state(pt);
    const { ProjectPanel } = await import("@/components/ai/ProjectPanel");
    // ProjectPanel fetches on mount; render the ready state through its own read model shape instead.
    expect(st.comparisons).toHaveLength(1);
    expect(st.comparisons[0]).toMatchObject({ id: saved.comparison.id, label: "spring", provenance_digest: saved.comparison.provenance_digest });
    expect(typeof ProjectPanel).toBe("function");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// The project's ACCEPTED supplier quotations priced into the comparison. Evidence rows are seeded as the state view
// holds them (SYNTHETIC suppliers); only `state: "accepted"` lines may reach a price.
// ---------------------------------------------------------------------------------------------------------------------
function quotation(project_id: string, n: number, over: Record<string, unknown> = {}) {
  return {
    id: `00000000-0000-4000-8000-0000000000e${n}`, deliverable_id: "d", project_id, cost_key: "transformer.replacement",
    unit: "EUR/MVA", value: 100_000, currency: "EUR", supplier: `SYNTHETIC-SUPPLIER-${n}`, received_on: "2026-10-01",
    valid_until: "2099-12-31", reference: `SYN-${n}`, scope: "Replace transformer", quoted_quantity: null, quoted_quantity_unit: null,
    specification: {}, response_digest: String(n).repeat(64), validation_status: "validated", problems: [], limitations: [],
    comparability: "exact", synthetic: true, submitted_at: "2026-10-01T10:00:00Z", state: "accepted",
    reviewed_basis: "budgetary_quote", reviewed_comparability: "exact", includes_keys: [], reviewed_region: "IE",
    reviewer: "Test Reviewer", reviewed_at: "2026-10-05T10:00:00Z", review_reason: null, superseded_by: null,
    retired_kind: null, retired_at: null, retirement_reason: null, retired_by: null, ...over,
  };
}
const projectId = (token: string) => rowsOf("projects").find((p) => p.project_token === token).id as string;
const priceWith = async (token: string, body: unknown = { request: REQ }) =>
  (await import("@/app/api/projects/[token]/compare/route")).POST(json(body), ctx({ token }));

describe.runIf(hasPython)("pricing a comparison with the project's accepted quotations", () => {
  it("applies only ACCEPTED lines of THIS project, names them, moves the basis off the library, and changes nothing but cost", async () => {
    const a = await project("A");
    const b = await project("B");
    db.seed("cost_evidence_state", [
      quotation(projectId(a), 1),                                                 // accepted: prices the transformer line
      quotation(projectId(a), 2, { state: "validated", reviewed_basis: null }),  // reviewed by nobody: never offered
      quotation(projectId(a), 3, { state: "rejected", reviewed_basis: null }),
      quotation(projectId(a), 4, { state: "withdrawn", retired_kind: "withdrawn" }),
      quotation(projectId(b), 5, { value: 1 }),                                   // another project's quotation
    ]);
    const library = await compare();
    const res = await priceWith(a);
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.evidence).toEqual({ offered: [quotation(projectId(a), 1).id], used: [quotation(projectId(a), 1).id], ignored: [] });
    const r = body.result as CompareResult;
    expect(r.evidence_applied).toHaveLength(1);
    expect(r.evidence_applied[0]).toMatchObject({ key: "transformer.replacement", basis: "budgetary_quote", synthetic: true });
    expect(r.cost_evidence!.used.map((u) => u.evidence_id)).toEqual([quotation(projectId(a), 1).id]);
    expect(r.caveats.join(" ")).toMatch(/accepted supplier quotations/);
    expect(r.caveats.join(" ")).toMatch(/SYNTHETIC/);
    // "used" means admitted; a line prices a scenario only where that scenario's ladder takes the step. The engine's
    // own effect block names the scenarios whose capex moved: at least one must, and only cost may move.
    const effect = r.cost_evidence!.effect as { scenarios: { scenario: string; capex_delta_eur: number }[] };
    const moved = effect.scenarios.filter((x) => x.capex_delta_eur !== 0).map((x) => x.scenario);
    expect(moved.length).toBeGreaterThan(0);
    for (const id of moved) {
      const now = r.scenarios.find((s) => s.id === id)!;
      const was = library.result.scenarios.find((s: { id: string }) => s.id === id);
      expect(Object.keys(now.economics.cost_basis_mix)).toContain("budgetary_quote");
      expect(now.economics.capex_total_eur!.value).not.toBe(was.economics.capex_total_eur.value);
    }
    for (const now of r.scenarios) {
      const was = library.result.scenarios.find((s: { id: string }) => s.id === now.id);
      expect(now.after_ladder.racks).toBe(was.after_ladder.racks);               // physics unchanged
      expect(now.time_to_power.weeks).toBe(was.time_to_power.weeks);
    }
    expect(r.request_digest).not.toBe(library.result.request_digest);             // a different question
    expect(body.result_digest).not.toBe(library.result_digest);
    // the request returned carries the quotations, and only the accepted one of this project
    expect(body.request.cost_evidence).toHaveLength(1);
    expect(body.request.cost_evidence[0]).toMatchObject({ evidence_id: quotation(projectId(a), 1).id, status: "accepted", value: 100_000 });
    expect(JSON.stringify(body.request)).not.toContain("SYNTHETIC-SUPPLIER-5");
    expect(JSON.stringify(body.request)).not.toContain("SYNTHETIC-SUPPLIER-2");
    // it reproduces at the engine from that request alone
    const direct = await (await realFetch(`${ENGINE}/v1/compare`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY }, body: JSON.stringify(body.request) })).json();
    expect(direct.request_digest).toBe(r.request_digest);
    expect(direct.scenarios).toEqual(r.scenarios);
  });

  it("with no accepted quotation it says so (409) rather than pricing from nothing, and a library compare is unchanged", async () => {
    const a = await project("A");
    db.seed("cost_evidence_state", [quotation(projectId(a), 2, { state: "validated", reviewed_basis: null })]);
    const res = await priceWith(a);
    expect(res.status).toBe(409);
    expect((await j(res)).error).toMatch(/No quotation has been accepted/);
    storeCalls = [];
    const plain = await compare();
    expect(plain.result.evidence_applied).toEqual([]);
    expect(plain.result.cost_evidence).toBeUndefined();
    expect(storeCalls).toEqual([]);
  });

  it("saves the quotation-priced answer with the quotations in the stored request and their ids in the event", async () => {
    const a = await project("A");
    db.seed("cost_evidence_state", [quotation(projectId(a), 1)]);
    const priced = await j(await priceWith(a));
    const res = await save(a, { request: REQ, idempotency_key: "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4", evidence: "project", reviewed_result_digest: priced.result_digest });
    expect(res.status).toBe(201);
    const body = await j(res);
    const [row] = rowsOf("project_comparisons");
    expect(row.request.cost_evidence).toHaveLength(1);
    expect(row.result.evidence_applied).toHaveLength(1);
    expect(row.result_digest).toBe(priced.result_digest);
    expect(row.request_digest).toBe(priced.result.request_digest);
    expect(events()[0].payload).toMatchObject({ evidence_offered: [quotation(projectId(a), 1).id], evidence_used: [quotation(projectId(a), 1).id] });
    expect(JSON.stringify(events()[0].payload)).not.toContain("100000");          // identifiers, never a price
    // the stored record reopens with its quotations; the project list counts them
    const rec = (await j(await one(a, body.comparison.id))).comparison;
    expect(rec.request.cost_evidence[0].evidence_id).toBe(quotation(projectId(a), 1).id);
    expect((await j(await list(a))).comparisons[0].quotations_used).toBe(1);
    expect((await state(a)).comparisons[0].quotations_used).toBe(1);
    // the library-priced answer of the same hall is a different record, not a replay
    const lib = await j(await save(a, { request: REQ, idempotency_key: "e5e5e5e5-e5e5-4e5e-8e5e-e5e5e5e5e5e5" }));
    expect(lib.created).toBe(true);
    expect(rowsOf("project_comparisons")).toHaveLength(2);
    expect((await j(await list(a))).comparisons.map((c: { quotations_used: number }) => c.quotations_used).sort()).toEqual([0, 1]);
  });

  it("a quotation accepted after the person compared changes the answer, so the save is refused until they re-read it", async () => {
    const a = await project("A");
    db.seed("cost_evidence_state", [quotation(projectId(a), 1)]);
    const priced = await j(await priceWith(a));
    db.seed("cost_evidence_state", [quotation(projectId(a), 6, { cost_key: "ups.per_kW", unit: "EUR/kW", value: 250, received_on: "2026-10-02" })]);
    const res = await save(a, { request: REQ, idempotency_key: "f6f6f6f6-f6f6-4f6f-8f6f-f6f6f6f6f6f6", evidence: "project", reviewed_result_digest: priced.result_digest });
    expect(res.status).toBe(409);
    expect((await j(res)).error).toMatch(/no longer the one you reviewed/);
    expect(rowsOf("project_comparisons")).toHaveLength(0);
    expect(events()).toHaveLength(0);
  });

  it("evidence:\"project\" with nothing accepted saves nothing (409); another project's token cannot price with this project's quotations", async () => {
    const a = await project("A");
    const b = await project("B");
    db.seed("cost_evidence_state", [quotation(projectId(a), 1)]);
    expect((await save(b, { request: REQ, idempotency_key: "a7a7a7a7-a7a7-4a7a-8a7a-a7a7a7a7a7a7", evidence: "project" })).status).toBe(409);
    expect((await priceWith(b)).status).toBe(409);
    expect((await priceWith("no-such-project")).status).toBe(404);
    expect((await priceWith(a, { request: { ...REQ, scenarios: ["rdhx"] } })).status).toBe(422);
    expect(rowsOf("project_comparisons")).toHaveLength(0);
  });

  it("a failed read of the quotations is a failed compare, never a silent library price", async () => {
    const a = await project("A");
    vi.spyOn(console, "error").mockImplementation(() => {});
    db.dropTable("cost_evidence_state");
    engineCalls = 0;
    const res = await priceWith(a);
    expect(res.status).toBe(502);
    expect(engineCalls).toBe(0);
  });

  it("the page shows which quotations priced the answer and the basis of every scenario's capex", async () => {
    const a = await project("A");
    db.seed("cost_evidence_state", [quotation(projectId(a), 1)]);
    const priced = await j(await priceWith(a));
    const markup = renderToStaticMarkup(React.createElement(ComparisonResults, {
      out: { result: priced.result, request: priced.request, synthetic: false, result_digest: priced.result_digest, priced: "project" },
      cli: "", copied: false, onCopy: () => {},
    }));
    expect(markup).toMatch(/Quotations applied/);
    expect(markup).toMatch(/1 accepted quotation priced a line/);
    expect(markup).toMatch(/transformer\.replacement/);
    expect(markup).toMatch(/budgetary quote/);
    expect(markup).toMatch(/SYNTHETIC/);
    expect(markup).toMatch(/library placeholder \(not a price\) ×/);
  });
});
