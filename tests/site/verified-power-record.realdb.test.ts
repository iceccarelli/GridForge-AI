/**
 * The Verified Power Record against REAL PostgreSQL, through REAL PostgREST, with the
 * REAL Python engine. The in-memory fake is not involved.
 *
 * What is NOT real here: Supabase Storage. The "gateway" below serves /rest/v1 by
 * proxying to PostgREST (as Supabase's gateway does) and implements only the three
 * Storage object calls evidence upload makes, in memory. It is a stand-in, and this
 * file does not claim to verify Supabase Storage.
 *
 * Skipped unless GF_PGRST_URL (PostgREST, e.g. http://127.0.0.1:3300) and GF_PGRST_JWT
 * (a token whose role is service_role) are set — a skip is a gap in what was checked.
 */
import fs from "node:fs";
import crypto from "node:crypto";
import http from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";

// The admin review route reads the signed-in cookie; there is no request scope in a test.
const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT && spawnSync("python3", ["--version"]).status === 0;
// In CI the stack is mandatory: with GF_REQUIRE_REALDB=1 a missing or misconfigured database FAILS this file
// (the guard below) instead of letting every real-database test skip into a green run.
const required = process.env.GF_REQUIRE_REALDB === "1";

describe("real-database prerequisites", () => {
  it.runIf(required)("are present when the real database is required", () => {
    expect(PGRST, "GF_PGRST_URL must point at PostgREST (scripts/realdb-up.sh)").not.toBe("");
    expect(JWT, "GF_PGRST_JWT must be a service_role token (scripts/realdb-up.sh)").not.toBe("");
    expect(spawnSync("python3", ["--version"]).status, "python3 (the real engine) must be available").toBe(0);
    expect(enabled).toBe(true);
  });

  it.runIf(required && enabled)("answers: PostgREST is up and the project schema is applied", async () => {
    const r = await fetch(`${PGRST}/project_observations?limit=1`, { headers: { Authorization: `Bearer ${JWT}` } });
    expect(r.status, "migration 0017 must be applied").toBe(200);
  });
});
const KEY = "realdb-key";

let engine: ChildProcess | null = null;
let gateway: http.Server | null = null;
const objects = new Map<string, { bytes: Buffer; type: string }>();

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
      const r = await fetch(PGRST + url.slice("/rest/v1".length), {
        method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : body,
      });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
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

