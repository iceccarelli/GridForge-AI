/**
 * The project-quotation routes through the real handlers, against the in-memory PostgREST, with the REAL Python engine for the part that asks it.
 * What the SQL refuses (an unverified file, another project's file, a bidi character, a concurrent acceptance) is proven against PostgreSQL in
 * project-quotation-claims.realdb.test.ts and tests/test_project_quotation_claims_migration.py; this file proves what the ROUTES do before and
 * around it: what is refused before any allowance is spent, what the store is asked to write (and nothing more), what a holder is shown, what the
 * engine is and is not sent, and the 503 on a deployment without the migration.
 *
 * Every supplier, price and date is a SYNTHETIC fixture (suppliers are named SYNTHETIC-SUPPLIER-x).
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { RATE_POLICIES, resetMemoryLimiter } from "@/lib/rate-limit";
import { PostgrestFake } from "./postgrest-fake";
import { installProjectRpcs } from "./project-rpc-fake";
import { engineAvailable } from "./_engine-guard";

const hasPython = spawnSync("python3", ["--version"]).status === 0;
const guard = engineAvailable(hasPython);
const KEY = "quotation-claims-key";
let engine: ChildProcess | null = null;
let ENGINE = "";
const realFetch = globalThis.fetch;
let engineBodies: Record<string, any>[];
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
describe("the real-engine suites may only be skipped where that is allowed", () => {
  it("python3 is present where CI requires it", () => expect(guard.ok, guard.reason).toBe(true));
});
beforeAll(async () => { if (hasPython) ENGINE = await startEngine(); }, 30_000);
afterAll(() => engine?.kill());

const TABLES = [
  "projects", "project_links", "project_events", "project_evidence", "project_evidence_reviews", "cost_evidence_state", "cost_evidence_runs",
  "deliverables", "project_comparisons", "project_shares", "rate_limit_windows",
];
const FILE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const FILE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let submitted: any[];

beforeEach(() => {
  resetMemoryLimiter();
  engineBodies = [];
  submitted = [];
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = KEY;
  db = new PostgrestFake(TABLES);
  installProjectRpcs(db);
  // What gf_submit_project_quotation would write, as far as the route is concerned: the arguments are recorded, and one validated row is stored.
  db.rpcs.set("gf_submit_project_quotation", ({ p }, d) => {
    submitted.push(p);
    d.insertRow("cost_evidence_state", {
      id: `line-${submitted.length}`, project_id: p.project_id, deliverable_id: null, source_file_id: p.source_file_id, cost_key: p.cost_key, unit: p.unit, value: p.value,
      currency: "EUR", supplier: p.supplier, received_on: p.received_on, valid_until: p.valid_until, reference: p.reference, scope: p.scope,
      quoted_quantity: p.quoted_quantity, quoted_quantity_unit: p.quoted_quantity_unit, comparability: p.comparability, limitations: p.limitations, submitted_at: "2026-11-08T10:00:00Z",
      state: "validated", claimed_quote_type: p.claimed_quote_type, lead_time_weeks: p.lead_time_weeks, notes: p.notes, submitted_by: p.submitted_by, synthetic: false,
      response_digest: "d".repeat(64), problems: [], validation_status: "validated",
    });
    return { created: true, id: `line-${submitted.length}` };
  });
  restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (ENGINE && url.startsWith(ENGINE)) {
      engineBodies.push(JSON.parse(String(init?.body ?? "{}")));
      return realFetch(i as RequestInfo, init);
    }
    return dbFetch(i, init);
  }) as typeof fetch;
});
afterEach(() => { restoreDb(); globalThis.fetch = realFetch; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const j = async (r: Response) => (await r.json()) as any;
const post = (path: string, body: unknown, ip = "203.0.113.5") =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) });
const claim = (over: Record<string, unknown> = {}) => ({
  file_id: FILE_A, cost_key: "cdu.addition", unit: "EUR", price_eur: 317450, quote_type: "firm_quote", supplier: "SYNTHETIC-SUPPLIER-A", quoted_on: day(-3),
  valid_until: "2099-12-31", lead_time_weeks: 26, scope: "supply and install", submitted_by: "A. Holder", ...over,
});
const HALL = {
  siteName: "Synthetic Hall", hallId: "H1", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63,
  floorLoadingKPa: 12, positionsAvailable: 180, plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};

function project(token: string, id: string) {
  db.insertRow("projects", { id, project_token: token, project_name: `Project ${id}`, status: "draft" });
  return id;
}
function file(id: string, projectId: string, over: Record<string, unknown> = {}) {
  db.insertRow("project_evidence", { id, project_id: projectId, filename: `${id.slice(0, 4)}.pdf`, media_type: "application/pdf", byte_size: 2048, sha256: id[0].repeat(64), storage_ref: `project-evidence/${projectId}/${id[0].repeat(64)}-q.pdf`, review_status: "unverified", ...over });
}
function line(id: string, projectId: string, fileId: string, over: Record<string, unknown> = {}) {
  db.insertRow("cost_evidence_state", {
    id, project_id: projectId, deliverable_id: null, source_file_id: fileId, cost_key: "cdu.addition", unit: "EUR", value: 317450, currency: "EUR", supplier: "SYNTHETIC-SUPPLIER-A",
    received_on: day(-3), valid_until: "2099-12-31", reference: null, scope: "supply and install", quoted_quantity: null, quoted_quantity_unit: null, comparability: "limited", limitations: [],
    submitted_at: "2026-11-08T10:00:00Z", state: "validated", claimed_quote_type: "firm_quote", lead_time_weeks: 26, notes: null, submitted_by: "A. Holder", synthetic: false,
    response_digest: fileId[0].repeat(64), problems: [], validation_status: "validated", reviewed_basis: null, reviewer: null, reviewed_at: null, ...over,
  });
}
const accepted = { state: "accepted", reviewed_basis: "firm_quote", reviewed_comparability: "limited", reviewer: "R. Reviewer", reviewed_at: "2026-11-09T09:00:00Z", includes_keys: [], reviewed_region: null };
const submit = async (token: string, body: unknown, ip?: string) => (await import("@/app/api/projects/[token]/cost-evidence/route")).POST(post(`/api/projects/${token}/cost-evidence`, body, ip), ctx(token));
const list = async (token: string) => (await import("@/app/api/projects/[token]/cost-evidence/route")).GET(new Request(siteUrl("/x")), ctx(token));
const compareRoute = async (token: string) => (await import("@/app/api/projects/[token]/cost-evidence/compare/route")).POST(post(`/api/projects/${token}/cost-evidence/compare`, { compare: { hall: HALL, objective: "fastest" } }), ctx(token));

describe("recording a claim", () => {
  it("writes exactly the claim, stores it unverified, and says it is not counted", async () => {
    project("tok-a", "p-a"); file(FILE_A, "p-a");
    const res = await submit("tok-a", claim({ notes: "excludes civils", reference: "SYN-1" }));
    expect(res.status).toBe(201);
    expect(await j(res)).toMatchObject({ ok: true, created: true, state: "received", counted: false });
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatchObject({
      project_id: "p-a", source_file_id: FILE_A, cost_key: "cdu.addition", unit: "EUR", value: 317450, claimed_quote_type: "firm_quote", lead_time_weeks: 26,
      received_on: expect.any(String), valid_until: "2099-12-31", comparability: "limited", submitted_by: "A. Holder", reference: "SYN-1", notes: "excludes civils",
    });
    expect(submitted[0].line_digest).toMatch(/^[0-9a-f]{64}$/);
    // there is no way to say a state, a basis, a review or a class: the body is rejected and the store is never asked
    for (const extra of [{ state: "accepted" }, { basis: "firm_quote" }, { evidence_class: "E5" }, { reviewer: "me" }, { synthetic: true }]) {
      expect((await submit("tok-a", claim(extra))).status).toBe(422);
    }
    expect(submitted).toHaveLength(1);
    expect(db.rows("project_events").some((e) => e.event_type === "cost_evidence_accepted")).toBe(false);
  });

  it("refuses a bad claim with the fields that were wrong, before any allowance is spent", async () => {
    project("tok-a", "p-a"); file(FILE_A, "p-a");
    const policy = RATE_POLICIES.project_quotation;
    for (let i = 0; i < policy.limit + 5; i++) {
      const r = await submit("tok-a", claim({ valid_until: day(-1) }));
      expect(r.status).toBe(422);
      if (i === 0) expect((await j(r)).details).toEqual([{ field: "valid_until", problem: expect.stringMatching(/after today/) }]);
    }
    expect((await submit("tok-a", claim())).status).toBe(201);                      // none of the refused ones counted against the caller
    expect(submitted).toHaveLength(1);
  });

  it("limits a caller who keeps submitting valid claims, per the project_quotation policy", async () => {
    project("tok-a", "p-a"); file(FILE_A, "p-a");
    const policy = RATE_POLICIES.project_quotation;
    let last = 0;
    for (let i = 0; i < policy.limit + 1; i++) last = (await submit("tok-a", claim({ price_eur: 1000 + i }))).status;
    expect(last).toBe(429);
    expect(submitted).toHaveLength(policy.limit);
  });

  it("reaches nothing with an unknown token, and a file that is not the project's is a 404 that stores nothing", async () => {
    project("tok-a", "p-a"); project("tok-b", "p-b"); file(FILE_B, "p-b");
    expect((await submit("nope", claim())).status).toBe(404);
    expect((await submit("tok-a", claim({ file_id: FILE_B }))).status).toBe(404);
    expect(submitted).toHaveLength(0);
  });

  it("will not rest a quotation on a file a reviewer rejected", async () => {
    project("tok-a", "p-a"); file(FILE_A, "p-a", { review_status: "rejected" });
    const r = await submit("tok-a", claim());
    expect(r.status).toBe(409);
    expect(submitted).toHaveLength(0);
  });

  it("answers 503 where the migration has not been applied, and says nothing was recorded", async () => {
    project("tok-a", "p-a"); file(FILE_A, "p-a");
    db.rpcs.delete("gf_submit_project_quotation");
    const r = await submit("tok-a", claim());
    expect(r.status).toBe(503);
    expect((await j(r)).error).toMatch(/migration has not been applied.*Nothing was recorded/);
    db.dropColumn("cost_evidence_state", "source_file_id");
    expect((await list("tok-a")).status).toBe(503);
  });
});

describe("what a holder is shown", () => {
  it("lists only this project's claims, each with its file's standing and why it is not counted, and never a storage path", async () => {
    project("tok-a", "p-a"); project("tok-b", "p-b"); file(FILE_A, "p-a"); file(FILE_B, "p-b", { review_status: "verified" });
    line("l-a1", "p-a", FILE_A);
    line("l-a2", "p-a", FILE_A, { ...accepted, cost_key: "plant.uprate" });
    line("l-b1", "p-b", FILE_B, { ...accepted, supplier: "SYNTHETIC-SUPPLIER-B", value: 999111 });
    db.insertRow("project_evidence_reviews", { evidence_id: FILE_B, decision: "verified", reviewer: "F", sha256_confirmed: FILE_B[0].repeat(64), reviewed_at: "2026-11-09T09:00:00Z" });
    const body = await j(await list("tok-a"));
    expect(body.claims.map((c: any) => c.id).sort()).toEqual(["l-a1", "l-a2"]);
    const byId = Object.fromEntries(body.claims.map((c: any) => [c.id, c]));
    expect(byId["l-a1"]).toMatchObject({ state: "validated", counted: false, lead_time_weeks: 26 });
    expect(byId["l-a1"].reason).toMatch(/Not yet counted: it is waiting for a reviewer/);
    expect(byId["l-a1"].file).toMatchObject({ review_status: "unverified", hash_confirmed: false, status_text: "file not yet verified" });
    expect(byId["l-a2"]).toMatchObject({ state: "accepted", counted: true, reason: null });
    expect(byId["l-a2"].review).toMatchObject({ reviewer: "R. Reviewer", basis_label: "firm supplier quote" });
    const text = JSON.stringify(body);
    for (const s of ["SYNTHETIC-SUPPLIER-B", "999111", "l-b1", "project-evidence/", "storage_ref"]) expect(text, s).not.toContain(s);
    // the other project sees its own file as verified with a confirmed digest
    const other = await j(await list("tok-b"));
    expect(other.claims[0].file).toMatchObject({ review_status: "verified", hash_confirmed: true });
  });

  it("says an accepted quotation past its validity date is not counted", async () => {
    project("tok-a", "p-a"); file(FILE_A, "p-a", { review_status: "verified" });
    line("l-old", "p-a", FILE_A, { ...accepted, valid_until: "2020-01-01", received_on: "2019-01-01" });
    const c = (await j(await list("tok-a"))).claims[0];
    expect(c).toMatchObject({ state: "accepted", counted: false });
    expect(c.reason).toMatch(/validity date 2020-01-01 has passed/);
  });
});

describe.skipIf(!hasPython)("what the engine is and is not sent", () => {
  it("offers only accepted, in-project, in-date lines; asks the engine nothing when none is accepted", async () => {
    project("tok-a", "p-a"); project("tok-b", "p-b"); file(FILE_A, "p-a", { review_status: "verified" }); file(FILE_B, "p-b", { review_status: "verified" });
    line("l-pending", "p-a", FILE_A, { cost_key: "plant.uprate" });
    line("l-rejected", "p-a", FILE_A, { state: "rejected", cost_key: "busway.replacement" });
    line("l-foreign", "p-b", FILE_B, { ...accepted, supplier: "SYNTHETIC-SUPPLIER-B", cost_key: "pump.uprate" });
    const none = await j(await compareRoute("tok-a"));
    expect(none).toMatchObject({ ok: true, offered: 0, result: null });
    expect(engineBodies).toHaveLength(0);                                              // nothing new to ask
    expect(none.claims.every((c: any) => c.counted === false)).toBe(true);

    line("l-ok", "p-a", FILE_A, { ...accepted });
    resetMemoryLimiter();
    const out = await j(await compareRoute("tok-a"));
    expect(out).toMatchObject({ ok: true, offered: 1, applied: ["l-ok"] });
    expect(engineBodies).toHaveLength(1);
    const sent = engineBodies[0].cost_evidence as Record<string, unknown>[];
    expect(sent.map((e) => e.evidence_id)).toEqual(["l-ok"]);                          // not the pending, rejected or foreign line
    expect(sent[0]).toMatchObject({ key: "cdu.addition", basis: "firm_quote", status: "accepted", project: "p-a", reviewer: "R. Reviewer" });
    expect(out.result.cost_evidence.used.map((u: any) => u.evidence_id)).toEqual(["l-ok"]);
    expect(out.result.cost_evidence.effect.scenarios.some((s: any) => s.steps_changed.length > 0)).toBe(true);
    for (const s of ["SYNTHETIC-SUPPLIER-B", "l-foreign", "pump.uprate"]) expect(JSON.stringify(out), s).not.toContain(s);
  });

  it("returns the engine's own reason for a line it was offered and ignored", async () => {
    project("tok-a", "p-a"); file(FILE_A, "p-a", { review_status: "verified" });
    line("l-old", "p-a", FILE_A, { ...accepted, valid_until: "2020-01-01", received_on: "2019-01-01" });
    const out = await j(await compareRoute("tok-a"));
    expect(out.offered).toBe(1);
    expect(out.applied).toEqual([]);
    expect(out.result.cost_evidence.ignored).toEqual([{ key: "cdu.addition", evidence_id: "l-old", reason: "the quotation expired on 2020-01-01" }]);
  });

  it("is refused for an unknown token and for a body that names anything but the comparison", async () => {
    project("tok-a", "p-a");
    const { POST } = await import("@/app/api/projects/[token]/cost-evidence/compare/route");
    expect((await compareRoute("nope")).status).toBe(404);
    const extra = await POST(post("/x", { compare: { hall: HALL }, cost_evidence: [{ key: "cdu.addition", value: 1 }] }), ctx("tok-a"));
    expect(extra.status).toBe(422);                                                      // a browser cannot send the engine a quotation of its own
    expect(engineBodies).toHaveLength(0);
  });
});
