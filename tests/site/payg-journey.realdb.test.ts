/**
 * The complete metered-API lifecycle, free -> pay-as-you-go -> failure -> recovery -> cancellation, run end to end through the
 * website's own route handlers against a REAL engine process and REAL PostgreSQL through REAL PostgREST (scripts/realdb-up.sh,
 * every migration applied).
 *
 * WHAT IS REAL
 *   - the engine: the Python server (gridforge.api.server) started by this file as a child process, with GRIDFORGE_KEY_SECRET,
 *     GRIDFORGE_ADMIN_KEY and GRIDFORGE_USAGE_FILE / LEDGER_FILE / REVOKED_FILE / COST_FILE in a temp directory, FLY_MACHINE_ID
 *     unset (so the directory counts as a durable volume exactly as a mounted one would). Its signed-key verification, metering,
 *     402 refusals, MCP batches, Idempotency-Key replays, revocation store, /v1/estimate and operator ledger are all the real code.
 *   - the database: PostgreSQL + PostgREST with the real migrations (the unique settlement row, the revoked-id trigger, the
 *     conditional PATCHes the compare-and-set mint and the cancellation rely on, the ledger copy, the once-only operator ledger).
 *   - the website: the route handlers (/api/free-account, /api/keys, /api/payg/enable, /api/payg/cap, /api/cron/payg,
 *     /api/stripe/webhook) are imported and called in-process with real Request objects; ingest, settlement, reminders and the
 *     revocation sweep are the shipped modules. Readiness (meteredReadiness) is evaluated against the real engine process.
 *   - the ledger file is read directly from disk, and every step asserts it together with the engine's answers and the database rows.
 * WHAT IS MOCKED (and nothing else)
 *   - Stripe: MockStripe (tests/site/payg-harness.ts); Stripe events are signed locally with a test secret. No Stripe call is made.
 *   - Resend: an intercepted fetch records the mail; nothing is sent.
 *   - The site's clock for the month rollover: only `Date` is faked (vi.setSystemTime); the engine keeps the real clock, so the
 *     usage it recorded is in the real month and "next month" is when the site's settlement considers it closed.
 * NOT PROVEN HERE: Stripe delivering or charging, Supabase (this is PostgREST + plain PostgreSQL), Vercel invoking the crons, Resend
 * delivering to an inbox, Fly.io volumes (a temp directory stands in for the mounted volume).
 *
 * Skipped unless GF_PGRST_URL and GF_PGRST_JWT are set -- a skip is a gap in what was checked. GF_REQUIRE_REALDB=1 turns a missing
 * stack into a failure.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { inspectKey } from "@/lib/api-access";
import { meteredReadiness, resetApiReadinessCache } from "@/lib/api-readiness";
import { PAYG, paygChargeCents, utcMonth } from "@/lib/payg";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import { siteUrl } from "@/lib/site";
import { MockStripe } from "./payg-harness";

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT && spawnSync("python3", ["--version"]).status === 0;
const required = process.env.GF_REQUIRE_REALDB === "1";
const SECRET = "journey-signing-secret-0123456789abcdef";
const ADMIN = "journey-admin-key-0123456789";
const WH = "whsec_journey_realdb";
const CRON = "cron-secret-value";
const realFetch = globalThis.fetch;

let engine: ChildProcess | null = null;
let gateway: http.Server | null = null;
let ENGINE = "";
let DIR = "";
const mail: { to: string; subject: string; text: string }[] = [];
let mock: MockStripe;

describe("real-database prerequisites (payg journey)", () => {
  it.runIf(required)("are present when the real database is required", async () => {
    expect(enabled).toBe(true);
    for (const t of ["usage_events", "usage_settlements", "operator_notices", "customer_notifications"]) {
      expect((await realFetch(`${PGRST}/${t}?limit=1`, { headers: { Authorization: `Bearer ${JWT}` } })).status, t).toBe(200);
    }
  });
});

// --------------------------------------------------------------------------------------------------------- plumbing
const sql = (p: string, init: RequestInit = {}) =>
  realFetch(PGRST + p, { ...init, headers: { Authorization: `Bearer ${JWT}`, "Content-Type": "application/json", Prefer: "return=representation", ...(init.headers ?? {}) } });
const rows = async (table: string, q = "") => (await (await sql(`/${table}?select=*${q}`)).json()) as any[];
const patch = (table: string, q: string, body: unknown) => sql(`/${table}?${q}`, { method: "PATCH", body: JSON.stringify(body) });

async function startGateway(): Promise<string> {
  gateway = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = req.url ?? "";
    if (!url.startsWith("/rest/v1/")) { res.writeHead(404).end("{}"); return; }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string" && k !== "host" && k !== "content-length") headers[k] = v;
    const r = await realFetch(PGRST + url.slice("/rest/v1".length), { method: req.method, headers, body: ["GET", "HEAD"].includes(req.method ?? "") ? undefined : Buffer.concat(chunks) });
    res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
    res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise<void>((r) => gateway!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(gateway!.address() as { port: number }).port}`;
}

const file = (n: string) => path.join(DIR, n);

/**
 * The shared database may already hold ledger copies from other real-database tests (seq is UNIQUE and the cursor is global), so this
 * engine's ledger starts after them: filler events for a dummy account in an old month, never ingested (the cursor is moved past them).
 */
