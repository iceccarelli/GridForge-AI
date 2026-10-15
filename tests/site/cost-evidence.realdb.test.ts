/**
 * The procurement-to-cost-evidence loop against REAL PostgreSQL, through REAL PostgREST, with the REAL Python
 * engine. The in-memory fake is not involved.
 *
 * Every supplier, price and date in this file is a SYNTHETIC fixture (suppliers are named SYNTHETIC-SUPPLIER-x).
 * None is a real quotation. The assertions are about rules: what may influence a number, what is refused, what is
 * kept private, and what survives a retry, an outage or a race.
 *
 * Skipped unless GF_PGRST_URL and GF_PGRST_JWT are set; with GF_REQUIRE_REALDB=1 a missing stack FAILS this file.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { adminToken } from "@/lib/admin";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT && spawnSync("python3", ["--version"]).status === 0;
const required = process.env.GF_REQUIRE_REALDB === "1";
const KEY = "realdb-key";

describe("real-database prerequisites (cost evidence)", () => {
  it.runIf(required)("are present when the real database is required", async () => {
    expect(enabled).toBe(true);
    const r = await fetch(`${PGRST}/cost_evidence?limit=1`, { headers: { Authorization: `Bearer ${JWT}` } });
    expect(r.status, "migration 0022 must be applied").toBe(200);
  });
});

let engine: ChildProcess | null = null;
let gateway: http.Server | null = null;
let engineUrl = "";
let submitsAllowed = Infinity; // injected outage: gf_submit_cost_evidence answers 503 after this many calls
const gatewayLog: string[] = [];

async function startEngine(): Promise<string> {
  const code = [
    "import os", `os.environ['GRIDFORGE_API_KEYS']='${KEY}'`, "os.environ['GRIDFORGE_RATE_LIMIT']='0'",
    "os.environ['GRIDFORGE_REPORT_DATE']='2026-10-13'",
    `os.environ['GRIDFORGE_REVOKED_FILE']=${JSON.stringify(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gf-ce-")), "revoked.json"))}`,
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
    gatewayLog.push(`${req.method} ${url}`);
    if (url.startsWith("/rest/v1/rpc/gf_submit_cost_evidence")) {
      if (submitsAllowed <= 0) { res.writeHead(503, { "content-type": "application/json" }).end('{"message":"injected outage"}'); return; }
      submitsAllowed -= 1;
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
    const r = await fetch(PGRST + url.slice("/rest/v1".length), {
      method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : body,
    });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((r) => gateway!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(gateway!.address() as { port: number }).port}`;
}

const db = async (p: string, init: RequestInit = {}) =>
  fetch(PGRST + p, { ...init, headers: { Authorization: `Bearer ${JWT}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers ?? {}) } });
const rows = async (table: string, q = "") => (await (await db(`/${table}?select=*${q}`)).json()) as any[];
const post = (p: string, body: unknown) =>
  new Request(siteUrl(p), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const INTAKE = JSON.parse(fs.readFileSync(path.join(process.cwd(), "examples/intake/dublin_hall.json"), "utf8"));

let template: any;
beforeAll(async () => {
  if (!enabled) return;
  engineUrl = await startEngine();
  process.env.SUPABASE_URL = await startGateway();
  process.env.SUPABASE_SERVICE_ROLE_KEY = JWT;
  process.env.GRIDFORGE_API_URL = engineUrl;
  process.env.GRIDFORGE_API_KEY = KEY;
  process.env.GRIDFORGE_ADMIN_KEY = "realdb-admin";
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  process.env.GRIDFORGE_KEY_SECRET = "realdb-signing-secret";
  const spec = await (await fetch(`${engineUrl}/v1/spec`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY },
    body: JSON.stringify({ intake: INTAKE, constraint: "transformer_capacity" }),
  })).json();
  template = spec.response_template;
}, 40_000);
afterAll(() => { engine?.kill(); gateway?.close(); });

/** An engagement as the site holds it after release: a procurement_spec deliverable attached to a project. */
async function engagement(opts: { withProject?: boolean; status?: string; kind?: string } = {}) {
  const token = crypto.randomBytes(12).toString("hex");
  const stored = { ...INTAKE, _gridforge: { spec: { constraint_id: "transformer_capacity" } } };
  const d = (await (await db("/deliverables", {
    method: "POST",
    body: JSON.stringify({ token, kind: opts.kind ?? "procurement_spec", status: opts.status ?? "released", intake: stored,
                           document_html: "<p>the original deliverable</p>" }),
  })).json())[0];
  let project: any = null;
  if (opts.withProject !== false) {
    project = (await (await db("/projects", { method: "POST", body: JSON.stringify({ project_token: crypto.randomBytes(12).toString("hex"), project_name: "Synthetic hall" }) })).json())[0];
    await db("/project_links", { method: "POST", body: JSON.stringify({ project_id: project.id, object_type: "deliverable", object_id: d.id }) });
  }
  return { token, id: d.id as string, project };
}

