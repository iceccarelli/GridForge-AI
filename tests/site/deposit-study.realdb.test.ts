/**
 * The Envelope Study, deposit to delivery, against REAL PostgreSQL through REAL PostgREST (every migration applied) and
 * the REAL Python engine:
 *
 *   paid deposit -> contacted -> scoped -> OPEN STUDY INTAKE (one engagement, the buyer's private link emailed, never twice)
 *   -> the buyer's full intake -> the engine's /v1/study -> a draft pack (study + one-page board summary + working files)
 *   -> a named engineer's review and release -> the deposit is DELIVERED by itself, referencing the engagement -> the buyer reads it.
 *
 * Mail is intercepted (Resend is never contacted) and Stripe events are signed locally. NOT proven here: Stripe delivering, Supabase
 * (this is PostgREST + plain PostgreSQL), Resend delivering to an inbox.
 *
 * Skipped unless GF_PGRST_URL and GF_PGRST_JWT are set (scripts/realdb-up.sh); GF_REQUIRE_REALDB=1 turns a missing stack into a failure.
 */
import crypto from "node:crypto";
import http from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Stripe from "stripe";
import { adminToken } from "@/lib/admin";
import { reviewHash } from "@/lib/deliverables";
import { screenIntakeSchema, toIntakeDocument } from "@/lib/engagement-intake";
import { siteUrl } from "@/lib/site";
import { paidSession } from "./checkout-fixture";

(globalThis as { React?: unknown }).React = React;
const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));
// These journeys prove database behaviour with checkout sessions Stripe has never seen; the release gate that asks Stripe whether a payment still stands is covered in tests/site/release-payment-standing.test.ts.
vi.mock("@/lib/payment-standing", () => ({ paymentStanding: async () => ({ state: "ok", partial_refund_cents: 0 }) }));

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT && spawnSync("python3", ["--version"]).status === 0;
const required = process.env.GF_REQUIRE_REALDB === "1";
const KEY = "deposit-study-realdb-key";
const WH = "whsec_deposit_study_realdb";
let engine: ChildProcess | null = null;
let gateway: http.Server | null = null;
const mail: { to: string[] | string; subject: string; text: string; key: string | null }[] = [];
let mailDown = false;
const realFetch = globalThis.fetch;

describe("real-database prerequisites (deposit study)", () => {
  it.runIf(required)("are present when the real database is required", async () => {
    expect(enabled).toBe(true);
    for (const t of ["watch_note_notices", "engagement_credits", "customer_notifications", "engagement_deposits"]) {
      expect((await realFetch(`${PGRST}/${t}?limit=1`, { headers: { Authorization: `Bearer ${JWT}` } })).status, t).toBe(200);
    }
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
/** The application talks to Supabase at /rest/v1/...; PostgREST serves the same tables at /. */
async function startGateway(): Promise<string> {
  gateway = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = req.url ?? "";
    if (url.startsWith("/rest/v1/")) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
      const r = await realFetch(PGRST + url.slice("/rest/v1".length), { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : Buffer.concat(chunks) });
      res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
      res.end(Buffer.from(await r.arrayBuffer()));
      return;
    }
    res.writeHead(404).end("{}");
  });
  await new Promise<void>((r) => gateway!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(gateway!.address() as { port: number }).port}`;
}

const sql = (path: string, init: RequestInit = {}) =>
  realFetch(PGRST + path, { ...init, headers: { Authorization: `Bearer ${JWT}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers ?? {}) } });
const rows = async (table: string, q = "") => (await (await sql(`/${table}?select=*${q}`)).json()) as any[];
const patch = (table: string, q: string, body: unknown) => sql(`/${table}?${q}`, { method: "PATCH", body: JSON.stringify(body) });

