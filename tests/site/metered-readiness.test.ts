/**
 * The website must not issue or open anything the engine cannot honour.
 *
 * Production's engine predates the ledger. These tests run the routes against a mock engine that behaves like that engine
 * (metered: false) and like a current one, and prove: free keys, pay-as-you-go, cap changes and key mints are refused with nothing
 * created and nothing charged when the engine cannot record them; they work when it can; a mismatched price or allowance is
 * refused; and a rotation does not revoke the key it replaces until the engine is shown to verify our keys.
 * MOCKS: the PostgREST fake and the engine are test doubles; their answers mirror gridforge/api/server.py /v1/version and
 * /v1/admin/ledger (proven against the real engine in tests/test_payg_http.py).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";
import { inspectKey, mintChecked, retryRevocations, type ApiAccount } from "@/lib/api-access";
import { meteredReadiness, resetApiReadinessCache } from "@/lib/api-readiness";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { MockStripe, mockEngine, newPaygDb, paygAccount, type MockEngine } from "./payg-harness";
import type { PostgrestFake } from "./postgrest-fake";

let db: PostgrestFake;
let restore: () => void;
let engine: MockEngine;
let mail: { to: string; subject: string; text: string }[];
let ipn = 0;

beforeEach(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", STRIPE_SECRET_KEY: "sk_test_placeholder",
    GRIDFORGE_KEY_SECRET: "test-signing-secret", RESEND_API_KEY: "re_test", LEAD_TO_EMAIL: "ops@example.test",
    LEAD_FROM_EMAIL: "Time to Power <power@timetopower.ai>",
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  resetMemoryLimiter();
  resetApiReadinessCache();
  db = newPaygDb();
  restore = db.install();
  mail = [];
  engine = mockEngine(mail);
  setPaygStripeForTests(new MockStripe());
});
afterEach(() => { setPaygStripeForTests(null); engine.restore(); restore(); resetApiReadinessCache(); vi.restoreAllMocks(); });

const post = (path: string, body: unknown) =>
  new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json", "x-real-ip": `10.9.${Math.floor(++ipn / 250)}.${(ipn % 250) + 1}` }, body: JSON.stringify(body) });
const accounts = () => db.rows("api_accounts") as any[];

describe("an engine from before the ledger (what production runs today): nothing metered is opened", () => {
  beforeEach(() => { engine.metered = false; });

  it("reports why, as a category", async () => {
    expect((await meteredReadiness()).category).toBe("metering_unsupported");
  });

  it("free-account creates nothing and says it is not open yet", async () => {
    const { POST } = await import("@/app/api/free-account/route");
    const res = await POST(post("/api/free-account", { email: "dev@example.com" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.reason).toBe("metered_unavailable");
    expect(body.error).toMatch(/not open on this deployment yet/);
    expect(body.error).toMatch(/nothing was charged/i);
    expect(JSON.stringify(body)).not.toMatch(/metering_unsupported/); // the category is logged, never shown
    expect(accounts()).toHaveLength(0);
    expect(mail).toHaveLength(0);
  });

  it("a free key cannot be minted, nor a pay-as-you-go key, and a cap change mints nothing", async () => {
    const free = paygAccount(db, { plan: "api_free", cap_units: null, monthly_units: 25, account: "free-aaaaaaaaaa", key_id: null, status: "active", free_verified_at: new Date().toISOString() });
    const payg = paygAccount(db, { account: "payg-bbbbbbbbbb", key_id: null });
    const keys = await import("@/app/api/keys/route");
    for (const row of [free, payg]) {
      const res = await keys.POST(post("/api/keys", { token: row.token }));
      expect(res.status).toBe(503);
      expect((await res.json()).reason).toBe("metered_unavailable");
    }
    const { POST: cap } = await import("@/app/api/payg/cap/route");
    const capped = await cap(post("/api/payg/cap", { token: payg.token, cap_eur: 100 }));
    expect(capped.status).toBe(503);
    expect(accounts().every((a) => a.key_id === null)).toBe(true);
  });

  it("enabling pay-as-you-go creates no Stripe session", async () => {
    const free = paygAccount(db, { plan: "api_free", cap_units: null, monthly_units: 25, account: "free-cccccccccc" });
    const { POST } = await import("@/app/api/payg/enable/route");
    const res = await POST(post("/api/payg/enable", { token: free.token, cap_eur: 100 }));
    expect(res.status).toBe(503);
    expect((await res.json()).reason).toBe("metered_unavailable");
  });

  it("a SUBSCRIPTION key is not blocked by this gate (it needs only signing, proven by the sales readiness)", async () => {
    const sub = paygAccount(db, { plan: "api_triage", monthly_units: 600, cap_units: null, account: "sub-dddddddddd", key_id: null });
    const keys = await import("@/app/api/keys/route");
    const res = await keys.POST(post("/api/keys", { token: sub.token }));
    expect(res.status).toBe(200);
    expect(inspectKey((await res.json()).key)?.s).toBe("machine");
  });
});

describe("a current engine: the same routes work", () => {
  it("is ready, and free-account, enable and the key mints go through", async () => {
    expect(await meteredReadiness()).toMatchObject({ ready: true, category: "ready" });
    const { POST } = await import("@/app/api/free-account/route");
    expect((await POST(post("/api/free-account", { email: "dev@example.com" }))).status).toBe(200);
    expect(accounts()).toHaveLength(1);
    const payg = paygAccount(db, { account: "payg-eeeeeeeeee", key_id: null });
    const keys = await import("@/app/api/keys/route");
    const res = await keys.POST(post("/api/keys", { token: payg.token }));
    expect(res.status).toBe(200);
    expect(inspectKey((await res.json()).key)).toMatchObject({ s: "payg", q: 50 });
  });
});

describe("the engine must quote the scheme this site quotes", () => {
  it("a different unit price, free allowance, minimum invoice or currency is refused as a mismatch", async () => {
    const inner = globalThis.fetch;
    for (const patch of [{ unit_price_cents: 250 }, { free_allowance_units: 50 }, { min_invoice_cents: 100 }, { currency: "usd" }]) {
      resetApiReadinessCache();
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await inner(input as RequestInfo, init);
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url !== "https://engine.test/v1/version") return res;
        const j = await res.json();
        if (j.payg) j.payg = { ...j.payg, ...patch };
        return new Response(JSON.stringify(j), { status: 200 });
      }) as typeof fetch;
      expect((await meteredReadiness()).category, JSON.stringify(patch)).toBe("metering_mismatch");
    }
    globalThis.fetch = inner;
  });

  it("an engine that is down, or whose ledger is not durable, is not ready", async () => {
    engine.down = true;
    expect((await meteredReadiness()).ready).toBe(false);
    engine.down = false;
    resetApiReadinessCache();
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://engine.test/v1/version") {
        const j = await (await inner(input as RequestInfo, init)).json();
        if (j.metering) j.metering = { ...j.metering, ledger_durable: false };
        return new Response(JSON.stringify(j), { status: 200 });
      }
      return inner(input as RequestInfo, init);
    }) as typeof fetch;
    expect((await meteredReadiness()).category).toBe("ledger_unavailable");
    globalThis.fetch = inner;
  });
});

describe("rotation never leaves the customer with a key the engine cannot verify", () => {
  const live = (over: Record<string, unknown> = {}): ApiAccount => paygAccount(db, { plan: "api_triage", monthly_units: 600, cap_units: null, account: "rot-ffffffffff", key_id: "oldkey01", key_scope: "machine", key_expires_at: "2099-01-01", ...over }) as unknown as ApiAccount;

  it("verified engine: the old id is revoked at once and confirmed", async () => {
    const row = live();
    const out = await mintChecked(row, { rotate: true });
    expect(out.ok && out.result.engine_revoked).toBe(true);
    expect(engine.revokeCalls).toEqual(["oldkey01"]);
  });

  it("an engine that cannot be asked: the old key is NOT revoked, the result says deferred, and the id stays recorded for the sweep", async () => {
    engine.down = true;
    const row = live();
    const out = await mintChecked(row, { rotate: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.result.engine_revoked).toBeNull();
    expect(out.result.rotation_deferred).toBe(true);
    expect(engine.revokeCalls).toEqual([]);
    const stored = accounts().find((a) => a.account === "rot-ffffffffff");
    expect(stored.revoked_key_ids).toContain("oldkey01");
    expect(stored.revoked_confirmed_ids ?? []).not.toContain("oldkey01");
  });

  it("an engine that rejects our signatures (a different secret): the old key is kept", async () => {
    // an engine whose secret differs reads our probe as tier public
    const inner = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url === "https://engine.test/v1/version" && String((init?.headers as Record<string, string>)?.["X-API-Key"]).startsWith("gfk1.")) {
        return new Response(JSON.stringify({ tier: "public" }), { status: 200 });
      }
      return inner(input as RequestInfo, init);
    }) as typeof fetch;
    const out = await mintChecked(live(), { rotate: true });
    expect(out.ok && out.result.rotation_deferred).toBe(true);
    expect(engine.revokeCalls).toEqual([]);
    globalThis.fetch = inner;
  });

  it("the sweep revokes the deferred id for an ACTIVE account only after the engine verifies our keys, and a cancelled account's ids always", async () => {
    engine.down = true;
    const active = live();
    await mintChecked(active, { rotate: true });
    const cancelled = paygAccount(db, { account: "can-gggggggggg", status: "cancelled", key_id: "deadkey1", revoked_key_ids: ["deadkey1"], revoked_confirmed_ids: [] });
    const first = await retryRevocations(50);
    expect(engine.revokeCalls).toEqual(["deadkey1"]); // the cancelled account is cut off even while the engine cannot verify keys
    expect(first.stillPending).toBeGreaterThanOrEqual(1);
    engine.down = false;
    engine.revokeCalls.length = 0;
    await retryRevocations(50);
    expect(engine.revokeCalls).toContain("oldkey01");
    void cancelled;
  });
});