async function seedLedgerPad(): Promise<number> {
  const top = (await rows("usage_events", "&order=seq.desc&limit=1"))[0]?.seq ?? 0;
  const cur = (await rows("payg_cursor", "&id=eq.1"))[0]?.last_seq ?? 0;
  const pad = Math.max(Number(top), Number(cur)) + 1;
  const lines: string[] = [];
  for (let seq = 1; seq <= pad; seq++) {
    lines.push(JSON.stringify({ seq, id: crypto.randomBytes(16).toString("hex"), ts: "2020-01-01T00:00:00Z", kind: "charge", account: "journey-pad", key_id: "", scope: "trial", endpoint: "/v1/screen", units: 1, project: "", idem: "", ref: "" }));
  }
  fs.writeFileSync(file("ledger.jsonl"), lines.join("\n") + "\n");
  expect((await patch("payg_cursor", "id=eq.1", { last_seq: pad })).status).toBe(200);
  return pad;
}

async function startEngine(): Promise<string> {
  const code = [
    "from gridforge.api.server import Handler, make_server", "Handler.limiter.per_minute=0",
    "h=make_server('127.0.0.1',0)", "print(h.server_address[1],flush=True)", "h.serve_forever()",
  ].join("\n");
  const env: NodeJS.ProcessEnv = {
    ...process.env, GRIDFORGE_KEY_SECRET: SECRET, GRIDFORGE_ADMIN_KEY: ADMIN, GRIDFORGE_RATE_LIMIT: "0",
    GRIDFORGE_USAGE_FILE: file("usage.json"), GRIDFORGE_LEDGER_FILE: file("ledger.jsonl"), GRIDFORGE_REVOKED_FILE: file("revoked.json"), GRIDFORGE_COST_FILE: file("costs.json"),
  };
  for (const k of ["FLY_MACHINE_ID", "GRIDFORGE_API_KEYS", "GRIDFORGE_REVOKED_KEYS", "GRIDFORGE_REPORT_DATE"]) delete env[k];
  engine = spawn("python3", ["-c", code], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "inherit"] });
  return await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("engine did not start")), 20_000);
    engine!.stdout!.once("data", (d) => { clearTimeout(t); res(`http://127.0.0.1:${String(d).trim()}`); });
  });
}

let pad = 0;
beforeAll(async () => {
  if (!enabled) return;
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), "gf-journey-"));
  pad = await seedLedgerPad();
  // A quarantined ledger event nobody acknowledged would (rightly) hold settlement of every month: not this test's business.
  await patch("usage_quarantine", "acked_at=is.null", { acked_at: new Date().toISOString(), acked_note: "payg journey test" });
  ENGINE = await startEngine();
  Object.assign(process.env, {
    GRIDFORGE_API_URL: ENGINE, GRIDFORGE_ADMIN_KEY: ADMIN, GRIDFORGE_KEY_SECRET: SECRET,
    SUPABASE_URL: await startGateway(), SUPABASE_SERVICE_ROLE_KEY: JWT,
    STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_WEBHOOK_SECRET: WH, CRON_SECRET: CRON,
    RESEND_API_KEY: "re_test", LEAD_FROM_EMAIL: "Time to Power <power@timetopower.ai>", LEAD_TO_EMAIL: "ops@example.test",
    RATE_LIMIT_HMAC_KEY: "r".repeat(40), FUNNEL_REF_KEY: "f".repeat(32),
  });
  delete process.env.GRIDFORGE_FREE_ACCOUNTS_MAX;
  for (const m of ["error", "log", "warn"] as const) vi.spyOn(console, m).mockImplementation(() => {});
  mock = new MockStripe();
  setPaygStripeForTests(mock);
  // Mail is intercepted; the gateway and the engine are local and answer for real.
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith("https://api.resend.com")) {
      const b = JSON.parse(String(init?.body));
      mail.push({ to: ([] as string[]).concat(b.to)[0], subject: b.subject, text: b.text });
      return new Response(JSON.stringify({ id: `em_${mail.length}` }), { status: 200 });
    }
    return realFetch(i as RequestInfo, init);
  }) as typeof fetch;
}, 90_000);
afterAll(() => {
  vi.useRealTimers();
  globalThis.fetch = realFetch;
  setPaygStripeForTests(null);
  engine?.kill();
  gateway?.close();
  if (DIR) fs.rmSync(DIR, { recursive: true, force: true });
});