beforeAll(async () => {
  if (!enabled) return;
  process.env.GRIDFORGE_API_URL = await startEngine();
  process.env.SUPABASE_URL = await startGateway();
  process.env.SUPABASE_SERVICE_ROLE_KEY = JWT;
  process.env.GRIDFORGE_API_KEY = KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = WH;
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  process.env.CRON_SECRET = "cron-secret-value";
  process.env.RESEND_API_KEY = "re_test";
  process.env.LEAD_FROM_EMAIL = "Time to Power <power@timetopower.ai>";
  process.env.LEAD_TO_EMAIL = "ops@example.test";
  delete process.env.RESEND_FROM;
  // Mail is intercepted; everything else is the real network (the gateway and the engine are local).
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith("https://api.resend.com")) {
      if (mailDown) return new Response("{}", { status: 503 });
      mail.push({ ...JSON.parse(String(init?.body)), key: (init?.headers as Record<string, string>)["Idempotency-Key"] ?? null });
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }
    return realFetch(i as RequestInfo, init);
  }) as typeof fetch;
}, 40_000);
afterAll(() => { globalThis.fetch = realFetch; engine?.kill(); gateway?.close(); });
beforeEach(() => { mail.length = 0; mailDown = false; jar.length = 0; });

const stripe = new Stripe("sk_test_placeholder");
const uid = () => crypto.randomUUID().slice(0, 8);
let ip = 10;
const caller = () => ({ "x-real-ip": `198.51.100.${(ip = (ip % 250) + 1)}` });
async function event(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id: `evt_${uid()}`, type, data: { object } });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
}
const checkout = (session: string, kind: string, amount: number, email: string, extra: Record<string, unknown> = {}) =>
  event("checkout.session.completed", paidSession({ id: session, customer_email: email, customer: `cus_${session}`, amount_total: amount, currency: "eur", metadata: { kind, company: "Hall Co" }, ...extra }));
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const json = (b: unknown, method = "POST") => new Request(siteUrl("/x"), { method, headers: { "content-type": "application/json", ...caller() }, body: JSON.stringify(b) });
const INTAKE = {
  siteName: "North Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4,
  currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180,
  plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};
const cronGet = (path: string) => new Request(siteUrl(path), { headers: { authorization: "Bearer cron-secret-value" } });
const to = (m: { to: string[] | string }) => ([] as string[]).concat(m.to).join(",");


const FULL_INTAKE = {
  ...INTAKE,
  buswayRuns: 6, voltageV: 400, powerFactor: 0.97, utilisation: 0.75, floorType: "raised_floor",
  plantReturnC: 12, designDrybulbC: 34,
  transformers: [{ id: "TX1", unit_rating_MVA: 8, units: 3, redundancy: "N+1" }],
  ups: [{ id: "UPS1", unit_rating_kW: 1600, units: 4, redundancy: "N+1" }],
};

async function scopedDeposit(email: string) {
  const session = `cs_study_${uid()}`;
  expect((await checkout(session, "envelope_study_deposit", 900_000, email)).status).toBe(200);
  const [dep] = await rows("engagement_deposits", `&stripe_session_id=eq.${session}`);
  jar.push({ name: "gf_admin", value: adminToken()! });
  const { POST: step } = await import("@/app/api/admin/deposits/[id]/route");
  const go = (b: Record<string, unknown>) => step(json(b), { params: Promise.resolve({ id: dep.id }) });
  expect((await go({ owner: "A. Rivera" })).status).toBe(200);
  const scoped = await go({ scope_note: "One hall, all architectures, time to power", agreed_fee_cents: 2_800_000, delivery_due_on: "2099-03-31" });
  expect(scoped.status, await scoped.clone().text()).toBe(200);
  return { dep, session };
}
const openIntake = async (id: string) => {
  const { POST } = await import("@/app/api/admin/deposits/[id]/open-intake/route");
  return POST(json({}), { params: Promise.resolve({ id }) });
};