const sql = async (path: string, init: RequestInit = {}) =>
  fetch(PGRST + path, { ...init, headers: { Authorization: `Bearer ${JWT}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers ?? {}) } });
const rows = async (table: string, q = "") => (await (await sql(`/${table}?select=*${q}`)).json()) as any[];

const REQUEST = {
  load_profile: { csv: "timestamp,kW\n2026-01-01T00:00:00,30000\n2026-01-01T00:15:00,30000\n2026-01-01T00:30:00,30000\n", source: "hall-a.csv" },
  grid_firm_MW: 10, target_MW: 35, ride_through_hours: 3, redundancy: "N+1",
  generation: [
    { id: "GEN-A", kind: "gas_engine", nameplate_MW: 20, capex_eur: 16_000_000, lead_time_weeks: 44, fuel_type: "natural gas" },
    { id: "GEN-B", kind: "gas_engine", nameplate_MW: 20, capex_eur: 16_000_000, lead_time_weeks: 44, fuel_type: "natural gas" },
  ],
  bess: [{ id: "BESS-1", power_MW: 8, energy_MWh: 32, capex_eur: 7_200_000, lead_time_weeks: 30 }],
  interconnection: { utility: "TenneT", pcc_voltage_kV: 20, import_capacity_MW: 15 },
  permitting: { emissions_status: "application submitted" },
};
const ARCH = "GRID + BESS + GENERATION";
const PDF = new TextEncoder().encode("%PDF-1.4\n% offer letter fixture\n%%EOF\n");

beforeAll(async () => {
  if (!enabled) return;
  const engineUrl = await startEngine();
  process.env.SUPABASE_URL = await startGateway();
  process.env.SUPABASE_SERVICE_ROLE_KEY = JWT;
  process.env.GRIDFORGE_API_URL = engineUrl;
  process.env.GRIDFORGE_API_KEY = KEY;
}, 40_000);
afterAll(() => { engine?.kill(); gateway?.close(); });

const post = (path: string, body: unknown) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const j = async (r: Response) => (await r.json()) as any;

describe.skipIf(!enabled)("Verified Power Record — real PostgreSQL via PostgREST", () => {
  it("runs the whole chain and the database enforces what the application relies on", async () => {
    const name = `Hall A ${crypto.randomUUID().slice(0, 8)}`;
    const { POST: mkProject } = await import("@/app/api/projects/route");
    const made = await j(await mkProject(post("/api/projects", { project_name: name, company: "Example Colo" })));
    const pt = made.project_token as string;
    const [proj] = await rows("projects", `&project_token=eq.${pt}`);
    expect(proj.project_name).toBe(name);

    const { POST: mkCase } = await import("@/app/api/power/deploy/cases/route");
    const c = await j(await mkCase(post("/api/power/deploy/cases", REQUEST)));
    const caseToken = c.case_token as string;
    const { POST: attach } = await import("@/app/api/projects/[token]/cases/route");
    const a = await j(await attach(post("/x", { case_token: caseToken }), ctx({ token: pt })));
    expect(a.attached).toBe(true);
    expect((await j(await attach(post("/x", { case_token: caseToken }), ctx({ token: pt })))).attached).toBe(false);
    expect(await rows("project_links", `&project_id=eq.${proj.id}`)).toHaveLength(1);

    // a second project cannot take the same case: the database's unique index refuses it
    const other = (await j(await mkProject(post("/api/projects", { project_name: "Other" })))).project_token;
    const stolen = await attach(post("/x", { case_token: caseToken }), ctx({ token: other }));
    expect(stolen.status).toBe(409);

    // revision of an attached case: row + event in one transaction
    const { POST: revise } = await import("@/app/api/power/deploy/cases/[token]/route");
    const rev = await j(await revise(post("/x", { target_MW: 36 }), ctx({ token: caseToken })));
    expect(rev).toMatchObject({ ok: true, revision: 2, project_history: "recorded" });
    await revise(post("/x", { target_MW: 35 }), ctx({ token: caseToken }));

    const { GET: state } = await import("@/app/api/projects/[token]/route");
    const s1 = await j(await state(new Request(siteUrl("/x")), ctx({ token: pt })));
    expect(s1.cases[0]).toMatchObject({ latest_revision: 3, target_MW: 35, gap_MW: 25 });

    // RFQ from the real engine
    const { POST: rfq } = await import("@/app/api/projects/[token]/packages/route");
    const g = await j(await rfq(post("/x", { case_token: caseToken, architecture: ARCH }), ctx({ token: pt })));
    expect(g.ok).toBe(true);
    const pkg = g.package.package_token as string;
    const [pkgRow] = await rows("procurement_packages", `&package_token=eq.${pkg}`);
    expect(pkgRow.document_md).toContain("GEN-A");
    expect((await rows("project_links", `&object_id=eq.${pkg}`))).toHaveLength(1);

    const { POST: respond } = await import("@/app/api/projects/[token]/packages/[package]/responses/route");
    const resp = (supplier: string, v: Record<string, number>) => ({
      supplier, received_on: "2026-10-01", values: { ...pkgRow.response_template.values, ...v },
      compliance: Object.fromEntries(Object.keys(pkgRow.response_template.compliance).map((k) => [k, "C"])),
    });
    const pctx = ctx({ token: pt, package: pkg });
    expect((await respond(post("/x", resp("Supplier A", { capex_eur: 41e6, lead_time_weeks: 40, install_weeks: 8 })), pctx)).status).toBe(201);
    // duplicate supplier: refused by the database's unique index, not only by the application
    expect((await respond(post("/x", resp("supplier a", { capex_eur: 1, lead_time_weeks: 1 })), pctx)).status).toBe(409);
    expect((await respond(post("/x", resp("Supplier B", { capex_eur: 36.5e6, lead_time_weeks: 52, install_weeks: 10 })), pctx)).status).toBe(201);
    expect(await rows("procurement_responses", `&package_id=eq.${pkgRow.id}`)).toHaveLength(2);

    const { POST: compare } = await import("@/app/api/projects/[token]/packages/[package]/comparison/route");
    const cmp = await j(await compare(post("/x", {}), pctx));
    const [stored] = await rows("procurement_comparisons", `&package_id=eq.${pkgRow.id}`);
    expect(stored.result.ranked).toEqual(cmp.result.ranked);

    const { POST: select } = await import("@/app/api/projects/[token]/packages/[package]/selection/route");
    const loser = cmp.result.leading === "Supplier A" ? "Supplier B" : "Supplier A";
    expect((await select(post("/x", { supplier: loser, actor: "J. Ortiz" }), pctx)).status).toBe(200);
    expect((await select(post("/x", { supplier: cmp.result.leading, actor: "J. Ortiz" }), pctx)).status).toBe(409);
    const [after] = await rows("procurement_comparisons", `&package_id=eq.${pkgRow.id}`);
    expect(after.result).toEqual(stored.result);

    // evidence
    const { POST: up } = await import("@/app/api/projects/[token]/evidence/route");
    const send = (bytes: Uint8Array | string, type: string, file: string) =>
      up(new Request(siteUrl(`/api/projects/${pt}/evidence?filename=${file}`), { method: "POST", headers: { "content-type": type }, body: bytes as BodyInit }), ctx({ token: pt }));
    const ok = await j(await send(PDF, "application/pdf", "offer.pdf"));
    expect(ok.evidence.sha256).toBe(crypto.createHash("sha256").update(PDF).digest("hex"));
    const [evRow] = await rows("project_evidence", `&project_id=eq.${proj.id}`);
    expect(evRow).toMatchObject({ review_status: "unverified", evidence_class: null, media_type: "application/pdf", byte_size: PDF.byteLength });
    expect((await send(PDF, "application/pdf", "again.pdf")).status).toBe(409);
    expect((await send("x", "image/png", "a.png")).status).toBe(415);
    expect(await rows("project_evidence", `&project_id=eq.${proj.id}`)).toHaveLength(1);

    // complete history, in order, from the real table
    const events = await rows("project_events", `&project_id=eq.${proj.id}&order=occurred_at.asc`);
    expect(events.map((e) => e.event_type)).toEqual([
      "project_created", "btm_case_attached", "btm_case_revised", "btm_case_revised", "rfq_generated",
      "supplier_response_received", "supplier_response_received", "comparison_completed",
      "supplier_selected", "evidence_attached",
    ]);
    const final = await j(await state(new Request(siteUrl("/x")), ctx({ token: pt })));
    expect(final.events).toHaveLength(10);
    expect(final.procurement.packages[0].selection.supplier).toBe(loser);
    expect(final.evidence).toMatchObject({ total: 1, unverified: 1 });

    // the database itself refuses to rewrite history, even for service_role
    const id = events[0].id;
    expect((await sql(`/project_events?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ actor: "x" }) })).status).toBe(403);
    expect((await sql(`/project_events?id=eq.${id}`, { method: "DELETE" })).status).toBe(403);
    expect((await sql(`/procurement_comparisons?id=eq.${stored.id}`, { method: "DELETE" })).status).toBe(403);
    expect((await sql(`/procurement_responses?package_id=eq.${pkgRow.id}`, { method: "PATCH", body: JSON.stringify({ supplier: "x" }) })).status).toBe(403);

    // calibration: no observation link exists, and one cannot be made without a prediction
    expect(await rows("project_links", "&object_type=eq.calibration_observation")).toHaveLength(0);
    const bad = await sql("/project_links", { method: "POST", body: JSON.stringify({ project_id: proj.id, object_type: "calibration_observation", object_id: "o1" }) });
    expect(bad.status).toBe(400);

    // anonymous callers read nothing
    const anon = await fetch(`${PGRST}/projects?select=*`);
    expect(anon.ok).toBe(false);
  }, 120_000);
});


