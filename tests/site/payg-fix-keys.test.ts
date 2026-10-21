/**
 * Red-team F6 and F7, in the key paths this work touches.
 *
 * F6  two concurrent mints read the same row and the last write won; the other key's id was recorded nowhere and so could never be
 *     revoked (it lives up to 35 days). The key write is now a compare-and-set on the key id the mint read.
 * F7  the response said an unconfirmed revocation "will be retried" and nothing retried it. Confirmation is now tracked per id
 *     (revoked_confirmed_ids) and /api/cron/payg pushes every unconfirmed id until the engine confirms.
 *
 * The compare-and-set is exercised against the in-memory PostgREST, whose filters (`key_id=eq.X` / `is.null`, `status=eq.active`)
 * behave as PostgREST's do; the revoked-ids union trigger is mirrored (SUPPLEMENTAL) and proven in tests/test_payg_migration.py.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { inspectKey, mintChecked, retryRevocations, type ApiAccount } from "@/lib/api-access";
import { mockEngine, newPaygDb, paygAccount, type MockEngine } from "./payg-harness";
import type { PostgrestFake } from "./postgrest-fake";

let db: PostgrestFake;
let restore: () => void;
let engine: MockEngine;

beforeEach(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", GRIDFORGE_KEY_SECRET: "test-signing-secret",
    STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_WEBHOOK_SECRET: "whsec_fix_keys", CRON_SECRET: "cron-secret-value",
  });
  delete process.env.RESEND_API_KEY;
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  db = newPaygDb();
  restore = db.install();
  engine = mockEngine();
});
afterEach(() => { engine.restore(); restore(); vi.restoreAllMocks(); });

const post = (path: string, body: unknown) => new Request(siteUrl(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const keys = () => import("@/app/api/keys/route");
const asRow = (r: unknown) => r as ApiAccount;

describe("F6: two concurrent mints cannot both win", () => {
  it("POST /api/keys twice at once: exactly one key is issued, the other answers 409, and the account records the issued one", async () => {
    const a = paygAccount(db, { plan: "api_scale", cap_units: null, monthly_units: 2500, key_id: "oldkey01", key_scope: "machine", key_issued_at: "2026-09-01", key_expires_at: "2026-10-23" }); // near expiry: both want to mint
    const { POST } = await keys();
    const [r1, r2] = await Promise.all([POST(post("/api/keys", { token: a.token })), POST(post("/api/keys", { token: a.token }))]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const winner = await (r1.status === 200 ? r1 : r2).json();
    expect(winner.issued).toBe(true);
    // the id on the account IS the winner's key; there is no live key whose id is recorded nowhere
    expect(inspectKey(winner.key)!.k).toBe(a.key_id);
    expect(a.revoked_key_ids).toEqual(["oldkey01"]);
    const loser = await (r1.status === 409 ? r1 : r2).json();
    expect(loser.ok).toBe(false);
    expect(loser).not.toHaveProperty("key");
  });

  it("many concurrent first-time mints (no key yet): one wins", async () => {
    const a = paygAccount(db, { plan: "api_scale", cap_units: null, monthly_units: 100 });
    const { POST } = await keys();
    const res = await Promise.all(Array.from({ length: 5 }, () => POST(post("/api/keys", { token: a.token }))));
    expect(res.filter((r) => r.status === 200)).toHaveLength(1);
    expect(res.filter((r) => r.status === 409)).toHaveLength(4);
  });

  it("a cap change racing a mint (both read the same row first): exactly one wins and the account's cap matches the key that is live", async () => {
    const a = paygAccount(db, { key_id: "oldkey01", key_scope: "payg", key_issued_at: "2026-10-01", key_expires_at: "2026-11-05", cap_units: 50 });
    const readByCap = { ...a } as unknown as ApiAccount;
    const readByMint = { ...a } as unknown as ApiAccount;
    const [capChange, plainMint] = await Promise.all([
      mintChecked(readByCap, { rotate: true, entitlement: { scope: "payg", quota: 100 }, extra: { cap_units: 100, monthly_units: 100 } }),
      mintChecked(readByMint, { rotate: true }),
    ]);
    expect([capChange.ok, plainMint.ok].sort()).toEqual([false, true]);
    const winner = capChange.ok ? capChange : plainMint;
    const k = inspectKey((winner as { ok: true; result: { token: string } }).result.token)!;
    expect(k.k).toBe(a.key_id);
    expect(k.q).toBe(a.cap_units); // never a row saying one cap with a live key carrying another
    expect(a.monthly_units).toBe(a.cap_units);
  });

  it("the cap route itself answers 409 (nothing changed) when it loses such a race", async () => {
    const a = paygAccount(db, { key_id: "oldkey01", key_scope: "payg", key_issued_at: "2026-10-01", key_expires_at: "2026-11-05", cap_units: 50 });
    // A concurrent mint lands between the route's read and its write: simulate by changing the key id under a read that already happened.
    const realFetch = globalThis.fetch;
    let armed = true;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      if (armed && init?.method === "PATCH" && String(i).includes("/api_accounts")) { armed = false; a.key_id = "intruder"; }
      return realFetch(i as RequestInfo, init);
    }) as typeof fetch;
    const cap = await import("@/app/api/payg/cap/route");
    const res = await cap.POST(post("/api/payg/cap", { token: a.token, cap_eur: 200 }));
    globalThis.fetch = realFetch;
    expect(res.status).toBe(409);
    expect(a).toMatchObject({ cap_units: 50, key_id: "intruder" });
    expect(engine.revokeCalls).toEqual([]);
  });

  it("the compare-and-set also refuses to hand out a key if the account stopped being active meanwhile", async () => {
    const a = paygAccount(db, { plan: "api_scale", cap_units: null, monthly_units: 100 });
    const snapshot = { ...a } as unknown as ApiAccount; // what a mint read before a cancellation landed
    a.status = "cancelled";
    const out = await mintChecked(snapshot);
    expect(out).toMatchObject({ ok: false, reason: "conflict" });
    expect(a.key_id).toBeNull();
  });

  it("a stale read never overwrites a newer key id", async () => {
    const a = paygAccount(db, { plan: "api_scale", cap_units: null, monthly_units: 100 });
    const stale = { ...a } as unknown as ApiAccount;
    const first = await mintChecked(asRow(a));
    expect(first.ok).toBe(true);
    const keyAfterFirst = a.key_id;
    const second = await mintChecked(stale); // based on "no key yet"
    expect(second).toMatchObject({ ok: false, reason: "conflict" });
    expect(a.key_id).toBe(keyAfterFirst);
  });
});

describe("F7: an unconfirmed revocation is retried until the engine confirms it", () => {
  it("the mint records an unconfirmed revocation, and the daily sweep confirms it once the engine answers", async () => {
    const a = paygAccount(db, { plan: "api_scale", cap_units: null, monthly_units: 100, key_id: "oldkey01", key_scope: "machine", key_issued_at: "2026-10-01", key_expires_at: "2026-11-05" });
    engine.refuseRevoke = true;
    const { POST } = await keys();
    const j = await (await POST(post("/api/keys", { token: a.token, rotate: true }))).json();
    expect(j).toMatchObject({ ok: true, revoked_previous: false, revocation_pending: true });
    expect(j.revocation_note).toMatch(/daily job keeps retrying/);
    expect(j.revocation_note).not.toMatch(/will be retried;/); // the claim is now backed by a job, and says which
    expect(a.revoked_key_ids).toEqual(["oldkey01"]);
    expect(a.revoked_confirmed_ids).toEqual([]);
    expect(a.revocation_pending).toBe(true);

    // still refusing: the sweep keeps it pending and says so
    expect(await retryRevocations()).toEqual({ accounts: 1, confirmed: 0, stillPending: 1 });
    expect(a.revocation_pending).toBe(true);
    // the engine recovers
    engine.refuseRevoke = false;
    expect(await retryRevocations()).toEqual({ accounts: 1, confirmed: 1, stillPending: 0 });
    expect(a.revoked_confirmed_ids).toEqual(["oldkey01"]);
    expect(a.revocation_pending).toBe(false);
    expect(engine.revokeCalls).toEqual(["oldkey01"]);
    // and a confirmed id is not pushed again
    expect(await retryRevocations()).toEqual({ accounts: 0, confirmed: 0, stillPending: 0 });
  });

  it("a mint the engine DID confirm leaves nothing pending", async () => {
    const a = paygAccount(db, { plan: "api_scale", cap_units: null, monthly_units: 100, key_id: "oldkey01", key_scope: "machine", key_issued_at: "2026-10-01", key_expires_at: "2026-11-05" });
    const { POST } = await keys();
    const j = await (await POST(post("/api/keys", { token: a.token, rotate: true }))).json();
    expect(j.revoked_previous).toBe(true);
    expect(a.revocation_pending).toBe(false);
  });

  it("cancellation pushes every id, records only the ones the engine confirmed, and the sweep finishes the rest", async () => {
    const a = paygAccount(db, { plan: "api_scale", cap_units: null, monthly_units: 100, key_id: "live0001", stripe_subscription_id: "sub_1", revoked_key_ids: ["gone0001"] });
    engine.refuseRevoke = true;
    const payload = JSON.stringify({ id: "evt_c", type: "customer.subscription.deleted", data: { object: { id: "sub_1", object: "subscription", metadata: {} } } });
    const sdk = new Stripe("sk_test_placeholder");
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": sdk.webhooks.generateTestHeaderString({ payload, secret: "whsec_fix_keys" }) }, body: payload }));
    expect(res.status).toBe(200);
    expect(a.status).toBe("cancelled");
    expect([...(a.revoked_key_ids as string[])].sort()).toEqual(["gone0001", "live0001"]);
    expect(a.revoked_confirmed_ids).toEqual([]);
    engine.refuseRevoke = false;
    await retryRevocations();
    expect([...(a.revoked_confirmed_ids as string[])].sort()).toEqual(["gone0001", "live0001"]);
    expect(a.revocation_pending).toBe(false);
  });

  it("GET /api/cron/payg runs the sweep, only for the caller holding CRON_SECRET (401 otherwise, and with no secret set at all)", async () => {
    const a = paygAccount(db, { plan: "api_scale", cap_units: null, monthly_units: 100, revoked_key_ids: ["old00001"] });
    delete process.env.GRIDFORGE_API_URL; // no engine ledger in this test: the sweep needs only the revoke endpoint, which uses the same URL
    process.env.GRIDFORGE_API_URL = "https://engine.test";
    const { GET } = await import("@/app/api/cron/payg/route");
    const call = (auth?: string) => GET(new Request(siteUrl("/api/cron/payg"), { headers: auth ? { authorization: auth } : {} }));
    expect((await call()).status).toBe(401);
    expect((await call("Bearer wrong")).status).toBe(401);
    expect(a.revocation_pending).toBe(true);
    const ok = await call("Bearer cron-secret-value");
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.revocations).toEqual({ accounts: 1, confirmed: 1, stillPending: 0 });
    expect(a.revocation_pending).toBe(false);
    delete process.env.CRON_SECRET;
    expect((await call("Bearer cron-secret-value")).status).toBe(401); // fails closed with no secret configured
  });
});
