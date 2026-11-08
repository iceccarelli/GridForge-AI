/**
 * The supplier-quotation loop END TO END against REAL PostgreSQL through REAL PostgREST, with the REAL Python engine:
 *
 *   upload the quotation document -> record the claims (stored unverified, not counted) -> the reviewer verifies the FILE
 *   (server-computed SHA-256, 0048) -> the reviewer accepts the RECORD (refused until the file is verified: 0054) -> the engine reprices the
 *   comparison on it (capex before/after, ladder steps from a library placeholder to a supplier quote) -> a saved comparison rests on it.
 *
 * Every supplier, price, reviewer and document here is a SYNTHETIC fixture (suppliers are named SYNTHETIC-SUPPLIER-x; the PDF is a few bytes of
 * text). Nothing is a real quotation. What is NOT real: Supabase Storage (the gateway below serves /rest/v1 by proxying to PostgREST and keeps
 * the three Storage object calls upload and review make in memory) and Supabase Auth.
 *
 * Skipped unless GF_PGRST_URL and GF_PGRST_JWT are set (scripts/realdb-up.sh) - a skip is a gap in what was checked; GF_REQUIRE_REALDB=1 turns it
 * into a failure.
 */
import crypto from "node:crypto";
import http from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { adminToken } from "@/lib/admin";
import { siteUrl } from "@/lib/site";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { effectView } from "@/lib/quotation-effect";
import type { CompareResult } from "@/lib/ttp-compare";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT && spawnSync("python3", ["--version"]).status === 0;
const required = process.env.GF_REQUIRE_REALDB === "1";
const KEY = "quotation-claims-realdb-key";
let engine: ChildProcess | null = null;
let gateway: http.Server | null = null;
const objects = new Map<string, { bytes: Buffer; type: string }>();

describe("real-database prerequisites (project quotation claims)", () => {
  it.runIf(required)("are present when the real database is required", () => {
    expect(PGRST).not.toBe("");
    expect(JWT).not.toBe("");
    expect(enabled).toBe(true);
  });
  it.runIf(required && enabled)("migration 0054 is applied", async () => {
    const r = await fetch(`${PGRST}/cost_evidence_state?select=source_file_id,lead_time_weeks,claimed_quote_type&limit=1`, { headers: { Authorization: `Bearer ${JWT}` } });
    expect(r.status, "migration 0054 must be applied").toBe(200);
  });
});

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

async function startGateway(): Promise<string> {
  gateway = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = req.url ?? "";
    if (url.startsWith("/rest/v1/")) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
      const r = await fetch(PGRST + url.slice("/rest/v1".length), { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : body });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    const rb = url.match(/^\/storage\/v1\/object\/authenticated\/(.+)$/);
    if (rb && req.method === "GET") {
      const o = objects.get(decodeURIComponent(rb[1]));
      if (!o) { res.writeHead(400, { "content-type": "application/json" }).end('{"statusCode":"404","error":"not_found","code":"NoSuchKey"}'); return; }
      res.writeHead(200, { "content-type": o.type }).end(o.bytes); return;
    }
    const m = url.match(/^\/storage\/v1\/object\/(.+)$/);
    if (m) {
      const ref = decodeURIComponent(m[1]);
      if (req.method === "POST") {
        if (objects.has(ref)) { res.writeHead(409).end("{}"); return; }
        objects.set(ref, { bytes: body, type: String(req.headers["content-type"]) });
        res.writeHead(200).end("{}"); return;
      }
      if (req.method === "DELETE") { objects.delete(ref); res.writeHead(200).end("{}"); return; }
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => gateway!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(gateway!.address() as { port: number }).port}`;
}

beforeAll(async () => {
  if (!enabled) return;
  process.env.GRIDFORGE_API_URL = await startEngine();
  process.env.GRIDFORGE_API_KEY = KEY;
  process.env.SUPABASE_URL = await startGateway();
  process.env.SUPABASE_SERVICE_ROLE_KEY = JWT;
  process.env.GRIDFORGE_ADMIN_KEY = "realdb-admin";
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  delete process.env.RESEND_API_KEY;
}, 40_000);
afterAll(() => { engine?.kill(); gateway?.close(); });

const sql = async (path: string, init: RequestInit = {}) =>
  fetch(PGRST + path, { ...init, headers: { Authorization: `Bearer ${JWT}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers ?? {}) } });
