/**
 * The paid journeys of the existing products, against REAL PostgreSQL through REAL PostgREST (migrations 0001-0034 applied) and
 * the REAL Python engine: Procurement Specification, Hall Watch (purchase -> baseline -> scheduled re-run -> change note ->
 * retried email -> pause -> resume -> cancel), the stuck-generation sweep and the deposit receipt / scoping / credit ledger.
 *
 * Mail is intercepted (Resend is never contacted) and Stripe events are signed locally. NOT proven here: Stripe delivering,
 * Supabase (this is PostgREST + plain PostgreSQL), Vercel invoking the crons, Resend delivering to an inbox.
 *
 * Skipped unless GF_PGRST_URL and GF_PGRST_JWT are set (scripts/realdb-up.sh) -- a skip is a gap in what was checked.
 * GF_REQUIRE_REALDB=1 turns a missing stack into a failure.
 */
import crypto from "node:crypto";
import http from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Stripe from "stripe";
import { adminToken } from "@/lib/admin";
import { packHash } from "@/lib/deliverables";
import { screenIntakeSchema, toIntakeDocument } from "@/lib/engagement-intake";
import { siteUrl } from "@/lib/site";

(globalThis as { React?: unknown }).React = React;
const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => jar.find((c) => c.name === n) }) }));

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT && spawnSync("python3", ["--version"]).status === 0;
const required = process.env.GF_REQUIRE_REALDB === "1";
const KEY = "journeys-realdb-key";
const WH = "whsec_journeys_realdb";
let engine: ChildProcess | null = null;
let gateway: http.Server | null = null;
const mail: { to: string[] | string; subject: string; text: string; key: string | null }[] = [];
let mailDown = false;
const realFetch = globalThis.fetch;

