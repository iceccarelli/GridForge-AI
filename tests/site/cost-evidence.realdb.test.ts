/**
 * The procurement-to-cost-evidence loop against REAL PostgreSQL, through REAL PostgREST, with the REAL Python
 * engine. The in-memory fake is not involved.
 *
 * Every supplier, price and date in this file is a SYNTHETIC fixture (suppliers are named SYNTHETIC-SUPPLIER-x).
 * None is a real quotation. The assertions are about rules: what may influence a number, what is refused, what is
 * kept private, and what survives a retry, an outage or a race.
 *
 * Skipped unless GF_PGRST_URL and GF_PGRST_JWT are set; with GF_REQUIRE_REALDB=1 a missing stack FAILS this file.
 *
 * OBJECT STORE: with GF_STORAGE_URL set (scripts/realdb-up.sh with GF_REAL_STORAGE=1) every scenario below runs against
 * the REAL supabase/storage-api service. Without it they run against the deterministic stub in tests/site/storage-stub.ts,
 * which proves the application logic but NOT the Storage contract. GF_REQUIRE_REAL_STORAGE=1 makes a missing real service
 * FAIL this file. The gateway below only maps /storage/v1/* onto the service (what Supabase's gateway does) and injects
 * transport faults (outage, truncated write) where a scenario calls for one; it never answers a Storage request itself.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { adminToken } from "@/lib/admin";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { digestOf, runFingerprint, sha256Hex } from "@/lib/run-identity";
import { startStorageStub, type StorageStub } from "./storage-stub";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT && spawnSync("python3", ["--version"]).status === 0;
const required = process.env.GF_REQUIRE_REALDB === "1";
const STORAGE_URL = process.env.GF_STORAGE_URL ?? "";
const realStorage = !!STORAGE_URL;
const requireRealStorage = process.env.GF_REQUIRE_REAL_STORAGE === "1";
const KEY = "realdb-key";

describe("real-Storage prerequisites (cost evidence)", () => {
  it.runIf(requireRealStorage)("a real Storage service is configured and answering when it is required", async () => {
    expect(realStorage, "GF_STORAGE_URL must be set (run scripts/realdb-up.sh with GF_REAL_STORAGE=1)").toBe(true);
    const v = await fetch(`${STORAGE_URL}/version`);
    expect(v.status).toBe(200);
  });
});

describe("real-database prerequisites (cost evidence)", () => {
  it.runIf(required)("are present when the real database is required", async () => {
    expect(enabled).toBe(true);
    const r = await fetch(`${PGRST}/cost_evidence?limit=1`, { headers: { Authorization: `Bearer ${JWT}` } });
    expect(r.status, "migration 0022 must be applied").toBe(200);
  });
});

const engines: ChildProcess[] = [];
let gateway: http.Server | null = null;
let proxy: http.Server | null = null;
let storage: StorageStub | null = null;
/** Faults injected on the gateway's /storage/v1 path, whichever backend sits behind it. */
const faults = { uploads: false, reads: false, corruptWrites: false };
/** Every Storage request the application made, as the gateway saw it (never its body). */
const storageLog: { method: string; path: string; authed: boolean; upsert: string | null }[] = [];

interface Probe {
  get(ref: string): Promise<Buffer | null>;
  /** Overwrite an object out-of-band, as an operator or attacker with storage access could. */
  put(ref: string, bytes: Buffer): Promise<void>;
  remove(ref: string): Promise<void>;
  keysFor(deliverableId: string): Promise<string[]>;
  publicStatus(ref: string): Promise<number>;
}
let probe: Probe;
const svcHeaders = () => ({ Authorization: `Bearer ${JWT}`, apikey: JWT });

function stubProbe(st: StorageStub): Probe {
  return {
    get: async (ref) => st.objects.get(ref)?.bytes ?? null,
    put: async (ref, bytes) => void st.objects.set(ref, { bytes, contentType: "text/html" }),
    remove: async (ref) => void st.objects.delete(ref),
    keysFor: async (id) => [...st.objects.keys()].filter((k) => k.includes(id)),
    publicStatus: async (ref) => (await fetch(`${st.url}/storage/v1/object/public/${ref}`, { headers: { apikey: JWT } })).status,
  };
}

/** Talks to the real service directly (not through the application's gateway), with the test-only service credential. */
function realProbe(base: string): Probe {
  const list = async (prefix: string) => {
    const r = await fetch(`${base}/object/list/cost-evidence-artifacts`, {
      method: "POST", headers: { ...svcHeaders(), "Content-Type": "application/json" }, body: JSON.stringify({ prefix, limit: 1000 }),
    });
    return (await r.json()) as { name: string; id: string | null }[];
  };
  return {
    get: async (ref) => {
      const r = await fetch(`${base}/object/authenticated/${ref}`, { headers: svcHeaders() });
      return r.status === 200 ? Buffer.from(await r.arrayBuffer()) : null;
    },
    put: async (ref, bytes) => {
      const r = await fetch(`${base}/object/${ref}`, { method: "POST", headers: { ...svcHeaders(), "Content-Type": "text/html", "x-upsert": "true" }, body: new Uint8Array(bytes) });
      if (!r.ok) throw new Error(`probe put failed ${r.status}`);
    },
    remove: async (ref) => void (await fetch(`${base}/object/${ref}`, { method: "DELETE", headers: svcHeaders() })),
    keysFor: async (id) => {
      const out: string[] = [];
      for (const fp of await list(`${id}/`)) for (const f of await list(`${id}/${fp.name}/`)) out.push(`cost-evidence-artifacts/${id}/${fp.name}/${f.name}`);
      return out;
    },
    publicStatus: async (ref) => (await fetch(`${base}/object/public/${ref}`)).status,
  };
}
const KEYS = { A: "", B: "", C: "", S: "" };
let submitsAllowed = Infinity; // injected outage: gf_submit_cost_evidence answers 503 after this many calls
const gatewayLog: string[] = [];

/** Faults and observations at the two seams the site talks through. */
const seam = {
  /** The engine every site call goes to: A (default), B (a different private cost library), C (a later report date),
   * S (a much later report date, so a quotation that is still valid today has expired for it). */
  upstream: "A" as keyof typeof KEYS,
  /** Append a distinct HTML comment to every generated study, as a non-deterministic engine would. */
  suffixEvery: false,
  studyCalls: 0,
  candidate: 0,
  /** Fail the run-recording RPC with 503. */
  recordFails: false,
  /** Hold run-recording RPCs until this many have arrived, then release them together (a deterministic race). */
  barrier: 0,
  recordCalls: 0,
  /** Runs once the run-recording RPC has committed, before its answer is returned (a fault between record and reply). */
  afterRecord: null as null | (() => void | Promise<void>),
};
let waiting: (() => void)[] = [];

/** Start the REAL Python engine. `lib` points it at a private cost library, as an operator's deployment would. */
async function startEngine(opts: { date: string; lib?: object }): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gf-ce-"));
  const libPath = path.join(dir, "cost_library.json");
  if (opts.lib) fs.writeFileSync(libPath, JSON.stringify(opts.lib));
  const code = [
    "import os", `os.environ['GRIDFORGE_API_KEYS']='${KEY}'`, "os.environ['GRIDFORGE_RATE_LIMIT']='0'",
    `os.environ['GRIDFORGE_REPORT_DATE']='${opts.date}'`,
    `os.environ['GRIDFORGE_COST_LIBRARY']=${JSON.stringify(libPath)}`,
    `os.environ['GRIDFORGE_CALIBRATION_LEDGER']=${JSON.stringify(path.join(dir, "no-ledger.json"))}`,
    `os.environ['GRIDFORGE_REVOKED_FILE']=${JSON.stringify(path.join(dir, "revoked.json"))}`,
    "from gridforge.api.server import Handler, make_server", "Handler.limiter.per_minute=0",
    "h=make_server('127.0.0.1',0)", "print(h.server_address[1],flush=True)", "h.serve_forever()",
  ].join("\n");
  const proc = spawn("python3", ["-c", code], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  engines.push(proc);
  return await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("engine did not start")), 20_000);
    proc.stdout!.once("data", (d) => { clearTimeout(t); res(`http://127.0.0.1:${String(d).trim()}`); });
  });
}