const rows = async (table: string, q = "") => (await (await sql(`/${table}?select=*${q}`)).json()) as any[];
const rpc = async (name: string, body: unknown) => {
  const r = await sql(`/rpc/${name}`, { method: "POST", body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => null)) as any };
};
const ownerSql = (statement: string) => {
  const r = spawnSync("psql", ["-X", "-q", "-At", "-d", process.env.GF_PG_DB ?? "gf", "-v", "ON_ERROR_STOP=1", "-c", statement], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql failed: ${String(r.stderr).split("\n")[0]}`);
  return r.stdout.trim();
};

const anAddress = () => `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
const post = (path: string, body: unknown) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": anAddress() }, body: JSON.stringify(body) });
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const j = async (r: Response) => (await r.json()) as any;
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

const HALL = {
  siteName: "Realdb Hall", hallId: "H1", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9,
  buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180, plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};
const COMPARE = { hall: HALL, objective: "fastest" };

async function newProject() {
  resetMemoryLimiter();
  const { POST } = await import("@/app/api/projects/route");
  const made = await j(await POST(post("/api/projects", { project_name: `Quotation loop ${crypto.randomUUID().slice(0, 8)}` })));
  const token = made.project_token as string;
  const [row] = await rows("projects", `&project_token=eq.${token}`);
  return { token, id: row.id as string };
}
let n = 0;
async function upload(token: string, label = "quote") {
  const { POST } = await import("@/app/api/projects/[token]/evidence/route");
  const bytes = new TextEncoder().encode(`%PDF-1.4\n% SYNTHETIC supplier quotation fixture ${label} ${++n} ${crypto.randomUUID()}\n%%EOF\n`);
  const r = await POST(new Request(siteUrl(`/api/projects/${token}/evidence?filename=${label}-${n}.pdf&source_category=supplier_document`), { method: "POST", headers: { "content-type": "application/pdf", "x-forwarded-for": anAddress() }, body: bytes as BodyInit }), ctx({ token }));
  expect(r.status).toBe(201);
  const b = await j(r);
  return { id: b.evidence.id as string, sha256: b.evidence.sha256 as string };
}
const claim = (fileId: string, over: Record<string, unknown> = {}) => ({
  file_id: fileId, cost_key: "cdu.addition", unit: "EUR", price_eur: 317450, quote_type: "firm_quote", supplier: "SYNTHETIC-SUPPLIER-A",
  quoted_on: day(-3), valid_until: "2099-12-31", lead_time_weeks: 26, scope: "supply and mechanical install of the CDUs (confidential scope wording)",
  notes: "excludes civils", reference: "SYN-A-REF", submitted_by: "A. Holder", ...over,
});
async function submit(token: string, body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/projects/[token]/cost-evidence/route");
  return POST(post(`/api/projects/${token}/cost-evidence`, body), ctx({ token }));
}
async function verifyFile(fileId: string) {
  const { POST } = await import("@/app/api/admin/evidence/[id]/review/route");
  return POST(post("/x", { decision: "verified", reviewer: "F. Keane", reason: "opened it; the digest matches" }), ctx({ id: fileId }));
}
async function decide(id: string, body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/admin/cost-evidence/[id]/review/route");
  return POST(post("/x", body), ctx({ id }));
}
const ACCEPT = { decision: "accepted", reviewer: "R. Reviewer", basis: "firm_quote", comparability: "limited", reason: "matches the document" };
async function compareRoute(token: string) {
  const { POST } = await import("@/app/api/projects/[token]/cost-evidence/compare/route");
  resetMemoryLimiter();
  return POST(post(`/api/projects/${token}/cost-evidence/compare`, { compare: COMPARE }), ctx({ token }));
}
async function baseResult(): Promise<CompareResult> {
  const { POST } = await import("@/app/api/power/compare/route");
  resetMemoryLimiter();
  return (await j(await POST(post("/api/power/compare", COMPARE)))).result as CompareResult;
}
async function claimsOf(token: string) {
  const { GET } = await import("@/app/api/projects/[token]/cost-evidence/route");
  return j(await GET(new Request(siteUrl("/x")), ctx({ token })));
}

describe.skipIf(!enabled)("supplier quotation loop — real PostgreSQL via PostgREST, real engine", () => {
  it("runs submit -> verify file -> accept record -> engine reprices, and each gate holds in the database", async () => {
    jar.length = 0;
    const { token, id: pid } = await newProject();
    const file = await upload(token);

    // 1. SUBMISSION: stored unverified, tied to the file by id, not counted.
    const res = await submit(token, claim(file.id));
    expect(res.status).toBe(201);
    const sub = await j(res);
    expect(sub).toMatchObject({ ok: true, created: true, state: "received", counted: false });
    const [line] = await rows("cost_evidence_state", `&id=eq.${sub.id}`);
    expect(line).toMatchObject({
      project_id: pid, deliverable_id: null, source_file_id: file.id, state: "validated", validation_status: "validated", cost_key: "cdu.addition",
      unit: "EUR", currency: "EUR", claimed_quote_type: "firm_quote", lead_time_weeks: 26, submitted_by: "A. Holder", synthetic: false, response_digest: file.sha256,
    });
    expect(Number(line.value)).toBe(317450);
    expect(line.comparability).toBe("limited");                       // a lump with no stated quantity
    expect(await rows("project_events", `&project_id=eq.${pid}&event_type=eq.cost_evidence_received`)).toHaveLength(1);

    // the same claim again is the same line and writes no second event
    const again = await submit(token, claim(file.id));
    expect(again.status).toBe(200);
    expect((await j(again)).id).toBe(sub.id);
    expect(await rows("cost_evidence", `&project_id=eq.${pid}`)).toHaveLength(1);
    expect(await rows("project_events", `&project_id=eq.${pid}&event_type=eq.cost_evidence_received`)).toHaveLength(1);

    // the holder sees it, with the file's standing, and a reason it is not counted; no storage path anywhere
    const listed = await claimsOf(token);
    expect(listed.claims).toHaveLength(1);
    expect(listed.claims[0]).toMatchObject({ id: sub.id, state: "validated", counted: false, supplier: "SYNTHETIC-SUPPLIER-A", lead_time_weeks: 26 });
    expect(listed.claims[0].file).toMatchObject({ id: file.id, review_status: "unverified", hash_confirmed: false });
    expect(listed.claims[0].reason).toMatch(/waiting for a reviewer/);
    expect(JSON.stringify(listed)).not.toMatch(/storage_ref|project-evidence\//);

    // an unaccepted quotation is never sent to the engine: the compare route says so and returns "not yet counted"
    const none = await j(await compareRoute(token));
    expect(none).toMatchObject({ ok: true, offered: 0, result: null });
    expect(none.claims[0]).toMatchObject({ counted: false });

    // 2. ADMIN GATE: not without a verified file
    expect((await decide(sub.id, ACCEPT)).status).toBe(401);          // no admin cookie
    jar.push({ name: "gf_admin", value: adminToken()! });
    const early = await decide(sub.id, ACCEPT);
    expect(early.status).toBe(409);
    expect((await j(early)).error).toMatch(/has not been verified/);
    expect((await rows("cost_evidence_reviews", `&evidence_id=eq.${sub.id}`))).toHaveLength(0);
    // the database itself refuses it, not just the route (GF009)
    const direct = await rpc("gf_review_cost_evidence", { p: { evidence_id: sub.id, decision: "accepted", basis: "firm_quote", comparability: "limited", reviewer: "X" }, p_event: { event_type: "cost_evidence_reviewed", actor: "X", occurred_at: new Date().toISOString(), payload: {} } });
    expect(direct.status).toBeGreaterThanOrEqual(400);
    expect(direct.body.code).toBe("GF009");

    // verify the FILE (the server re-reads the stored bytes and hashes them), then accept the RECORD
    const vr = await verifyFile(file.id);
    expect(vr.status).toBe(201);
    const [dec] = await rows("project_evidence_reviews", `&evidence_id=eq.${file.id}`);
    expect(dec).toMatchObject({ decision: "verified", sha256_confirmed: file.sha256 });
    const acc = await decide(sub.id, ACCEPT);
    expect(acc.status).toBe(201);
    expect((await decide(sub.id, { decision: "rejected", reviewer: "R. Reviewer" })).status).toBe(409);   // decided once
    const [accepted] = await rows("cost_evidence_state", `&id=eq.${sub.id}`);
    expect(accepted).toMatchObject({ state: "accepted", reviewed_basis: "firm_quote", reviewed_comparability: "limited", reviewer: "R. Reviewer" });
    // append-only: a raw update of the price is refused, even for the service role
    expect((await sql(`/cost_evidence?id=eq.${sub.id}`, { method: "PATCH", body: JSON.stringify({ value: 1 }) })).status).toBeGreaterThanOrEqual(400);

    // 3. LIVE ENGINE REPRICING: the engine's own answer
    const base = await baseResult();
    const priced = await j(await compareRoute(token));
    expect(priced).toMatchObject({ ok: true, offered: 1 });
    expect(priced.applied).toEqual([sub.id]);
    const withQ = priced.result as CompareResult;
    expect(withQ.cost_evidence!.used.map((u) => u.evidence_id)).toEqual([sub.id]);
    expect(withQ.cost_evidence!.used[0]).toMatchObject({ key: "cdu.addition", basis: "firm_quote", supplier: "SYNTHETIC-SUPPLIER-A", comparability: "limited", reviewer: "R. Reviewer" });
    const view = effectView(base, withQ)!;
    const moved = view.scenarios.filter((s) => s.steps.length > 0);
    expect(moved.length).toBeGreaterThan(0);
    for (const s of moved) {
      expect(s.capex_before_eur).not.toBe(s.capex_after_eur);
      expect(s.steps.every((st) => st.from === "library placeholder (not a price)" && st.to === "firm supplier quote")).toBe(true);
      expect(s.steps[0].cost_keys).toContain("cdu.addition");
      // the engine's own flag, not ours: whatever it says is what the panel shows
      const raw = withQ.cost_evidence!.effect!.scenarios.find((x) => x.scenario === s.id)!;
      expect(s.complete_after).toBe(raw.capex_complete_after);
      expect(s.capex_after_eur).toBe(raw.capex_after_eur);
      // the quotation prices the works: the date does not move, and the panel says so
      expect(s.weeks_with).toBe(s.weeks_without);
      expect(s.date_unchanged).toBe(true);
    }
    expect(view.ignored).toEqual([]);
    expect(view.used[0].basis_label).toBe("firm supplier quote");
    // the library-priced base is untouched by it
    expect(base.cost_evidence).toBeUndefined();

    // a saved comparison can now rest on the project-level quotation (0054 gf_save_comparison), and the buyer page discloses no supplier text
    const { POST: save } = await import("@/app/api/power/compare/save/route");
    resetMemoryLimiter();
    const saved = await save(post("/api/power/compare/save", { compare: COMPARE, project: { project_token: token }, use_accepted_quotations: true }));
    expect(saved.status, JSON.stringify(await saved.clone().json())).toBe(201);
    expect((await j(saved)).quotations).toEqual({ offered: 1, applied: 1 });
    const [cmp] = await rows("project_comparisons", `&project_id=eq.${pid}`);
    expect(cmp.evidence_ids).toEqual([sub.id]);
    const { POST: shareRoute } = await import("@/app/api/projects/[token]/share/route");
    const sh = await j(await shareRoute(new Request(siteUrl("/x"), { method: "POST" }), ctx({ token })));
    const mod = await import("@/app/p/[shareToken]/page");
    const html = renderToStaticMarkup(await mod.default({ params: Promise.resolve({ shareToken: String(sh.share_path).replace("/p/", "") }) }));
    expect(html).toContain("1 accepted quotation");
    for (const s of ["SYNTHETIC-SUPPLIER", "R. Reviewer", "SYN-A-REF", "confidential scope wording", "317450", "317,450", "A. Holder", file.sha256, token]) expect(html, s).not.toContain(s);
  }, 120_000);

  it("keeps the unverified, rejected, expired and foreign quotations out, with the engine's own reason where it was asked", async () => {
    jar.length = 0;
    jar.push({ name: "gf_admin", value: adminToken()! });
    const a = await newProject();
    const b = await newProject();

    // project B accepts a quotation with a different supplier and price
    const fb = await upload(b.token, "b");
    const sb = await j(await submit(b.token, claim(fb.id, { supplier: "SYNTHETIC-SUPPLIER-B", price_eur: 999111, cost_key: "plant.uprate", scope: "plant works B" })));
    expect((await verifyFile(fb.id)).status).toBe(201);
    expect((await decide(sb.id, ACCEPT)).status).toBe(201);

    // project A: cannot cite B's file
    const fa = await upload(a.token, "a");
    const foreign = await submit(a.token, claim(fb.id));
    expect(foreign.status).toBe(404);
    expect((await rows("cost_evidence", `&project_id=eq.${a.id}`))).toHaveLength(0);

    // A: one unverified, one rejected, one verified+accepted that then passes its validity date
    const fRej = await upload(a.token, "rej");
    const fOld = await upload(a.token, "old");
    const unv = await j(await submit(a.token, claim(fa.id, { cost_key: "plant.uprate", scope: "plant works A", price_eur: 411250 })));
    const rej = await j(await submit(a.token, claim(fRej.id, { cost_key: "busway.replacement", unit: "EUR", scope: "busway A" })));
    const old = await j(await submit(a.token, claim(fOld.id, { valid_until: day(2) })));
    expect((await verifyFile(fRej.id)).status).toBe(201);
    expect((await decide(rej.id, { decision: "rejected", reviewer: "R. Reviewer", reason: "does not match the document" })).status).toBe(201);
    expect((await verifyFile(fOld.id)).status).toBe(201);
    expect((await decide(old.id, ACCEPT)).status).toBe(201);
    // the quotation's date passes (a fixture the append-only guard would otherwise refuse)
    ownerSql(`alter table public.cost_evidence disable trigger cost_evidence_append_only; update public.cost_evidence set received_on = '2019-01-01', valid_until = '2020-01-01' where id = '${old.id}'; alter table public.cost_evidence enable trigger cost_evidence_append_only;`);

    const mine = await claimsOf(a.token);
    const byId = new Map(mine.claims.map((c: any) => [c.id, c]));
    expect(byId.get(unv.id)).toMatchObject({ state: "validated", counted: false });
    expect(byId.get(rej.id)).toMatchObject({ state: "rejected", counted: false });
    expect((byId.get(rej.id) as any).reason).toMatch(/rejected it/);
    expect(byId.get(old.id)).toMatchObject({ state: "accepted", counted: false });
    expect((byId.get(old.id) as any).reason).toMatch(/validity date 2020-01-01 has passed/);

    // the engine is asked with the accepted-but-expired line only: it ignores it and says why, in its own words
    const out = await j(await compareRoute(a.token));
    expect(out.offered).toBe(1);
    expect(out.applied).toEqual([]);
    const ignored = (out.result as CompareResult).cost_evidence!.ignored;
    expect(ignored).toEqual([{ key: "cdu.addition", evidence_id: old.id, reason: "the quotation expired on 2020-01-01" }]);
    expect((out.result as CompareResult).cost_evidence!.used).toEqual([]);
    // ...and a comparison cannot be SAVED as quotation-backed on it
    resetMemoryLimiter();
    const { POST: save } = await import("@/app/api/power/compare/save/route");
    const refused = await save(post("/api/power/compare/save", { compare: COMPARE, project: { project_token: a.token }, use_accepted_quotations: true }));
    expect(refused.status).toBe(409);
    expect(await rows("project_comparisons", `&project_id=eq.${a.id}`)).toHaveLength(0);

    // confidentiality: nothing of project B's reaches A's answers
    for (const text of [JSON.stringify(out), JSON.stringify(mine)]) {
      for (const s of ["SYNTHETIC-SUPPLIER-B", "999111", "plant works B", fb.id, sb.id, b.id]) expect(text, s).not.toContain(s);
    }
    // and B's own list does not carry A's
    const theirs = JSON.stringify(await claimsOf(b.token));
    for (const s of ["411250", "plant works A", "busway A", unv.id, rej.id, old.id]) expect(theirs, s).not.toContain(s);
    // an unknown token reaches nothing
    expect((await submit("no-such-token", claim(fa.id))).status).toBe(404);
  }, 120_000);

  it("refuses a claim that is not a defensible quotation, before anything is stored", async () => {
    jar.length = 0;
    const { token, id: pid } = await newProject();
    const f = await upload(token, "v");
    const bad: [string, Record<string, unknown>][] = [
      ["a direction-changing character in the supplier", { supplier: "ACME\u202eSYN" }],
      ["a control character in the scope", { scope: "line one\nline two" }],
      ["a validity date that has passed", { valid_until: day(-1) }],
      ["a validity date of today", { valid_until: day(0) }],
      ["a validity date before the quotation date", { quoted_on: day(-1), valid_until: day(-2) }],
      ["a quotation date in the future", { quoted_on: day(30) }],
      ["a price of zero", { price_eur: 0 }],
      ["a negative price", { price_eur: -5 }],
      ["a price above the ceiling", { price_eur: 1e12 }],
      ["a price that is text", { price_eur: "317450" }],
      ["notes beyond the bound", { notes: "x".repeat(1001) }],
      ["a lead time of zero", { lead_time_weeks: 0 }],
      ["a lead time beyond 520 weeks", { lead_time_weeks: 521 }],
      ["a cost key the engine does not price from a quotation", { cost_key: "made.up_key" }],
      ["a unit that does not belong to the line", { cost_key: "tapoff.unit", unit: "EUR" }],
      ["a quantity on a per-unit price", { cost_key: "plant.uprate", unit: "EUR/kW", quoted_quantity: 5 }],
      ["a field the caller has no business setting", { state: "accepted" }],
      ["another file id", { file_id: "not-a-uuid" }],
    ];
    for (const [name, over] of bad) {
      const r = await submit(token, claim(f.id, over));
      expect(r.status, name).toBe(422);
    }
    expect((await submit(token, claim("00000000-0000-4000-8000-000000000000"))).status).toBe(404);   // a file that is nobody's
    expect(await rows("cost_evidence", `&project_id=eq.${pid}`)).toHaveLength(0);
    // the same bad values are also refused by the database itself (a caller holding only the service key)
    const sneaky = await rpc("gf_submit_project_quotation", {
      p: { project_id: pid, source_file_id: f.id, line_digest: "e".repeat(64), cost_key: "cdu.addition", unit: "EUR", value: 1, supplier: "ACME\u202eSYN", received_on: day(-1), valid_until: day(10), scope: "s", comparability: "exact", claimed_quote_type: "firm_quote", submitted_by: "x" },
      p_event: { event_type: "cost_evidence_received", actor: "x", occurred_at: new Date().toISOString(), payload: {} },
    });
    expect(sneaky.status).toBeGreaterThanOrEqual(400);
    expect(await rows("cost_evidence", `&project_id=eq.${pid}`)).toHaveLength(0);
  }, 120_000);

  it("retires an older accepted quotation of the same item and honours a withdrawal, for project-level quotations too", async () => {
    jar.length = 0;
    jar.push({ name: "gf_admin", value: adminToken()! });
    const { token } = await newProject();
    const f1 = await upload(token, "one");
    const f2 = await upload(token, "two");
    const first = await j(await submit(token, claim(f1.id)));
    const second = await j(await submit(token, claim(f2.id, { price_eur: 250000, quoted_on: day(-1) })));
    for (const f of [f1, f2]) expect((await verifyFile(f.id)).status).toBe(201);
    expect((await decide(first.id, ACCEPT)).status).toBe(201);
    const acc2 = await j(await decide(second.id, ACCEPT));
    expect(acc2.superseded).toEqual([first.id]);
    expect((await rows("cost_evidence_state", `&id=eq.${first.id}`))[0].state).toBe("superseded");
    const out = await j(await compareRoute(token));
    expect(out.offered).toBe(1);
    expect(out.applied).toEqual([second.id]);
    const { POST: wd } = await import("@/app/api/admin/cost-evidence/[id]/withdraw/route");
    expect((await wd(post("/x", { retired_by: "R. Reviewer", reason: "supplier withdrew it" }), ctx({ id: second.id }))).status).toBe(201);
    expect((await rows("cost_evidence_state", `&id=eq.${second.id}`))[0].state).toBe("withdrawn");
    expect((await j(await compareRoute(token))).offered).toBe(0);
  }, 120_000);

  it("shares one file with the hall registry: an origin 'quotation' input cites the SAME project_evidence row, nothing is duplicated", async () => {
    jar.length = 0;
    const { token, id: pid } = await newProject();
    const f = await upload(token, "hall");
    const sub = await j(await submit(token, claim(f.id)));
    const actor = `owner-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const org = (await rpc("gf_create_org", { p_actor: actor, p_name: "Org Q" })).body.org_id;
    const site = (await rpc("gf_create_site", { p_actor: actor, p_org: org, p_name: "Site Q", p_country: "IE", p_data_origin: "synthetic" })).body.site_id;
    const hall = (await rpc("gf_create_hall", { p_actor: actor, p_site: site, p_label: "Hall Q" })).body.hall_id;
    expect((await rpc("gf_attach_project_to_hall", { p_actor: actor, p_hall: hall, p_project_token: token })).body.ok).toBe(true);
    const input = await rpc("gf_record_hall_input", {
      p_actor: actor, p_hall: hall, p_field_path: "plant.cdu_quote_eur", p_value: 317450, p_unit: "EUR", p_evidence_class: "E3", p_origin: "quotation",
      p_project_evidence: f.id, p_intake_evidence: null, p_as_of: day(-3),
    });
    expect(input.status, JSON.stringify(input.body)).toBe(200);
    expect(input.body.input.source).toMatchObject({ kind: "project_evidence", id: f.id });
    // one file row serves both; the quotation claim and the hall figure name the same id
    expect(await rows("project_evidence", `&project_id=eq.${pid}`)).toHaveLength(1);
    const [claimRow] = await rows("cost_evidence", `&id=eq.${sub.id}`);
    expect(claimRow.source_file_id).toBe(f.id);
    // and a hall figure cannot cite a file the quotation's reviewer rejected
    const f2 = await upload(token, "hall2");
    jar.push({ name: "gf_admin", value: adminToken()! });
    const { POST } = await import("@/app/api/admin/evidence/[id]/review/route");
    expect((await POST(post("/x", { decision: "rejected", reviewer: "F. Keane", reason: "not a quotation" }), ctx({ id: f2.id }))).status).toBe(201);
    expect((await submit(token, claim(f2.id, { price_eur: 1234 }))).status).toBe(409);
    const refused = await rpc("gf_record_hall_input", { p_actor: actor, p_hall: hall, p_field_path: "plant.cdu_quote_eur2", p_value: 1, p_unit: "EUR", p_evidence_class: "E3", p_origin: "quotation", p_project_evidence: f2.id, p_intake_evidence: null, p_as_of: day(-3) });
    expect(refused.body.ok).toBe(false);                               // the registry answers a refused figure with ok:false, not a crash
    expect(JSON.stringify(refused.body)).toMatch(/rejected/);
  }, 120_000);
});