describe("real-database prerequisites (journeys)", () => {
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
  event("checkout.session.completed", { id: session, object: "checkout_session", customer_email: email, customer: `cus_${session}`, amount_total: amount, currency: "eur", metadata: { kind, company: "Hall Co" }, ...extra });
const ctx = (token: string) => ({ params: Promise.resolve({ token }) });
const json = (b: unknown, method = "POST") => new Request(siteUrl("/x"), { method, headers: { "content-type": "application/json", ...caller() }, body: JSON.stringify(b) });
const INTAKE = {
  siteName: "North Hall", hallId: "H1", metro: "Dublin", firmCapacityMVA: 15, contractedMW: 12, currentPeakMW: 7.4,
  currentItLoadMW: 4.9, buswayAmpacityA: 400, tapoffMaxA: 63, floorLoadingKPa: 12, positionsAvailable: 180,
  plantCapacityKW: 6000, plantSupplyC: 6, platform: "gb300_nvl72",
};
const cronGet = (path: string) => new Request(siteUrl(path), { headers: { authorization: "Bearer cron-secret-value" } });
const to = (m: { to: string[] | string }) => ([] as string[]).concat(m.to).join(",");

describe.skipIf(!enabled)("Procurement Specification, payment to release, on real PostgreSQL and the real engine", () => {
  it("webhook x3 -> one deliverable -> intake -> /v1/spec -> a draft WITH its response schedule -> human release -> customer retrieval", async () => {
    const email = `spec-${uid()}@hall.example`, session = `cs_spec_${uid()}`;
    for (let i = 0; i < 3; i++) expect((await checkout(session, "procurement_spec", 1_800_000, email)).status).toBe(200);
    const [d] = await rows("deliverables", `&stripe_session_id=eq.${session}`);
    expect(await rows("deliverables", `&stripe_session_id=eq.${session}`)).toHaveLength(1);
    expect(d).toMatchObject({ kind: "procurement_spec", status: "awaiting_intake" });

    const { POST: intake } = await import("@/app/api/intake/[token]/route");
    const res = await intake(json({ ...INTAKE, designDrybulbC: 38 }), ctx(d.intake_token));
    expect(res.status, await res.clone().text()).toBe(200);
    const [draft] = await rows("deliverables", `&id=eq.${d.id}`);
    expect(draft.status).toBe("draft");
    expect(draft.title).toMatch(/specification/i);
    expect(Object.keys(draft.working_files).sort()).toEqual(["bundle.json", "response_template.json", "specification.json"]);
    expect(draft.intake._gridforge).toMatchObject({ endpoint: "spec" });
    expect(draft.intake._gridforge.provenance.engine_version).toMatch(/\d/);

    jar.push({ name: "gf_admin", value: adminToken()! });
    const { PATCH } = await import("@/app/api/admin/deliverables/route");
    const rel = await PATCH(json({ token: draft.token, reviewed_hash: packHash(draft), reviewed_by: "A. Rivera" }, "PATCH"));
    expect(rel.status, await rel.clone().text()).toBe(200);
    const [released] = await rows("deliverables", `&id=eq.${d.id}`);
    expect(released.status).toBe("released");
    expect(released.intake._gridforge.review).toMatchObject({ by: "A. Rivera", pack_sha256: packHash(draft) });
    expect(mail.filter((m) => to(m).includes(email) && /document is ready/.test(m.subject))).toHaveLength(1);

    const { default: Page } = await import("@/app/deliverable/[token]/page");
    const page = renderToStaticMarkup(await Page({ params: Promise.resolve({ token: draft.token }) }));
    expect(page).toContain("Basis of this specification");
    expect(page).toContain("38 °C (supplied by you)");
    expect(page).toContain("by A. Rivera");
  }, 120_000);

  it("a stuck generation is swept to a recoverable state on the real store, then regenerates", async () => {
    const email = `stuck-${uid()}@hall.example`, session = `cs_stuck_${uid()}`;
    await checkout(session, "density_screen", 450_000, email);
    const [d] = await rows("deliverables", `&stripe_session_id=eq.${session}`);
    // what a dead request leaves behind
    await patch("deliverables", `id=eq.${d.id}`, { status: "generating", intake: { ...toIntakeDocument(screenIntakeSchema.parse(INTAKE), "Hall Co"), _gridforge: { generating_since: new Date(Date.now() - 30 * 60_000).toISOString() } } });
    const { GET } = await import("@/app/api/cron/engagements/route");
    const out: any = await (await GET(cronGet("/api/cron/engagements"))).json();
    expect(out.stale_generating_recovered).toBeGreaterThanOrEqual(1);
    expect((await rows("deliverables", `&id=eq.${d.id}`))[0].status).toBe("engine_unavailable");
    expect(mail.some((m) => to(m).includes("ops@example.test") && /stuck generating/i.test(m.subject))).toBe(true);
    jar.push({ name: "gf_admin", value: adminToken()! });
    const { PATCH } = await import("@/app/api/admin/deliverables/route");
    const regen = await PATCH(json({ token: d.token, action: "regenerate" }, "PATCH"));
    expect(regen.status, await regen.clone().text()).toBe(200);
    expect((await rows("deliverables", `&id=eq.${d.id}`))[0].status).toBe("draft");
  }, 120_000);
});

describe.skipIf(!enabled)("Hall Watch, purchase to cron, on real PostgreSQL and the real engine", () => {
  it("purchase -> baseline -> scheduled re-run finds a change -> note + retried email -> pause -> resume -> cancel", async () => {
    const email = `watch-${uid()}@hall.example`, sub = `sub_${uid()}`;
    for (let i = 0; i < 2; i++) expect((await checkout(`cs_${sub}`, "hall_watch", 600_000, email, { subscription: sub })).status).toBe(200);
    const find = async () => (await rows("watches", `&stripe_subscription_id=eq.${sub}`))[0];
    expect(await rows("watches", `&stripe_subscription_id=eq.${sub}`)).toHaveLength(1);
    let w = await find();
    expect(w).toMatchObject({ status: "active", intake: null, last_state: null });

    // the first submission is the baseline
    const { POST: submit } = await import("@/app/api/watch/[token]/route");
    const first = await submit(json(INTAKE), ctx(w.token));
    expect(first.status, await first.clone().text()).toBe(200);
    expect(((await first.json()) as any).baseline).toBe(true);
    w = await find();
    expect(w.last_state).toBeTruthy();
    let notes = await rows("watch_notes", `&watch_id=eq.${w.id}`);
    expect(notes.map((n) => n.trigger)).toEqual(["baseline"]);

    // the hall changes behind the watch's back (a library or input moved) and the schedule comes round
    const changed = { ...(w.intake as any), compute: { ...(w.intake as any).compute, platform: "generic_dlc_50" } };
    await patch("watches", `id=eq.${w.id}`, { intake: changed, next_run_at: new Date(Date.now() - 60_000).toISOString() });
    mailDown = true;
    const { GET: cron } = await import("@/app/api/cron/watches/route");
    const out: any = await (await cron(cronGet("/api/cron/watches"))).json();
    expect(out.ok).toBe(true);
    const mine = out.results.find((r: any) => r.token === w.token);
    expect(mine.status).toBe("changed");                       // a different compute platform moves the real engine's answer
    notes = await rows("watch_notes", `&watch_id=eq.${w.id}`);
    expect(notes.map((n) => n.trigger)).toContain("scheduled");
    const scheduled = notes.find((n) => n.trigger === "scheduled");
    w = await find();
    expect(new Date(w.next_run_at).getTime()).toBeGreaterThan(Date.now() + 80 * 86_400_000);

    if (mine.status === "changed") {
      // the email failed (provider down): the obligation is durable and pending, and the sweep delivers it once
      const [notice] = await rows("watch_note_notices", `&watch_note_id=eq.${scheduled.id}`);
      expect(notice).toMatchObject({ status: "pending", attempts: 1 });
      mailDown = false;
      await patch("watch_note_notices", `id=eq.${notice.id}`, { next_attempt_at: new Date(Date.now() - 1000).toISOString() });
      const { GET: sweep } = await import("@/app/api/cron/engagements/route");
      const swept: any = await (await sweep(cronGet("/api/cron/engagements"))).json();
      expect(swept.watch_notices.sent).toBeGreaterThanOrEqual(1);
      expect((await rows("watch_note_notices", `&id=eq.${notice.id}`))[0]).toMatchObject({ status: "sent", attempts: 2 });
      const noteMail = mail.filter((m) => m.key === `watch-note-${scheduled.id}`);
      expect(noteMail).toHaveLength(1);                                   // (the purchase's own watch link email is a different obligation)
      expect(to(noteMail[0])).toContain(email);
    }

    // failed payment pauses; nothing runs; a paid invoice resumes; cancellation ends it
    expect((await event("invoice.payment_failed", { id: "in_1", object: "invoice", subscription: sub })).status).toBe(200);
    expect((await find()).status).toBe("paused");
    await patch("watches", `id=eq.${w.id}`, { next_run_at: new Date(Date.now() - 60_000).toISOString() });
    const paused: any = await (await cron(cronGet("/api/cron/watches"))).json();
    expect(paused.results.some((r: any) => r.token === w.token)).toBe(false);
    expect((await submit(json(INTAKE), ctx(w.token))).status).toBe(409);
    expect((await event("invoice.paid", { id: "in_2", object: "invoice", subscription: sub })).status).toBe(200);
    expect((await find()).status).toBe("active");
    expect((await event("customer.subscription.deleted", { id: sub, object: "subscription", metadata: { kind: "hall_watch" } })).status).toBe(200);
    expect((await find()).status).toBe("cancelled");
    await patch("watches", `id=eq.${w.id}`, { next_run_at: new Date(Date.now() - 60_000).toISOString() });
    const cancelled: any = await (await cron(cronGet("/api/cron/watches"))).json();
    expect(cancelled.results.some((r: any) => r.token === w.token)).toBe(false);
  }, 120_000);
});

describe.skipIf(!enabled)("deposit receipt, scoping and the credit ledger, on real PostgreSQL", () => {
  it("pays -> one durable receipt through redelivery -> scoping credits a paid Screen once, atomically, and never again", async () => {
    const email = `dep-${uid()}@hall.example`, session = `cs_dep_${uid()}`;
    // a paid Density Screen for the same buyer
    await checkout(`cs_ds_${uid()}`, "density_screen", 450_000, email);
    const [screen] = await rows("deliverables", `&email=eq.${encodeURIComponent(email)}`);

    for (let i = 0; i < 3; i++) expect((await checkout(session, "envelope_study_deposit", 900_000, email)).status).toBe(200);
    const [dep] = await rows("engagement_deposits", `&stripe_session_id=eq.${session}`);
    const receipts = await rows("customer_notifications", `&kind=eq.deposit_receipt&subject_id=eq.${dep.id}`);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: "accepted", subject_table: "engagement_deposits" });
    const toBuyer = mail.filter((m) => to(m).includes(email) && /reference/i.test(m.subject));
    expect(toBuyer).toHaveLength(1);
    expect(toBuyer[0].text).toContain(`Reference: ${dep.id}`);

    jar.push({ name: "gf_admin", value: adminToken()! });
    const { POST: step } = await import("@/app/api/admin/deposits/[id]/route");
    const go = (b: Record<string, unknown>) => step(json(b), { params: Promise.resolve({ id: dep.id }) });
    expect((await go({ owner: "A. Rivera" })).status).toBe(200);
    expect((await go({ scope_note: "x" })).status).toBe(422);                              // a fee and a date are required
    expect((await go({ scope_note: "x", agreed_fee_cents: 100, delivery_due_on: "2099-01-01" })).status).toBe(422);   // outside the band
    const done = await go({ scope_note: "One hall, two architectures", agreed_fee_cents: 2_500_000, delivery_due_on: "2099-01-31" });
    const body: any = await done.json();
    expect(done.status, JSON.stringify(body)).toBe(200);
    expect(body.deposit).toMatchObject({ status: "scoped", agreed_fee_cents: 2_500_000, credit_applied_cents: 450_000 });
    expect(body.balance_due_cents).toBe(2_500_000 - 900_000 - 450_000);
    expect(await rows("engagement_credits", `&source_deliverable_id=eq.${screen.id}`)).toEqual([expect.objectContaining({ deposit_id: dep.id, amount_cents: 450_000 })]);

    // the database itself refuses a second credit of the same Screen and a rewrite of the committed date
    const dup = await sql("/engagement_credits", { method: "POST", body: JSON.stringify({ source_deliverable_id: screen.id, deposit_id: dep.id, amount_cents: 450_000, applied_by: "x" }) });
    expect(dup.status).toBeGreaterThanOrEqual(400);
    expect((await patch("engagement_deposits", `id=eq.${dep.id}`, { delivery_due_on: "2099-06-30" })).status).toBeGreaterThanOrEqual(400);

    // a second deposit by the same buyer: the Screen is spent
    const second = `cs_dep_${uid()}`;
    await checkout(second, "envelope_study_deposit", 900_000, email);
    const [dep2] = await rows("engagement_deposits", `&stripe_session_id=eq.${second}`);
    const go2 = (b: Record<string, unknown>) => step(json(b), { params: Promise.resolve({ id: dep2.id }) });
    await go2({ owner: "A. Rivera" });
    const r2: any = await (await go2({ scope_note: "Second hall", agreed_fee_cents: 2_500_000, delivery_due_on: "2099-02-28" })).json();
    expect(r2.deposit.credit_applied_cents).toBe(0);

    // and the operator's table reads it from the real store
    const { depositTable } = await import("@/lib/attention");
    const table = await depositTable();
    expect(table.ok && table.items.find((x) => x.id === dep.id)).toMatchObject({ status: "scoped", fee_cents: 2_500_000, credit_cents: 450_000, due: "2099-01-31", owner: "A. Rivera" });
  }, 120_000);
});