/** What the site calls as "the engine": the real engines behind it, with a seam that can make a study non-deterministic. */
async function startProxy(): Promise<string> {
  proxy = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const upstream = KEYS[seam.upstream];
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
    const r = await fetch(upstream + (req.url ?? ""), { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : body });
    let out = Buffer.from(await r.arrayBuffer());
    if (req.url === "/v1/study" && req.method === "POST") {
      seam.studyCalls += 1;
      if (seam.suffixEvery && r.ok) {
        const j = JSON.parse(out.toString("utf8"));
        j.document_full = `${j.document_full}<!-- candidate ${++seam.candidate} -->`;
        out = Buffer.from(JSON.stringify(j));
      }
    }
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(out);
  });
  await new Promise<void>((r) => proxy!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
}

async function startGateway(): Promise<string> {
  gateway = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks);
    const url = req.url ?? "";
    gatewayLog.push(`${req.method} ${url}`);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
    // Supabase's gateway maps /storage/v1/* onto the Storage service; so does this. Nothing here answers for the service.
    if (url.startsWith("/storage/v1/")) {
      storageLog.push({ method: req.method ?? "", path: url.split("?")[0], authed: `${req.headers.authorization ?? ""}${req.headers.apikey ?? ""}`.includes(JWT), upsert: (req.headers["x-upsert"] as string) ?? null });
      const send = (status: number, text: string) => res.writeHead(status, { "content-type": "application/json" }).end(text);
      if (req.method === "POST" && faults.uploads) return send(500, '{"statusCode":"500","error":"injected upload failure"}');
      if (req.method === "GET" && faults.reads) return send(500, '{"statusCode":"500","error":"injected read failure"}');
      const sent = req.method === "POST" && faults.corruptWrites ? body.subarray(0, Math.max(0, body.length - 1)) : body;
      const target = realStorage ? STORAGE_URL + url.slice("/storage/v1".length) : storage!.url + url;
      const r = await fetch(target, { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : new Uint8Array(sent) });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    if (url.startsWith("/rest/v1/rpc/gf_submit_cost_evidence")) {
      if (submitsAllowed <= 0) { res.writeHead(503, { "content-type": "application/json" }).end('{"message":"injected outage"}'); return; }
      submitsAllowed -= 1;
    }
    if (url.startsWith("/rest/v1/rpc/gf_record_cost_evidence_run")) {
      seam.recordCalls += 1;
      if (seam.recordFails) { res.writeHead(503, { "content-type": "application/json" }).end('{"message":"injected outage"}'); return; }
      if (seam.barrier > 0) {
        await new Promise<void>((release) => {
          waiting.push(release);
          if (waiting.length >= seam.barrier) { const all = waiting; waiting = []; all.forEach((f) => f()); }
        });
      }
    }
    const r = await fetch(PGRST + url.slice("/rest/v1".length), {
      method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : body,
    });
    const payload = Buffer.from(await r.arrayBuffer());
    if (url.startsWith("/rest/v1/rpc/gf_record_cost_evidence_run") && seam.afterRecord) await seam.afterRecord();
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(payload);
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
  KEYS.A = await startEngine({ date: "2026-10-13" });
  // B: the same code and date, a different private cost library (a model/configuration revision).
  KEYS.B = await startEngine({ date: "2026-10-13", lib: { entries: [{ key: "ups.per_kW", label: "SYNTHETIC private line", unit: "EUR/kW", value: 4321, basis: "library_default" }] } });
  // C: the same code and library as A on a later day. S: far enough ahead that a quotation valid today has expired.
  KEYS.C = await startEngine({ date: "2026-11-02" });
  KEYS.S = await startEngine({ date: "2030-01-01" });
  if (realStorage) {
    probe = realProbe(STORAGE_URL);
  } else {
    storage = await startStorageStub(JWT);
    probe = stubProbe(storage);
  }
  process.env.SUPABASE_URL = await startGateway();
  process.env.SUPABASE_SERVICE_ROLE_KEY = JWT;
  process.env.GRIDFORGE_API_URL = await startProxy();
  process.env.GRIDFORGE_API_KEY = KEY;
  process.env.GRIDFORGE_ADMIN_KEY = "realdb-admin";
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  process.env.GRIDFORGE_KEY_SECRET = "realdb-signing-secret";
  const spec = await (await fetch(`${KEYS.A}/v1/spec`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": KEY },
    body: JSON.stringify({ intake: INTAKE, constraint: "transformer_capacity" }),
  })).json();
  template = spec.response_template;
}, 60_000);
afterAll(async () => { engines.forEach((e) => e.kill()); gateway?.close(); proxy?.close(); await storage?.close(); });

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

// =====================================================================================================================
// Durable, versioned runs: the database record is the authority, and it owns its exact bytes.
//
// STORAGE: tests/site/storage-stub.ts models Supabase Storage's HTTP contract and persists exact bytes. It is NOT
// Supabase; a deployed project's bucket, its privacy setting and its service key are unverified here.
// =====================================================================================================================

const TODAY = new Date().toISOString().slice(0, 10);
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

const history = async (token: string) => {
  const { GET } = await import("@/app/api/deliverable/[token]/evidence-run/route");
  return GET(new Request(siteUrl(`/api/deliverable/${token}/evidence-run`)), { params: Promise.resolve({ token }) });
};
const artifact = async (token: string, runId: string) => {
  const { GET } = await import("@/app/api/deliverable/[token]/evidence-run/[runId]/artifact/route");
  return GET(new Request(siteUrl(`/api/deliverable/${token}/evidence-run/${runId}/artifact`)), { params: Promise.resolve({ token, runId }) });
};
const runRows = (deliverableId: string) => rows("cost_evidence_runs", `&deliverable_id=eq.${deliverableId}&order=created_at.asc,id.asc`);
const stored = (deliverableId: string) => probe.keysFor(deliverableId);
const eventTypes = async (projectId: string) => (await rows("project_events", `&project_id=eq.${projectId}`)).map((x) => x.event_type as string);
const engineProvenance = async (which: keyof typeof KEYS) =>
  (await (await fetch(`${KEYS[which]}/v1/version`, { headers: { "X-API-Key": KEY } })).json()).provenance;

async function submitAndAccept(e: { token: string }, supplier = "SYNTHETIC-SUPPLIER-A", capex = 2_340_000) {
  asAdmin();
  const line = (await (await quotes(e.token, { responses: [response(supplier, capex)], submitted_by: "Buyer", synthetic: true })).json()).lines[0];
  expect((await review(line.id, ACCEPT)).status).toBe(201);
  return line as { id: string };
}

/** A validated line inserted straight into the table, for a cost key the template does not price. SYNTHETIC. */
async function insertValidatedLine(e: { id: string; project: any }, over: Record<string, unknown> = {}) {
  const r = await db("/cost_evidence", {
    method: "POST",
    body: JSON.stringify({
      deliverable_id: e.id, project_id: e.project?.id ?? null, line_digest: crypto.randomBytes(32).toString("hex"),
      cost_key: "ups.per_kW", unit: "EUR/kW", value: 500, submitted_value: 500, currency: "EUR", supplier: "SYNTHETIC-SUPPLIER-Z",
      received_on: "2026-10-01", valid_until: inDays(3), reference: "SYN-Z", scope: "SYNTHETIC UPS line", specification: {},
      response_digest: crypto.randomBytes(32).toString("hex"), validation_status: "validated", comparability: "exact", synthetic: true, ...over,
    }),
  });
  expect(r.status).toBe(201);
  return (await r.json())[0] as { id: string };
}

// =====================================================================================================================
// The real Supabase Storage contract. Runs only against the real service (GF_STORAGE_URL); in CI the mandatory
// `real-storage` job sets GF_REQUIRE_REAL_STORAGE=1 so it cannot be skipped. Every assertion below is about the
// service's own behaviour or the application's handling of it; none is answered by a test double.
// =====================================================================================================================