describe.skipIf(!enabled)("project → existing paid product, against real PostgreSQL", () => {
  const WH = "whsec_realdb_test_secret_for_signature";
  const hook = async (sessionId: string, kind: string, projectId: string | null, extra: Record<string, unknown> = {}) => {
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    process.env.STRIPE_WEBHOOK_SECRET = WH;
    delete process.env.RESEND_API_KEY;
    const payload = JSON.stringify({
      id: `evt_${sessionId}`, type: "checkout.session.completed",
      data: { object: { id: sessionId, object: "checkout_session", customer_email: "buyer@hall.example",
        amount_total: 450000, customer: "cus_x", metadata: { kind, company: "Hall Co", project_id: projectId }, ...extra } },
    });
    const sig = new Stripe("sk_test_placeholder").webhooks.generateTestHeaderString({ payload, secret: WH });
    const { POST } = await import("@/app/api/stripe/webhook/route");
    return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": sig }, body: payload }));
  };

  it("attaches Density Screen, Hall Watch and an Envelope Study deposit exactly once each, through redelivery", async () => {
    const { POST: mk } = await import("@/app/api/projects/route");
    const made = await j(await mk(post("/api/projects", { project_name: `Buyer ${crypto.randomUUID().slice(0, 6)}` })));
    const [proj] = await rows("projects", `&project_token=eq.${made.project_token}`);
    const sid = crypto.randomUUID().slice(0, 8);

    for (let i = 0; i < 3; i++) expect((await hook(`cs_ds_${sid}`, "density_screen", proj.id)).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await hook(`cs_w_${sid}`, "hall_watch", proj.id, { subscription: `sub_${sid}`, amount_total: 600000 })).status).toBe(200);
    for (let i = 0; i < 2; i++) expect((await hook(`cs_es_${sid}`, "envelope_study_deposit", proj.id, { amount_total: 900000 })).status).toBe(200);

    const [deliv] = await rows("deliverables", `&stripe_session_id=eq.cs_ds_${sid}`);
    expect(await rows("deliverables", `&stripe_session_id=eq.cs_ds_${sid}`)).toHaveLength(1);
    expect(await rows("watches", `&stripe_subscription_id=eq.sub_${sid}`)).toHaveLength(1);
    const links = await rows("project_links", `&project_id=eq.${proj.id}`);
    expect(links.map((l) => l.object_type).sort()).toEqual(["deliverable", "watch"]);
    expect(links.find((l) => l.object_type === "deliverable").object_id).toBe(deliv.id);
    const bought = await rows("project_events", `&project_id=eq.${proj.id}&event_type=eq.paid_product_attached&order=occurred_at.asc`);
    expect(bought.map((e) => e.payload.kind)).toEqual(["density_screen", "hall_watch", "envelope_study_deposit"]);

    // an object already owned by this project cannot be taken by another, even through the webhook
    const other = await j(await mk(post("/api/projects", { project_name: "Thief" })));
    const [otherProj] = await rows("projects", `&project_token=eq.${other.project_token}`);
    expect((await hook(`cs_ds_${sid}`, "density_screen", otherProj.id)).status).toBe(200); // fulfilled; attachment refused
    expect(await rows("project_links", `&project_id=eq.${otherProj.id}`)).toHaveLength(0);

    const { GET: state } = await import("@/app/api/projects/[token]/route");
    const s = await j(await state(new Request(siteUrl("/x")), ctx({ token: made.project_token })));
    expect(s.engagements.map((e: any) => [e.kind, e.status])).toEqual([
      ["density_screen", "awaiting_intake"], ["hall_watch", "active"], ["envelope_study_deposit", null],
    ]);
    expect(JSON.stringify(s)).not.toMatch(/intake_token/);
  }, 60_000);

  /** Run SQL as the database owner — used only to break and restore a real privilege. */
  const owner = (statement: string) =>
    spawnSync("psql", ["-h", process.env.PGHOST ?? "", "-p", process.env.PGPORT ?? "5432", "-U", process.env.PGUSER ?? "postgres",
      "-d", process.env.GF_PG_DB ?? "gf", "-v", "ON_ERROR_STOP=1", "-q", "-c", statement], { encoding: "utf8" });
  const canBreakPrivileges = !!process.env.PGHOST && spawnSync("psql", ["--version"]).status === 0;
  const newProject = async (name: string) => {
    const { POST: mk } = await import("@/app/api/projects/route");
    const made = await j(await mk(post("/api/projects", { project_name: `${name} ${crypto.randomUUID().slice(0, 6)}` })));
    const [row] = await rows("projects", `&project_token=eq.${made.project_token}`);
    return { token: made.project_token as string, id: row.id as string };
  };
  const eventsOf = (projectId: string) =>
    rows("project_events", `&project_id=eq.${projectId}&event_type=eq.paid_product_attached`);

  it("every attachable product ends in the identical state after three identical deliveries", async () => {
    const p = await newProject("Triple");
    const sid = crypto.randomUUID().slice(0, 8);
    const buy = [
      ["density_screen", `cs_ds_${sid}`, {}],
      ["procurement_spec", `cs_ps_${sid}`, { amount_total: 1_800_000 }],
      ["hall_watch", `cs_hw_${sid}`, { subscription: `sub_${sid}`, amount_total: 600_000 }],
      ["envelope_study_deposit", `cs_es_${sid}`, { amount_total: 900_000 }],
    ] as const;
    const snapshot = async () => JSON.stringify({
      deliverables: (await rows("deliverables", `&stripe_session_id=in.(cs_ds_${sid},cs_ps_${sid})`)).length,
      watches: (await rows("watches", `&stripe_subscription_id=eq.sub_${sid}`)).length,
      links: (await rows("project_links", `&project_id=eq.${p.id}`)).map((l) => l.object_type).sort(),
      events: (await eventsOf(p.id)).map((e) => [e.payload.kind, e.payload.stripe_session_id, e.payload.amount_cents]).sort(),
    });
    for (const [kind, session, extra] of buy) expect((await hook(session, kind, p.id, extra)).status).toBe(200);
    const once = await snapshot();
    for (let i = 0; i < 2; i++) for (const [kind, session, extra] of buy) expect((await hook(session, kind, p.id, extra)).status).toBe(200);
    expect(await snapshot()).toBe(once);                       // identical final state after 3 deliveries
    expect(JSON.parse(once)).toEqual({
      deliverables: 2, watches: 1, links: ["deliverable", "deliverable", "watch"],
      events: expect.arrayContaining([["procurement_spec", `cs_ps_${sid}`, 1_800_000], ["envelope_study_deposit", `cs_es_${sid}`, 900_000]]),
    });
    expect(JSON.parse(once).events).toHaveLength(4);
  }, 60_000);

  it("a purchase with no project is fulfilled exactly as before and touches no project", async () => {
    const before = (await rows("project_events", "&event_type=eq.paid_product_attached")).length;
    const sid = crypto.randomUUID().slice(0, 8);
    expect((await hook(`cs_plain_${sid}`, "density_screen", null)).status).toBe(200);
    expect((await hook(`cs_plain_w_${sid}`, "hall_watch", null, { subscription: `sub_plain_${sid}` })).status).toBe(200);
    expect(await rows("deliverables", `&stripe_session_id=eq.cs_plain_${sid}`)).toHaveLength(1);
    expect(await rows("watches", `&stripe_subscription_id=eq.sub_plain_${sid}`)).toHaveLength(1);
    expect((await rows("project_events", "&event_type=eq.paid_product_attached")).length).toBe(before);
  }, 30_000);

  it("a watch owned by one project is never reassigned to another", async () => {
    const a = await newProject("Owner");
    const b = await newProject("Other");
    const sid = crypto.randomUUID().slice(0, 8);
    const sub = { subscription: `sub_${sid}`, amount_total: 600_000 };
    expect((await hook(`cs_w_${sid}`, "hall_watch", a.id, sub)).status).toBe(200);
    expect((await hook(`cs_w_${sid}`, "hall_watch", b.id, sub)).status).toBe(200);   // fulfilled; attachment refused
    expect(await rows("project_links", `&project_id=eq.${b.id}`)).toHaveLength(0);
    expect(await eventsOf(b.id)).toHaveLength(0);
    expect(await rows("project_links", `&project_id=eq.${a.id}&object_type=eq.watch`)).toHaveLength(1);
    expect(await rows("watches", `&stripe_subscription_id=eq.sub_${sid}`)).toHaveLength(1);
  }, 30_000);

  it.skipIf(!canBreakPrivileges)("a real attachment failure asks Stripe to retry, leaves no false attachment, and the retry completes it once", async () => {
    const p = await newProject("Fails");
    const sid = crypto.randomUUID().slice(0, 8);
    expect(owner("revoke execute on function public.gf_attach_purchase(uuid, text, text, jsonb) from service_role").status).toBe(0);
    try {
      expect((await hook(`cs_f_${sid}`, "density_screen", p.id)).status).toBe(500);         // Stripe will redeliver
      expect(await rows("deliverables", `&stripe_session_id=eq.cs_f_${sid}`)).toHaveLength(1); // customer was fulfilled
      expect(await rows("project_links", `&project_id=eq.${p.id}`)).toHaveLength(0);          // no half-attachment
      expect(await eventsOf(p.id)).toHaveLength(0);                                           // no false event
    } finally {
      expect(owner("grant execute on function public.gf_attach_purchase(uuid, text, text, jsonb) to service_role").status).toBe(0);
    }
    expect((await hook(`cs_f_${sid}`, "density_screen", p.id)).status).toBe(200);
    expect((await hook(`cs_f_${sid}`, "density_screen", p.id)).status).toBe(200);
    expect(await rows("deliverables", `&stripe_session_id=eq.cs_f_${sid}`)).toHaveLength(1);
    expect(await rows("project_links", `&project_id=eq.${p.id}`)).toHaveLength(1);
    expect(await eventsOf(p.id)).toHaveLength(1);
  }, 30_000);
});