// ---- the engine, as a customer or the operator sees it
type Res = { status: number; json: any; headers: Headers };
async function eng(method: string, p: string, o: { key?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<Res> {
  const r = await realFetch(`${ENGINE}${p}`, {
    method,
    headers: { ...(o.body !== undefined ? { "content-type": "application/json" } : {}), ...(o.key ? { "X-API-Key": o.key } : {}), ...(o.headers ?? {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
  });
  const text = await r.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json, headers: r.headers };
}
const INTAKE = { grid: { contracted_MW: 12, firm_capacity_MVA: 12 } };
const BAD_INTAKE = { grid: { contracted_MW: "abc" } };
const screen = (key: string, headers?: Record<string, string>) => eng("POST", "/v1/screen", { key, body: INTAKE, headers });
const study = (key: string) => eng("POST", "/v1/study", { key, body: INTAKE });
const mcpCall = (id: number, intake: unknown) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "gridforge_screen", arguments: { intake } } });
const version = (key: string) => eng("GET", "/v1/version", { key });
const estimate = (key: string, endpoint: string) => eng("GET", `/v1/estimate?endpoint=${endpoint}`, { key });

// ---- the ledger file, exactly as the engine wrote it
interface LedgerRow { seq: number; id: string; ts: string; kind: "charge" | "refund"; account: string; key_id: string; scope: string; endpoint: string; units: number; idem: string; ref: string }
const ledger = (): LedgerRow[] => fs.readFileSync(file("ledger.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((e: LedgerRow) => e.seq > pad);
const net = (account: string, scope?: string) =>
  ledger().filter((e) => e.account === account && (!scope || e.scope === scope)).reduce((n, e) => n + (e.kind === "charge" ? e.units : -e.units), 0);
/** The engine's revocation store, as written to disk (absent until the first revocation). */
const revokedOnEngine = (): string[] => (fs.existsSync(file("revoked.json")) ? JSON.parse(fs.readFileSync(file("revoked.json"), "utf8")).revoked : []);

// ---- the website
const stripeSdk = new Stripe("sk_test_placeholder");
const uid = () => crypto.randomUUID().slice(0, 8);
const ipOf = () => ({ "x-real-ip": `203.0.${crypto.randomInt(1, 250)}.${crypto.randomInt(1, 250)}` });
const req = (p: string, body: unknown, method = "POST") => new Request(siteUrl(p), { method, headers: { "content-type": "application/json", ...ipOf() }, body: method === "GET" ? undefined : JSON.stringify(body) });
const getReq = (p: string, headers: Record<string, string> = {}) => new Request(siteUrl(p), { headers });
let evtN = 0;
async function stripeEvent(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({ id: `evt_${++evtN}_${uid()}`, type, data: { object } });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": stripeSdk.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
}
const cron = async () => {
  const { GET } = await import("@/app/api/cron/payg/route");
  const r = await GET(getReq("/api/cron/payg", { authorization: `Bearer ${CRON}` }));
  expect(r.status).toBe(200);
  return (await r.json()) as any;
};
const mint = async (token: string, body: Record<string, unknown> = {}) => {
  const { POST } = await import("@/app/api/keys/route");
  const r = await POST(req("/api/keys", { token, ...body }));
  return { status: r.status, json: (await r.json()) as any };
};
const acct = async (token: string) => (await rows("api_accounts", `&token=eq.${token}`))[0];
const tokenFromMail = (to: string) => {
  const m = [...mail].reverse().find((x) => x.to === to && /\/api-access\/[A-Za-z0-9_-]+/.test(x.text));
  expect(m, `no portal link mailed to ${to}`).toBeTruthy();
  return /\/api-access\/([A-Za-z0-9_-]+)/.exec(m!.text)![1];
};
const mailTo = (to: string, re: RegExp) => mail.filter((m) => m.to === to && re.test(m.subject));

/** A free account through the real route: the link in the (intercepted) mail is the credential. */
async function freeAccount(): Promise<{ email: string; token: string; row: any }> {
  const email = `journey-${uid()}@hall.example`;
  const { POST } = await import("@/app/api/free-account/route");
  const r = await POST(req("/api/free-account", { email, company: "Hall Co" }));
  expect(r.status).toBe(200);
  const token = tokenFromMail(email);
  return { email, token, row: await acct(token) };
}

/** Pay-as-you-go through the real routes: /api/payg/enable (MockStripe Checkout) then the signed setup-mode webhook. */
async function enablePayg(token: string, capEur: number): Promise<any> {
  const row = await acct(token);
  const { POST } = await import("@/app/api/payg/enable/route");
  const before = mock.sessions.length;
  const r = await POST(req("/api/payg/enable", { token, cap_eur: capEur }));
  expect(r.status).toBe(200);
  expect((await r.json()).url).toMatch(/^https:\/\/checkout\.stripe\.test\//);
  const session = mock.sessions[before];
  expect(session).toMatchObject({ mode: "setup", metadata: { kind: "api_payg_enable", account_id: row.account, cap_eur: String(capEur) } });
  const n = uid();
  const customer = `cus_${n}`;
  mock.setupIntentStore.set(`seti_${n}`, { id: `seti_${n}`, status: "succeeded", payment_method: `pm_${n}`, customer, metadata: { kind: "api_payg_enable", account_id: row.account, cap_eur: String(capEur) } });
  const ok = await stripeEvent("checkout.session.completed", { id: `cs_${n}`, object: "checkout.session", mode: "setup", customer, setup_intent: `seti_${n}`, metadata: { kind: "api_payg_enable", account_id: row.account, cap_eur: String(capEur) } });
  expect(ok.status).toBe(200);
  return acct(token);
}

/** The usage the engine recorded for one account, as the engine itself reports it to the key's holder. */
const statement = async (key: string) => (await eng("GET", "/v1/usage", { key })).json;

// ============================================================================================================================
// the journey: one account (A) from sign-up to cancellation, with the others covering what A cannot
// ============================================================================================================================
const J: Record<string, any> = {};
const statuses: number[] = [];

describe.skipIf(!enabled)("metered API lifecycle on the real engine and real PostgreSQL", () => {
  it("(1) POST /api/free-account against the real engine: readiness is proven against the process, the link is mailed, the row exists", async () => {
    // The real engine, started with the secret, the admin key and a durable ledger / revocation directory, is ready for metered access.
    resetApiReadinessCache();
    expect(await meteredReadiness()).toMatchObject({ ready: true, category: "ready" });
    const v = (await eng("GET", "/v1/version", { key: ADMIN })).json;
    expect(v).toMatchObject({ tier: "internal", revocation_persistable: true, metering: { durable: true, ledger_durable: true }, payg: { unit_price_cents: PAYG.unitPriceCents, free_allowance_units: PAYG.freeAllowanceUnits } });
    expect(v.ledger_status).toBe("ok");

    // An engine this site's admin credential does not match is NOT ready, and the route refuses before creating anything.
    process.env.GRIDFORGE_ADMIN_KEY = "a-different-admin-key";
    resetApiReadinessCache();
    const { POST } = await import("@/app/api/free-account/route");
    const refused = await POST(req("/api/free-account", { email: `closed-${uid()}@hall.example` }));
    expect(refused.status).toBe(503);
    expect((await refused.json()).reason).toBe("metered_unavailable");
    process.env.GRIDFORGE_ADMIN_KEY = ADMIN;
    resetApiReadinessCache();

    const a = await freeAccount();
    Object.assign(J, { A: a });
    const queued = mailTo(a.email, /./);
    expect(queued).toHaveLength(1);
    expect(queued[0].text).toContain("/api-access/");
    expect(a.row).toMatchObject({ plan: "api_free", status: "active", monthly_units: PAYG.freeAllowanceUnits, key_id: null, free_verified_at: null });
    expect(a.row.account).toMatch(/^[a-z0-9-]+-[0-9a-f]{10}$/);
    // The same address again: the same answer, still one account and no second link
    const again = await POST(req("/api/free-account", { email: a.email }));
    expect(again.status).toBe(200);
    expect(await rows("api_accounts", `&email=eq.${a.email}`)).toHaveLength(1);
  });

  it("(2) mint a trial key with the portal token: the real engine verifies it and the estimate reports the whole allowance", async () => {
    const { token, row } = J.A;
    const m = await mint(token);
    expect(m.status).toBe(200);
    expect(m.json).toMatchObject({ ok: true, issued: true });
    J.A.trial = m.json.key as string;
    const payload = inspectKey(J.A.trial)!;
    expect(payload).toMatchObject({ valid: true, a: row.account, s: "trial", q: PAYG.freeAllowanceUnits });
    const after = await acct(token);
    expect(after).toMatchObject({ key_id: payload.k, key_scope: "trial" });
    expect(after.free_verified_at).toBeTruthy();
    // The real engine's own verdict
    expect((await version(J.A.trial)).json.tier).toBe("client");
    const est = (await estimate(J.A.trial, "/v1/screen")).json;
    expect(est).toMatchObject({ scope: "trial", cap_units: 25, used_units: 0, remaining_units: 25, units: 1, fits: true, unit_price_cents: PAYG.unitPriceCents });
    expect(ledger().filter((e) => e.account === row.account)).toHaveLength(0);
    // The key id is on the account row and NOT on the engine's revocation list
    expect(revokedOnEngine()).not.toContain(payload.k);
  });

  it("(3) real billable calls to the free allowance: one study, screens, an MCP batch with a failing call and an Idempotency-Key retry; then 402 free_allowance_exhausted, never 429", async () => {
    const key = J.A.trial as string;
    const account = J.A.row.account as string;
    const take = (r: Res) => { statuses.push(r.status); return r; };
    let delivered = 0;
    for (let i = 0; i < 10; i++) { const r = take(await screen(key)); expect(r.status).toBe(200); delivered += Number(r.headers.get("x-gridforge-units")); }
    const s = take(await study(key));
    expect(s.status).toBe(200);
    expect(Number(s.headers.get("x-gridforge-units"))).toBe(5);
    delivered += 5;
    expect(net(account)).toBe(15);
    expect(delivered).toBe(15);

    // An MCP batch: a good call, a call that FAILS (refunded), a good call. Retried with the same Idempotency-Key.
    const batch = [mcpCall(1, INTAKE), mcpCall(2, BAD_INTAKE), mcpCall(3, { grid: { contracted_MW: 9, firm_capacity_MVA: 9 } })];
    const before = ledger().length;
    const b1 = take(await eng("POST", "/mcp", { key, body: batch, headers: { "Idempotency-Key": "journey-batch-1" } }));
    expect(b1.status).toBe(200);
    expect(b1.json[0].result.isError).toBe(false);
    expect(b1.json[1].error).toBeTruthy();
    expect(b1.json[2].result.isError).toBe(false);
    const events1 = ledger().slice(before);
    expect(events1.map((e) => e.kind)).toEqual(["charge", "charge", "refund", "charge"]); // the failing call was charged and given back
    expect(events1.filter((e) => e.kind === "charge" && e.idem).map((e) => e.idem).sort()).toEqual(["journey-batch-1#0", "journey-batch-1#1", "journey-batch-1#2"]);
    expect(net(account)).toBe(17);
    const retry = take(await eng("POST", "/mcp", { key, body: batch, headers: { "Idempotency-Key": "journey-batch-1" } }));
    expect(retry.headers.get("x-gridforge-idempotent-replay")).toBe("true");
    expect(retry.json[0].result).toEqual(b1.json[0].result); // the paid call is replayed, identical
    expect(retry.json[2].result).toEqual(b1.json[2].result);
    expect(retry.json[1].error).toBeTruthy();                // the failed one was never paid for, so it ran again and failed again
    expect(net(account)).toBe(17);                           // ...and no unit was charged twice
    expect(ledger().filter((e) => e.kind === "charge" && e.idem === "journey-batch-1#0")).toHaveLength(1);
    delivered += 2;

    for (let i = 0; i < 8; i++) { const r = take(await screen(key)); expect(r.status).toBe(200); delivered += 1; }
    expect(delivered).toBe(25);
    expect(net(account)).toBe(25);
    expect(net(account, "trial")).toBe(25);
    expect((await statement(key)).units).toBe(25);

    // The allowance is spent: 402 with the free-allowance reason (not 429), nothing charged, the ledger untouched
    const events = ledger().length;
    const over = take(await screen(key));
    expect(over.status).toBe(402);
    expect(over.json).toMatchObject({ reason: "free_allowance_exhausted", plan: "api_free", monthly_quota: 25, units_used: 25, units_required: 1 });
    expect(over.json.fix).toMatch(/pay-as-you-go/i);
    expect(take(await study(key)).status).toBe(402);
    const overMcp = take(await eng("POST", "/mcp", { key, body: mcpCall(9, INTAKE) }));
    expect(overMcp.json.error.data.reason).toBe("free_allowance_exhausted");
    expect(ledger()).toHaveLength(events);
    expect(statuses).not.toContain(429);
    expect(await estimate(key, "/v1/screen")).toMatchObject({ json: { remaining_units: 0, fits: false } });
  });

  it("(4a) enable pay-as-you-go (MockStripe Checkout, then the signed setup webhook), mint a payg key; the cap counts the free units already used (ENGINE DEFECT, reported)", async () => {
    const { token, row } = J.A;
    const enabledRow = await enablePayg(token, 20);
    expect(enabledRow).toMatchObject({ plan: "api_payg", cap_units: 10, monthly_units: 10, status: "active", account: row.account });
    expect(enabledRow.stripe_customer_id).toMatch(/^cus_/);
    expect(enabledRow.stripe_payment_method_id).toMatch(/^pm_/);
    J.A.customer = enabledRow.stripe_customer_id;
    const m = await mint(token);
    expect(m.status).toBe(200);
    const oldTrial = inspectKey(J.A.trial)!.k;
    expect(m.json).toMatchObject({ issued: true, revoked_previous: true });
    J.A.payg = m.json.key as string;
    expect(inspectKey(J.A.payg)).toMatchObject({ valid: true, s: "payg", q: 10, a: row.account });
    // The wrong-scope trial key was replaced and is dead on the REAL engine; the payg key verifies
    const dead = await screen(J.A.trial);
    expect(dead.status).toBe(401);
    expect(String(dead.json.error)).toMatch(/revoked/);
    expect(revokedOnEngine()).toContain(oldTrial);
    expect((await acct(token)).revoked_confirmed_ids).toContain(oldTrial);
    expect((await version(J.A.payg)).json.tier).toBe("client");
    // ENGINE DEFECT (gridforge/api/metering.py, reported to the lead, not edited here): the engine's counter is per account and month
    // ACROSS scopes, so the 25 FREE units already used count against the customer's EUR 20 (10-unit) pay-as-you-go cap, and the first
    // billable call is refused although nothing has been billed. Pinned so that fixing the engine turns this red on purpose.
    const first = await screen(J.A.payg);
    expect(first.status).toBe(402);
    expect(first.json).toMatchObject({ reason: "spending_cap_reached", plan: "api_payg", cap_units: 10, units_used: 25 });
    expect(net(row.account, "payg")).toBe(0);
  });

  it("(4b) the customer raises the cap (new key, old one revoked); billable calls run to the cap and are refused with spending_cap_reached; estimates match the ledger", async () => {
    const { token, row } = J.A;
    const { POST } = await import("@/app/api/payg/cap/route");
    const r = await POST(req("/api/payg/cap", { token, cap_eur: 100 }));
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j).toMatchObject({ issued: true, cap_units: 50, revoked_previous: true });
    const oldKey = J.A.payg as string;
    const prior = inspectKey(oldKey)!.k;
    J.A.payg = j.key as string;
    expect((await screen(oldKey)).status).toBe(401);
    expect(revokedOnEngine()).toContain(prior);
    expect(await acct(token)).toMatchObject({ cap_units: 50, monthly_units: 50 });
    const key = J.A.payg as string;
    // Each call's price from the estimator equals the units the ledger recorded x the unit price
    const priced = async (endpoint: string, call: () => Promise<Res>) => {
      const e = (await estimate(key, endpoint)).json;
      const before = ledger().length;
      const res = await call();
      expect(res.status).toBe(200);
      const ev = ledger().slice(before);
      expect(ev).toHaveLength(1);
      expect(ev[0]).toMatchObject({ kind: "charge", scope: "payg", endpoint, account: row.account });
      expect(e.estimated_cents).toBe(ev[0].units * PAYG.unitPriceCents);
      expect(Number(res.headers.get("x-gridforge-charge-cents"))).toBe(paygChargeCents(ev[0].units));
      expect(e.would_cost_after_allowance).toBe(ev[0].units * PAYG.unitPriceCents);
      return ev[0].units;
    };
    let payg = 0;
    payg += await priced("/v1/study", () => study(key));
    // The free allowance (25 trial units) does not count against the pay-as-you-go cap: the whole EUR 100 cap (50 units) is billable
    for (let i = 0; i < 45; i++) payg += await priced("/v1/screen", () => screen(key));
    expect(payg).toBe(50);
    expect(net(row.account, "payg")).toBe(50);
    expect(net(row.account, "trial")).toBe(25);
    const over = await screen(key);
    expect(over.status).toBe(402);
    expect(over.json).toMatchObject({ reason: "spending_cap_reached", plan: "api_payg", cap_units: 50, cap_eur: 100, units_used: 50 });
    expect(await estimate(key, "/v1/screen")).toMatchObject({ json: { remaining_units: 0, fits: false } });
  });

  it("(4c) a payg account that never used the free allowance: cap EUR 20 = 10 units, run to the cap, 402 spending_cap_reached at exactly 10", async () => {
    const b = await freeAccount();
    await enablePayg(b.token, 20);
    const m = await mint(b.token);
    expect(m.status).toBe(200);
    const key = m.json.key as string;
    expect(inspectKey(key)).toMatchObject({ s: "payg", q: 10 });
    Object.assign(J, { B: { ...b, key, account: (await acct(b.token)).account, customer: (await acct(b.token)).stripe_customer_id } });
    let units = 0;
    for (const call of [() => study(key), ...Array.from({ length: 5 }, () => () => screen(key))]) {
      const e = (await estimate(key, units === 0 ? "/v1/study" : "/v1/screen")).json;
      const before = ledger().length;
      const r = await call();
      expect(r.status).toBe(200);
      const ev = ledger().slice(before);
      expect(e.estimated_cents).toBe(ev[0].units * PAYG.unitPriceCents);
      units += ev[0].units;
    }
    expect(units).toBe(10);
    const over = await screen(key);
    expect(over.status).toBe(402);
    expect(over.json).toMatchObject({ reason: "spending_cap_reached", cap_units: 10, cap_eur: 20, units_used: 10 });
    expect(net(J.B.account, "payg")).toBe(10);
    // a second account that will end the month under the invoice minimum (1 unit = EUR 2 < EUR 5)
    const c = await freeAccount();
    await enablePayg(c.token, 20);
    const ck = (await mint(c.token)).json.key as string;
    expect((await screen(ck)).status).toBe(200);
    const row = await acct(c.token);
    Object.assign(J, { C: { ...c, key: ck, account: row.account, customer: row.stripe_customer_id } });
    expect(net(row.account, "payg")).toBe(1);
  });

  it("(5a) /api/cron/payg ingests the real engine ledger into usage_events; run twice: no duplicates, the cursor stands at the engine's head", async () => {
    const accounts = [J.A.row.account, J.B.account, J.C.account];
    const run1 = await cron();
    expect(run1.ingest).toMatchObject({ ok: true, complete: true, quarantined: 0 });
    expect(run1.ingest.inserted).toBe(ledger().length);
    const head = (await eng("GET", "/v1/admin/ledger?after_seq=0&limit=1", { key: ADMIN })).json.head_seq as number;
    expect(head).toBe(ledger().length + pad);
    expect((await rows("payg_cursor", "&id=eq.1"))[0].last_seq).toBe(head);
    const copied = async (a: string) => (await rows("usage_events", `&account=eq.${a}&order=seq.asc`)) as any[];
    for (const a of accounts) {
      const db = await copied(a);
      const file = ledger().filter((e) => e.account === a);
      expect(db.map((e) => e.event_id)).toEqual(file.map((e) => e.id));          // the same events, same order
      expect(db.map((e) => e.seq)).toEqual(file.map((e) => e.seq));
      expect(db.reduce((n, e) => n + (e.kind === "charge" ? e.units : -e.units), 0)).toBe(net(a));
    }
    // A's refunded batch call is a charge AND a refund row in the database, exactly as in the file
    expect((await copied(J.A.row.account)).filter((e) => e.kind === "refund").length).toBe(ledger().filter((e) => e.account === J.A.row.account && e.kind === "refund").length);
    const run2 = await cron();
    expect(run2.ingest).toMatchObject({ ok: true, complete: true, inserted: 0 });
    expect(await rows("usage_events", `&account=in.(${accounts.join(",")})`)).toHaveLength(ledger().filter((e) => accounts.includes(e.account)).length);
    expect((await rows("payg_cursor", "&id=eq.1"))[0].last_seq).toBe(head);
    // The month is still open: nothing of ours is settled
    expect(await rows("usage_settlements", `&account=in.(${accounts.join(",")})`)).toHaveLength(0);
  });

  it("(5b) the site clock moves to the next UTC month: exactly one invoice for A's payg units at EUR 2.00 (free units never invoiced), B invoiced, C carried; a second run creates nothing", async () => {
    const real = new Date();
    const next = new Date(Date.UTC(real.getUTCFullYear(), real.getUTCMonth() + 1, 2, 3, 23));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(next);
    expect(utcMonth(new Date())).not.toBe(utcMonth(real));
    const month = utcMonth(real);
    const mine = [J.A.row.account, J.B.account, J.C.account];
    const run = await cron();
    expect(run.settle.errors).toEqual([]);
    const settlements = (await rows("usage_settlements", `&account=in.(${mine.join(",")})&order=account.asc`)) as any[];
    const by = (a: string) => settlements.filter((s) => s.account === a);
    // A: 25 payg units (the 25 free units are not in the invoice at all)
    expect(by(J.A.row.account)).toHaveLength(1);
    expect(by(J.A.row.account)[0]).toMatchObject({ month, units: 25, amount_cents: 2 * 100 * 25, status: "invoiced", carried_units: 0 });
    expect(by(J.A.row.account)[0].amount_cents).toBe(paygChargeCents(25));
    expect(by(J.B.account)[0]).toMatchObject({ month, units: 10, amount_cents: 2000, status: "invoiced" });
    // C: EUR 2.00 is under the EUR 5 minimum: carried, no invoice
    expect(by(J.C.account)[0]).toMatchObject({ month, units: 1, amount_cents: 200, status: "carried", rolled_into: null });
    const invoicesOf = (customer: string) => mock.allInvoices.filter((i) => i.customer === customer);
    expect(invoicesOf(J.A.customer)).toHaveLength(1);
    expect(invoicesOf(J.B.customer)).toHaveLength(1);
    expect(invoicesOf(J.C.customer)).toHaveLength(0);
    const inv = invoicesOf(J.A.customer)[0];
    expect(inv.metadata).toMatchObject({ kind: "payg_settlement", account: J.A.row.account, month });
    expect(mock.items.filter((i) => i.invoice === inv.id)).toEqual([expect.objectContaining({ amount: paygChargeCents(25) })]);
    expect(inv.params.default_payment_method).toBe((await acct(J.A.token)).stripe_payment_method_id);
    expect(by(J.A.row.account)[0].stripe_invoice_id).toBe(inv.id);
    J.A.invoice = inv;
    // A second run (and a run on the next day) creates no second invoice or settlement row
    const before = mock.allInvoices.length;
    await cron();
    expect(mock.allInvoices).toHaveLength(before);
    expect(await rows("usage_settlements", `&account=in.(${mine.join(",")})`)).toHaveLength(3);
    mock.forgetIdempotency(); // Stripe's idempotency keys expire after 24 h; the settlement row is what makes "once" true
    vi.setSystemTime(new Date(next.getTime() + 86_400_000));
    await cron();
    expect(mock.allInvoices).toHaveLength(before);
    expect(invoicesOf(J.A.customer)).toHaveLength(1);
  });

  it("(6) invoice.payment_failed: account past_due, the live key REVOKED ON THE REAL ENGINE (401), mint refused (402), one failure email; a redelivery changes nothing", async () => {
    const inv = J.A.invoice;
    const live = inspectKey(J.A.payg)!.k;
    expect((await screen(J.A.payg)).status).toBe(402); // still the cap, but the key itself is valid until now
    expect((await version(J.A.payg)).json.tier).toBe("client");
    const failed = { id: inv.id, object: "invoice", metadata: inv.metadata, hosted_invoice_url: "https://invoice.stripe.test/i/x" };
    expect((await stripeEvent("invoice.payment_failed", failed)).status).toBe(200);
    const row = await acct(J.A.token);
    expect(row).toMatchObject({ status: "past_due", key_id: null });
    expect(row.revoked_key_ids).toContain(live);
    expect(row.revoked_confirmed_ids).toContain(live);
    expect(row.revocation_pending).toBe(false);
    expect(revokedOnEngine()).toContain(live);
    const dead = await screen(J.A.payg);
    expect(dead.status).toBe(401);
    expect(String(dead.json.error)).toMatch(/revoked/);
    expect((await version(J.A.payg)).json.tier).toBe("public");
    const refused = await mint(J.A.token);
    expect(refused.status).toBe(402);
    expect(refused.json.status).toBe("past_due");
    expect((await rows("usage_settlements", `&account=eq.${J.A.row.account}`))[0].status).toBe("failed");
    J.A.settlementId = (await rows("usage_settlements", `&account=eq.${J.A.row.account}`))[0].id;
    const notices = () => rows("customer_notifications", `&kind=eq.payg_payment_failed&subject_id=eq.${J.A.settlementId}`);
    expect(await notices()).toHaveLength(1);
    expect(mailTo(J.A.row.email, /payment|invoice/i)).toHaveLength(1);
    // The same event again: nothing new anywhere
    const mailBefore = mail.length;
    const ledgerBefore = revokedOnEngine().length;
    expect((await stripeEvent("invoice.payment_failed", failed)).status).toBe(200);
    expect(await notices()).toHaveLength(1);
    expect(mail.length).toBe(mailBefore);
    expect(revokedOnEngine()).toHaveLength(ledgerBefore);
    expect(await acct(J.A.token)).toMatchObject({ status: "past_due", key_id: null });
    expect((await rows("funnel_events", `&name=eq.payment_failed`)).length).toBeGreaterThanOrEqual(1);
  });

  it("(7) invoice.paid: account active, a new key works against the real engine, the old one stays 401, and a late payment_failed after paid does not revert", async () => {
    const inv = J.A.invoice;
    const old = J.A.payg as string;
    const paid = { id: inv.id, object: "invoice", metadata: inv.metadata, hosted_invoice_url: "https://invoice.stripe.test/i/x" };
    expect((await stripeEvent("invoice.paid", paid)).status).toBe(200);
    expect(await acct(J.A.token)).toMatchObject({ status: "active", key_id: null }); // reinstated; the revoked key stays revoked
    expect((await rows("usage_settlements", `&account=eq.${J.A.row.account}`))[0].status).toBe("paid");
    const m = await mint(J.A.token);
    expect(m.status).toBe(200);
    expect(m.json).toMatchObject({ issued: true });
    const fresh = m.json.key as string;
    const payload = inspectKey(fresh)!;
    expect(payload).toMatchObject({ valid: true, s: "payg", q: 50, a: J.A.row.account });
    expect(payload.k).not.toBe(inspectKey(old)!.k);
    expect(await acct(J.A.token)).toMatchObject({ key_id: payload.k, key_scope: "payg" });
    expect((await version(fresh)).json.tier).toBe("client");
    expect((await screen(old)).status).toBe(401);
    // The new key is accepted by the metered path too (the cap is still the month's: 50 units, all used)
    expect((await screen(fresh)).json).toMatchObject({ reason: "spending_cap_reached" });
    // A failure notice that arrives after the payment (Stripe does not deliver in order) reverts nothing
    const late = await stripeEvent("invoice.payment_failed", { id: inv.id, object: "invoice", metadata: inv.metadata });
    expect(late.status).toBe(200);
    expect(await acct(J.A.token)).toMatchObject({ status: "active", key_id: payload.k });
    expect((await rows("usage_settlements", `&account=eq.${J.A.row.account}`))[0].status).toBe("paid");
    expect((await version(fresh)).json.tier).toBe("client");
    expect(mailTo(J.A.row.email, /payment|invoice/i)).toHaveLength(1); // no second failure email
    J.A.payg = fresh;
  });

  it("(8) subscription cancellation: key revoked on the real engine; a failed engine revoke stays unconfirmed in revoked_key_ids and the cron retries it until the engine confirms", async () => {
    // an api_triage subscription through the checkout webhook, its key minted from the mailed link
    const email = `sub-${uid()}@hall.example`;
    const sub = `sub_${uid()}`;
    const ck = await stripeEvent("checkout.session.completed", { id: `cs_${uid()}`, object: "checkout.session", mode: "subscription", customer: `cus_${uid()}`, subscription: sub, customer_email: email, amount_total: 90_000, currency: "eur", metadata: { kind: "api_triage", company: "Sub Co" } });
    expect(ck.status).toBe(200);
    const token = tokenFromMail(email);
    const m = await mint(token);
    expect(m.status).toBe(200);
    const key = m.json.key as string;
    const id = inspectKey(key)!.k;
    expect(inspectKey(key)).toMatchObject({ s: "machine", q: 600 });
    expect((await version(key)).json.tier).toBe("client");
    expect((await screen(key)).status).toBe(200);
    expect(net(inspectKey(key)!.a)).toBe(1);

    // the cancellation arrives while the engine cannot be reached for that one revoke: the id is recorded, unconfirmed
    const engineUrl = process.env.GRIDFORGE_API_URL;
    process.env.GRIDFORGE_API_URL = "http://127.0.0.1:1";
    let cancelled: Response;
    try {
      cancelled = await stripeEvent("customer.subscription.deleted", { id: sub, object: "subscription", status: "canceled", metadata: { kind: "api_triage" } });
    } finally {
      process.env.GRIDFORGE_API_URL = engineUrl;
    }
    expect(cancelled.status).toBe(200);
    const row = await acct(token);
    expect(row.status).toBe("cancelled");
    expect(row.revoked_key_ids).toContain(id);
    expect(row.revoked_confirmed_ids ?? []).not.toContain(id);
    expect(row.revocation_pending).toBe(true);
    expect(revokedOnEngine()).not.toContain(id);
    expect((await version(key)).json.tier).toBe("client"); // the engine has not been told: the key still works. That is the window the sweep closes.
    expect((await mint(token)).status).toBe(402);

    // the daily cron pushes it until the engine confirms
    const r = await cron();
    expect(r.revocations.confirmed).toBeGreaterThanOrEqual(1);
    expect(revokedOnEngine()).toContain(id);
    const after = await acct(token);
    expect(after.revoked_confirmed_ids).toContain(id);
    expect(after.revocation_pending).toBe(false);
    const dead = await screen(key);
    expect(dead.status).toBe(401);
    expect(String(dead.json.error)).toMatch(/revoked/);
    expect(await rows("funnel_events", "&name=eq.subscription_cancelled")).not.toHaveLength(0);
    // and the sweep is idempotent: nothing left to push
    expect((await cron()).revocations.confirmed).toBe(0);
  });

  it("(9a) 20 concurrent /v1/screen calls on a key with 10 remaining units: exactly 10 succeed, 10 get 402, the ledger nets to 10, no 429", async () => {
    const d = await freeAccount();
    await enablePayg(d.token, 20);
    const key = (await mint(d.token)).json.key as string;
    const account = inspectKey(key)!.a;
    expect((await estimate(key, "/v1/screen")).json).toMatchObject({ remaining_units: 10 });
    const out = await Promise.all(Array.from({ length: 20 }, () => screen(key)));
    expect(out.filter((r) => r.status === 200)).toHaveLength(10);
    expect(out.filter((r) => r.status === 402)).toHaveLength(10);
    expect(out.map((r) => r.status).filter((s) => s !== 200 && s !== 402)).toEqual([]);
    expect(out.filter((r) => r.status === 402).every((r) => r.json.reason === "spending_cap_reached")).toBe(true);
    expect(net(account)).toBe(10);
    expect(ledger().filter((e) => e.account === account && e.kind === "charge")).toHaveLength(10);
    expect(ledger().filter((e) => e.account === account && e.kind === "refund")).toHaveLength(0);
    expect((await statement(key)).units).toBe(10);
    J.D = { account, customer: (await acct(d.token)).stripe_customer_id };
    // ...and it is copied and invoiced exactly once as well
    await cron();
    const s = await rows("usage_settlements", `&account=eq.${account}`);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ units: 10, amount_cents: 2000, status: "invoiced" });
    expect(mock.allInvoices.filter((i) => i.customer === J.D.customer)).toHaveLength(1);
  });

  it("(9b) 8 concurrent /api/keys mints for one account: exactly one wins (409 for the others); then 8 concurrent ROTATIONS: one winner, and every issued id is live or revoked on the engine", async () => {
    const g = await freeAccount();
    await enablePayg(g.token, 20);
    const results = await Promise.all(Array.from({ length: 8 }, () => mint(g.token)));
    // A request that read the account before the winner's write loses the compare-and-set (409); one that read after it is told a key is
    // already live (issued: false). Either way exactly ONE key is issued.
    const issuedNow = results.filter((r) => r.status === 200 && r.json.issued === true);
    expect(issuedNow).toHaveLength(1);
    for (const r of results.filter((x) => x !== issuedNow[0])) expect(r.status === 409 || (r.status === 200 && r.json.issued === false)).toBe(true);
    expect(results.filter((r) => r.status === 409).length).toBeGreaterThanOrEqual(1);
    const first = inspectKey(issuedNow[0].json.key)!;
    expect((await acct(g.token)).key_id).toBe(first.k);
    expect((await version(issuedNow[0].json.key)).json.tier).toBe("client");

    // eight explicit rotations at once. Each rotation that is issued replaces the key it READ; two requests can never replace the same
    // one (409), but a request that reads after another has finished is a second, sequential rotation: so one OR MORE keys are issued,
    // and the invariant is that exactly one is live and every other issued id is revoked, recorded, and refused by the real engine.
    const rot = await Promise.all(Array.from({ length: 8 }, () => mint(g.token, { rotate: true })));
    const issued = rot.filter((r) => r.status === 200 && r.json.issued === true);
    expect(issued.length).toBeGreaterThanOrEqual(1);
    expect(rot.filter((r) => r.status !== 200).every((r) => r.status === 409)).toBe(true);
    expect(rot.filter((r) => r.status === 409).length + issued.length).toBe(8);
    const row = await acct(g.token);
    const issuedKeys = [issuedNow[0].json.key as string, ...issued.map((r) => r.json.key as string)];
    const ids = issuedKeys.map((k) => inspectKey(k)!.k);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === row.key_id)).toHaveLength(1); // exactly one live
    for (const [i, id] of ids.entries()) {
      if (id === row.key_id) {
        expect((await screen(issuedKeys[i])).status).toBe(200);
        expect(revokedOnEngine()).not.toContain(id);
        continue;
      }
      expect(row.revoked_key_ids, id).toContain(id);
      expect(row.revoked_confirmed_ids, id).toContain(id);
      expect(revokedOnEngine(), id).toContain(id);
      expect((await screen(issuedKeys[i])).status, id).toBe(401);
    }
    expect(row.revocation_pending).toBe(false);
    expect(statuses).not.toContain(429);
  });
});