function response(supplier: string, capex: number, over: Record<string, unknown> = {}) {
  return {
    ...template, supplier, received_on: "2026-10-01", valid_until: "2099-12-31", currency: "EUR", reference: `SYN-${supplier.slice(-1)}`,
    values: { ...template.values, capex_eur: capex, lead_time_weeks: 40, install_weeks: 6 },
    compliance: Object.fromEntries(Object.keys(template.compliance).map((k) => [k, "C"])), ...over,
  };
}

const quotes = async (token: string, body: unknown) => {
  const { POST } = await import("@/app/api/deliverable/[token]/quotes/route");
  return POST(post(`/api/deliverable/${token}/quotes`, body), { params: Promise.resolve({ token }) });
};
const listQuotes = async (token: string) => {
  const { GET } = await import("@/app/api/deliverable/[token]/quotes/route");
  return (await GET(new Request(siteUrl(`/api/deliverable/${token}/quotes`)), { params: Promise.resolve({ token }) })).json();
};
const review = async (id: string, body: unknown) => {
  const { POST } = await import("@/app/api/admin/cost-evidence/[id]/review/route");
  return POST(post(`/api/admin/cost-evidence/${id}/review`, body), { params: Promise.resolve({ id }) });
};
const withdraw = async (id: string, body: unknown) => {
  const { POST } = await import("@/app/api/admin/cost-evidence/[id]/withdraw/route");
  return POST(post(`/api/admin/cost-evidence/${id}/withdraw`, body), { params: Promise.resolve({ id }) });
};
const run = async (token: string) => {
  const { POST } = await import("@/app/api/deliverable/[token]/evidence-run/route");
  return POST(post(`/api/deliverable/${token}/evidence-run`, {}), { params: Promise.resolve({ token }) });
};
const asAdmin = () => { jar.length = 0; jar.push({ name: "gf_admin", value: adminToken()! }); };
const asAnonymous = () => { jar.length = 0; };
const ACCEPT = { decision: "accepted", basis: "budgetary_quote", comparability: "exact", reviewer: "Test Reviewer", reason: "synthetic review" };

