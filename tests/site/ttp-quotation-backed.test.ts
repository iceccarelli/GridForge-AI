/**
 * A Time-to-Power comparison priced on a project's accepted supplier quotations, saved, and shown on the read-only buyer
 * page -- through the real route handlers and the REAL Python engine (spawned, not stubbed), against the in-memory
 * PostgREST whose rpc functions mirror migrations 0025/0026. That the SQL itself refuses evidence that is not accepted
 * evidence of the project, and cannot be rewritten, is proven against PostgreSQL in ttp-quotation-backed.realdb.test.ts.
 *
 * Every supplier, price and date here is a SYNTHETIC fixture (suppliers are named SYNTHETIC-SUPPLIER-x). The rows are
 * flagged synthetic:false only because the product refuses synthetic lines; none is a real quotation. The assertions are
 * about rules: what may reach the engine, what the saved record says, and what a buyer may see.
 */
import crypto from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { getBuyerView } from "@/lib/buyer-view";
import { backingLines, buyerQuotations } from "@/lib/comparison-evidence";
import { eligibleQuotations } from "@/lib/project-quotations";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const KEY = "quotation-backed-key";
let engine: ChildProcess | null = null;
let ENGINE = "";
const realFetch = globalThis.fetch;
let engineBodies: Record<string, any>[];
let afterEngine: (() => void) | null;
let rewriteAnswer: ((body: any) => any) | null;
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

const TABLES = [
  "projects", "project_links", "project_events", "project_evidence", "procurement_packages", "procurement_responses",
  "procurement_comparisons", "project_observations", "project_observation_reviews", "supplier_actuals", "supplier_actual_reviews",
  "supplier_reality", "cost_evidence_state", "cost_evidence_runs", "deliverables", "watches", "watch_notes", "leads",
  "engagement_deposits", "project_comparisons", "project_shares", "rate_limit_windows",
];

beforeEach(() => {
  resetMemoryLimiter();
  engineBodies = [];
  afterEngine = null;
  rewriteAnswer = null;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = KEY;
  db = new PostgrestFake(TABLES);
  db.appendOnly.add("project_comparisons");
  installProjectRpcs(db);
  restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (ENGINE && url.startsWith(ENGINE)) {
      engineBodies.push(JSON.parse(String(init?.body ?? "{}")));
      const res = await realFetch(i as RequestInfo, init);
      afterEngine?.();
      if (!rewriteAnswer) return res;
      return new Response(JSON.stringify(rewriteAnswer(await res.json())), { status: res.status, headers: { "content-type": "application/json" } });
    }
    return dbFetch(i, init);
  }) as typeof fetch;
});
afterEach(() => { restoreDb(); globalThis.fetch = realFetch; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const HALL = {
  siteName: "Synthetic Hall", hallId: "H1", metro: "Dublin", dso: "Private DSO Name", queueNote: "confidential queue note",
  firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63,
  floorLoadingKPa: 12, positionsAvailable: 180, plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};
const post = (path: string, body: unknown, ip = "203.0.113.5") =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });
const saveRoute = () => import("@/app/api/power/compare/save/route");
const save = async (body: Record<string, unknown>, ip?: string) => (await saveRoute()).POST(post("/api/power/compare/save", { compare: { hall: HALL, objective: "fastest" }, ...body }, ip));
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const j = async (r: Response) => (await r.json()) as any;

async function newProject(name = "North Hall expansion") {
  const body = await j(await save({ project: { project_name: name } }));
  const token = body.project_token as string;
  const row = db.rows("projects").find((p) => p.project_token === token)!;
  return { token, id: row.id as string };
}
async function issue(token: string): Promise<string> {
  const r = await (await import("@/app/api/projects/[token]/share/route")).POST(new Request(siteUrl("/x"), { method: "POST" }), ctx(token));
  expect(r.status).toBe(201);
  return ((await r.json()).share_path as string).replace("/p/", "");
}
async function page(shareToken: string) {
  const mod = await import("@/app/p/[shareToken]/page");
  return renderToStaticMarkup(await mod.default({ params: Promise.resolve({ shareToken }) }));
}

