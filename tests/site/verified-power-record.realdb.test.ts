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
import crypto from "node:crypto";
import http from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import Stripe from "stripe";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT && spawnSync("python3", ["--version"]).status === 0;
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
  const hook = async (sessionId: string, kind: string, projectId: string, extra: Record<string, unknown> = {}) => {
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
});