describe.skipIf(!enabled)("Envelope Study: deposit to delivery on real PostgreSQL and the real engine", () => {
  it("cannot be opened before the scope, the fee and the date are recorded", async () => {
    const email = `early-${uid()}@hall.example`, session = `cs_early_${uid()}`;
    await checkout(session, "envelope_study_deposit", 900_000, email);
    const [dep] = await rows("engagement_deposits", `&stripe_session_id=eq.${session}`);
    jar.push({ name: "gf_admin", value: adminToken()! });
    const res = await openIntake(dep.id);
    expect(res.status).toBe(409);
    expect(await rows("deliverables", `&stripe_session_id=eq.${session}`)).toHaveLength(0);
  });

  it("is admin-only, and only for the two deposit-backed engagements", async () => {
    const email = `auth-${uid()}@hall.example`, { dep } = await scopedDeposit(email);
    jar.length = 0;
    expect((await openIntake(dep.id)).status).toBe(401);
    // a deposit of a legacy kind (no engagement behind it) never opens an intake
    const legacy = `cs_legacy_${uid()}`;
    await checkout(legacy, "engagement_deposit", 900_000, `lg-${uid()}@hall.example`);
    const [lg] = await rows("engagement_deposits", `&stripe_session_id=eq.${legacy}`);
    jar.push({ name: "gf_admin", value: adminToken()! });
    expect((await openIntake(lg.id)).status).toBe(422);
  });

  it("scoped -> one engagement and one email, however many times it is clicked or clicked at once", async () => {
    const email = `once-${uid()}@hall.example`, { dep, session } = await scopedDeposit(email);
    const results = await Promise.all([openIntake(dep.id), openIntake(dep.id), openIntake(dep.id)]);
    for (const r of results) expect(r.status, await r.clone().text()).toBe(200);
    const made = await Promise.all(results.map(async (r) => (await r.json()) as any));
    expect(made.filter((m) => m.created).length).toBe(1);
    const d = await rows("deliverables", `&stripe_session_id=eq.${session}`);
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "envelope_study_deposit", status: "awaiting_intake", email, amount_cents: 900_000 });
    const links = mail.filter((m) => to(m).includes(email) && /numbers we need/.test(m.subject));
    expect(links).toHaveLength(1);
    expect(links[0].text).toContain(`/intake/${d[0].intake_token}`);
    expect(links[0].text).not.toContain(d[0].token);          // never the credential that reads the document
    // the database itself refuses a second engagement for the same deposit payment (deliverables_one_per_session)
    const dup = await sql("/deliverables", { method: "POST", body: JSON.stringify({ kind: "envelope_study_deposit", token: `dup-${uid()}`, stripe_session_id: session, status: "awaiting_intake" }) });
    expect(dup.status).toBeGreaterThanOrEqual(400);
  });

  it("the whole journey: intake -> /v1/study -> a draft pack -> a named engineer's release -> the deposit is delivered by itself -> the buyer reads it", async () => {
    const email = `study-${uid()}@hall.example`, { dep, session } = await scopedDeposit(email);
    expect((await openIntake(dep.id)).status).toBe(200);
    const [row] = await rows("deliverables", `&stripe_session_id=eq.${session}`);

    const { POST: intake } = await import("@/app/api/intake/[token]/route");
    const res = await intake(json(FULL_INTAKE), ctx(row.intake_token));
    expect(res.status, await res.clone().text()).toBe(200);
    const [draft] = await rows("deliverables", `&id=eq.${row.id}`);
    expect(draft.status).toBe("draft");
    expect(draft.title).toMatch(/study/i);
    expect(draft.intake._gridforge).toMatchObject({ endpoint: "study" });
    expect(Object.keys(draft.working_files)).toEqual(expect.arrayContaining(["bundle.json", "board_summary.html", "board_summary.md", "headroom_ladder.csv", "assumed_inputs.csv"]));
    expect(draft.document_html).toBeTruthy();

    // a deposit is not delivered by a draft
    expect((await rows("engagement_deposits", `&id=eq.${dep.id}`))[0].status).toBe("scoped");

    jar.push({ name: "gf_admin", value: adminToken()! });
    const { PATCH } = await import("@/app/api/admin/deliverables/route");
    const rel = await PATCH(json({ token: draft.token, reviewed_hash: reviewHash(draft), reviewed_by: "A. Rivera" }, "PATCH"));
    const relBody: any = await rel.json();
    expect(rel.status, JSON.stringify(relBody)).toBe(200);
    expect(relBody.deposit_delivery).toBe("delivered");

    const [done] = await rows("engagement_deposits", `&id=eq.${dep.id}`);
    expect(done).toMatchObject({ status: "delivered", delivery_ref: `engagement:${row.id}` });
    expect(done.delivery_ref).not.toContain(draft.token);
    expect(mail.filter((m) => to(m).includes(email) && /document is ready/.test(m.subject))).toHaveLength(1);

    // releasing again changes nothing about the deposit
    const again = await PATCH(json({ token: draft.token, reviewed_hash: reviewHash(draft), reviewed_by: "A. Rivera" }, "PATCH"));
    expect(again.status).toBe(200);
    expect((await rows("engagement_deposits", `&id=eq.${dep.id}`))[0]).toMatchObject({ status: "delivered", delivery_ref: `engagement:${row.id}` });

    // and the buyer reads the study at their private link
    const { default: Page } = await import("@/app/deliverable/[token]/page");
    const page = renderToStaticMarkup(await Page({ params: Promise.resolve({ token: draft.token }) }));
    expect(page).toContain("by A. Rivera");
    expect(page.length).toBeGreaterThan(5_000);
    // the open-intake call on a delivered deposit is refused
    expect((await openIntake(dep.id)).status).toBe(409);
  });
});