/** One accepted quotation line for an engagement linked to the project, as cost_evidence_state holds it. */
function quotation(projectId: string | null, over: Record<string, unknown> = {}) {
  const deliverable_id = (over.deliverable_id as string) ?? crypto.randomUUID();
  if (projectId && over.link !== false) db.insertRow("project_links", { project_id: projectId, object_type: "deliverable", object_id: deliverable_id });
  const { link: _l, ...rest } = over;
  return db.insertRow("cost_evidence_state", {
    deliverable_id, project_id: projectId, cost_key: "cdu.addition", unit: "EUR", value: 317450, currency: "EUR",
    supplier: "SYNTHETIC-SUPPLIER-A", received_on: "2026-10-01", valid_until: "2099-12-31", reference: "SYN-A-REF",
    scope: "supply, install, commission (confidential scope wording)", quoted_quantity: null, quoted_quantity_unit: null, specification: {},
    response_digest: "a".repeat(64), validation_status: "validated", problems: [], limitations: [], comparability: "exact",
    synthetic: false, submitted_at: "2026-10-01T10:00:00Z", state: "accepted", reviewed_basis: "firm_quote",
    reviewed_comparability: "exact", includes_keys: [], reviewed_region: null, reviewer: "Confidential Reviewer",
    reviewed_at: "2026-10-02T09:00:00Z", review_reason: null, superseded_by: null, retired_kind: null, retired_at: null, ...rest,
  }) as Record<string, any>;
}
const saved = () => db.rows("project_comparisons");
const SECRETS = ["SYNTHETIC-SUPPLIER", "Confidential Reviewer", "SYN-A-REF", "confidential scope wording", "317450", "317,450", "a".repeat(64)];

describe.runIf(hasPython)("a comparison priced on accepted quotations", () => {
  it("applies an accepted quotation, stores the engine's answer and the lines it rests on, and nothing from the browser", async () => {
    const { token, id } = await newProject();
    const plain = saved()[0];
    const q = quotation(id);
    const before = engineBodies.length;
    const res = await save({ project: { project_token: token }, use_accepted_quotations: true });
    expect(res.status).toBe(201);
    const body = await j(res);
    expect(body).toMatchObject({ ok: true, created: true, quotations: { offered: 1, applied: 1 } });

    // The engine was handed the server's own reading of the line, with its lifecycle and review provenance.
    const sent = engineBodies[before];
    expect(sent.cost_evidence).toHaveLength(1);
    expect(sent.cost_evidence[0]).toMatchObject({ key: "cdu.addition", value: 317450, currency: "EUR", basis: "firm_quote", status: "accepted", evidence_id: q.id, reviewer: "Confidential Reviewer", synthetic: false });

    const row = saved().find((c) => c.id === body.comparison_id)!;
    expect(row.evidence_ids).toEqual([q.id]);
    expect(row.request).toEqual(sent);                                  // re-asking the engine with the stored request reproduces it
    expect(row.request_digest).not.toBe(plain.request_digest);          // a different question from the library-priced one
    const result = row.result as any;
    expect(result.cost_evidence.used.map((u: any) => u.evidence_id)).toEqual([q.id]);
    const again = await j(await realFetch(`${ENGINE}/v1/compare`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY }, body: JSON.stringify(row.request) }));
    expect(again.request_digest).toBe(result.request_digest);

    // The quote repriced the cdu step in every scenario that buys a CDU, and nothing else.
    const plainFull = (plain.result as any).scenarios.find((s: any) => s.id === "full_dlc");
    const full = result.scenarios.find((s: any) => s.id === "full_dlc");
    expect(full.economics.cost_basis_mix.firm_quote.lines).toBe(1);
    expect(plainFull.economics.cost_basis_mix.firm_quote).toBeUndefined();
    expect(full.after_ladder.racks).toBe(plainFull.after_ladder.racks);
    expect(full.time_to_power.weeks).toBe(plainFull.time_to_power.weeks);
    expect(full.economics.capex_total_eur.value).not.toBe(plainFull.economics.capex_total_eur.value);

    const ev = db.rows("project_events").filter((e) => e.event_type === "comparison_saved").at(-1)!;
    expect(ev.payload).toMatchObject({ comparison_id: row.id, quotation_lines: 1 });
  });

  it("shows the project's owner which saved comparisons rest on quotations, and nothing confidential", async () => {
    const { token, id } = await newProject();
    quotation(id);
    await save({ project: { project_token: token }, use_accepted_quotations: true });
    const { GET } = await import("@/app/api/projects/[token]/route");
    const state = await (await GET(new Request(siteUrl("/x")), ctx(token))).json();
    expect(state.comparisons.items.map((x: any) => x.quotation_lines).sort()).toEqual([0, 1]);
    for (const s of SECRETS) expect(JSON.stringify(state.comparisons), s).not.toContain(s);
  });

  it("is idempotent for the same evidence and a new record when the evidence changes", async () => {
    const { token, id } = await newProject();
    const q = quotation(id);
    const a = await j(await save({ project: { project_token: token }, use_accepted_quotations: true }));
    const b = await j(await save({ project: { project_token: token }, use_accepted_quotations: true }));
    expect([a.created, b.created]).toEqual([true, false]);
    expect(b.comparison_id).toBe(a.comparison_id);
    expect(saved()).toHaveLength(2);                                    // the library-priced one and this one
    // A better quotation for the same item replaces the first: a new comparison, and the old one is untouched.
    q.state = "superseded";
    const q2 = quotation(id, { value: 250000, received_on: "2026-10-05" });
    const snapshot = JSON.stringify(saved().find((c) => c.id === a.comparison_id));
    const c = await j(await save({ project: { project_token: token }, use_accepted_quotations: true }));
    expect(c.created).toBe(true);
    expect(saved()).toHaveLength(3);
    expect(saved().find((r) => r.id === c.comparison_id)!.evidence_ids).toEqual([q2.id]);
    expect(JSON.stringify(saved().find((r) => r.id === a.comparison_id))).toBe(snapshot);
  });
});