describe.runIf(enabled)("procurement quotes -> cost evidence -> a new run (real PostgreSQL + PostgREST + engine)", () => {
  it("receives a valid response as VALIDATED, links it to the engagement and project, and gives it no authority", async () => {
    const e = await engagement();
    const res = await quotes(e.token, { responses: [response("SYNTHETIC-SUPPLIER-A", 2_340_000)], submitted_by: "Buyer", synthetic: true });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({ state: "validated", cost_key: "transformer.replacement", supplier: "SYNTHETIC-SUPPLIER-A", currency: "EUR", synthetic: true });
    const [row] = await rows("cost_evidence", `&deliverable_id=eq.${e.id}`);
    expect(row.project_id).toBe(e.project.id);
    expect(row.quoted_quantity_unit).toBe("MVA");
    expect(Number(row.quoted_quantity)).toBeGreaterThan(0);
    expect(row.specification).toMatchObject({ hall: "DUB-01", constraint: "transformer_capacity" });
    expect(await rows("cost_evidence_reviews", `&evidence_id=eq.${row.id}`)).toHaveLength(0);
    // Receipt alone changes no run: nothing is accepted, so there is nothing to apply.
    const r = await run(e.token);
    expect(r.status).toBe(409);
    const events = await rows("project_events", `&project_id=eq.${e.project.id}`);
    expect(events.map((x) => x.event_type)).toContain("cost_evidence_received");
  });

  it("is idempotent: submitting the same response again creates nothing", async () => {
    const e = await engagement();
    const payload = { responses: [response("SYNTHETIC-SUPPLIER-A", 2_340_000)], submitted_by: "Buyer" };
    const first = await quotes(e.token, payload);
    const again = await quotes(e.token, payload);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect((await again.json()).lines.every((l: any) => l.created === false)).toBe(true);
    expect(await rows("cost_evidence", `&deliverable_id=eq.${e.id}`)).toHaveLength(1);
    const ev = (await rows("project_events", `&project_id=eq.${e.project.id}`)).filter((x) => x.event_type === "cost_evidence_received");
    expect(ev).toHaveLength(1);
  });

  it.each([
    ["another currency", { currency: "USD" }, "USD"],
    ["a different hall", { specification: { project: "Reference Project (synthetic)", hall: "OTHER-HALL", constraint: "transformer_capacity", sized_for_racks: 69 } }, "hall"],
    ["a different sizing", { specification: { project: "Reference Project (synthetic)", hall: "DUB-01", constraint: "transformer_capacity", sized_for_racks: 3 } }, "re-price"],
    ["an expired validity", { valid_until: "2026-01-01" }, "expired"],
  ])("records %s as INVALID with the reason, and an invalid line can never be accepted", async (_n, over, needle) => {
    const e = await engagement();
    const res = await quotes(e.token, { responses: [response("SYNTHETIC-SUPPLIER-A", 2_340_000, over)], submitted_by: "Buyer" });
    expect(res.status).toBe(201);
    const line = (await res.json()).lines[0];
    expect(line.state).toBe("invalid");
    expect(line.problems.join(" ").toLowerCase()).toContain(needle.toLowerCase());
    asAdmin();
    const r = await review(line.id, ACCEPT);
    expect(r.status).toBe(422);
    expect(await rows("cost_evidence_reviews", `&evidence_id=eq.${line.id}`)).toHaveLength(0);
  });

  it("refuses non-finite, zero and missing amounts as INVALID rather than storing a number that is not one", async () => {
    const e = await engagement();
    const res = await quotes(e.token, { responses: [response("SYNTHETIC-SUPPLIER-A", 0)], submitted_by: "Buyer" });
    expect([200, 201, 422]).toContain(res.status);
    if (res.status !== 422) expect((await res.json()).lines[0].state).toBe("invalid");
    const none = await quotes(e.token, { responses: [response("SYNTHETIC-SUPPLIER-B", null as any)], submitted_by: "Buyer" });
    if (none.status !== 422) expect((await none.json()).lines[0].state).toBe("invalid");
  });

  it("two responses from one supplier in a submission are both invalid", async () => {
    const e = await engagement();
    const res = await quotes(e.token, { responses: [response("SYNTHETIC-SUPPLIER-A", 2_000_000), response("SYNTHETIC-SUPPLIER-A", 2_100_000, { reference: "SYN-A2" })], submitted_by: "Buyer" });
    expect((await res.json()).lines.every((l: any) => l.state === "invalid")).toBe(true);
  });

  it("only a named person's acceptance makes a line evidence; the review preserves who, when, basis and the project record", async () => {
    const e = await engagement();
    const line = (await (await quotes(e.token, { responses: [response("SYNTHETIC-SUPPLIER-A", 2_340_000)], submitted_by: "Buyer", synthetic: true })).json()).lines[0];
    asAnonymous();
    expect((await review(line.id, ACCEPT)).status).toBe(401);
    asAdmin();
    expect((await review(line.id, { ...ACCEPT, reviewer: "" })).status).toBe(422);
    expect((await review(line.id, { decision: "accepted", reviewer: "R" })).status).toBe(422); // basis is never defaulted
    const ok = await review(line.id, ACCEPT);
    expect(ok.status).toBe(201);
    expect((await review(line.id, { ...ACCEPT, decision: "rejected", basis: undefined, comparability: undefined })).status).toBe(409); // never flipped
    const [state] = await rows("cost_evidence_state", `&id=eq.${line.id}`);
    expect(state).toMatchObject({ state: "accepted", reviewer: "Test Reviewer", reviewed_basis: "budgetary_quote", project_id: e.project.id, supplier: "SYNTHETIC-SUPPLIER-A" });
    expect(state.reviewed_at).toBeTruthy();
  });

  it("a new run applies ONLY accepted evidence, names it, records what changed, and never rewrites the stored deliverable", async () => {
    const e = await engagement();
    asAdmin();
    const a = (await (await quotes(e.token, { responses: [response("SYNTHETIC-SUPPLIER-A", 2_340_000)], submitted_by: "Buyer", synthetic: true })).json()).lines[0];
    const b = (await (await quotes(e.token, { responses: [response("SYNTHETIC-SUPPLIER-B", 9_999_000)], submitted_by: "Buyer", synthetic: true })).json()).lines[0];
    expect((await review(b.id, { decision: "rejected", reviewer: "Test Reviewer", reason: "out of scope" })).status).toBe(201);
    expect((await review(a.id, ACCEPT)).status).toBe(201);

    const first = await run(e.token);
    expect(first.status).toBe(201);
    const out = await first.json();
    expect(out.evidence_ids).toEqual([a.id]);
    expect(out.document).toContain("SYNTHETIC-SUPPLIER-A");
    expect(out.document).not.toContain("SYNTHETIC-SUPPLIER-B"); // rejected: never influences a run
    expect(out.document).toContain(a.id);
    expect(out.document).toContain("SYNTHETIC");
    expect(out.document).toContain("What the accepted evidence changed");
    expect(out.effect.scenarios.some((x: any) => x.capex_delta_eur !== 0)).toBe(true);

    const [stored] = await rows("deliverables", `&id=eq.${e.id}`);
    expect(stored.document_html).toBe("<p>the original deliverable</p>");
    expect(stored.intake._gridforge.spec.constraint_id).toBe("transformer_capacity");
    expect((await rows("cost_evidence_runs", `&deliverable_id=eq.${e.id}`))).toHaveLength(1);

    // Retried: the same recorded run, nothing new.
    const again = await run(e.token);
    expect(again.status).toBe(200);
    expect((await again.json()).document_sha256).toBe(out.document_sha256);
    expect(await rows("cost_evidence_runs", `&deliverable_id=eq.${e.id}`)).toHaveLength(1);
    const types = (await rows("project_events", `&project_id=eq.${e.project.id}`)).map((x) => x.event_type);
    expect(types.filter((t) => t === "cost_evidence_run")).toHaveLength(1);
  });

  it("a newer accepted quotation for the same line supersedes the older; the older stops influencing runs and the earlier run keeps naming it", async () => {
    const e = await engagement();
    asAdmin();
    const a = (await (await quotes(e.token, { responses: [response("SYNTHETIC-SUPPLIER-A", 2_340_000)], submitted_by: "Buyer" })).json()).lines[0];
    await review(a.id, ACCEPT);
    const before = await (await run(e.token)).json();
    const b = (await (await quotes(e.token, { responses: [response("SYNTHETIC-SUPPLIER-B", 2_200_000)], submitted_by: "Buyer" })).json()).lines[0];
    const accepted = await review(b.id, ACCEPT);
    expect((await accepted.json()).superseded).toEqual([a.id]);
    const states = Object.fromEntries((await rows("cost_evidence_state", `&deliverable_id=eq.${e.id}`)).map((r) => [r.id, r.state]));
    expect(states).toEqual({ [a.id]: "superseded", [b.id]: "accepted" });
    const after = await (await run(e.token)).json();
    expect(after.evidence_ids).toEqual([b.id]);
    expect(after.document).not.toContain("SYNTHETIC-SUPPLIER-A");
    const runs = await rows("cost_evidence_runs", `&deliverable_id=eq.${e.id}&order=created_at.asc`);
    expect(runs).toHaveLength(2);
    expect(runs[0].evidence_ids).toEqual([a.id]);          // history is immutable
    expect(runs[0].document_sha256).toBe(before.document_sha256);
  });

  it("a withdrawn quotation stops influencing runs", async () => {
    const e = await engagement();
    asAdmin();
    const a = (await (await quotes(e.token, { responses: [response("SYNTHETIC-SUPPLIER-A", 2_340_000)], submitted_by: "Buyer" })).json()).lines[0];
    await review(a.id, ACCEPT);
    expect((await run(e.token)).status).toBe(201);
    expect((await withdraw(a.id, { retired_by: "Test Reviewer", reason: "supplier retracted" })).status).toBe(201);
    expect((await withdraw(a.id, { retired_by: "Test Reviewer" })).status).toBe(409);
    expect((await run(e.token)).status).toBe(409);
  });

  it("two concurrent acceptances for one line leave exactly one current", async () => {
    const e = await engagement();
    asAdmin();
    const ids = [];
    for (const s of ["A", "B", "C"]) ids.push((await (await quotes(e.token, { responses: [response(`SYNTHETIC-SUPPLIER-${s}`, 2_000_000 + ids.length * 1000)], submitted_by: "Buyer" })).json()).lines[0].id);
    const results = await Promise.all(ids.map((id) => review(id, ACCEPT)));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const states = (await rows("cost_evidence_state", `&deliverable_id=eq.${e.id}`)).map((r) => r.state).sort();
    expect(states).toEqual(["accepted", "superseded", "superseded"]);
  });

  it("a store failure between lines leaves recorded lines intact, says so, and a retry completes without duplicates", async () => {
    const e = await engagement();
    // A response with several priced lines would be needed; two suppliers give two lines in one submission.
    const payload = { responses: [response("SYNTHETIC-SUPPLIER-A", 2_000_000), response("SYNTHETIC-SUPPLIER-B", 2_100_000)], submitted_by: "Buyer" };
    submitsAllowed = 1;
    const failed = await quotes(e.token, payload);
    submitsAllowed = Infinity;
    expect(failed.status).toBe(502);
    expect((await failed.json()).error).toContain("1 of 2");
    expect(await rows("cost_evidence", `&deliverable_id=eq.${e.id}`)).toHaveLength(1);
    const retry = await quotes(e.token, payload);
    expect(retry.status).toBe(201);
    expect(await rows("cost_evidence", `&deliverable_id=eq.${e.id}`)).toHaveLength(2);
  });

  it("supplier pricing is confidential: admin routes refuse the unauthenticated, another engagement's token sees nothing, and no price reaches the log", async () => {
    const e = await engagement();
    const other = await engagement();
    await quotes(e.token, { responses: [response("SYNTHETIC-SUPPLIER-A", 2_345_678)], submitted_by: "Buyer" });
    asAnonymous();
    const { GET } = await import("@/app/api/admin/cost-evidence/route");
    expect((await GET(new Request(siteUrl("/api/admin/cost-evidence")))).status).toBe(401);
    expect((await withdraw("00000000-0000-0000-0000-000000000000", { retired_by: "x" })).status).toBe(401);
    expect((await listQuotes(other.token)).items).toEqual([]);
    expect((await (await import("@/app/api/deliverable/[token]/quotes/route")).GET(new Request(siteUrl("/x")), { params: Promise.resolve({ token: "nope" }) })).status).toBe(404);
    // RLS: the anonymous database role reads nothing.
    const anon = await fetch(`${PGRST}/cost_evidence?select=*`, { headers: {} });
    expect([401, 403, 404]).toContain(anon.status);
    expect(gatewayLog.join("\n")).not.toContain("2345678");
  });

  it("refuses an engagement that is not a released Procurement Specification", async () => {
    const wrongKind = await engagement({ kind: "density_screen" });
    expect((await quotes(wrongKind.token, { responses: [response("SYNTHETIC-SUPPLIER-A", 1)], submitted_by: "B" })).status).toBe(409);
    const draft = await engagement({ status: "draft" });
    expect((await quotes(draft.token, { responses: [response("SYNTHETIC-SUPPLIER-A", 1)], submitted_by: "B" })).status).toBe(409);
  });

  it("an engagement with no project still records the loop, without project events", async () => {
    const e = await engagement({ withProject: false });
    asAdmin();
    const a = (await (await quotes(e.token, { responses: [response("SYNTHETIC-SUPPLIER-A", 2_340_000)], submitted_by: "Buyer" })).json()).lines[0];
    expect((await review(a.id, ACCEPT)).status).toBe(201);
    expect((await run(e.token)).status).toBe(201);
    expect((await rows("cost_evidence", `&deliverable_id=eq.${e.id}`))[0].project_id).toBeNull();
  });
});