// ---------------------------------------------------------------------------------------------------------------------------------
const HALLS_CSV = [
  "siteName,hallId,metro,country,contractedMW,currentPeakMW,currentItLoadMW,buswayAmpacityA,tapoffMaxA,positionsAvailable,plantSupplyC,firmCapacityMVA,floorLoadingKPa,plantCapacityKW,platform",
  "North Hall,H1,Dublin,IE,12,7.4,4.9,400,63,180,6,15,12,6000,gb300_nvl72",
  "South Hall,H2,Cork,IE,30,18,12,1600,250,400,7,36,15,16000,gb300_nvl72",
  "East Hall,H3,Galway,IE,6,4.2,2.5,250,63,90,8,,,,gb300_nvl72",
  "West Hall,H4,Limerick,IE,20,11,7,800,125,260,6,24,12,11000,gb200_nvl72",
  "Port Hall,H5,Dublin,IE,45,30,20,3200,400,700,6,52,18,30000,gb300_nvl72",
].join("\n");

async function scopedPortfolio(email: string) {
  const session = `cs_pf_${uid()}`;
  expect((await checkout(session, "portfolio_screen_deposit", 1_500_000, email)).status).toBe(200);
  const [dep] = await rows("engagement_deposits", `&stripe_session_id=eq.${session}`);
  jar.push({ name: "gf_admin", value: adminToken()! });
  const { POST: step } = await import("@/app/api/admin/deposits/[id]/route");
  const go = (b: Record<string, unknown>) => step(json(b), { params: Promise.resolve({ id: dep.id }) });
  expect((await go({ owner: "A. Rivera" })).status).toBe(200);
  const scoped = await go({ scope_note: "Five halls, ranked by deployable compute", agreed_fee_cents: 9_000_000, delivery_due_on: "2099-04-30" });
  expect(scoped.status, await scoped.clone().text()).toBe(200);
  return { dep, session };
}

