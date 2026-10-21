/**
 * Accepted supplier quotations -> Time-to-Power comparison -> saved record -> read-only buyer page, against REAL PostgreSQL
 * through REAL PostgREST, with the REAL Python engine. The in-memory fake is not involved: the quotation lifecycle
 * (received -> accepted -> superseded / withdrawn) is driven through the real 0022 functions, and the guard in 0026 is
 * exercised as SQL.
 *
 * Every supplier, price and date here is a SYNTHETIC fixture (suppliers are named SYNTHETIC-SUPPLIER-x). The lines are
 * recorded with synthetic:false only because the product refuses synthetic lines; none is a real quotation.
 *
 * Skipped unless GF_PGRST_URL and GF_PGRST_JWT are set (scripts/realdb-up.sh) -- a skip is a gap in what was checked.
 */
import crypto from "node:crypto";
import http from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { resetMemoryLimiter } from "@/lib/rate-limit";

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT && spawnSync("python3", ["--version"]).status === 0;
const required = process.env.GF_REQUIRE_REALDB === "1";
const KEY = "quotation-realdb-key";
let engine: ChildProcess | null = null;
let gateway: http.Server | null = null;

describe("real-database prerequisites (quotation-backed comparison)", () => {
  it.runIf(required)("are present when the real database is required", () => {
    expect(PGRST).not.toBe("");
    expect(JWT).not.toBe("");
    expect(enabled).toBe(true);
  });
  it.runIf(required && enabled)("migrations 0022 and 0026 are applied", async () => {
    expect((await fetch(`${PGRST}/cost_evidence?limit=1`, { headers: { Authorization: `Bearer ${JWT}` } })).status).toBe(200);
    expect((await fetch(`${PGRST}/project_comparisons?select=evidence_ids&limit=1`, { headers: { Authorization: `Bearer ${JWT}` } })).status).toBe(200);
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

/** Supabase's gateway serves PostgREST under /rest/v1; this does the same and nothing else. */
async function startGateway(): Promise<string> {
  gateway = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = req.url ?? "";
    if (!url.startsWith("/rest/v1/")) { res.writeHead(404).end("{}"); return; }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
    const r = await fetch(PGRST + url.slice("/rest/v1".length), { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : body });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
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
const psql = (statement: string) => {
  const r = spawnSync("psql", ["-X", "-q", "-At", "-d", process.env.GF_PG_DB ?? "gf", "-c", statement], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql failed: ${String(r.stderr).split("\n")[0]}`);
  return r.stdout.trim();
};

const HALL = {
  siteName: "Realdb Hall", hallId: "H1", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4, currentItLoadMW: 4.9,
  buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180, plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};
const post = (path: string, body: unknown) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}` }, body: JSON.stringify(body) });
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const j = async (r: Response) => (await r.json()) as any;
const save = async (body: Record<string, unknown>) =>
  (await import("@/app/api/power/compare/save/route")).POST(post("/api/power/compare/save", { compare: { hall: HALL, objective: "fastest" }, ...body }));
async function page(shareToken: string) {
  const mod = await import("@/app/p/[shareToken]/page");
  return renderToStaticMarkup(await mod.default({ params: Promise.resolve({ shareToken }) }));
}
async function newProject(name = `Quotation chain ${crypto.randomUUID().slice(0, 8)}`) {
  resetMemoryLimiter();
  const res = await save({ project: { project_name: name } });
  expect(res.status).toBe(201);
  const token = (await j(res)).project_token as string;
  const [row] = await rows("projects", `&project_token=eq.${token}`);
  return { token, id: row.id as string };
}
async function share(token: string) {
  const r = await (await import("@/app/api/projects/[token]/share/route")).POST(new Request(siteUrl("/x"), { method: "POST" }), ctx(token));
  expect(r.status).toBe(201);
  return ((await j(r)).share_path as string).replace("/p/", "");
}

const event = (type: string) => ({ event_type: type, actor: "realdb-test", occurred_at: new Date().toISOString(), payload: {} });
const hex = () => crypto.randomBytes(32).toString("hex");

/** An engagement (a released procurement_spec deliverable), optionally linked to a project. */
async function engagement(projectId: string | null) {
  const d = (await (await sql("/deliverables", {
    method: "POST", body: JSON.stringify({ token: crypto.randomBytes(12).toString("hex"), kind: "procurement_spec", status: "released", intake: { _gridforge: { review: { by: "A. Reviewer" } } } }),
  })).json())[0];
  if (projectId) await sql("/project_links", { method: "POST", body: JSON.stringify({ project_id: projectId, object_type: "deliverable", object_id: d.id }) });
  return d.id as string;
}

/** One quotation line through the real 0022 functions: received, then (optionally) reviewed. */
async function line(deliverableId: string, opts: { key?: string; value?: number; decision?: "accepted" | "rejected" | null; synthetic?: boolean; receivedOn?: string; validUntil?: string } = {}) {
  const key = opts.key ?? "cdu.addition";
  const sub = await rpc("gf_submit_cost_evidence", {
    p: {
      deliverable_id: deliverableId, line_digest: hex(), cost_key: key, unit: "EUR", value: opts.value ?? 317450, submitted_value: opts.value ?? 317450,
      currency: "EUR", supplier: "SYNTHETIC-SUPPLIER-A", received_on: opts.receivedOn ?? "2026-10-01", valid_until: opts.validUntil ?? "2099-12-31",
      reference: "SYN-A-REF", scope: "supply, install, commission (confidential scope wording)", quoted_quantity: null, quoted_quantity_unit: null,
      specification: {}, response_digest: hex(), validation_status: "validated", problems: [], limitations: [], comparability: "exact",
      synthetic: opts.synthetic === true,
    },
    p_event: event("cost_evidence_received"),
  });
  expect(sub.status, JSON.stringify(sub.body)).toBe(200);
  const id = sub.body.id as string;
  if (opts.decision !== null) {
    const rev = await rpc("gf_review_cost_evidence", {
      p: opts.decision === "rejected"
        ? { evidence_id: id, decision: "rejected", reviewer: "Confidential Reviewer", reason: "synthetic" }
        : { evidence_id: id, decision: "accepted", basis: "firm_quote", comparability: "exact", includes_keys: [], region: "", reviewer: "Confidential Reviewer", reason: null },
      p_event: event("cost_evidence_reviewed"),
    });
    expect(rev.status, JSON.stringify(rev.body)).toBe(200);
  }
  return id;
}
const withdraw = (id: string) => rpc("gf_retire_cost_evidence", { p: { evidence_id: id, retired_by: "Confidential Reviewer", reason: "synthetic" }, p_event: event("cost_evidence_retired") });
const SECRETS = ["SYNTHETIC-SUPPLIER", "Confidential Reviewer", "SYN-A-REF", "confidential scope wording", "317450", "317,450"];

describe.skipIf(!enabled)("accepted quotations -> comparison -> record -> buyer page — real PostgreSQL via PostgREST", () => {
  it("prices a saved comparison on the project's accepted quotations, and the buyer page says exactly that and no more", async () => {
    const { token, id: pid } = await newProject();
    // Two engagements linked to the project exercise the multi-value read against real PostgREST.
    const e1 = await engagement(pid), e2 = await engagement(pid);
    const cdu = await line(e1, { key: "cdu.addition" });
    const plant = await line(e2, { key: "plant.uprate", value: 411250 });

    resetMemoryLimiter();
    const res = await save({ project: { project_token: token }, use_accepted_quotations: true });
    expect(res.status).toBe(201);
    const body = await j(res);
    expect(body.quotations).toEqual({ offered: 2, applied: 2 });

    const [cmp] = await rows("project_comparisons", `&id=eq.${body.comparison_id}`);
    expect(cmp.evidence_ids.sort()).toEqual([cdu, plant].sort());
    expect(cmp.request.cost_evidence.map((e: any) => e.evidence_id).sort()).toEqual([cdu, plant].sort());
    expect(cmp.result.cost_evidence.used.map((u: any) => u.evidence_id).sort()).toEqual([cdu, plant].sort());
    const events = await rows("project_events", `&project_id=eq.${pid}&event_type=eq.comparison_saved&order=occurred_at.asc`);
    expect(events.at(-1).payload).toMatchObject({ comparison_id: cmp.id, quotation_lines: 2 });

    const link = await share(token);
    const html = await page(link);
    expect(html).toContain("2 accepted quotations");
    expect(html).toContain("Quotation 1");
    expect(html).toContain("Quotation 2");
    expect(html).toMatch(/firm quote/);
    expect(html).toMatch(/still accepted and in date/);
    expect(html).toMatch(/Incomplete — a lower bound, not a price/);
    expect(html).toMatch(/library placeholder/);
    for (const s of SECRETS) expect(html, s).not.toContain(s);
    expect(html).not.toContain(token);

    // The record the owner holds is exactly what the engine said, reproducible from the stored request.
    const again = await j(await fetch(`${process.env.GRIDFORGE_API_URL}/v1/compare`, { method: "POST", headers: { "content-type": "application/json", "x-api-key": KEY }, body: JSON.stringify(cmp.request) }));
    expect(again.request_digest).toBe(cmp.request_digest);
    expect(again.provenance.digest).toBe(cmp.provenance_digest);
  });

  it("a quotation withdrawn or replaced afterwards leaves the saved record untouched and makes the page say it is not current", async () => {
    const { token, id: pid } = await newProject();
    const e1 = await engagement(pid);
    const first = await line(e1);
    resetMemoryLimiter();
    const saved1 = await j(await save({ project: { project_token: token }, use_accepted_quotations: true }));
    const link = await share(token);
    const before = JSON.stringify(await rows("project_comparisons", `&project_id=eq.${pid}&order=id.asc`));
    expect(await page(link)).toMatch(/still accepted and in date/);

    // A better quotation for the same item is accepted: the database retires the first one in the same transaction.
    const second = await line(e1, { value: 250000, receivedOn: "2026-10-05" });
    const [firstNow] = await rows("cost_evidence_state", `&id=eq.${first}`);
    expect(firstNow.state).toBe("superseded");
    let html = await page(link);
    expect(html).toContain("This comparison is no longer current.");
    expect(html).toMatch(/replaced by a newer accepted quotation/);
    expect(JSON.stringify(await rows("project_comparisons", `&project_id=eq.${pid}&order=id.asc`))).toBe(before);

    // Saving again prices on the new quotation: a second record, the first still as it was.
    resetMemoryLimiter();
    const saved2 = await j(await save({ project: { project_token: token }, use_accepted_quotations: true }));
    expect(saved2.created).toBe(true);
    expect(saved2.comparison_id).not.toBe(saved1.comparison_id);
    const [cmp2] = await rows("project_comparisons", `&id=eq.${saved2.comparison_id}`);
    expect(cmp2.evidence_ids).toEqual([second]);
    html = await page(link);
    expect(html).toMatch(/still accepted and in date/);
    expect(html).not.toContain("This comparison is no longer current.");
    expect(html).toMatch(/2 earlier saved comparisons/);   // the library-priced one and the first quotation-backed one

    // The supplier withdraws it: current -> not current, with nothing rewritten.
    const snapshot = JSON.stringify(await rows("project_comparisons", `&project_id=eq.${pid}&order=id.asc`));
    expect((await withdraw(second)).status).toBe(200);
    html = await page(link);
    expect(html).toMatch(/has since been withdrawn/);
    expect(JSON.stringify(await rows("project_comparisons", `&project_id=eq.${pid}&order=id.asc`))).toBe(snapshot);
    // ... and a request to price on quotations now has none to use.
    resetMemoryLimiter();
    const none = await save({ project: { project_token: token }, use_accepted_quotations: true });
    expect(none.status).toBe(409);
  });

  it("evidence of another project, unreviewed, rejected or synthetic lines never reach the engine through the route", async () => {
    const mine = await newProject();
    const theirs = await newProject();
    await line(await engagement(theirs.id));                                   // accepted, but theirs
    await line(await engagement(mine.id), { decision: null });                 // received, never reviewed
    await line(await engagement(mine.id), { decision: "rejected" });
    await line(await engagement(mine.id), { synthetic: true });
    await line(await engagement(null));                                        // accepted, attached to no project
    resetMemoryLimiter();
    const before = (await rows("project_comparisons", `&project_id=eq.${mine.id}`)).length;
    const res = await save({ project: { project_token: mine.token }, use_accepted_quotations: true });
    expect(res.status).toBe(409);
    expect((await rows("project_comparisons", `&project_id=eq.${mine.id}`)).length).toBe(before);
    const buyer = await page(await share(mine.token));
    expect(buyer).toContain("library-priced · no supplier quotation");
    expect(buyer).not.toContain("Quotation 1");
  });
});

describe.skipIf(!enabled)("gf_save_comparison refuses a claim the evidence does not support (migration 0026)", () => {
  /** A syntactically complete comparison record; the guard is about the evidence, so the digests are fresh each time. */
  const record = (projectId: string | null, evidence: string[]) => ({
    ...(projectId ? { project_id: projectId } : {}),
    request: { intake: {} }, result: { schema: "gridforge/ttp-compare/1" }, schema: "gridforge/ttp-compare/1",
    request_digest: hex(), provenance_digest: hex(), engine_version: "test", grade: "indicative", evidence_ids: evidence,
    saved_at: new Date().toISOString(),
  });
  const attempt = (projectId: string | null, evidence: string[], extra: Record<string, unknown> = {}) =>
    rpc("gf_save_comparison", { p: record(projectId, evidence), p_event: event("comparison_saved"), ...extra });
  const count = async (pid: string) => ({
    comparisons: (await rows("project_comparisons", `&project_id=eq.${pid}`)).length,
    events: (await rows("project_events", `&project_id=eq.${pid}&event_type=eq.comparison_saved`)).length,
  });

  it("stores accepted evidence of the project, deduplicated, and nothing else", async () => {
    const { id: pid } = await newProject();
    const good = await line(await engagement(pid));
    const ok = await attempt(pid, [good, good]);
    expect(ok.status).toBe(200);
    expect(ok.body.created).toBe(true);
    const [row] = await rows("project_comparisons", `&id=eq.${ok.body.comparison_id}`);
    expect(row.evidence_ids).toEqual([good]);
    // No evidence is the unchanged, library-priced record.
    const plain = await attempt(pid, []);
    expect(plain.status).toBe(200);
    expect((await rows("project_comparisons", `&id=eq.${plain.body.comparison_id}`))[0].evidence_ids).toEqual([]);
  });

  it("refuses, writing nothing, evidence that is not accepted evidence of this project", async () => {
    const mine = await newProject();
    const theirs = await newProject();
    const cases: [string, string][] = [
      ["a line of another project", await line(await engagement(theirs.id))],
      ["a line never reviewed", await line(await engagement(mine.id), { decision: null })],
      ["a rejected line", await line(await engagement(mine.id), { decision: "rejected" })],
      ["a synthetic line", await line(await engagement(mine.id), { synthetic: true })],
      ["an id that is no line at all", crypto.randomUUID()],
    ];
    const withdrawn = await line(await engagement(mine.id));
    expect((await withdraw(withdrawn)).status).toBe(200);
    cases.push(["a withdrawn line", withdrawn]);
    const eOld = await engagement(mine.id);
    const old = await line(eOld);
    await line(eOld, { value: 250000, receivedOn: "2026-10-05" });                       // retires `old` in the same transaction
    cases.push(["a superseded line", old]);
    // An accepted line whose engagement is no longer linked to the project.
    const eUnlinked = await engagement(mine.id);
    const unlinked = await line(eUnlinked);
    const del = await sql(`/project_links?project_id=eq.${mine.id}&object_id=eq.${eUnlinked}`, { method: "DELETE" });
    if (del.ok) cases.push(["a line whose engagement is not linked", unlinked]);

    const before = await count(mine.id);
    for (const [label, id] of cases) {
      const r = await attempt(mine.id, [id]);
      expect(r.status, label).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(r.body), label).toMatch(/23514|accepted quotations of its own project/);
    }
    // One bad line among good ones refuses the whole record.
    const good = await line(await engagement(mine.id));
    expect((await attempt(mine.id, [good, theirsLine(cases)])).status).toBeGreaterThanOrEqual(400);
    expect(await count(mine.id)).toEqual(before);
  });

  const theirsLine = (cases: [string, string][]) => cases[0][1];

  it("a new project cannot be created with evidence it cannot have, and the failed create leaves no project behind", async () => {
    const other = await newProject();
    const mine = await line(await engagement(other.id));
    const token = crypto.randomBytes(16).toString("hex");
    const r = await attempt(null, [mine], {
      p_new_project: { project_token: token, company: null, project_name: "never created", site_label: null, location: null, status: "draft", created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
      p_new_event: event("project_created"),
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await rows("projects", `&project_token=eq.${token}`)).toHaveLength(0);
  });

  it("a saved comparison's evidence cannot be edited or removed, even by the service role", async () => {
    const { id: pid } = await newProject();
    const a = await line(await engagement(pid));
    const b = await line(await engagement(pid), { key: "plant.uprate" });
    const ok = await attempt(pid, [a]);
    const patch = await sql(`/project_comparisons?id=eq.${ok.body.comparison_id}`, { method: "PATCH", body: JSON.stringify({ evidence_ids: [b] }) });
    expect(patch.status).toBeGreaterThanOrEqual(400);
    const del = await sql(`/project_comparisons?id=eq.${ok.body.comparison_id}`, { method: "DELETE" });
    expect(del.status).toBeGreaterThanOrEqual(400);
    expect((await rows("project_comparisons", `&id=eq.${ok.body.comparison_id}`))[0].evidence_ids).toEqual([a]);
  });

  it("serialises with a withdrawal: a comparison is never stored on a line that was already withdrawn", async () => {
    const { id: pid } = await newProject();
    const outcomes = { savedFirst: 0, refused: 0 };
    for (let i = 0; i < 12; i++) {
      const id = await line(await engagement(pid), { key: i % 2 ? "plant.uprate" : "cdu.addition" });
      const [saveR, retireR] = await Promise.all([attempt(pid, [id]), withdraw(id)]);
      expect(retireR.status).toBe(200);                                            // a withdrawal of an accepted line always succeeds
      if (saveR.status === 200) {
        outcomes.savedFirst += 1;
        // Both committed, so the save's transaction must have come first: it took the lock before the withdrawal did.
        const cmpX = Number(psql(`select xmin::text from project_comparisons where id = '${saveR.body.comparison_id}'`));
        const retX = Number(psql(`select xmin::text from cost_evidence_retirements where evidence_id = '${id}'`));
        expect(cmpX, `iteration ${i}`).toBeLessThan(retX);
      } else {
        outcomes.refused += 1;
        expect(JSON.stringify(saveR.body)).toMatch(/23514/);
        expect(await rows("project_comparisons", `&project_id=eq.${pid}&evidence_ids=cs.{${id}}`)).toHaveLength(0);
      }
    }
    expect(outcomes.savedFirst + outcomes.refused).toBe(12);
  });
});