describe.skipIf(!enabled)("observed outcome against a real prediction, on real PostgreSQL", () => {
  const ledgerCount = () =>
    Number(spawnSync("python3", ["-c", "from gridforge.calibration import load_ledger; print(len(load_ledger().observations))"],
      { encoding: "utf8", cwd: process.cwd() }).stdout.trim());

  it("reads the prediction from the engine's own stored result, reviews it once, and never touches the ledger", async () => {
    process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
    jar.length = 0;
    const before = ledgerCount();
    expect(before).toBe(0);

    const { POST: mk } = await import("@/app/api/projects/route");
    const made = await j(await mk(post("/api/projects", { project_name: `Observed ${crypto.randomUUID().slice(0, 6)}` })));
    const [proj] = await rows("projects", `&project_token=eq.${made.project_token}`);
    const { POST: mkCase } = await import("@/app/api/power/deploy/cases/route");
    const c = await j(await mkCase(post("/api/power/deploy/cases", REQUEST)));
    const { POST: attach } = await import("@/app/api/projects/[token]/cases/route");
    await attach(post("/x", { case_token: c.case_token }), ctx({ token: made.project_token }));

    // the engine's own number for the architecture
    const engineMW = c.result.architectures.find((a: any) => a.label === ARCH).available_MW as number;
    expect(engineMW).toBeGreaterThan(0);

    const { POST: up } = await import("@/app/api/projects/[token]/evidence/route");
    const csv = `timestamp,kW\n2026-09-30T00:00:00,${Math.round((engineMW - 3) * 1000)}\n`;
    const upRes = await j(await up(new Request(siteUrl(`/api/projects/${made.project_token}/evidence?filename=meter.csv&source_category=load_data`),
      { method: "POST", headers: { "content-type": "text/csv" }, body: csv }), ctx({ token: made.project_token })));
    const evidenceId = upRes.evidence.id as string;

    const { POST: submit } = await import("@/app/api/projects/[token]/observations/route");
    const obs = (body: Record<string, unknown>) => submit(post("/x", body), ctx({ token: made.project_token }));
    const input = { calibration_key: "btm.firm_MW", case_token: c.case_token, architecture: ARCH, observed_value: engineMW - 3,
      observed_on: "2026-09-30", method: "revenue-meter export, 30-day trend", submitted_by: "A. Rivera", evidence_id: evidenceId,
      attests_installed_architecture: true, installed_basis: "commissioning certificate CC-114" };
    // refusals write neither a record nor an event
    const eventsBefore = (await rows("project_events", `&project_id=eq.${proj.id}`)).length;
    for (const bad of [{ evidence_id: undefined }, { attests_installed_architecture: false }, { installed_basis: "" }]) {
      expect((await obs({ ...input, ...bad })).status).toBe(422);
    }
    expect(await rows("project_observations", `&project_id=eq.${proj.id}`)).toHaveLength(0);
    expect((await rows("project_events", `&project_id=eq.${proj.id}`)).length).toBe(eventsBefore);
    const sub = await j(await obs({ ...input, predicted_value: 12345 }));
    const [row] = await rows("project_observations", `&project_id=eq.${proj.id}`);
    expect(Number(row.predicted_value)).toBeCloseTo(engineMW, 6);          // the engine's, not the caller's
    expect(Number(row.delta_value)).toBeCloseTo(-3, 6);
    expect(sub.observation.state).toBe("submitted");
    expect((await obs(input)).status).toBe(409);                          // same prediction, same day: once
    expect(await rows("project_observation_reviews", `&project_id=eq.${proj.id}`)).toHaveLength(0);

    // review: admin only, exactly once, class stated by the reviewer
    const { POST: rev } = await import("@/app/api/admin/observations/[id]/review/route");
    const decide = (body: Record<string, unknown>) => rev(post("/x", body), ctx({ id: row.id }));
    expect((await decide({ decision: "verified", evidence_class: "E5", reviewer: "J. Ortiz" })).status).toBe(401);
    const { createHash } = await import("node:crypto");
    jar.push({ name: "gf_admin", value: createHash("sha256").update(process.env.ADMIN_PASSWORD).digest("hex") });
    expect((await decide({ decision: "verified", reviewer: "J. Ortiz" })).status).toBe(422);
    expect((await decide({ decision: "verified", evidence_class: "E5", reviewer: "J. Ortiz", reason: "meter export matches" })).status).toBe(201);
    expect((await decide({ decision: "rejected", reviewer: "J. Ortiz" })).status).toBe(409);
    expect(await rows("project_observation_reviews", `&project_id=eq.${proj.id}`)).toHaveLength(1);

    const { GET: state } = await import("@/app/api/projects/[token]/route");
    const s = await j(await state(new Request(siteUrl("/x")), ctx({ token: made.project_token })));
    expect(s.observations).toEqual([expect.objectContaining({ state: "verified", evidence_class: "E5", reviewed_by: "J. Ortiz", ledger_eligible: true })]);

    // the database itself refuses to rewrite either record, even for service_role
    expect((await sql(`/project_observations?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ observed_value: 99 }) })).status).toBe(403);
    expect((await sql(`/project_observation_reviews?observation_id=eq.${row.id}`, { method: "DELETE" })).status).toBe(403);
    const events = await rows("project_events", `&project_id=eq.${proj.id}&event_type=in.(observation_submitted,observation_reviewed)&order=occurred_at.asc`);
    expect(events.map((e) => e.event_type)).toEqual(["observation_submitted", "observation_reviewed"]);

    // calibration is exactly where it was: verified is not the same as reconciled
    expect(ledgerCount()).toBe(before);
    expect(await rows("project_links", "&object_type=eq.calibration_observation")).toHaveLength(0);
  }, 60_000);
});


describe.skipIf(!enabled)("supplier reality against a real selected quote, on real PostgreSQL", () => {
  it("copies the quote from the stored selected response, derives the comparison in the database, reviews once, and touches no cost data", async () => {
    process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
    jar.length = 0;
    const { createHash } = await import("node:crypto");
    const fileHash = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    const costsBefore = [fileHash("gridforge/data/cost_library.json"), fileHash("gridforge/data/calibration.json")];

    const { POST: mk } = await import("@/app/api/projects/route");
    const made = await j(await mk(post("/api/projects", { project_name: `Reality ${crypto.randomUUID().slice(0, 6)}` })));
    const pt = made.project_token as string;
    const [proj] = await rows("projects", `&project_token=eq.${pt}`);
    const { POST: mkCase } = await import("@/app/api/power/deploy/cases/route");
    const c = await j(await mkCase(post("/api/power/deploy/cases", REQUEST)));
    const { POST: attach } = await import("@/app/api/projects/[token]/cases/route");
    await attach(post("/x", { case_token: c.case_token }), ctx({ token: pt }));
    const { POST: rfq } = await import("@/app/api/projects/[token]/packages/route");
    const g = await j(await rfq(post("/x", { case_token: c.case_token, architecture: ARCH }), ctx({ token: pt })));
    const pkg = g.package.package_token as string;
    const [pkgRow] = await rows("procurement_packages", `&package_token=eq.${pkg}`);
    const pctx = ctx({ token: pt, package: pkg });

    const { POST: respond } = await import("@/app/api/projects/[token]/packages/[package]/responses/route");
    const resp = {
      supplier: "Supplier B", received_on: "2026-10-01",
      values: { ...pkgRow.response_template.values, capex_eur: 36.5e6, lead_time_weeks: 52, install_weeks: 10 },
      compliance: Object.fromEntries(Object.keys(pkgRow.response_template.compliance).map((k) => [k, "C"])),
    };
    expect((await respond(post("/x", resp), pctx)).status).toBe(201);

    const { POST: up } = await import("@/app/api/projects/[token]/evidence/route");
    const upRes = await j(await up(new Request(siteUrl(`/api/projects/${pt}/evidence?filename=po.pdf&source_category=supplier_document`),
      { method: "POST", headers: { "content-type": "application/pdf" }, body: PDF as BodyInit }), ctx({ token: pt })));
    const evidenceId = upRes.evidence.id as string;

    const { POST: actual } = await import("@/app/api/projects/[token]/packages/[package]/actuals/route");
    const record = (body: Record<string, unknown>) => actual(post("/x", body), pctx);
    const facts = { po_date: "2025-06-02", on_site_date: "2026-05-18", energised_date: "2026-07-27", actual_cost: 38e6,
      actual_cost_currency: "EUR", cost_scope: "same_as_quote", evidence_id: evidenceId,
      method: "PO, delivery note and handover record", submitted_by: "A. Rivera" };

    // before any selection there is no quote to compare against: refused, nothing written
    const eventsBefore = (await rows("project_events", `&project_id=eq.${proj.id}`)).length;
    expect((await record(facts)).status).toBe(409);
    expect(await rows("supplier_actuals", `&project_id=eq.${proj.id}`)).toHaveLength(0);
    expect((await rows("project_events", `&project_id=eq.${proj.id}`)).length).toBe(eventsBefore);

    // selection follows a comparison, as in the product
    const { POST: compare } = await import("@/app/api/projects/[token]/packages/[package]/comparison/route");
    expect((await compare(post("/x", {}), pctx)).status).toBeLessThan(300);
    const { POST: select } = await import("@/app/api/projects/[token]/packages/[package]/selection/route");
    expect((await select(post("/x", { supplier: "Supplier B", actor: "J. Ortiz" }), pctx)).status).toBe(200);

    // the database copies the quote; the caller's idea of it is ignored
    expect((await record({ ...facts, quoted_capex_eur: 1, quoted_lead_time_weeks: 1 })).status).toBe(201);
    const [row] = await rows("supplier_actuals", `&project_id=eq.${proj.id}`);
    expect(row).toMatchObject({ supplier: "Supplier B", architecture: ARCH });
    expect(Number(row.quoted_capex_eur)).toBe(36.5e6);
    expect(Number(row.quoted_lead_time_weeks)).toBe(52);
    expect((await record(facts)).status).toBe(409);                          // one first record per package

    // the derived view, computed by PostgreSQL
    const [v] = await rows("supplier_reality", `&actual_id=eq.${row.id}`);
    expect(Number(v.actual_lead_time_weeks)).toBe(50);
    expect(Number(v.actual_install_weeks)).toBe(10);
    expect(Number(v.cost_delta_eur)).toBe(1.5e6);
    expect(v.cost_basis).toBe("EUR, same scope as quote");

    // a correction supersedes exactly one record; the original stays
    const fix = await record({ ...facts, actual_cost: 38.2e6, supersedes_id: row.id });
    expect(fix.status).toBe(201);
    expect((await record({ ...facts, supersedes_id: row.id })).status).toBe(409);
    expect(await rows("supplier_actuals", `&project_id=eq.${proj.id}`)).toHaveLength(2);

    // review: admin only, once, naming facts the record supplies
    const { POST: rev } = await import("@/app/api/admin/supplier-actuals/[id]/review/route");
    const decide = (body: Record<string, unknown>) => rev(post("/x", body), ctx({ id: row.id }));
    expect((await decide({ decision: "verified", verified_fields: ["po_date"], reviewer: "J. Ortiz" })).status).toBe(401);
    jar.push({ name: "gf_admin", value: createHash("sha256").update(process.env.ADMIN_PASSWORD).digest("hex") });
    expect((await decide({ decision: "verified", verified_fields: ["dispatch_date"], reviewer: "J. Ortiz" })).status).toBe(422);
    expect((await decide({ decision: "verified", verified_fields: ["po_date", "on_site_date"], reviewer: "J. Ortiz" })).status).toBe(201);
    expect((await decide({ decision: "rejected", reviewer: "J. Ortiz", reason: "no" })).status).toBe(409);

    const { GET: state } = await import("@/app/api/projects/[token]/route");
    const s = await j(await state(new Request(siteUrl("/x")), ctx({ token: pt })));
    expect(s.supplier_reality).toHaveLength(2);
    expect(s.supplier_reality[0]).toMatchObject({ state: "verified", superseded: true, verified_fields: ["po_date", "on_site_date"],
      lead_time: expect.objectContaining({ quoted_weeks: 52, actual_weeks: 50 }) });
    expect(s.supplier_reality[1]).toMatchObject({ state: "submitted", supersedes_id: row.id });

    // the database refuses to rewrite either record, even for service_role
    expect((await sql(`/supplier_actuals?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ actual_cost: 1 }) })).status).toBe(403);
    expect((await sql(`/supplier_actual_reviews?actual_id=eq.${row.id}`, { method: "DELETE" })).status).toBe(403);
    const events = await rows("project_events", `&project_id=eq.${proj.id}&event_type=in.(supplier_actual_submitted,supplier_actual_reviewed)&order=occurred_at.asc`);
    expect(events.map((e) => e.event_type)).toEqual(["supplier_actual_submitted", "supplier_actual_submitted", "supplier_actual_reviewed"]);

    // nothing reached the cost library or the calibration data
    expect([fileHash("gridforge/data/cost_library.json"), fileHash("gridforge/data/calibration.json")]).toEqual(costsBefore);
  }, 90_000);
});