describe.skipIf(!enabled)("Portfolio Screen: deposit to delivery on real PostgreSQL and the real engine", () => {
  it("the whole journey: scoped -> intake opened -> five halls -> the engine ranks them -> draft with a pack per hall -> release -> delivered", async () => {
    const { parsePortfolioCsv } = await import("@/lib/portfolio-csv");
    const email = `pf-${uid()}@fund.example`, { dep, session } = await scopedPortfolio(email);
    expect((await openIntake(dep.id)).status).toBe(200);
    const [row] = await rows("deliverables", `&stripe_session_id=eq.${session}`);
    expect(row).toMatchObject({ kind: "portfolio_screen_deposit", status: "awaiting_intake" });
    expect(mail.filter((m) => to(m).includes(email) && /numbers we need/.test(m.subject))).toHaveLength(1);

    // the buyer's page is the multi-hall form, not the one-hall form
    const { default: IntakePage } = await import("@/app/intake/[token]/page");
    const html = renderToStaticMarkup(await IntakePage({ params: Promise.resolve({ token: row.intake_token }) }));
    expect(html).toContain("The halls to rank");

    // what the form sends: the CSV, parsed exactly as the form parses it
    const parsed = parsePortfolioCsv(HALLS_CSV);
    expect(parsed.errors).toEqual([]);
    expect(parsed.halls).toHaveLength(5);
    const { POST: intake } = await import("@/app/api/intake/[token]/route");

    // refused, and nothing generated: one hall, a repeated hall, a missing required figure
    for (const bad of [
      { halls: [parsed.halls[0]] },
      { halls: [parsed.halls[0], parsed.halls[0]] },
      { halls: [parsed.halls[0], { ...parsed.halls[1], contractedMW: undefined }] },
      { halls: parsed.halls, objective: "cheapest" },
    ]) {
      const r = await intake(json(bad), ctx(row.intake_token));
      expect(r.status, JSON.stringify(bad).slice(0, 80)).toBe(422);
    }
    expect((await rows("deliverables", `&id=eq.${row.id}`))[0].status).toBe("awaiting_intake");

    // documents are attached to one hall, so the evidence routes refuse a portfolio
    const ev = await import("@/app/api/intake/[token]/evidence/route");
    expect((await ev.GET(new Request(siteUrl("/x")), ctx(row.intake_token))).status).toBe(422);

    const res = await intake(json({ client: "North Estate", objective: "max_compute", halls: parsed.halls }), ctx(row.intake_token));
    const body: any = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe("draft");
    // East Hall left three figures blank: they are named, hall by hall
    expect(body.assumed.filter((a: any) => a.hall === "East Hall / H3").map((a: any) => a.field).sort()).toEqual(["firmCapacityMVA", "floorLoadingKPa", "plantCapacityKW"]);

    const [draft] = await rows("deliverables", `&id=eq.${row.id}`);
    expect(draft.status).toBe("draft");
    expect(draft.title).toMatch(/Portfolio Screen/i);
    expect(draft.title).toMatch(/5 halls/);
    const files = Object.keys(draft.working_files);
    expect(files.filter((f) => f.startsWith("model_pack_")).length).toBe(5);
    expect(files).toEqual(expect.arrayContaining(["ranking.json", "bundle.json"]));
    expect(JSON.parse(draft.working_files["bundle.json"]).expected).toEqual(["study", "hall_model_packs"]);
    const ranking = JSON.parse(draft.working_files["ranking.json"]);
    expect(ranking.halls).toHaveLength(5);
    expect(draft.document_md).toContain("North Estate");
    for (const h of ["North Hall", "South Hall", "East Hall", "West Hall", "Port Hall"]) expect(draft.document_md).toContain(h);
    // one solve: the packs are exactly the halls that were ranked
    expect(files.filter((f) => f.startsWith("model_pack_")).sort()).toEqual(["model_pack_EAST-HALL_H3.json", "model_pack_NORTH-HALL_H1.json", "model_pack_PORT-HALL_H5.json", "model_pack_SOUTH-HALL_H2.json", "model_pack_WEST-HALL_H4.json"]);
    // not delivered by a draft
    expect((await rows("engagement_deposits", `&id=eq.${dep.id}`))[0].status).toBe("scoped");

    jar.push({ name: "gf_admin", value: adminToken()! });
    const { PATCH } = await import("@/app/api/admin/deliverables/route");
    const rel = await PATCH(json({ token: draft.token, reviewed_hash: reviewHash(draft), reviewed_by: "A. Rivera" }, "PATCH"));
    const relBody: any = await rel.json();
    expect(rel.status, JSON.stringify(relBody)).toBe(200);
    expect(relBody.deposit_delivery).toBe("delivered");
    expect((await rows("engagement_deposits", `&id=eq.${dep.id}`))[0]).toMatchObject({ status: "delivered", delivery_ref: `engagement:${row.id}` });

    // the buyer's page lists a downloadable pack for every hall, and each downloads as JSON
    const { default: Page } = await import("@/app/deliverable/[token]/page");
    const page = renderToStaticMarkup(await Page({ params: Promise.resolve({ token: draft.token }) }));
    expect(page).toContain("by A. Rivera");
    expect(page.match(/model_pack_/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    const dl = await import("@/app/api/deliverable/[token]/route");
    const first = files.find((f) => f.startsWith("model_pack_"))!;
    const got = await dl.GET(new Request(siteUrl(`/api/deliverable/${draft.token}?format=csv&file=${encodeURIComponent(first)}`)), ctx(draft.token));
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toContain("application/json");
    expect(Object.keys(JSON.parse(await got.text())).length).toBeGreaterThan(3);
  });
});