describe.runIf(hasPython)("only accepted evidence of this project reaches the engine", () => {
  it.each([
    ["received (never reviewed)", { state: "validated" }],
    ["rejected", { state: "rejected" }],
    ["superseded", { state: "superseded", retired_kind: "superseded" }],
    ["withdrawn", { state: "withdrawn", retired_kind: "withdrawn" }],
    ["a synthetic fixture", { synthetic: true }],
    ["quoted in another currency", { currency: "USD" }],
    ["without a usable price", { value: null }],
  ])("a quotation that is %s is never offered, and nothing is saved or spent", async (_label, over) => {
    const { token, id } = await newProject();
    quotation(id, over);
    const calls = engineBodies.length;
    const before = saved().length;
    const res = await save({ project: { project_token: token }, use_accepted_quotations: true });
    // 'state' is the view's own filter for accepted; synthetic/currency/price are the server's.
    expect(res.status).toBe(409);
    expect((await j(res)).error).toMatch(/no accepted supplier quotation/);
    expect(engineBodies.length).toBe(calls);                            // the engine was not called
    expect(saved()).toHaveLength(before);
    expect(db.rows("rate_limit_windows").filter((r) => r.bucket === "ttp_compare_save")).toHaveLength(1); // only the first, plain save used allowance
  });

  it("does not take evidence from another project, or from an engagement that is not linked to this one", async () => {
    const mine = await newProject("Mine");
    const other = await newProject("Someone else's");
    quotation(other.id);                                                // accepted, but stamped with the other project
    quotation(mine.id, { link: false });                                // stamped with mine, but no engagement link to it
    quotation(null);                                                    // accepted for an engagement attached to no project
    const res = await save({ project: { project_token: mine.token }, use_accepted_quotations: true });
    expect(res.status).toBe(409);
    expect(engineBodies.filter((b) => b.cost_evidence)).toHaveLength(0);
    // ... and the other project's own request still works, proving the row was valid, only not mine.
    const theirs = await save({ project: { project_token: other.token }, use_accepted_quotations: true });
    expect(theirs.status).toBe(201);
    expect(saved().filter((c) => c.project_id === mine.id)).toHaveLength(1);   // just its library-priced one
  });

  it("offers a mix only its eligible lines", async () => {
    const { token, id } = await newProject();
    const good = quotation(id);
    quotation(id, { cost_key: "busway.replacement", state: "rejected" });
    quotation(id, { cost_key: "plant.uprate", synthetic: true });
    const res = await save({ project: { project_token: token }, use_accepted_quotations: true });
    expect(res.status).toBe(201);
    expect(engineBodies.at(-1)!.cost_evidence.map((e: any) => e.evidence_id)).toEqual([good.id]);
  });

  it("lets the browser name nothing: no evidence, ids, amounts or acceptance flags in the request", async () => {
    const { token, id } = await newProject();
    const q = quotation(id, { state: "validated" });
    const attempts: Record<string, unknown>[] = [
      { project: { project_token: token }, cost_evidence: [{ key: "cdu.addition", value: 1, status: "accepted" }] },
      { project: { project_token: token }, evidence_ids: [q.id] },
      { project: { project_token: token }, use_accepted_quotations: "yes" },
      { project: { project_token: token, quotations: [q.id] } },
      { project: { project_name: "brand new" }, use_accepted_quotations: true },
    ];
    for (const a of attempts) expect((await save(a)).status).toBe(422);
    // Nor through the compare request itself, which is where the schema would otherwise let an extra key through.
    const sneak = await save({ project: { project_token: token }, compare: { hall: HALL, cost_evidence: [{ key: "cdu.addition", value: 1 }] } });
    expect(sneak.status).toBe(201);
    expect(engineBodies.at(-1)!.cost_evidence).toBeUndefined();
    const free = await (await import("@/app/api/power/compare/route")).POST(post("/api/power/compare", { hall: HALL, cost_evidence: [{ key: "cdu.addition", value: 1, status: "accepted" }] }));
    expect(free.status).toBe(200);
    expect(engineBodies.at(-1)!.cost_evidence).toBeUndefined();
  });

  it("an unknown token is a 404 before anything about quotations is read", async () => {
    const res = await save({ project: { project_token: "nope" }, use_accepted_quotations: true });
    expect(res.status).toBe(404);
    expect(engineBodies).toHaveLength(0);
  });

  it("eligibility rules, as pure data", () => {
    const base: any = { id: "a", state: "accepted", synthetic: false, currency: "EUR", value: 5, cost_key: "cdu.addition", unit: "EUR", reviewed_basis: "firm_quote", reviewed_comparability: "exact", reviewer: "R", reviewed_at: "2026-10-02T00:00:00Z", supplier: "S", scope: "s", includes_keys: [], quoted_quantity: null, quoted_quantity_unit: null, response_digest: "d", received_on: "2026-10-01", valid_until: null, reviewed_region: null, project_id: "p", comparability: "exact" };
    const set = eligibleQuotations([base, { ...base }, { ...base, id: "b", currency: "GBP" }, { ...base, id: "c", synthetic: true }, { ...base, id: "d", value: 0 }, { ...base, id: "e", state: "withdrawn" }]);
    expect(set.ids).toEqual(["a"]);                                   // the same row twice is one line
    expect(set.excluded.map((x) => x.id).sort()).toEqual(["b", "c", "d", "e"]);
    expect(set.excluded.find((x) => x.id === "b")!.reason).toMatch(/GBP.*converts nothing/);
  });
});