describe.skipIf(!enabled)("deposit hand-off on real PostgreSQL", () => {
  const WH = "whsec_test_secret_for_signature_generation";
  const hook = async (sessionId: string, kind: string, amount: number, extra: Record<string, string> = {}) => {
    process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
    process.env.STRIPE_WEBHOOK_SECRET = WH;
    delete process.env.RESEND_API_KEY;
    const payload = JSON.stringify({
      id: `evt_${sessionId}`, type: "checkout.session.completed",
      data: { object: { id: sessionId, object: "checkout_session", customer_email: "buyer@hall.example", currency: "eur",
        amount_total: amount, metadata: { kind, company: "Hall Co", ...extra } } },
    });
    const sig = new Stripe("sk_test_placeholder").webhooks.generateTestHeaderString({ payload, secret: WH });
    const { POST } = await import("@/app/api/stripe/webhook/route");
    return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": sig }, body: payload }));
  };

  it("records the payment once through redelivery, advances it only with proof, and the database refuses the rest", async () => {
    process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
    jar.length = 0;
    const sid = `cs_dep_${crypto.randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 3; i++) expect((await hook(sid, "envelope_study_deposit", 900_000)).status).toBe(200);
    const mine = await rows("engagement_deposits", `&stripe_session_id=eq.${sid}`);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "envelope_study_deposit", amount_cents: 900_000, currency: "eur", status: "paid", owner: null });

    // the customer page, from the real record
    const { default: Page } = await import("@/app/commissioned/page");
    const React = (await import("react")).default;
    (globalThis as { React?: unknown }).React = React;
    const { renderToStaticMarkup } = await import("react-dom/server");
    expect(renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ session_id: sid }) }))).toContain("there is no intake form");

    // operator steps: admin only, in order, each with its proof
    const { createHash } = await import("node:crypto");
    const { POST: adv } = await import("@/app/api/admin/deposits/[id]/route");
    const go = (body: Record<string, unknown>) => adv(post("/x", body), ctx({ id: mine[0].id }));
    expect((await go({ owner: "A. Rivera" })).status).toBe(401);
    jar.push({ name: "gf_admin", value: createHash("sha256").update(process.env.ADMIN_PASSWORD).digest("hex") });
    expect((await go({})).status).toBe(422);
    expect((await go({ owner: "A. Rivera" })).status).toBe(200);
    expect((await go({ owner: "again" })).status).toBe(422);                 // now needs the scope note
    expect((await go({ scope_note: "Hall A+B, 35 MW" })).status).toBe(200);
    expect((await go({ delivery_ref: "https://example.test/d/1" })).status).toBe(200);
    expect((await go({ delivery_ref: "x" })).status).toBe(409);
    const [done] = await rows("engagement_deposits", `&stripe_session_id=eq.${sid}`);
    expect(done).toMatchObject({ status: "delivered", owner: "A. Rivera", scope_note: "Hall A+B, 35 MW" });

    // the database, not the route, refuses to rewrite the payment, reverse a step or delete the record
    const patch = (body: unknown) => sql(`/engagement_deposits?id=eq.${done.id}`, { method: "PATCH", body: JSON.stringify(body) });
    expect((await patch({ amount_cents: 1 })).status).toBeGreaterThanOrEqual(400);
    expect((await patch({ status: "paid" })).status).toBeGreaterThanOrEqual(400);
    expect((await patch({ owner: "someone else" })).status).toBeGreaterThanOrEqual(400);
    expect((await sql(`/engagement_deposits?id=eq.${done.id}`, { method: "DELETE" })).status).toBeGreaterThanOrEqual(400);
    expect((await rows("engagement_deposits", `&id=eq.${done.id}`))).toHaveLength(1);
  }, 60_000);
});
