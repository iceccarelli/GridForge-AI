/**
 * The pay-as-you-go routes: /api/free-account, /api/usage, /api/payg/enable, /api/payg/cap and the scope selection in /api/keys.
 *
 * Stripe is a MOCK (MockStripe); the engine is a fetch interceptor; the database is the in-memory PostgREST with TypeScript mirrors of
 * the SQL functions (SUPPLEMENTAL: tests/test_payg_migration.py runs the SQL). No live Stripe or Supabase call is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { inspectKey, issueKey } from "@/lib/api-access";
import { PAYG, paygCapUnits } from "@/lib/products";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { MockStripe, ledgerEvent, mockEngine, newPaygDb, paygAccount, type MockEngine } from "./payg-harness";
import type { PostgrestFake } from "./postgrest-fake";

let db: PostgrestFake;
let restore: () => void;
let engine: MockEngine;
let mock: MockStripe;
let mail: { to: string; subject: string; text: string }[];

beforeEach(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", STRIPE_SECRET_KEY: "sk_test_placeholder",
    GRIDFORGE_KEY_SECRET: "test-signing-secret", RESEND_API_KEY: "re_test", LEAD_TO_EMAIL: "ops@example.test",
    LEAD_FROM_EMAIL: "Time to Power <power@timetopower.ai>",
  });
  delete process.env.GRIDFORGE_FREE_ACCOUNTS_MAX;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resetMemoryLimiter();
  db = newPaygDb();
  restore = db.install();
  mail = [];
  engine = mockEngine(mail);
  mock = new MockStripe();
  setPaygStripeForTests(mock);
});
afterEach(() => { setPaygStripeForTests(null); engine.restore(); restore(); vi.restoreAllMocks(); vi.useRealTimers(); });

let ipn = 0;
const post = (path: string, body: unknown, ip = `10.1.${Math.floor(++ipn / 250)}.${(ipn % 250) + 1}`) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", "x-real-ip": ip }, body: JSON.stringify(body) });
const get = (path: string, ip = `10.2.0.${(++ipn % 250) + 1}`) => new Request(siteUrl(path), { headers: { "x-real-ip": ip } });
const accounts = () => db.rows("api_accounts") as any[];
const by = (account: string) => accounts().find((a) => a.account === account);

// ------------------------------------------------------------------------------------------------ free account

describe("POST /api/free-account", () => {
  const route = () => import("@/app/api/free-account/route");

  it("creates a free account and queues the access email; the key is NOT returned (it is minted from the emailed link)", async () => {
    const { POST } = await route();
    const res = await POST(post("/api/free-account", { email: "Dev@Example.com", company: "Dev Co" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/gfk1|token|key_id|dev@example/i);
    expect(accounts()).toHaveLength(1);
    expect(accounts()[0]).toMatchObject({ plan: "api_free", status: "active", monthly_units: PAYG.freeAllowanceUnits, key_id: null, email: "dev@example.com" });
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe("dev@example.com");
    expect(mail[0].text).toContain(`/api-access/${accounts()[0].token}`);
    expect(mail[0].text).not.toMatch(/gfk1/);
    expect(db.rows("funnel_events").filter((e: any) => e.name === "free_account_created")).toHaveLength(1);
  });

  it("the same email twice (and its +tag / dotted-Gmail aliases) is ONE account, with an identical response each time", async () => {
    const { POST } = await route();
    const bodies: string[] = [];
    for (const email of ["alice@gmail.com", "alice@gmail.com", "ALICE+work@gmail.com", "a.l.i.c.e@googlemail.com"]) {
      const res = await POST(post("/api/free-account", { email }));
      expect(res.status).toBe(200);
      bodies.push(JSON.stringify(await res.json()));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(accounts()).toHaveLength(1);
    expect(db.rows("funnel_events").filter((e: any) => e.name === "free_account_created")).toHaveLength(1);
  });

  it("a visitor who lost the link gets it again, but never within the cooldown of the last one (bounding what anyone can make us mail to an address)", async () => {
    const { POST } = await route();
    await POST(post("/api/free-account", { email: "bob@example.com" }));
    expect(mail).toHaveLength(1);
    for (let i = 0; i < 4; i++) await POST(post("/api/free-account", { email: "bob@example.com" }));
    expect(mail).toHaveLength(1); // inside the cooldown: nothing more, however often it is asked
    // after the cooldown (the function takes the clock, as the cron jobs do) the link goes again, once
    const { createFreeAccount, FREE_RESEND_COOLDOWN_MS } = await import("@/lib/payg-accounts");
    const later = new Date(Date.now() + FREE_RESEND_COOLDOWN_MS + 60_000);
    await createFreeAccount("bob@example.com", null, later);
    await createFreeAccount("bob@example.com", null, later);
    expect(mail).toHaveLength(2);
    expect(accounts()).toHaveLength(1);
  });

  it("sign-up never reveals the ceiling (it counts VERIFIED accounts, at the first key mint): every new address gets the same answer", async () => {
    process.env.GRIDFORGE_FREE_ACCOUNTS_MAX = "1";
    const { POST } = await route();
    const bodies: string[] = [];
    for (const e of ["a1@example.com", "a2@example.com", "a3@example.com", "a1@example.com"]) {
      const res = await POST(post("/api/free-account", { email: e }));
      expect(res.status).toBe(200);
      bodies.push(JSON.stringify(await res.json()));
    }
    expect(new Set(bodies).size).toBe(1);
    expect(accounts()).toHaveLength(3);
  });

  it("the monthly ceiling of VERIFIED accounts is enforced when the owner first mints a key from the emailed link", async () => {
    process.env.GRIDFORGE_FREE_ACCOUNTS_MAX = "2";
    const { POST } = await route();
    for (const e of ["v1@example.com", "v2@example.com", "v3@example.com"]) await POST(post("/api/free-account", { email: e }));
    const keys = await import("@/app/api/keys/route");
    const mint = (a: any) => keys.POST(post("/api/keys", { token: a.token }));
    const [a1, a2, a3] = accounts();
    expect((await mint(a1)).status).toBe(200);
    expect((await mint(a2)).status).toBe(200);
    const over = await mint(a3);
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ ok: false, reason: "capacity" });
    expect(a3.key_id).toBeNull();
    expect(a3.free_verified_at).toBeNull();
    // an account already verified is never turned away, and rotating its key does not count it twice
    expect((await keys.POST(post("/api/keys", { token: a1.token, rotate: true }))).status).toBe(200);
    expect(accounts().filter((a: any) => a.free_verified_at)).toHaveLength(2);
  });

  it("the default ceiling is the catalogue's, not a number typed here", async () => {
    const { freeAccountsMax } = await import("@/lib/payg");
    expect(freeAccountsMax({} as NodeJS.ProcessEnv)).toBe(PAYG.freeAccountsMaxPerMonth);
    expect(freeAccountsMax({ GRIDFORGE_FREE_ACCOUNTS_MAX: "7" } as unknown as NodeJS.ProcessEnv)).toBe(7);
    expect(freeAccountsMax({ GRIDFORGE_FREE_ACCOUNTS_MAX: "lots" } as unknown as NodeJS.ProcessEnv)).toBe(PAYG.freeAccountsMaxPerMonth);
  });

  it("is rate limited per caller address (429 with Retry-After), and the refused request creates nothing", async () => {
    const { POST } = await route();
    const ip = "203.0.113.9";
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await POST(post("/api/free-account", { email: `rl${i}@example.com` }, ip))).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    expect(accounts()).toHaveLength(5);
  });

  it("rejects an invalid email or body before anything is written", async () => {
    const { POST } = await route();
    for (const body of [{ email: "nope" }, { email: 5 }, {}, { email: "a@b" }]) expect((await POST(post("/api/free-account", body))).status).toBe(400);
    expect((await POST(new Request(siteUrl("/api/free-account"), { method: "POST", body: "{not json" }))).status).toBe(400);
    expect(accounts()).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------------ usage

describe("GET /api/usage", () => {
  const route = () => import("@/app/api/usage/route");

  function two() {
    const a = paygAccount(db, { account: "acme-aaaaaa", token: "token-for-acme-0123456789abcd", email: "ops@acme.example" });
    const b = paygAccount(db, { account: "bravo-bbbbbb", token: "token-for-bravo-0123456789abcd", email: "cfo@bravo.example", cap_units: 100, monthly_units: 100 });
    const month = new Date().toISOString().slice(0, 7);
    const ts = `${month}-02T10:00:00+00:00`;
    let seq = 0;
    const ev = (account: string, over: Record<string, unknown> = {}) => {
      const e = ledgerEvent({ seq: ++seq, account, ts, ...over }) as any;
      db.rows("usage_events").push({ event_id: e.id, seq: e.seq, account, key_id: e.key_id, scope: e.scope, endpoint: e.endpoint, units: e.units, kind: e.kind, project: e.project, idem: "", ref: e.ref, occurred_at: new Date(e.ts).toISOString() });
      return e;
    };
    ev("acme-aaaaaa", { units: 5, endpoint: "/v1/study", project: "hall-a", key_id: "acmekey1" });
    ev("acme-aaaaaa", { units: 3, endpoint: "/v1/screen", key_id: "acmekey1" });
    ev("acme-aaaaaa", { kind: "refund", units: 3, ref: "ev000002", endpoint: "/v1/screen" });
    ev("bravo-bbbbbb", { units: 40, endpoint: "/v1/portfolio", project: "SECRET-PROJECT-B", key_id: "bravokey9" });
    db.insertRow("usage_settlements", { account: "bravo-bbbbbb", month: "2026-08", units: 99, amount_cents: 19800, status: "paid", hosted_invoice_url: "https://invoice.stripe.test/BRAVO" });
    db.insertRow("usage_settlements", { account: "acme-aaaaaa", month: "2026-08", units: 11, amount_cents: 2200, status: "invoiced", hosted_invoice_url: "https://invoice.stripe.test/ACME" });
    return { a, b };
  }

  it("answers with this account's meter, events and settlements, in the documented shape", async () => {
    two();
    const { GET } = await route();
    const res = await GET(get("/api/usage?token=token-for-acme-0123456789abcd"));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({
      ok: true,
      account: { plan: "api_payg", status: "active", scope: "payg", cap_units: 50, cap_eur: 100, payment_method_saved: true },
      units_used: 5, units_cap: 50, remaining_units: 45, billable_units: 5, eur_accrued_cents: 5 * PAYG.unitPriceCents,
      unit_price_cents: PAYG.unitPriceCents, currency: "eur", min_invoice_cents: PAYG.minInvoiceCents,
      alerts: { "80": false, "100": false },
    });
    expect(j.month).toBe(new Date().toISOString().slice(0, 7));
    expect(j.events.map((e: any) => [e.kind, e.units, e.endpoint])).toEqual([["refund", 3, "/v1/screen"], ["charge", 3, "/v1/screen"], ["charge", 5, "/v1/study"]]); // newest first
    expect(Object.keys(j.events[0]).sort()).toEqual(["endpoint", "id", "key_id", "kind", "project", "ref", "ts", "units"]);
    expect(j.settlements).toEqual([{ month: "2026-08", units: 11, amount_cents: 2200, status: "invoiced", carried_units: 0, hosted_invoice_url: "https://invoice.stripe.test/ACME", refunded_cents: 0, refund_state: null, dispute: null }]);
    expect(typeof j.billing_rule).toBe("string");
  });

  it("NEVER returns another account's rows: token isolation (events, projects, key ids, invoices, emails)", async () => {
    two();
    const { GET } = await route();
    const a = JSON.stringify(await (await GET(get("/api/usage?token=token-for-acme-0123456789abcd"))).json());
    for (const leak of ["bravo", "SECRET-PROJECT-B", "bravokey9", "portfolio", "BRAVO", "cfo@", "cfo@bravo.example", "token-for-bravo"]) expect(a, leak).not.toContain(leak);
    const b = JSON.stringify(await (await GET(get("/api/usage?token=token-for-bravo-0123456789abcd"))).json());
    for (const leak of ["acme", "hall-a", "acmekey1", "ACME", "ops@", "token-for-acme"]) expect(b, leak).not.toContain(leak);
    expect(b).toContain("SECRET-PROJECT-B");
    // there is no parameter that selects another account: naming one changes nothing
    const sneaky = JSON.stringify(await (await GET(get("/api/usage?token=token-for-acme-0123456789abcd&account=bravo-bbbbbb&email=cfo@bravo.example"))).json());
    expect(sneaky).toBe(a);
  });

  it("an unknown, empty or malformed token is 404 and reveals nothing", async () => {
    two();
    const { GET } = await route();
    for (const q of ["", "?token=", "?token=nope", `?token=${"x".repeat(500)}`, "?token=token-for-acme-0123456789abcd%27%20or%201=1"]) {
      const res = await GET(get(`/api/usage${q}`));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ ok: false, error: "Unknown account" });
    }
  });

  it("a free account's meter is the free allowance, never invoiced", async () => {
    paygAccount(db, { account: "free-ccc", token: "token-for-free-0123456789abcde", plan: "api_free", monthly_units: 25, cap_units: null, stripe_customer_id: null });
    const { GET } = await route();
    const j = await (await GET(get("/api/usage?token=token-for-free-0123456789abcde"))).json();
    expect(j.account).toMatchObject({ plan: "api_free", scope: "trial", cap_units: PAYG.freeAllowanceUnits, cap_eur: null });
    expect(j.eur_accrued_cents).toBe(0);
  });

  it("is unavailable (503), never an empty meter, when the store cannot be read", async () => {
    two();
    db.dropTable("usage_events");
    const { GET } = await route();
    expect((await GET(get("/api/usage?token=token-for-acme-0123456789abcd"))).status).toBe(503);
  });
});

// ---------------------------------------------------------------------------------------------- enable / cap

describe("cap bounds are enforced server-side", () => {
  const cases: [string, unknown, number][] = [
    ["below the minimum", PAYG.minCapEur - 1, 400], ["above the maximum", PAYG.maxCapEur + 1, 400], ["a fraction", 25.5, 400], ["zero", 0, 400],
    ["negative", -50, 400], ["text", "lots", 400], ["missing", undefined, 400], ["a huge string", "9".repeat(30), 400], ["null", null, 400], ["an object", { a: 1 }, 400],
  ];
  it.each(cases)("enable refuses %s", async (_n, cap, status) => {
    const acct = paygAccount(db, { plan: "api_free", cap_units: null, monthly_units: 25, stripe_customer_id: null, token: "free-token-0123456789abcdefgh" });
    const { POST } = await import("@/app/api/payg/enable/route");
    const res = await POST(post("/api/payg/enable", { token: acct.token, cap_eur: cap }));
    expect(res.status).toBe(status);
    expect(mock.calls).toEqual([]);
  });
  it.each(cases)("cap change refuses %s, changing nothing", async (_n, cap, status) => {
    const acct = paygAccount(db);
    const { POST } = await import("@/app/api/payg/cap/route");
    const res = await POST(post("/api/payg/cap", { token: acct.token, cap_eur: cap }));
    expect(res.status).toBe(status);
    expect(acct).toMatchObject({ cap_units: 50, key_id: null });
    expect(engine.revokeCalls).toEqual([]);
  });
  it("accepts exactly the catalogue's bounds, and the cap in units is the catalogue's conversion", async () => {
    const { POST } = await import("@/app/api/payg/cap/route");
    for (const cap of [PAYG.minCapEur, PAYG.defaultCapEur, PAYG.maxCapEur]) {
      const acct = paygAccount(db, { account: `a${cap}`, token: `tok-${cap}-0123456789abcdefghijk` });
      const res = await POST(post("/api/payg/cap", { token: acct.token, cap_eur: cap }));
      expect(res.status).toBe(200);
      expect(acct.cap_units).toBe(paygCapUnits(cap));
      expect(acct.monthly_units).toBe(paygCapUnits(cap));
    }
  });
});

describe("POST /api/payg/enable", () => {
  const route = () => import("@/app/api/payg/enable/route");
  const free = (over: Record<string, unknown> = {}) => paygAccount(db, { account: "free-ab12", token: "free-token-0123456789abcdefgh", plan: "api_free", monthly_units: 25, cap_units: null, stripe_customer_id: null, stripe_payment_method_id: null, ...over });

  it("starts a Stripe Checkout in SETUP mode (EUR, card saved, nothing charged) with the metadata the webhook needs", async () => {
    const a = free();
    const { POST } = await route();
    const res = await POST(post("/api/payg/enable", { token: a.token, cap_eur: 100 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, url: expect.stringMatching(/^https:\/\/checkout\.stripe\.test\//) });
    expect(mock.calls).toEqual(["checkout.sessions.create"]); // no invoice, no item, no payment intent
    const s = mock.sessions[0];
    expect(s).toMatchObject({ mode: "setup", currency: "eur", customer_creation: "always", metadata: { kind: "api_payg_enable", account_id: "free-ab12", cap_eur: "100" } });
    expect(s.setup_intent_data.metadata).toMatchObject({ kind: "api_payg_enable", account_id: "free-ab12" });
    expect(s).not.toHaveProperty("line_items");
    expect(s).not.toHaveProperty("payment_intent_data");
    expect(a.plan).toBe("api_free"); // only the signed webhook enables
  });

  it("reuses an existing Stripe customer instead of creating another", async () => {
    const a = free({ stripe_customer_id: "cus_existing" });
    const { POST } = await route();
    await POST(post("/api/payg/enable", { token: a.token, cap_eur: 50 }));
    expect(mock.sessions[0]).toMatchObject({ customer: "cus_existing" });
    expect(mock.sessions[0]).not.toHaveProperty("customer_creation");
  });

  it("refuses cancelled and past_due accounts (402), a pay-as-you-go account (409 -> use the cap), a subscription plan (409), and an unknown token (404)", async () => {
    const { POST } = await route();
    const cancelled = free({ status: "cancelled", account: "c1", token: "tok-c1-0123456789abcdefghijkl" });
    expect((await POST(post("/api/payg/enable", { token: cancelled.token, cap_eur: 50 }))).status).toBe(402);
    const pastDue = free({ status: "past_due", account: "c2", token: "tok-c2-0123456789abcdefghijkl" });
    expect((await POST(post("/api/payg/enable", { token: pastDue.token, cap_eur: 50 }))).status).toBe(402);
    const payg = paygAccount(db, { account: "c3", token: "tok-c3-0123456789abcdefghijkl" });
    const already = await POST(post("/api/payg/enable", { token: payg.token, cap_eur: 50 }));
    expect(already.status).toBe(409);
    expect(await already.json()).toMatchObject({ fix: "change_cap" });
    const sub = paygAccount(db, { account: "c4", token: "tok-c4-0123456789abcdefghijkl", plan: "api_scale" });
    expect((await POST(post("/api/payg/enable", { token: sub.token, cap_eur: 50 }))).status).toBe(409);
    expect((await POST(post("/api/payg/enable", { token: "nope", cap_eur: 50 }))).status).toBe(404);
    expect(mock.calls).toEqual([]);
  });

  it("503 with nothing created when Stripe is unavailable; 502 when Stripe fails", async () => {
    const a = free();
    const { POST } = await route();
    mock.failOnce.add("checkout.sessions.create");
    expect((await POST(post("/api/payg/enable", { token: a.token, cap_eur: 50 }))).status).toBe(502);
    setPaygStripeForTests(null);
    delete process.env.STRIPE_SECRET_KEY;
    expect((await POST(post("/api/payg/enable", { token: a.token, cap_eur: 50 }))).status).toBe(503);
  });

  it("is rate limited per caller address", async () => {
    const a = free();
    const { POST } = await route();
    const out: number[] = [];
    for (let i = 0; i < 32; i++) out.push((await POST(post("/api/payg/enable", { token: a.token, cap_eur: 50 }, "198.51.100.4"))).status);
    expect(out.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});

describe("POST /api/payg/cap: the cap lives in the signed key, so changing it rotates the key", () => {
  const route = () => import("@/app/api/payg/cap/route");

  async function mintFirst(token: string) {
    const { POST } = await import("@/app/api/keys/route");
    const res = await POST(post("/api/keys", { token }));
    expect(res.status).toBe(200);
    return (await res.json()) as { key: string };
  }

  it("mints a key carrying the NEW cap, records cap and key in one write, and revokes the previous key id on the engine", async () => {
    const a = paygAccount(db);
    const first = await mintFirst(a.token as string);
    const firstId = a.key_id as string;
    expect(inspectKey(first.key)).toMatchObject({ s: "payg", q: 50, a: "acme-123456", valid: true });

    const { POST } = await route();
    const res = await POST(post("/api/payg/cap", { token: a.token, cap_eur: 200 }));
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, issued: true, cap_eur: 200, cap_units: 100, revoked_previous: true });
    const k = inspectKey(j.key)!;
    expect(k).toMatchObject({ s: "payg", q: 100, a: "acme-123456", valid: true });
    expect(k.k).not.toBe(firstId);
    expect(a).toMatchObject({ cap_units: 100, monthly_units: 100, key_id: k.k, key_scope: "payg" });
    expect(a.revoked_key_ids).toContain(firstId);
    expect(a.revoked_confirmed_ids).toContain(firstId);
    expect(engine.revokeCalls).toEqual([firstId]);
  });

  it("says plainly when the engine did not confirm the revocation, and records it as unconfirmed", async () => {
    const a = paygAccount(db);
    await mintFirst(a.token as string);
    const firstId = a.key_id as string;
    engine.refuseRevoke = true;
    const { POST } = await route();
    const j = await (await POST(post("/api/payg/cap", { token: a.token, cap_eur: 60 }))).json();
    expect(j).toMatchObject({ ok: true, revoked_previous: false, revocation_pending: true });
    expect(j.revocation_note).toMatch(/daily job keeps retrying/);
    expect(a.revoked_key_ids).toContain(firstId);
    expect(a.revoked_confirmed_ids ?? []).not.toContain(firstId);
  });

  it("refuses a free account, a past_due account and a cancelled one, and an unknown token", async () => {
    const { POST } = await route();
    const free = paygAccount(db, { account: "f", token: "tok-f-0123456789abcdefghijklmn", plan: "api_free" });
    expect((await POST(post("/api/payg/cap", { token: free.token, cap_eur: 50 }))).status).toBe(409);
    const pd = paygAccount(db, { account: "p", token: "tok-p-0123456789abcdefghijklmn", status: "past_due" });
    expect((await POST(post("/api/payg/cap", { token: pd.token, cap_eur: 50 }))).status).toBe(402);
    const cx = paygAccount(db, { account: "x", token: "tok-x-0123456789abcdefghijklmn", status: "cancelled" });
    expect((await POST(post("/api/payg/cap", { token: cx.token, cap_eur: 50 }))).status).toBe(402);
    expect((await POST(post("/api/payg/cap", { token: "nope", cap_eur: 50 }))).status).toBe(404);
    expect(engine.revokeCalls).toEqual([]);
  });

  it("without key signing configured it refuses, and changes nothing", async () => {
    delete process.env.GRIDFORGE_KEY_SECRET;
    const a = paygAccount(db);
    const { POST } = await route();
    expect((await POST(post("/api/payg/cap", { token: a.token, cap_eur: 50 }))).status).toBe(503);
    expect(a.cap_units).toBe(50);
  });
});

// --------------------------------------------------------------------------------------------- key scope by plan

describe("POST /api/keys chooses scope and quota by plan", () => {
  const mint = async (token: string, extra: Record<string, unknown> = {}) => {
    const { POST } = await import("@/app/api/keys/route");
    return POST(post("/api/keys", { token, ...extra }));
  };

  it("api_free mints a TRIAL key bounded by the free allowance", async () => {
    const a = paygAccount(db, { plan: "api_free", cap_units: null, monthly_units: 0, stripe_customer_id: null });
    const res = await mint(a.token as string);
    expect(res.status).toBe(200);
    expect(inspectKey((await res.json()).key)).toMatchObject({ s: "trial", q: PAYG.freeAllowanceUnits, valid: true });
    expect(a.key_scope).toBe("trial");
  });

  it("api_payg mints a PAYG key bounded by the customer's cap", async () => {
    const a = paygAccount(db, { cap_units: 37 });
    expect(inspectKey((await (await mint(a.token as string)).json()).key)).toMatchObject({ s: "payg", q: 37 });
  });

  it("a pay-as-you-go account with no cap on record gets NO key (never an unbounded one)", async () => {
    const a = paygAccount(db, { cap_units: null });
    const res = await mint(a.token as string);
    expect(res.status).toBe(409);
    expect(a.key_id).toBeNull();
    const zero = paygAccount(db, { account: "z", token: "tok-z-0123456789abcdefghijklmn", cap_units: 0 });
    expect((await mint(zero.token as string)).status).toBe(409);
  });

  it("a subscription plan is unchanged: a machine key with the plan's allowance", async () => {
    const a = paygAccount(db, { plan: "api_scale", monthly_units: 2500, cap_units: null });
    expect(inspectKey((await (await mint(a.token as string)).json()).key)).toMatchObject({ s: "machine", q: 2500 });
  });

  it("the free key is REPLACED (and revoked) when the account becomes pay-as-you-go: a live key of the wrong scope is not left running", async () => {
    const a = paygAccount(db, { plan: "api_payg", key_id: "freekey1", key_scope: "trial", key_issued_at: "2026-10-01", key_expires_at: "2026-11-05", cap_units: 50 });
    const res = await mint(a.token as string); // no rotate flag, key is not near expiry
    const j = await res.json();
    expect(j).toMatchObject({ ok: true, issued: true, revoked_previous: true });
    expect(inspectKey(j.key)).toMatchObject({ s: "payg", q: 50 });
    expect(engine.revokeCalls).toEqual(["freekey1"]);
  });

  it("issueKey itself refuses a bounded scope with no bound", () => {
    expect(() => issueKey({ account: "a", quota: 0, scope: "trial" })).toThrow(/quota above zero/);
    expect(() => issueKey({ account: "a", quota: -3, scope: "payg" })).toThrow();
    expect(() => issueKey({ account: "a", quota: 0, scope: "machine" })).not.toThrow(); // 0 stays "unlimited" for a subscription key
  });
});