describe.runIf(hasPython)("quotations that do not make a defensible quotation-backed comparison", () => {
  it("refuses an item this hall never buys: it is not saved under a claim its numbers do not support", async () => {
    const { token, id } = await newProject();
    quotation(id, { cost_key: "generator.diesel_set" });
    const before = saved().length;
    const res = await save({ project: { project_token: token }, use_accepted_quotations: true });
    expect(res.status).toBe(409);
    expect((await j(res)).error).toMatch(/prices anything this hall's scenarios buy/);
    expect(saved()).toHaveLength(before);
  });

  it("refuses when the only accepted quotation has expired, and returns the engine's reason", async () => {
    const { token, id } = await newProject();
    quotation(id, { valid_until: "2026-01-31" });
    const res = await save({ project: { project_token: token }, use_accepted_quotations: true });
    expect(res.status).toBe(409);
    const body = await j(res);
    expect(body.error).toMatch(/None of the project's accepted quotations could be applied/);
    expect(body.ignored[0]).toMatch(/expired on 2026-01-31/);
    expect(saved().filter((c) => (c.evidence_ids as string[]).length)).toHaveLength(0);
  });

  it("applies one of two accepted quotations for the same item and reports the other as not applied, never summing them", async () => {
    const { token, id } = await newProject();
    const older = quotation(id, { value: 417450, received_on: "2026-09-01" });
    const newer = quotation(id, { value: 317450, received_on: "2026-10-01" });
    const res = await save({ project: { project_token: token }, use_accepted_quotations: true });
    expect(res.status).toBe(201);
    const row = saved().find((c) => (c.evidence_ids as string[]).length)!;
    expect(row.evidence_ids).toEqual([newer.id]);
    const ev = (row.result as any).cost_evidence;
    expect(ev.ignored).toEqual([expect.objectContaining({ evidence_id: older.id, reason: expect.stringMatching(/superseded within this request/) })]);
    // The same hall on the newer quotation alone, in another project, is the same price: no double count.
    const solo = await newProject("Solo");
    quotation(solo.id, { value: 317450, received_on: "2026-10-01" });
    await save({ project: { project_token: solo.token }, use_accepted_quotations: true });
    const soloRow = saved().find((c) => c.project_id === solo.id && (c.evidence_ids as string[]).length)!;
    const totals = (r: any) => (r.result as any).scenarios.map((s: any) => s.economics.capex_total_eur?.value);
    expect(totals(row)).toEqual(totals(soloRow));
    // The buyer page lists one quotation and says the other was offered but not applied.
    const html = await page(await issue(token));
    expect(html).toContain("1 accepted quotation");
    expect(html).not.toContain("Quotation 2");
    expect(html).toMatch(/offered but not applied: .*superseded within this request/);
  });

  it("never states a complete project price: unpriced components stay named and uncompared", async () => {
    const { token, id } = await newProject();
    quotation(id);
    expect((await save({ project: { project_token: token }, use_accepted_quotations: true })).status).toBe(201);
    const html = await page(await issue(token));
    expect(html).toMatch(/Incomplete — a lower bound, not a price, and not comparable on cost/);
    expect(html).toMatch(/No scenario has a complete capital figure, so none is ranked on cost|Complete capital figure/);
    expect(html).toMatch(/library placeholder/);                       // every line the quote does not cover is still named as one
    expect(html).toMatch(/1 line: firm supplier quote/);
  });

  it("fails closed when the engine does not account for the quotations it was given", async () => {
    const { token, id } = await newProject();
    quotation(id);
    rewriteAnswer = (b) => { delete b.cost_evidence; return b; };    // an engine build that ignored cost_evidence
    vi.spyOn(console, "error").mockImplementation(() => {});
    const before = saved().length;
    const res = await save({ project: { project_token: token }, use_accepted_quotations: true });
    expect(res.status).toBe(502);
    expect((await j(res)).error).toMatch(/did not report how it used the quotations/);
    expect(saved()).toHaveLength(before);
  });

  it("fails closed, before the engine, when the store cannot record the evidence list (migration 0026 not applied)", async () => {
    const { token, id } = await newProject();
    quotation(id);
    db.dropColumn("project_comparisons", "evidence_ids");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const calls = engineBodies.length;
    const res = await save({ project: { project_token: token }, use_accepted_quotations: true });
    expect(res.status).toBe(503);
    expect((await j(res)).error).toMatch(/not available on this deployment yet\. Nothing was saved/);
    expect(engineBodies.length).toBe(calls);
    expect(saved()).toHaveLength(1);                                    // only the library-priced one from newProject()
  });

  it("refuses to store the claim when a quotation is withdrawn while the engine is answering", async () => {
    const { token, id } = await newProject();
    const q = quotation(id);
    afterEngine = () => { q.state = "withdrawn"; q.retired_kind = "withdrawn"; };
    const before = saved().length;
    const res = await save({ project: { project_token: token }, use_accepted_quotations: true });
    expect(res.status).toBe(409);
    expect((await j(res)).error).toMatch(/changed while this comparison was being made/);
    expect(saved()).toHaveLength(before);
    expect(db.rows("project_events").filter((e) => e.event_type === "comparison_saved")).toHaveLength(before);
  });
});

describe.runIf(hasPython)("the buyer page: what is quoted, what is estimated, and what it may disclose", () => {
  it("shows the basis, the accepted quotations and their dates, and nothing confidential", async () => {
    const { token, id } = await newProject();
    quotation(id);
    expect((await save({ project: { project_token: token }, use_accepted_quotations: true })).status).toBe(201);
    const link = await issue(token);
    const html = await page(link);
    expect(html).toContain("1 accepted quotation");
    expect(html).toContain("What the capital figures rest on");
    expect(html).toContain("Quotation 1");
    expect(html).toContain("firm quote");
    expect(html).toContain("2026-10-01");                              // when it was quoted
    expect(html).toContain("2099-12-31");                              // how long it is valid
    expect(html).toContain("2026-10-02");                              // when a named reviewer accepted it
    expect(html).toContain("CDU capacity");                            // what it prices, in the ladder's words
    expect(html).toMatch(/still accepted and in date/);
    expect(html).toMatch(/1 line: firm supplier quote/);               // quoted
    expect(html).toMatch(/lines?: library placeholder \(not a price\)/); // ... against estimated
    expect(html).toMatch(/Quotations price the capital items below; they do not date anything/);
    expect(html).not.toMatch(/library-priced · no supplier quotation/);
    for (const s of SECRETS) expect(html, s).not.toContain(s);
    expect(html).not.toContain(token);
    expect(html).not.toContain(link);                                  // the page does not echo the link
  });

  it("holds none of the supplier detail in what it reads: the view has no request and no per-line account", async () => {
    const { token, id } = await newProject();
    quotation(id);
    await save({ project: { project_token: token }, use_accepted_quotations: true });
    const got = await getBuyerView(await issue(token));
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    const dump = JSON.stringify(got.view);
    for (const s of SECRETS) expect(dump, s).not.toContain(s);
    expect(dump).not.toContain("cost_evidence\":{");
    expect((got.view.comparison as any).request).toBeUndefined();
    expect(got.view.backing!.lines[0]).toEqual({
      label: "Quotation 1", item: "CDU capacity (derated to site water temperature)", basis: "firm quote", comparability: "exact",
      quoted_on: "2026-10-01", valid_until: "2099-12-31", accepted_on: "2026-10-02",
      // Only scenarios that are actually compared: the engine also evaluates full_dlc_btm, which this request did not ask for.
      priced: [{ scenario: "Hybrid DLC on retained plant, grid only", steps: 1 }, { scenario: "Full DLC, grid only", steps: 1 }],
      standing: "current",
    });
    expect(got.view.backing!.current).toBe(true);
  });

  it("does not follow a link of another project, a revoked link, or a malformed one to these quotations", async () => {
    const a = await newProject("A");
    const b = await newProject("B");
    quotation(a.id);
    await save({ project: { project_token: a.token }, use_accepted_quotations: true });
    const linkB = await issue(b.token);
    const htmlB = await page(linkB);
    expect(htmlB).not.toContain("Quotation 1");
    expect(htmlB).toContain("library-priced · no supplier quotation");
    const linkA = await issue(a.token);
    await (await import("@/app/api/projects/[token]/share/route")).DELETE(new Request(siteUrl("/x"), { method: "DELETE" }), ctx(a.token));
    await expect(page(linkA)).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
    await expect(page("x".repeat(43))).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404|NEXT_NOT_FOUND/);
  });

  it("says the comparison is no longer current once a quotation is withdrawn, replaced or a newer one is accepted, and rewrites nothing", async () => {
    const { token, id } = await newProject();
    const q = quotation(id);
    await save({ project: { project_token: token }, use_accepted_quotations: true });
    const link = await issue(token);
    const snapshot = JSON.stringify(saved());
    expect(await page(link)).toMatch(/still accepted and in date/);

    // 1. a newer accepted quotation for another item arrives
    const extra = quotation(id, { cost_key: "busway.replacement" });
    let html = await page(link);
    expect(html).toContain("This comparison is no longer current.");
    expect(html).toMatch(/1 further accepted quotation was recorded after this comparison/);
    extra.state = "rejected";
    // 2. the quotation behind it is withdrawn
    q.state = "withdrawn"; q.retired_kind = "withdrawn";
    html = await page(link);
    expect(html).toContain("not current");
    expect(html).toMatch(/1 quotation has since been withdrawn/);
    expect(html).toMatch(/withdrawn<\/td>/);
    // 3. it is replaced
    q.state = "superseded"; q.retired_kind = "superseded";
    html = await page(link);
    expect(html).toMatch(/replaced by a newer accepted quotation/);
    // 4. it simply passes its validity date
    q.state = "accepted"; q.retired_kind = null; q.valid_until = "2026-01-01";
    html = await page(link);
    expect(html).toMatch(/past its validity date/);

    // The historical record is exactly what it was: the page reports currency, it never repairs the figures.
    expect(JSON.stringify(saved())).toBe(snapshot);
    expect(html).toContain("The figures below");
  });

  it("is unchanged for a comparison with no quotation evidence", async () => {
    const { token, id } = await newProject();
    quotation(id);                                                      // accepted, but the owner did not ask to use it
    const link = await issue(token);
    const html = await page(link);
    expect(saved()[0].evidence_ids).toEqual([]);
    expect(engineBodies.at(-1)!.cost_evidence).toBeUndefined();
    expect(html).toContain("library-priced · no supplier quotation");
    expect(html).toMatch(/No supplier quotation is applied to this comparison/);
    expect(html).not.toContain("Quotation 1");
    expect(html).toMatch(/1 quotation line has been accepted for this project&#x27;s engagements, but this comparison was not saved on it/);
  });

  it("a read of the store that fails is a failed page, not 'current' and not 'no quotations'", async () => {
    const { token, id } = await newProject();
    quotation(id);
    await save({ project: { project_token: token }, use_accepted_quotations: true });
    const link = await issue(token);
    db.failMethod = null;
    db.dropTable("cost_evidence_state");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const got = await getBuyerView(link);
    expect(got.ok).toBe(false);
  });
});

describe("the evidence projection, as pure data", () => {
  const result: any = {
    scenarios: [{ id: "s1", name: "Scenario one", time_to_power: { lead_times: [{ constraint: "cdu_capacity", name: "CDU capacity" }] } }],
    cost_evidence: {
      used: [{ evidence_id: "e1", key: "cdu.addition", basis: "budgetary_quote", comparability: "limited", quoted_on: "2026-10-01", valid_until: null, reviewed_on: "2026-10-02" }, { evidence_id: "e2", key: "unrelated.key", basis: "firm_quote", comparability: "exact" }],
      ignored: [{ key: "cdu.addition", evidence_id: "e3", reason: "the quotation expired on 2026-01-01" }],
      effect: { used: ["e1", "e2"], scenarios: [{ scenario: "s1", steps_changed: [{ constraint: "cdu_capacity", cost_keys: ["cdu.addition"] }] }, { scenario: "not-compared", steps_changed: [{ constraint: "cdu_capacity", cost_keys: ["cdu.addition"] }] }] },
    },
  };

  it("counts as backing only a line the engine applied AND that repriced a step", () => {
    expect(backingLines(result).map((l) => l.evidence_id)).toEqual(["e1"]);
    // ... and only in scenarios that were compared: the engine also reports the intake's other scenarios.
    expect(backingLines(result)[0].priced).toEqual([{ scenario: "s1", steps: 1 }]);
  });

  it("describes a line as backing only if the database recorded it for that comparison", () => {
    expect(buyerQuotations(result, [], [], 0, "2026-10-17")).toBeNull();
    expect(buyerQuotations(result, ["e2"], [], 0, "2026-10-17")).toBeNull();
    const b = buyerQuotations(result, ["e1", "e2"], [{ id: "e1", state: "accepted", valid_until: null }], 0, "2026-10-17")!;
    expect(b.lines).toHaveLength(1);
    expect(b.lines[0]).toMatchObject({ basis: "budgetary quote (an indicative price, not an offer)", comparability: "limited", standing: "current" });
    expect(b.current).toBe(true);
    expect(b.not_applied).toEqual(["the quotation expired on 2026-01-01"]);
  });

  it("is not current when a line's standing is unknown", () => {
    const b = buyerQuotations(result, ["e1"], [], 0, "2026-10-17")!;
    expect(b.current).toBe(false);
    expect(b.reasons.join()).toMatch(/could not be confirmed/);
  });
});