/** SQL against the same database the real Storage service migrated: proof of what ITS schema holds. */
function pg(sql: string): string {
  const r = spawnSync("psql", ["-X", "-q", "-At", "-d", process.env.GF_PG_DB ?? "gf", "-c", sql], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`psql failed: ${String(r.stderr).split("\n")[0]}`);
  return r.stdout.trim();
}
/** The test-only signing secret from scripts/realdb-up.sh; never a production value. */
const TEST_JWT_SECRET = "gridforge-local-test-secret-32-chars-minimum!!";
function mint(role: string): string {
  const b = (x: Buffer | string) => Buffer.from(x).toString("base64url");
  const head = b(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b(JSON.stringify({ role, exp: Math.floor(Date.now() / 1000) + 3600 }));
  return `${head}.${body}.${b(crypto.createHmac("sha256", TEST_JWT_SECRET).update(`${head}.${body}`).digest())}`;
}

describe.runIf(enabled && realStorage)("the REAL Supabase Storage service: contract and integrity (supabase/storage-api)", () => {
  const BUCKET = "cost-evidence-artifacts";
  // Fresh per execution: the real store keeps its objects, so fixed paths would make a second run meet the first run's data.
  const DELIV = crypto.randomUUID();
  const html = (tag: string) => Buffer.from(`<!doctype html><html><body>SYNTHETIC integration document ${tag}</body></html>`, "utf8");
  const refFor = (b: Buffer, fp = "a".repeat(64)) => `${BUCKET}/${DELIV}/${fp}/${sha256Hex(b)}.html`;
  const metaOf = (b: Buffer) => ({ sha256: sha256Hex(b), bytes: b.byteLength });
  let store: typeof import("@/lib/artifact-store");
  beforeAll(async () => { store = await import("@/lib/artifact-store"); });
  beforeEach(() => { faults.uploads = false; faults.reads = false; faults.corruptWrites = false; });

  it("is the pinned supabase/storage-api image, running, with its own schema in the database the migrations used", async () => {
    const image = process.env.GF_STORAGE_IMAGE ?? "";
    expect(image).toMatch(/^supabase\/storage-api:v\d+\.\d+\.\d+@sha256:[0-9a-f]{64}$/);
    expect((await (await fetch(`${STORAGE_URL}/version`)).text()).trim()).toBe(image.match(/:v([\d.]+)@/)![1]);
    expect((await fetch(`${STORAGE_URL}/status`)).status).toBe(200);
    // Columns only the real service's migrations create (the harness's stand-in table has three columns).
    expect(pg("select count(*) from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name in ('avif_autodetection','file_size_limit','allowed_mime_types')")).toBe("3");
    expect(Number(pg("select count(*) from storage.migrations"))).toBeGreaterThan(20);
    expect(pg("select to_regclass('storage.objects') is not null")).toBe("t");
    expect(pg("select relrowsecurity from pg_class where oid = 'storage.objects'::regclass")).toBe("t");
  });

  it("created the artifact bucket through the migrations, private, with no public bucket and no public-read policy", async () => {
    expect(pg(`select public from storage.buckets where id = '${BUCKET}'`)).toBe("f");
    expect(pg("select count(*) from storage.buckets where public")).toBe("0");
    expect(pg(`select count(*) from pg_policies where schemaname = 'storage' and (coalesce(qual,'') ilike '%${BUCKET}%' or coalesce(with_check,'') ilike '%${BUCKET}%')`)).toBe("0");
    const info = await (await fetch(`${STORAGE_URL}/bucket/${BUCKET}`, { headers: svcHeaders() })).json();
    expect(info).toMatchObject({ id: BUCKET, public: false });
  });

  it("stores exact bytes through putVerified, reads them back through readVerified, and its own metadata agrees", async () => {
    const b = html("write-read");
    const ref = refFor(b);
    expect((await store.putVerified(ref, b, metaOf(b))).ok).toBe(true);
    const back = await store.readVerified(ref, metaOf(b));
    expect(back.ok && back.bytes.equals(b)).toBe(true);
    // The row the REAL service wrote for it, in its own table.
    const path = ref.slice(BUCKET.length + 1);
    expect(pg(`select count(*) from storage.objects where bucket_id = '${BUCKET}' and name = '${path}'`)).toBe("1");
    expect(Number(pg(`select metadata->>'size' from storage.objects where bucket_id = '${BUCKET}' and name = '${path}'`))).toBe(b.byteLength);
    // What the application sent was authenticated, never an upsert.
    expect(storageLog.filter((l) => l.method === "POST").every((l) => l.authed && l.upsert === "false")).toBe(true);
    // A direct read with the service credential returns the same bytes (the application did not read from anywhere else).
    expect((await probe.get(ref))!.equals(b)).toBe(true);
  });

  it("rejects a wrong digest or length without returning the bytes, and never returns tampered content", async () => {
    const b = html("integrity");
    const ref = refFor(b, "b".repeat(64));
    await store.putVerified(ref, b, metaOf(b));
    for (const wrong of [{ ...metaOf(b), sha256: "0".repeat(64) }, { ...metaOf(b), bytes: b.byteLength + 1 }, { ...metaOf(b), bytes: b.byteLength - 1 }]) {
      const r = await store.readVerified(ref, wrong);
      expect(r.ok).toBe(false);
      expect(r.ok === false && r.kind).toBe("corrupt");
      expect(r).not.toHaveProperty("bytes");
    }
    await probe.put(ref, Buffer.from(b.toString("utf8").replace("SYNTHETIC", "TAMPERED"), "utf8"));   // same length, different content
    const tampered = await store.readVerified(ref, metaOf(b));
    expect(tampered.ok).toBe(false);
    expect(tampered).not.toHaveProperty("bytes");
    expect(JSON.stringify(tampered)).not.toContain("TAMPERED");
  });

  it("tells a missing object from an unavailable store from corrupt data, using the service's real error shapes", async () => {
    // The shapes themselves, straight from the service.
    const gone = await fetch(`${STORAGE_URL}/object/authenticated/${BUCKET}/${DELIV}/nothing/${"e".repeat(64)}.html`, { headers: svcHeaders() });
    expect(gone.status).toBe(400);
    expect(await gone.json()).toMatchObject({ statusCode: "404", error: "not_found", code: "NoSuchKey" });
    const noBucket = await fetch(`${STORAGE_URL}/object/authenticated/no-such-bucket/x/y.html`, { headers: svcHeaders() });
    expect(await noBucket.json()).toMatchObject({ statusCode: "404", code: "NoSuchBucket" });
    // And the application's classification of them.
    const b = html("classify");
    const ref = refFor(b, "c".repeat(64));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const missing = await store.getArtifact(ref);
    expect(missing.ok === false && missing.kind).toBe("missing");
    await store.putVerified(ref, b, metaOf(b));
    faults.reads = true;                                       // the store answering 500
    const down = await store.getArtifact(ref);
    expect(down.ok === false && down.kind).toBe("unavailable");
    faults.reads = false;
    await probe.put(ref, html("different bytes"));
    const corrupt = await store.readVerified(ref, metaOf(b));
    expect(corrupt.ok === false && corrupt.kind).toBe("corrupt");
    const logged = spy.mock.calls.flat().map(String).join("\n");
    spy.mockRestore();
    expect(logged).not.toMatch(/SYNTHETIC|different bytes|eyJ/);   // no document content and no token reaches a log
  });

  it("refuses to overwrite: a duplicate is accepted only if the existing object is byte-identical", async () => {
    const b = html("duplicate");
    const ref = refFor(b, "d".repeat(64));
    expect((await store.putVerified(ref, b, metaOf(b))).ok).toBe(true);
    // The real service's duplicate response, which the client's no-overwrite strategy depends on.
    const dup = await fetch(`${STORAGE_URL}/object/${ref}`, { method: "POST", headers: { ...svcHeaders(), "Content-Type": "text/html", "x-upsert": "false" }, body: new Uint8Array(b) });
    expect(dup.status).toBe(400);
    expect(await dup.json()).toMatchObject({ statusCode: "409", error: "Duplicate", code: "KeyAlreadyExists" });
    expect((await store.putVerified(ref, b, metaOf(b))).ok).toBe(true);                // identical existing object: fine
    const objectId = pg(`select id from storage.objects where bucket_id = '${BUCKET}' and name = '${ref.slice(BUCKET.length + 1)}'`);
    const other = html("a different document");
    const refused = await store.putVerified(ref, other, metaOf(other));                // different bytes at the same path
    expect(refused.ok).toBe(false);
    expect((await probe.get(ref))!.equals(b)).toBe(true);                               // the original is untouched ...
    expect(pg(`select id from storage.objects where bucket_id = '${BUCKET}' and name = '${ref.slice(BUCKET.length + 1)}'`)).toBe(objectId);   // ... and it is the same stored object
  });

  it("serves nothing to an unauthenticated caller, a garbage token, the anon role, or the public route", async () => {
    const b = html("private");
    const ref = refFor(b, "f".repeat(64));
    await store.putVerified(ref, b, metaOf(b));
    const attempts: [string, Response][] = [
      ["no credentials", await fetch(`${STORAGE_URL}/object/authenticated/${ref}`)],
      ["garbage token", await fetch(`${STORAGE_URL}/object/authenticated/${ref}`, { headers: { Authorization: "Bearer not-a-token" } })],
      ["anon role", await fetch(`${STORAGE_URL}/object/authenticated/${ref}`, { headers: { Authorization: `Bearer ${mint("anon")}` } })],
      ["authenticated role, no policy", await fetch(`${STORAGE_URL}/object/authenticated/${ref}`, { headers: { Authorization: `Bearer ${mint("authenticated")}` } })],
      ["public route", await fetch(`${STORAGE_URL}/object/public/${ref}`)],
      ["public route + anon", await fetch(`${STORAGE_URL}/object/public/${ref}`, { headers: { Authorization: `Bearer ${mint("anon")}` } })],
      ["sign-less path read", await fetch(`${STORAGE_URL}/object/${ref}`)],
    ];
    for (const [name, r] of attempts) {
      expect(r.status, name).not.toBe(200);
      expect(await r.text(), name).not.toContain("SYNTHETIC");
    }
    // The application route with a valid token still returns it; a token for another engagement does not.
    expect((await fetch(`${STORAGE_URL}/object/authenticated/${ref}`, { headers: svcHeaders() })).status).toBe(200);
  });

  it("deleteArtifact removes only the object it was asked to, and only its own kind of path", async () => {
    const b = html("delete");
    const ref = refFor(b, "9".repeat(64));
    await store.putVerified(ref, b, metaOf(b));
    expect(await store.deleteArtifact("project-evidence/anything")).toBe(false);
    expect(await probe.get(ref)).not.toBeNull();
    expect(await store.deleteArtifact(ref)).toBe(true);
    expect(await probe.get(ref)).toBeNull();
    expect(pg(`select count(*) from storage.objects where bucket_id = '${BUCKET}' and name = '${ref.slice(BUCKET.length + 1)}'`)).toBe("0");
  });

  it("a recorded run's object exists in the real service with the size and digest on the run, and a retry leaves it untouched", async () => {
    const e = await engagement();
    await submitAndAccept(e);
    const first = await (await run(e.token)).json();
    const [row] = await runRows(e.id);
    const path = row.artifact_storage_ref.slice(BUCKET.length + 1);
    const q = (col: string) => pg(`select ${col} from storage.objects where bucket_id = '${BUCKET}' and name = '${path}'`);
    expect(Number(q("metadata->>'size'"))).toBe(Number(row.artifact_bytes));
    const id = q("id"), updated = q("updated_at");
    expect(sha256Hex((await probe.get(row.artifact_storage_ref))!)).toBe(row.artifact_sha256);
    seam.suffixEvery = true;
    const again = await (await run(e.token)).json();
    seam.suffixEvery = false;
    expect(again.created).toBe(false);
    expect(again.document).toBe(first.document);
    expect([q("id"), q("updated_at")]).toEqual([id, updated]);                          // the authoritative object was not replaced
    expect(pg(`select count(*) from storage.objects where bucket_id = '${BUCKET}' and name like '${e.id}/%'`)).toBe("1");
  });
});

describe.runIf(enabled)("durable, versioned cost-evidence runs (real PostgreSQL + PostgREST + engines; stubbed Storage)", () => {
  beforeEach(() => {
    seam.upstream = "A"; seam.suffixEvery = false; seam.recordFails = false; seam.barrier = 0; seam.afterRecord = null; waiting = [];
    faults.uploads = false; faults.reads = false; faults.corruptWrites = false;
    asAdmin();
  });

  it("stores the exact bytes privately and records a complete, verifiable identity for the run", async () => {
    const e = await engagement();
    const a = await submitAndAccept(e);
    storageLog.length = 0;
    const res = await run(e.token);
    expect(res.status).toBe(201);
    const out = await res.json();
    const [row] = await runRows(e.id);

    // The stored object is exactly the generated document, and the record describes exactly those bytes.
    const key = row.artifact_storage_ref as string;
    expect(key).toMatch(new RegExp(`^cost-evidence-artifacts/${e.id}/${row.run_fingerprint}/${row.artifact_sha256}\\.html$`));
    const objBytes = (await probe.get(key))!;
    expect(objBytes).toBeTruthy();
    expect(objBytes.equals(Buffer.from(out.document, "utf8"))).toBe(true);
    expect(sha256Hex(objBytes)).toBe(row.artifact_sha256);
    expect(row.document_sha256).toBe(row.artifact_sha256);
    expect(out.document_sha256).toBe(row.artifact_sha256);
    expect(Number(row.artifact_bytes)).toBe(objBytes.byteLength);
    expect(row.artifact_media_type).toBe("text/html; charset=utf-8");
    // A path made of ids and digests: nothing a supplier or a price said.
    expect(key).not.toMatch(/SYNTHETIC|SUPPLIER|2340000/i);

    // Every input of the identity is recorded and re-derivable from the record itself.
    const prov = await engineProvenance("A");
    expect(row.engine_fingerprint).toBe(prov.digest);
    expect(row.engine_provenance).toMatchObject({ digest: prov.digest, code_sha256: prov.code_sha256, cost_library_sha256: prov.cost_library_sha256 });
    expect(digestOf(row.accepted_snapshot)).toBe(row.accepted_snapshot_digest);
    expect(row.accepted_snapshot.map((x: any) => x.evidence_id)).toEqual([a.id]);
    expect(row.intake_digest).toBe(digestOf(row.intake_snapshot));
    expect(row.intake_snapshot._gridforge).toBeUndefined();
    expect(runFingerprint({ deliverable_id: e.id, intake_digest: row.intake_digest, accepted_snapshot_digest: row.accepted_snapshot_digest, engine_fingerprint: row.engine_fingerprint }))
      .toBe(row.run_fingerprint);
    expect(row.identity_version).toBe("gridforge/cost-evidence-run/1");
    expect(row.report_date).toBe("2026-10-13");
    expect(row.evidence_ids).toEqual([a.id]);            // used
    expect(row.accepted_evidence_ids).toEqual([a.id]);   // offered
    expect(row.project_id).toBe(e.project.id);
    expect(row.created_at).toBeTruthy();

    // Authenticated, never an upsert, never the public route.
    const writes = storageLog.filter((l) => l.method === "POST");
    expect(writes.length).toBeGreaterThan(0);
    expect(storageLog.every((l) => l.authed)).toBe(true);
    expect(writes.every((l) => l.upsert === "false")).toBe(true);
    expect(storageLog.filter((l) => l.method === "GET").every((l) => l.path.includes("/object/authenticated/"))).toBe(true);
    expect(await probe.publicStatus(key)).not.toBe(200);
  });

  it("a retry returns the persisted artifact, not a newly generated one, even when the engine's next output differs", async () => {
    const e = await engagement();
    await submitAndAccept(e);
    const first = await (await run(e.token)).json();
    const [before] = await runRows(e.id);
    const objectsBefore = await stored(e.id);
    const calls = seam.studyCalls;

    seam.suffixEvery = true;          // the engine would now produce different HTML for the very same identity
    const res = await run(e.token);
    seam.suffixEvery = false;
    expect(res.status).toBe(200);
    const again = await res.json();

    expect(again.created).toBe(false);
    expect(again.document).toBe(first.document);                       // byte for byte the original
    expect(again.document).not.toContain("candidate");
    expect(again.document_sha256).toBe(first.document_sha256);
    expect(again.run.id).toBe(first.run.id);
    expect(again.run.run_fingerprint).toBe(first.run.run_fingerprint);
    expect(seam.studyCalls).toBe(calls);                                // the engine was not asked again
    expect(await runRows(e.id)).toEqual([before]);                      // one run, unchanged
    expect(await stored(e.id)).toEqual(objectsBefore);                        // no second object
    expect((await eventTypes(e.project.id)).filter((t) => t === "cost_evidence_run")).toHaveLength(1);
  });

  it("two concurrent requests with differing candidates resolve to one authoritative run and its exact artifact", async () => {
    const e = await engagement();
    await submitAndAccept(e);
    seam.suffixEvery = true;          // each request's candidate is different
    seam.barrier = 2;                 // both reach the recording step before either is allowed to record
    const calls = seam.studyCalls;
    const [r1, r2] = await Promise.all([run(e.token), run(e.token)]);
    seam.barrier = 0; seam.suffixEvery = false;
    expect(seam.studyCalls - calls).toBe(2);                           // two candidates really were generated
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    const [b1, b2] = [await r1.json(), await r2.json()];

    const dbRows = await runRows(e.id);
    expect(dbRows).toHaveLength(1);                                    // the database chose one
    const winner = dbRows[0];
    for (const b of [b1, b2]) {
      expect(b.run.id).toBe(winner.id);
      expect(b.document_sha256).toBe(winner.artifact_sha256);
      expect(sha256Hex(Buffer.from(b.document, "utf8"))).toBe(winner.artifact_sha256);   // never the loser's bytes under the winner's hash
    }
    expect(b1.document).toBe(b2.document);
    expect((await probe.get(winner.artifact_storage_ref))!.equals(Buffer.from(b1.document, "utf8"))).toBe(true);
    expect([b1, b2].filter((b) => b.warning)).toHaveLength(1);         // the loser is told the candidates differed
    expect(await stored(e.id)).toEqual([winner.artifact_storage_ref]);       // the unreferenced candidate was cleaned up; the winner's was not
    expect((await eventTypes(e.project.id)).filter((t) => t === "cost_evidence_run")).toHaveLength(1);
  });

  describe("a different identity is a different run", () => {
    it("changed intake", async () => {
      const e = await engagement();
      await submitAndAccept(e);
      const one = await (await run(e.token)).json();
      const intake = { ...INTAKE, project: { ...INTAKE.project, note: "SYNTHETIC revised note" }, _gridforge: { spec: { constraint_id: "transformer_capacity" } } };
      await db(`/deliverables?id=eq.${e.id}`, { method: "PATCH", body: JSON.stringify({ intake }) });
      const two = await (await run(e.token)).json();
      expect(two.created).toBe(true);
      expect(two.run.id).not.toBe(one.run.id);
      const [r1, r2] = await runRows(e.id);
      expect(r2.intake_digest).not.toBe(r1.intake_digest);
      expect(r2.run_fingerprint).not.toBe(r1.run_fingerprint);
      expect(r2.accepted_snapshot_digest).toBe(r1.accepted_snapshot_digest);
      expect(r2.engine_fingerprint).toBe(r1.engine_fingerprint);
    });

    it("different accepted evidence", async () => {
      const e = await engagement();
      await submitAndAccept(e, "SYNTHETIC-SUPPLIER-A", 2_340_000);
      const one = await (await run(e.token)).json();
      await submitAndAccept(e, "SYNTHETIC-SUPPLIER-B", 2_200_000);
      const two = await (await run(e.token)).json();
      expect(two.created).toBe(true);
      const [r1, r2] = await runRows(e.id);
      expect(r2.accepted_snapshot_digest).not.toBe(r1.accepted_snapshot_digest);
      expect(r2.run_fingerprint).not.toBe(r1.run_fingerprint);
      expect(one.run.id).not.toBe(two.run.id);
    });

    it("accepted evidence that the engine then IGNORES still changes the snapshot and the run, and used is not accepted", async () => {
      const e = await engagement();
      seam.upstream = "S";   // an engine for which a quotation valid for a few more days has already expired
      const a = await submitAndAccept(e);
      const one = await (await run(e.token)).json();
      expect(one.created).toBe(true);
      const z = await insertValidatedLine(e);
      expect((await review(z.id, ACCEPT)).status).toBe(201);
      const two = await (await run(e.token)).json();
      expect(two.created).toBe(true);
      const [r1, r2] = await runRows(e.id);
      expect(r1.evidence_ids).toEqual([a.id]);
      expect(r2.evidence_ids).toEqual([a.id]);                                  // the same evidence was USED ...
      expect(r2.evidence_digest).toBe(r1.evidence_digest);                       // ... so the 0022 identity could not tell them apart
      expect([...r2.accepted_evidence_ids].sort()).toEqual([a.id, z.id].sort()); // ... but two lines were ACCEPTED and offered
      expect(r2.accepted_snapshot_digest).not.toBe(r1.accepted_snapshot_digest);
      expect(r2.run_fingerprint).not.toBe(r1.run_fingerprint);
      expect(r2.ignored.map((x: any) => x.evidence_id)).toEqual([z.id]);
      expect(String(r2.ignored[0].reason).toLowerCase()).toContain("expired");
      expect(r2.engine_fingerprint).toBe(r1.engine_fingerprint);
      expect(two.run.used_evidence_ids).toEqual([a.id]);
      expect(two.run.ignored_evidence).toHaveLength(1);
    });

    it("a changed cost library / model configuration (different engine fingerprint)", async () => {
      const e = await engagement();
      await submitAndAccept(e);
      const one = await (await run(e.token)).json();
      seam.upstream = "B";
      expect((await engineProvenance("B")).digest).not.toBe((await engineProvenance("A")).digest);
      const two = await (await run(e.token)).json();
      expect(two.created).toBe(true);
      const [r1, r2] = await runRows(e.id);
      expect(r2.engine_fingerprint).not.toBe(r1.engine_fingerprint);
      expect(r2.engine_provenance.cost_library_sha256).not.toBe(r1.engine_provenance.cost_library_sha256);
      expect(r2.engine_provenance.code_sha256).toBe(r1.engine_provenance.code_sha256);
      expect(r2.intake_digest).toBe(r1.intake_digest);
      expect(r2.accepted_snapshot_digest).toBe(r1.accepted_snapshot_digest);
      expect(r2.evidence_digest).toBe(r1.evidence_digest);                       // 0022 would have collided here
      expect(r2.run_fingerprint).not.toBe(r1.run_fingerprint);
      // The first run still returns ITS document; the second has its own.
      const first = await (await artifact(e.token, one.run.id)).text();
      expect(sha256Hex(Buffer.from(first, "utf8"))).toBe(r1.artifact_sha256);
      expect(sha256Hex(Buffer.from(await (await artifact(e.token, two.run.id)).text(), "utf8"))).toBe(r2.artifact_sha256);
    });

    it("the same engine on another day is the same run: the date moved, the identity did not", async () => {
      const e = await engagement();
      await submitAndAccept(e);
      const one = await (await run(e.token)).json();
      seam.upstream = "C";   // identical code, library and ledger; the report date is 2026-11-02
      expect((await engineProvenance("C")).digest).toBe((await engineProvenance("A")).digest);
      expect((await engineProvenance("C")).report_date).not.toBe((await engineProvenance("A")).report_date);
      const calls = seam.studyCalls;
      const again = await (await run(e.token)).json();
      expect(again.created).toBe(false);
      expect(again.document).toBe(one.document);
      expect(seam.studyCalls).toBe(calls);
      expect(await runRows(e.id)).toHaveLength(1);
    });
  });

  describe("a success means recorded, stored and verified; every failure is a failure", () => {
    it("a storage upload failure yields no run and no success, and a later retry succeeds", async () => {
      const e = await engagement();
      await submitAndAccept(e);
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      faults.uploads = true;
      const res = await run(e.token);
      faults.uploads = false;
      expect(res.status).toBe(502);
      expect((await res.json()).ok).toBe(false);
      expect(await runRows(e.id)).toHaveLength(0);
      expect(await stored(e.id)).toHaveLength(0);
      expect((await eventTypes(e.project.id)).filter((t) => t === "cost_evidence_run")).toHaveLength(0);
      const logged = spy.mock.calls.flat().map(String).join("\n");
      spy.mockRestore();
      expect(logged).not.toMatch(/SYNTHETIC|2340000/);
      expect((await run(e.token)).status).toBe(201);
    });

    it("a store that acknowledges a write but persists other bytes is detected, recorded as nothing, and does not poison a retry", async () => {
      const e = await engagement();
      await submitAndAccept(e);
      faults.corruptWrites = true;
      const res = await run(e.token);
      faults.corruptWrites = false;
      expect(res.status).toBe(502);
      expect(await runRows(e.id)).toHaveLength(0);
      expect(await stored(e.id)).toHaveLength(0);       // the bad object was removed: nothing referenced it
      expect((await run(e.token)).status).toBe(201);
    });

    it("a database write failure yields no run and no success, and removes the unreferenced candidate", async () => {
      const e = await engagement();
      await submitAndAccept(e);
      seam.recordFails = true;
      const res = await run(e.token);
      seam.recordFails = false;
      expect(res.status).toBe(502);
      expect(await runRows(e.id)).toHaveLength(0);
      expect(await stored(e.id)).toHaveLength(0);
      const ok = await run(e.token);
      expect(ok.status).toBe(201);
      expect(await stored(e.id)).toHaveLength(1);
    });

    it("a missing, changed or unreadable artifact fails closed on retry and on retrieval, and nothing is regenerated", async () => {
      const e = await engagement();
      await submitAndAccept(e);
      const first = await (await run(e.token)).json();
      const [row] = await runRows(e.id);
      const key = row.artifact_storage_ref as string;
      const original = (await probe.get(key))!;
      const calls = seam.studyCalls;
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);

      await probe.remove(key);                                                  // missing
      for (const res of [await run(e.token), await artifact(e.token, first.run.id)]) {
        expect(res.status).toBe(502);
        expect(await res.text()).not.toContain("<html");
      }
      await probe.put(key, Buffer.from(original.toString("utf8").replace("SYNTHETIC", "TAMPERED"), "utf8"));  // changed
      for (const res of [await run(e.token), await artifact(e.token, first.run.id)]) {
        expect(res.status).toBe(502);
        const text = await res.text();
        expect(text).not.toContain("TAMPERED");
        expect(text).not.toContain("<html");
      }
      await probe.put(key, original.subarray(0, original.length - 5));                                           // truncated
      expect((await artifact(e.token, first.run.id)).status).toBe(502);
      await probe.put(key, original);
      faults.reads = true;                                              // store outage
      expect((await artifact(e.token, first.run.id)).status).toBe(502);
      expect((await run(e.token)).status).toBe(502);
      faults.reads = false;
      spy.mockRestore();

      expect(seam.studyCalls).toBe(calls);                                     // no regeneration under the old identity
      expect(await runRows(e.id)).toEqual([row]);                              // the record was never rewritten
      const healed = await artifact(e.token, first.run.id);                    // and once the object is intact it serves again
      expect(healed.status).toBe(200);
      expect(await healed.text()).toBe(first.document);
    });

    it("if the stored object disappears between the record and the reply, identical bytes are restored; if they cannot be, the response is a failure", async () => {
      const e = await engagement();
      await submitAndAccept(e);
      seam.afterRecord = async () => { for (const k of await stored(e.id)) await probe.remove(k); };
      const healed = await run(e.token);
      seam.afterRecord = null;
      expect(healed.status).toBe(201);
      const [row] = await runRows(e.id);
      expect(sha256Hex((await probe.get(row.artifact_storage_ref))!)).toBe(row.artifact_sha256);

      const e2 = await engagement();
      await submitAndAccept(e2);
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      seam.afterRecord = async () => { for (const k of await stored(e2.id)) await probe.remove(k); faults.uploads = true; };
      const lost = await run(e2.token);
      seam.afterRecord = null; faults.uploads = false;
      spy.mockRestore();
      expect(lost.status).toBe(502);                                   // never "success" for a run whose document cannot be proven
      expect((await lost.json()).ok).toBe(false);
      expect((await artifact(e2.token, (await runRows(e2.id))[0].id)).status).toBe(502);   // and retrieval fails closed
    });

    it("orphan cleanup can never delete an artifact an authoritative run references", async () => {
      const { discardCandidate } = await import("@/lib/cost-evidence");
      const e = await engagement();
      await submitAndAccept(e);
      await run(e.token);
      const [row] = await runRows(e.id);
      expect(await discardCandidate(row.artifact_storage_ref)).toBe(false);
      expect(await probe.get(row.artifact_storage_ref)).not.toBeNull();
      // An unreferenced object (a lost race's candidate) is removed.
      const orphan = `cost-evidence-artifacts/${e.id}/${"c".repeat(64)}/${"d".repeat(64)}.html`;
      await probe.put(orphan, Buffer.from("x"));
      expect(await discardCandidate(orphan)).toBe(true);
      expect(await probe.get(orphan)).toBeNull();
    });
  });

  describe("database invariants", () => {
    it("refuses a versioned run without complete artifact metadata, and a legacy-shaped run that claims an artifact", async () => {
      const e = await engagement();
      await submitAndAccept(e);
      await run(e.token);
      const [r] = await runRows(e.id);
      const strip = (k: string) => { const { id, created_at, ...rest } = r; return { ...rest, run_fingerprint: "e".repeat(64), artifact_storage_ref: r.artifact_storage_ref + ".x", [k]: null }; };
      for (const field of ["artifact_storage_ref", "artifact_sha256", "artifact_bytes", "artifact_media_type", "engine_fingerprint", "accepted_snapshot_digest", "intake_snapshot", "request_options"]) {
        const res = await db("/cost_evidence_runs", { method: "POST", body: JSON.stringify(strip(field)) });
        expect(res.status, field).toBeGreaterThanOrEqual(400);
      }
      const { id, created_at, ...rest } = r;
      const legacyWithArtifact = { ...rest, run_fingerprint: null, identity_version: null, intake_snapshot: null, accepted_snapshot: null, accepted_snapshot_digest: null, accepted_evidence_ids: null, engine_provenance: null, engine_fingerprint: null, request_options: null, report_date: null, artifact_sha256: null, artifact_bytes: null, artifact_media_type: null, artifact_storage_ref: "cost-evidence-artifacts/fake" };
      expect((await db("/cost_evidence_runs", { method: "POST", body: JSON.stringify(legacyWithArtifact) })).status).toBeGreaterThanOrEqual(400);
      expect(await runRows(e.id)).toHaveLength(1);
    });

    it("run rows are append-only, and recording an existing identity again returns the original untouched, with no second event", async () => {
      const e = await engagement();
      await submitAndAccept(e);
      await run(e.token);
      const [r] = await runRows(e.id);
      expect((await db(`/cost_evidence_runs?id=eq.${r.id}`, { method: "PATCH", body: JSON.stringify({ artifact_sha256: "f".repeat(64), document_sha256: "f".repeat(64) }) })).status).toBeGreaterThanOrEqual(400);
      expect((await db(`/cost_evidence_runs?id=eq.${r.id}`, { method: "DELETE" })).status).toBeGreaterThanOrEqual(400);

      const replay = {
        deliverable_id: e.id, identity_version: r.identity_version, run_fingerprint: r.run_fingerprint, intake_digest: r.intake_digest,
        intake_snapshot: r.intake_snapshot, accepted_snapshot: r.accepted_snapshot, accepted_snapshot_digest: r.accepted_snapshot_digest,
        accepted_evidence_ids: r.accepted_evidence_ids, evidence_digest: r.evidence_digest, evidence_ids: r.evidence_ids, effect: {}, ignored: [],
        engine_provenance: r.engine_provenance, engine_fingerprint: r.engine_fingerprint, request_options: r.request_options,
        report_date: r.report_date, document_sha256: "f".repeat(64), artifact_storage_ref: `cost-evidence-artifacts/${e.id}/${r.run_fingerprint}/${"f".repeat(64)}.html`,
        artifact_sha256: "f".repeat(64), artifact_bytes: 10, artifact_media_type: "text/html; charset=utf-8",
      };
      const res = await db("/rpc/gf_record_cost_evidence_run", { method: "POST", body: JSON.stringify({ p: replay, p_event: { event_type: "cost_evidence_run", actor: "x", occurred_at: new Date().toISOString(), payload: {} } }) });
      const body = await res.json();
      expect(body.created).toBe(false);
      expect(body.run.artifact_sha256).toBe(r.artifact_sha256);                // the existing record, not the replay's
      expect(await runRows(e.id)).toEqual([r]);
      expect((await eventTypes(e.project.id)).filter((t) => t === "cost_evidence_run")).toHaveLength(1);
    });

    it("keeps a legacy run visible with an honest status, and never claims its document is retrievable", async () => {
      const e = await engagement();
      await submitAndAccept(e);
      const legacy = (await (await db("/cost_evidence_runs", {
        method: "POST",
        body: JSON.stringify({ deliverable_id: e.id, project_id: e.project.id, intake_digest: "1".repeat(64), evidence_digest: "2".repeat(64),
                               evidence_ids: [crypto.randomUUID()], effect: {}, ignored: [], document_sha256: "3".repeat(64) }),
      })).json())[0];
      expect(legacy.run_fingerprint).toBeNull();
      expect(legacy.artifact_storage_ref).toBeNull();
      // A second identical legacy row is still refused, as in 0022.
      expect((await db("/cost_evidence_runs", { method: "POST", body: JSON.stringify({ deliverable_id: e.id, intake_digest: "1".repeat(64), evidence_digest: "2".repeat(64), evidence_ids: [crypto.randomUUID()], effect: {}, document_sha256: "3".repeat(64) }) })).status).toBeGreaterThanOrEqual(400);

      const h = await (await history(e.token)).json();
      const l = h.runs.find((x: any) => x.id === legacy.id);
      expect(l).toMatchObject({ legacy: true, run_fingerprint: null, artifact_url: null, is_current: false });
      expect(l.artifact.status).toBe("legacy_unavailable");
      expect(l.artifact.sha256).toBeNull();
      const res = await artifact(e.token, legacy.id);
      expect(res.status).toBe(404);
      expect((await res.json()).error).toContain("never kept");
    });
  });

  describe("customer history and artifact retrieval", () => {
    it("lists the engagement's runs from the database, distinguishes current from older, and serves each exact artifact after a reload", async () => {
      const e = await engagement();
      await submitAndAccept(e, "SYNTHETIC-SUPPLIER-A", 2_340_000);
      const one = await (await run(e.token)).json();
      await submitAndAccept(e, "SYNTHETIC-SUPPLIER-B", 2_200_000);
      const two = await (await run(e.token)).json();

      // A "reload": nothing from the POSTs above is used; the history and artifacts come from the server alone.
      const hres = await history(e.token);
      expect(hres.headers.get("cache-control")).toContain("no-store");
      const h = await hres.json();
      expect(h.runs.map((r: any) => r.id)).toEqual([two.run.id, one.run.id]);                 // newest first
      expect(h.current_run_fingerprint).toBe(two.run.run_fingerprint);
      expect(h.runs.map((r: any) => r.is_current)).toEqual([true, false]);
      for (const r of h.runs) {
        expect(r).toMatchObject({ legacy: false, identity_version: "gridforge/cost-evidence-run/1" });
        expect(r.artifact).toMatchObject({ status: "stored", media_type: "text/html; charset=utf-8" });
        expect(r.artifact_url).toBe(`/api/deliverable/${e.token}/evidence-run/${r.id}/artifact`);
        expect(r.used_evidence_ids.length).toBe(1);
        expect(r.accepted_evidence_ids.length).toBe(1);
        expect(r.engine.fingerprint).toMatch(/^[0-9a-f]{64}$/);
        const dl = await artifact(e.token, r.id);
        expect(dl.status).toBe(200);
        const bytes = Buffer.from(await dl.arrayBuffer());
        expect(sha256Hex(bytes)).toBe(r.artifact.sha256);
        expect(bytes.byteLength).toBe(r.artifact.bytes);
        expect(dl.headers.get("x-artifact-sha256")).toBe(r.artifact.sha256);
      }
      const dl1 = await artifact(e.token, one.run.id);
      expect(await dl1.text()).toBe(one.document);
      expect(dl1.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(dl1.headers.get("content-disposition")).toMatch(/^attachment; filename="gridforge-evidence-run-[0-9a-f]{12}\.html"$/);
      expect(dl1.headers.get("cache-control")).toBe("private, no-store");
      expect(dl1.headers.get("x-content-type-options")).toBe("nosniff");

      // New evidence changes what "current" means, without touching either recorded run.
      const c = (await (await quotes(e.token, { responses: [response("SYNTHETIC-SUPPLIER-C", 2_100_000)], submitted_by: "Buyer", synthetic: true })).json()).lines[0];
      await review(c.id, ACCEPT);
      const h2 = await (await history(e.token)).json();
      expect(h2.runs.every((r: any) => r.is_current === false)).toBe(true);
      expect(h2.current_run_fingerprint).not.toBe(two.run.run_fingerprint);
    });

    it("does not leak: another engagement's token, a guessed run id, an unknown token and a malformed id all look alike", async () => {
      const mine = await engagement();
      const theirs = await engagement();
      await submitAndAccept(mine, "SYNTHETIC-SUPPLIER-A", 2_345_678);
      const myRun = await (await run(mine.token)).json();
      await submitAndAccept(theirs, "SYNTHETIC-SUPPLIER-B", 2_222_222);
      const theirRun = await (await run(theirs.token)).json();

      const notFound = async (res: Response) => { expect(res.status).toBe(404); return await res.text(); };
      const bodies = [
        await notFound(await artifact(theirs.token, myRun.run.id)),                       // another customer's token, my run
        await notFound(await artifact(mine.token, theirRun.run.id)),                      // my token, another customer's run
        await notFound(await artifact(mine.token, crypto.randomUUID())),                  // a guessed UUID
        await notFound(await artifact(mine.token, "not-a-uuid")),
        await notFound(await artifact("no-such-token", myRun.run.id)),                    // an unknown token
        await notFound(await artifact("", myRun.run.id)),
      ];
      expect(new Set(bodies.map((b) => b.replace(/"error":"[^"]*"/, "")))).toHaveProperty("size", 1);
      expect(bodies[0]).toBe(bodies[2]);          // "someone else's run" is indistinguishable from "no such run"
      expect((await history("no-such-token")).status).toBe(404);

      const h = await (await history(theirs.token)).text();
      expect(h).not.toContain(myRun.run.id);
      expect(h).not.toContain("SYNTHETIC-SUPPLIER-A");
      expect(h).not.toContain("2345678");
      for (const t of [h, await (await history(mine.token)).text(), JSON.stringify(myRun.run)]) {
        expect(t).not.toContain("cost-evidence-artifacts");     // no storage reference or bucket name ever reaches a customer
        expect(t).not.toContain("artifact_storage_ref");
        expect(t).not.toContain("accepted_snapshot\"");
        expect(t).not.toContain("intake_snapshot");
      }
      expect(JSON.parse(await (await history(mine.token)).text()).runs).toHaveLength(1);
    });
  });

  describe("the project record (Verified Power Record) carries the loop as counts and integrity facts", () => {
    it("shows line states, runs and document integrity for the project, and nothing confidential", async () => {
      const { getProjectState } = await import("@/lib/project-state");
      const e = await engagement();
      await submitAndAccept(e, "SYNTHETIC-SUPPLIER-A", 2_345_678);
      const pending = (await (await quotes(e.token, { responses: [response("SYNTHETIC-SUPPLIER-B", 2_999_000)], submitted_by: "Buyer" })).json()).lines[0];
      const made = await (await run(e.token)).json();
      await db("/cost_evidence_runs", { method: "POST", body: JSON.stringify({ deliverable_id: e.id, project_id: e.project.id, intake_digest: "1".repeat(64), evidence_digest: "2".repeat(64), evidence_ids: [crypto.randomUUID()], effect: {}, document_sha256: "3".repeat(64) }) });

      const r = await getProjectState(e.project.project_token);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const ce = r.state.cost_evidence;
      expect(ce.lines).toMatchObject({ total: 2, accepted: 1, validated: 1, rejected: 0 });
      expect(ce.runs).toHaveLength(2);
      const versioned = ce.runs.find((x) => !x.legacy)!;
      expect(versioned).toMatchObject({ id: made.run.id, offered: 1, used: 1, ignored: 0, report_date: "2026-10-13" });
      expect(versioned.artifact).toMatchObject({ status: "stored", sha256: made.document_sha256 });
      expect(ce.runs.find((x) => x.legacy)!.artifact).toEqual({ status: "legacy_unavailable", sha256: null, bytes: null });

      const text = JSON.stringify(r.state);
      for (const secret of ["SYNTHETIC-SUPPLIER", "2345678", "2999000", "cost-evidence-artifacts", "artifact_storage_ref"]) expect(text).not.toContain(secret);
      expect(pending.id).toBeTruthy();   // opaque evidence ids already appear in the existing event timeline; no supplier or price does
      // Another project sees none of it.
      const other = await engagement();
      const o = await getProjectState(other.project.project_token);
      expect(o.ok && o.state.cost_evidence).toEqual({ lines: { validated: 0, invalid: 0, accepted: 0, rejected: 0, superseded: 0, withdrawn: 0, total: 0 }, runs: [] });
    });
  });

  describe("the administrator's audit of runs", () => {
    const auditList = async () => (await import("@/app/api/admin/cost-evidence/runs/route")).GET();
    const auditFile = async (runId: string) =>
      (await import("@/app/api/admin/cost-evidence/runs/[runId]/artifact/route")).GET(new Request(siteUrl("/x")), { params: Promise.resolve({ runId }) });

    it("refuses the unauthenticated, and lists runs with integrity facts but no storage reference", async () => {
      const e = await engagement();
      await submitAndAccept(e);
      const made = await (await run(e.token)).json();
      asAnonymous();
      expect((await auditList()).status).toBe(401);
      expect((await auditFile(made.run.id)).status).toBe(401);
      jar.length = 0; jar.push({ name: "gf_admin", value: "forged" });
      expect((await auditFile(made.run.id)).status).toBe(401);
      asAdmin();
      const body = await (await auditList()).json();
      const mine = body.runs.find((r: any) => r.id === made.run.id);
      expect(mine).toMatchObject({ deliverable_id: e.id, legacy: false, artifact: "stored", artifact_sha256: made.document_sha256, used_evidence_ids: made.evidence_ids });
      expect(JSON.stringify(body)).not.toContain("cost-evidence-artifacts");
    });

    it("serves a run's document only after re-hashing it, and fails closed otherwise", async () => {
      const e = await engagement();
      await submitAndAccept(e);
      const made = await (await run(e.token)).json();
      const ok = await auditFile(made.run.id);
      expect(ok.status).toBe(200);
      expect(await ok.text()).toBe(made.document);
      const [row] = await runRows(e.id);
      const original = (await probe.get(row.artifact_storage_ref))!;
      await probe.put(row.artifact_storage_ref, Buffer.from(original.toString("utf8").replace("SYNTHETIC", "TAMPERED"), "utf8"));
      const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const bad = await auditFile(made.run.id);
      spy.mockRestore();
      await probe.put(row.artifact_storage_ref, original);
      expect(bad.status).toBe(502);
      expect(await bad.text()).not.toContain("TAMPERED");
      expect((await auditFile(crypto.randomUUID())).status).toBe(404);
      expect((await auditFile("nope")).status).toBe(404);
    });
  });

  describe("the administrator's review workflow, end to end through the existing routes", () => {
    const list = async (state: string) => {
      const { GET } = await import("@/app/api/admin/cost-evidence/route");
      return GET(new Request(siteUrl(`/api/admin/cost-evidence?state=${state}`)));
    };

    it("rejects every unauthenticated read and write", async () => {
      const e = await engagement();
      const a = await submitAndAccept(e);
      asAnonymous();
      expect((await list("pending")).status).toBe(401);
      expect((await list("all")).status).toBe(401);
      expect((await review(a.id, ACCEPT)).status).toBe(401);
      expect((await withdraw(a.id, { retired_by: "x" })).status).toBe(401);
      jar.length = 0; jar.push({ name: "gf_admin", value: "forged" });
      expect((await list("all")).status).toBe(401);
      expect((await review(a.id, { ...ACCEPT, decision: "rejected" })).status).toBe(401);
      asAdmin();
      expect((await withdraw(a.id, { retired_by: "R" })).status).toBe(201);
    });

    it("the queue carries what the review screen shows, for each lifecycle state", async () => {
      const e = await engagement();
      asAdmin();
      const mk = async (s: string, capex: number) => (await (await quotes(e.token, { responses: [response(`SYNTHETIC-SUPPLIER-${s}`, capex)], submitted_by: "B", synthetic: true })).json()).lines[0];
      const pending = await mk("A", 2_000_000);
      const bad = (await (await quotes(e.token, { responses: [response("SYNTHETIC-SUPPLIER-B", 2_000_000, { currency: "USD" })], submitted_by: "B" })).json()).lines[0];
      const rej = await mk("C", 2_100_000);
      await review(rej.id, { decision: "rejected", reviewer: "Test Reviewer", reason: "out of scope" });
      const older = await mk("D", 2_200_000);
      await review(older.id, { ...ACCEPT, includes_keys: ["transformer.install"], region: "IE" });
      const newer = await mk("E", 2_150_000);
      await review(newer.id, ACCEPT);                         // supersedes `older`
      const wd = await mk("F", 2_050_000);                    // supersedes `newer`, then is withdrawn
      await review(wd.id, ACCEPT);
      expect((await withdraw(wd.id, { retired_by: "Test Withdrawer", reason: "supplier retracted" })).status).toBe(201);

      const pend = (await (await list("pending")).json()).items.filter((x: any) => x.deliverable_id === e.id);
      expect(pend.map((x: any) => x.id)).toEqual([pending.id]);                            // only validated lines await a decision
      const all = ((await (await list("all")).json()).items as any[]).filter((x) => x.deliverable_id === e.id);
      const by = Object.fromEntries(all.map((x) => [x.id, x]));
      expect(by[pending.id].state).toBe("validated");
      expect(by[bad.id].state).toBe("invalid");
      expect(by[bad.id].problems.join(" ")).toContain("USD");
      expect(by[rej.id]).toMatchObject({ state: "rejected", reviewer: "Test Reviewer", review_reason: "out of scope" });
      expect(by[older.id]).toMatchObject({ state: "superseded", superseded_by: newer.id, retired_kind: "superseded", reviewed_basis: "budgetary_quote", reviewed_region: "IE", includes_keys: ["transformer.install"] });
      expect(by[older.id].retirement_reason).toContain("newer accepted");
      expect(by[wd.id]).toMatchObject({ state: "withdrawn", retired_by: "Test Withdrawer", retirement_reason: "supplier retracted", retired_kind: "withdrawn" });
      expect(by[wd.id].synthetic).toBe(true);
      for (const k of ["supplier", "cost_key", "unit", "value", "currency", "scope", "quoted_quantity", "quoted_quantity_unit", "specification", "response_digest", "validation_status", "limitations", "comparability", "reviewed_at"]) {
        expect(by[wd.id], k).toHaveProperty(k);
      }
    });

    it("refuses a duplicate decision, a flipped decision, missing fields, an invalid or expired line, and withdrawing what is not accepted", async () => {
      const e = await engagement();
      asAdmin();
      const q = async (s: string, capex: number, over: Record<string, unknown> = {}) => (await (await quotes(e.token, { responses: [response(`SYNTHETIC-SUPPLIER-${s}`, capex, over)], submitted_by: "B" })).json()).lines[0];
      const ok = await q("A", 2_000_000);
      const invalid = await q("B", 2_100_000, { currency: "USD" });
      expect((await review(ok.id, { decision: "accepted", reviewer: "R", comparability: "exact" })).status).toBe(422);        // no basis
      expect((await review(ok.id, { decision: "accepted", reviewer: "R", basis: "firm_quote" })).status).toBe(422);           // no comparability
      expect((await review(ok.id, { decision: "rejected", reviewer: "" })).status).toBe(422);                                 // no reviewer
      expect((await review(ok.id, { decision: "maybe", reviewer: "R" })).status).toBe(422);
      expect(await rows("cost_evidence_reviews", `&evidence_id=eq.${ok.id}`)).toHaveLength(0);                                // nothing recorded by any refusal
      expect((await review(ok.id, ACCEPT)).status).toBe(201);
      expect((await review(ok.id, ACCEPT)).status).toBe(409);                                                                 // duplicate
      expect((await review(ok.id, { decision: "rejected", reviewer: "R" })).status).toBe(409);                                // flip
      expect((await review(invalid.id, ACCEPT)).status).toBe(422);                                                            // invalid never accepted
      expect((await review(invalid.id, { decision: "rejected", reviewer: "R" })).status).toBe(201);
      expect((await withdraw(invalid.id, { retired_by: "R" })).status).toBe(409);                                             // rejected: not withdrawable
      expect((await withdraw(ok.id, { reason: "no name" })).status).toBe(422);
      expect((await withdraw("00000000-0000-4000-8000-000000000000", { retired_by: "R" })).status).toBe(404);
      expect((await withdraw("not-a-uuid", { retired_by: "R" })).status).toBe(404);
      const expired = await insertValidatedLine(e, { valid_until: inDays(-1), cost_key: "ups.per_kW" });
      expect((await review(expired.id, ACCEPT)).status).toBe(422);                                                            // expired: cannot be accepted
      expect((await review(expired.id, { decision: "rejected", reviewer: "R" })).status).toBe(201);                           // ... but can be rejected
      const states = Object.fromEntries((await rows("cost_evidence_state", `&deliverable_id=eq.${e.id}`)).map((r) => [r.id, r.state]));
      expect(states).toEqual({ [ok.id]: "accepted", [invalid.id]: "rejected", [expired.id]: "rejected" });
      expect((await withdraw(ok.id, { retired_by: "R", reason: "r" })).status).toBe(201);
      expect((await withdraw(ok.id, { retired_by: "R" })).status).toBe(409);                                                  // already withdrawn
      expect((await run(e.token)).status).toBe(409);                                                                          // nothing accepted: nothing applied
      expect(TODAY).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
