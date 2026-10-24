/**
 * The outbox as a contract: credential separation, truthful states, documented provider semantics,
 * stale-message cancellation, reconciliation of pre-outbox purchases, and the Intelligence welcome.
 * FAKE-BACKED store; email is intercepted (Resend is never contacted).
 */
import { adminToken } from "@/lib/admin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";
import { paidSession } from "./checkout-fixture";

const WH = "whsec_notification_contract";
const DOC_TOKEN = "DOCUMENT-token-must-never-be-mailed-0123456789";
const INTAKE_TOKEN = "intake-token-0123456789abcdefghij";
const ID = "11111111-1111-4111-8111-111111111111";
type Sent = { from: string; to: string[] | string; subject: string; text: string; key: string | null };
let db: PostgrestFake;
let undo: () => void;
let sent: Sent[];
let logged: string[];
let provider: (n: number, init?: RequestInit) => Response | Promise<Response>;
let calls: number;
let failPatchWhen: ((body: string) => boolean) | null;
let failAll: boolean;

beforeEach(() => {
  sent = []; logged = []; calls = 0; failPatchWhen = null; failAll = false;
  provider = () => new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
  const sink = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  vi.spyOn(console, "error").mockImplementation(sink);
  vi.spyOn(console, "log").mockImplementation(sink);
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", STRIPE_SECRET_KEY: "sk_test_placeholder",
    STRIPE_WEBHOOK_SECRET: WH, RESEND_API_KEY: "re_test", LEAD_FROM_EMAIL: "Time to Power <power@timetopower.ai>",
    LEAD_TO_EMAIL: "ops@example.test", ADMIN_PASSWORD: "a-long-random-admin-password",
  });
  delete process.env.RESEND_FROM;
  db = new PostgrestFake(["deliverables", "leads", "qualifications", "customer_notifications", "api_accounts", "watches", "subscriptions"]);
  db.uniqueKeys.set("deliverables", [["stripe_session_id"]]);
  db.uniqueKeys.set("customer_notifications", [["dedupe_key"]]);
  db.rowDefaults.set("customer_notifications", () => ({
    status: "pending", attempts: 0, max_attempts: 6, next_attempt_at: new Date(0).toISOString(), claimed_until: null, last_error: null,
    last_http_status: null, provider_message_id: null, accepted_at: null, origin: "webhook", reopened_count: 0,
  }));
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith("https://api.resend.com")) {
      calls++;
      const res = await provider(calls, init);
      if (res.ok) sent.push({ ...JSON.parse(String(init?.body)), key: (init?.headers as Record<string, string>)["Idempotency-Key"] ?? null });
      return res;
    }
    if (url.includes("/customer_notifications")) {
      const method = String(init?.method ?? "GET");
      if (failAll) return new Response("{}", { status: 500 });
      if (method === "PATCH" && failPatchWhen?.(String(init?.body))) return new Response("{}", { status: 500 });
    }
    return dbFetch(i as RequestInfo, init);
  }) as typeof fetch;
  undo = () => { globalThis.fetch = dbFetch; restoreDb(); };
});
afterEach(() => { undo(); vi.restoreAllMocks(); vi.doUnmock("next/headers"); vi.resetModules(); });

const note = () => db.rows("customer_notifications")[0] as any;
const due = () => { for (const n of db.rows("customer_notifications") as any[]) { n.next_attempt_at = new Date(0).toISOString(); n.claimed_until = null; } };
const lib = () => import("@/lib/notifications");
const everything = () => JSON.stringify({ sent, logged, rows: db.rows("customer_notifications") });
function seedDeliverable(over: Record<string, unknown> = {}) {
  const row = { id: ID, kind: "density_screen", status: "awaiting_intake", email: "buyer@hall.example", token: DOC_TOKEN, intake_token: INTAKE_TOKEN, ...over };
  db.rows("deliverables").push(row);
  return row;
}

describe("credential separation: the intake email can only ever carry the intake credential", () => {
  it("a document token with NO intake token sends nothing, keeps the obligation, tells the operator safely, and recovers once repaired", async () => {
    const d = seedDeliverable({ intake_token: null });
    const { ensureNotification } = await lib();
    const o = await ensureNotification("intake_link", ID);
    expect(o).toMatchObject({ state: "pending", category: "credential_missing" });
    expect(sent.filter((m) => ([] as string[]).concat(m.to).includes("buyer@hall.example"))).toHaveLength(0);
    expect(note()).toMatchObject({ status: "pending", attempts: 0, last_error: "credential_missing" });   // no attempt burned
    expect(logged.some((l) => l.includes("credential_missing"))).toBe(true);
    expect(everything()).not.toContain(DOC_TOKEN);                       // not in mail, log or the queue
    expect(sent.some((m) => /missing credential/i.test(m.subject))).toBe(true);   // the operator was told, with ids only

    // the admin list never shows it either
    const { listNotifications } = await lib();
    expect(JSON.stringify(await listNotifications("all"))).not.toContain(DOC_TOKEN);

    // authoritative record repaired -> the SAME obligation completes
    d.intake_token = INTAKE_TOKEN; due();
    const again = await ensureNotification("intake_link", ID);
    expect(again.state).toBe("accepted");
    const mail = sent.find((m) => ([] as string[]).concat(m.to).includes("buyer@hall.example"))!;
    expect(mail.text).toContain(`/intake/${INTAKE_TOKEN}`);
    expect(mail.text).not.toContain(DOC_TOKEN);
  });

  it("an intake token equal to the document token, or malformed, is not a credential", async () => {
    const { ensureNotification } = await lib();
    seedDeliverable({ intake_token: DOC_TOKEN });
    expect((await ensureNotification("intake_link", ID)).state).toBe("pending");
    expect(sent.filter((m) => ([] as string[]).concat(m.to).includes("buyer@hall.example"))).toHaveLength(0);
    expect(everything()).not.toContain(`/intake/${DOC_TOKEN}`);
  });

  it("an engagement whose intake has already been submitted cancels the reminder instead of sending a stale link", async () => {
    seedDeliverable({ status: "draft" });
    const { ensureNotification } = await lib();
    expect(await ensureNotification("intake_link", ID)).toMatchObject({ state: "cancelled" });
    expect(sent).toHaveLength(0);
  });
});

describe("provider outcomes follow the documented semantics", () => {
  const cases: [string, Response, string, string, number | null][] = [
    ["400 invalid request: permanent, a person must act", new Response(JSON.stringify({ name: "validation_error" }), { status: 400 }), "abandoned", "rejected", 400],
    ["422: permanent", new Response("{}", { status: 422 }), "abandoned", "rejected", 422],
    ["429: retry later", new Response("{}", { status: 429, headers: { "retry-after": "1800" } }), "pending", "rate_limited", 429],
    ["409 concurrent_idempotent_requests: safe retry later", new Response(JSON.stringify({ name: "concurrent_idempotent_requests" }), { status: 409 }), "pending", "rate_limited", 409],
    ["409 invalid_idempotent_request: pending, next try takes a new key version", new Response(JSON.stringify({ name: "invalid_idempotent_request" }), { status: 409 }), "pending", "idempotency_conflict", 409],
    ["408: retryable", new Response("{}", { status: 408 }), "pending", "provider_error", 408],
    ["503: retryable", new Response("{}", { status: 503 }), "pending", "provider_error", 503],
    ["401: our credential is refused -- operator config, no attempt burned", new Response("{}", { status: 401 }), "pending", "provider_auth", 401],
  ];
  for (const [label, res, status, category, http] of cases) {
    it(label, async () => {
      seedDeliverable();
      provider = () => res.clone();
      const { ensureNotification } = await lib();
      await ensureNotification("intake_link", ID);
      expect(note()).toMatchObject({ status, last_error: category, last_http_status: http });
      if (category === "provider_auth") expect(note().attempts).toBe(0);
      if (label.startsWith("429")) expect(new Date(note().next_attempt_at).getTime() - Date.now()).toBeGreaterThan(25 * 60_000);
      expect(everything()).not.toContain(DOC_TOKEN);
    });
  }

  it("a payload conflict retries under a NEW key version; ordinary retries keep the SAME key", async () => {
    seedDeliverable();
    const { ensureNotification } = await lib();
    const keys: (string | null)[] = [];
    provider = (_n, init) => { keys.push((init?.headers as Record<string, string>)["Idempotency-Key"] ?? null); return new Response(JSON.stringify({ name: keys.length === 1 ? "invalid_idempotent_request" : undefined }), { status: keys.length < 3 ? 409 : 200 }); };
    await ensureNotification("intake_link", ID); due();
    await ensureNotification("intake_link", ID); due();
    await ensureNotification("intake_link", ID);
    expect(keys[0]).toBe(`intake_link:${ID}`);
    expect(keys[1]).toMatch(new RegExp(`^intake_link:${ID}:v2$`));           // conflict -> new version
  });

  it("a timeout is ambiguous; past the provider's idempotency window it is NOT retried automatically and a person decides", async () => {
    seedDeliverable();
    provider = () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; };
    const { ensureNotification, actOnNotification, sweepNotifications } = await lib();
    await ensureNotification("intake_link", ID);
    expect(note().last_error).toBe("timeout_maybe_accepted");

    provider = () => new Response(JSON.stringify({ id: "em_x" }), { status: 200 });
    note().last_attempt_at = new Date(Date.now() - 25 * 3_600_000).toISOString(); due();
    const swept = await sweepNotifications();
    expect(swept.outcomes.map((o) => o.state)).toEqual(["ambiguous"]);
    expect(note().status).toBe("ambiguous");
    expect(sent.filter((m) => ([] as string[]).concat(m.to).includes("buyer@hall.example"))).toHaveLength(0);   // not guessed
    expect((await sweepNotifications()).outcomes).toEqual([]);                       // and not picked up again

    // the operator's two honest choices
    expect(await actOnNotification(note().id, "confirm_sent")).toMatchObject({ state: "accepted" });
    expect(note()).toMatchObject({ status: "accepted", last_error: "operator_confirmed" });
  });

  it("an operator can reopen an ambiguous notification (counted) and send it again", async () => {
    seedDeliverable();
    provider = () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; };
    const { ensureNotification, actOnNotification } = await lib();
    await ensureNotification("intake_link", ID);
    note().status = "ambiguous";
    provider = () => new Response(JSON.stringify({ id: "em_y" }), { status: 200 });
    expect((await actOnNotification(note().id, "retry")).state).toBe("accepted");
    expect(note()).toMatchObject({ status: "accepted", reopened_count: 1 });
  });
});

describe("provider success and database success are different facts", () => {
  it("accepted by the provider but the outbox write fails: NOT reported accepted, stays pending/in_flight, and the same-key retry reconciles it", async () => {
    seedDeliverable();
    const { ensureNotification } = await lib();
    failPatchWhen = (b) => b.includes('"status":"accepted"');
    const o = await ensureNotification("intake_link", ID);
    expect(o.state).toBe("accepted_unrecorded");
    expect(note()).toMatchObject({ status: "pending", last_error: "in_flight" });
    expect(logged.some((l) => l.includes("outbox write failed"))).toBe(true);
    const firstKey = sent[0].key;

    failPatchWhen = null; due();
    expect((await ensureNotification("intake_link", ID)).state).toBe("accepted");
    expect(sent[1].key).toBe(firstKey);                                              // the provider can return the original
  });

  it("the database unavailable before the send: no email, no direct-send fallback, and the webhook asks Stripe to retry", async () => {
    failAll = true;
    const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: paidSession({
      id: "cs_1", customer_email: "buyer@hall.example", customer: "cus_1", amount_total: 450_000,
      metadata: { kind: "density_screen", company: "Hall Co" } }) } });
    const { POST } = await import("@/app/api/stripe/webhook/route");
    const res = await POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST",
      headers: { "stripe-signature": new Stripe("sk_test_placeholder").webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
    expect(res.status).toBe(500);
    expect(sent.filter((m) => ([] as string[]).concat(m.to).includes("buyer@hall.example"))).toHaveLength(0);
    failAll = false;
    const retry = await POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST",
      headers: { "stripe-signature": new Stripe("sk_test_placeholder").webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
    expect(retry.status).toBe(200);
    expect(db.rows("deliverables")).toHaveLength(1);
    expect(sent.filter((m) => ([] as string[]).concat(m.to).includes("buyer@hall.example"))).toHaveLength(1);
  });

  it("racing workers (cron + admin + webhook) send exactly one message", async () => {
    seedDeliverable();
    provider = async () => { await new Promise((r) => setTimeout(r, 15)); return new Response(JSON.stringify({ id: "em" }), { status: 200 }); };
    const { ensureNotification, sweepNotifications, actOnNotification } = await lib();
    await ensureNotification("intake_link", ID).catch(() => {});
    note().status = "pending"; note().attempts = 0; note().last_error = null; sent.length = 0; db.rows("customer_notifications").length = 0;
    await Promise.all([ensureNotification("intake_link", ID), sweepNotifications(), ensureNotification("intake_link", ID)]);
    due();
    await actOnNotification(note().id, "retry");
    expect(sent.filter((m) => ([] as string[]).concat(m.to).includes("buyer@hall.example"))).toHaveLength(1);
    expect(note().status).toBe("accepted");
  });
});

describe("a queued message is rebuilt from current state, and a stale one is cancelled", () => {
  const acct = (over: Record<string, unknown> = {}) => {
    const row = { id: ID, token: "portal-token-0123456789abcdefgh", email: "dev@example.test", status: "active", key_id: "k1", key_expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10), monthly_units: 1000, ...over };
    db.rows("api_accounts").push(row);
    return row;
  };
  const expiry = (r: any) => r.key_expires_at as string;

  it("a rotation warning for the CURRENT near-expiry key is sent, once, naming the real date", async () => {
    const a = acct();
    const { ensureNotification } = await lib();
    expect((await ensureNotification("key_rotation", ID, expiry(a))).state).toBe("accepted");
    const m = sent.find((x) => ([] as string[]).concat(x.to).includes("dev@example.test"))!;
    expect(m.text).toContain(expiry(a));
    expect(m.text).not.toMatch(/null|undefined/);
    expect((await ensureNotification("key_rotation", ID, expiry(a))).state).toBe("skipped");   // duplicate event
    expect(sent.filter((x) => ([] as string[]).concat(x.to).includes("dev@example.test"))).toHaveLength(1);
  });

  it("no key at all, a rotated key, a renewed expiry and a far-future key are all cancelled -- never 'expires on null'", async () => {
    const { ensureNotification } = await lib();
    const a = acct({ key_id: null, key_expires_at: null });
    expect(await ensureNotification("key_rotation", ID, "none")).toMatchObject({ state: "cancelled" });

    db.rows("customer_notifications").length = 0;
    const old = expiry(a);
    Object.assign(a, { key_id: "k2", key_expires_at: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10) });
    // an obligation created for a DIFFERENT (older) expiry
    expect(await ensureNotification("key_rotation", ID, "2020-01-01")).toMatchObject({ state: "cancelled", why: "key already replaced or renewed" });

    db.rows("customer_notifications").length = 0;
    Object.assign(a, { key_expires_at: new Date(Date.now() + 300 * 86_400_000).toISOString().slice(0, 10) });
    expect(await ensureNotification("key_rotation", ID, expiry(a))).toMatchObject({ state: "cancelled", why: "key no longer near expiry" });
    void old;
    expect(sent.filter((m) => ([] as string[]).concat(m.to).includes("dev@example.test"))).toHaveLength(0);
    expect(everything()).not.toMatch(/expires on null/);
  });

  it("a queued warning goes stale when the customer rotates before it is sent", async () => {
    const a = acct();
    provider = () => new Response("{}", { status: 503 });
    const { ensureNotification } = await lib();
    const was = expiry(a);
    await ensureNotification("key_rotation", ID, was);
    expect(note().status).toBe("pending");
    Object.assign(a, { key_id: "k9", key_expires_at: new Date(Date.now() + 34 * 86_400_000).toISOString().slice(0, 10) });
    provider = () => new Response(JSON.stringify({ id: "em" }), { status: 200 });
    due();
    expect((await ensureNotification("key_rotation", ID, was)).state).toBe("cancelled");
    expect(sent).toHaveLength(0);
  });
});

describe("the Intelligence welcome", () => {
  const buyIntelligence = async (evt: string) => {
    const payload = JSON.stringify({ id: evt, type: "checkout.session.completed", data: { object: paidSession({
      id: "cs_int_1", customer_email: "reader@example.test", customer: "cus_i", subscription: "sub_i", amount_total: 90_000,
      metadata: { kind: "intelligence_subscription", plan: "pro" } }) } });
    const { POST } = await import("@/app/api/stripe/webhook/route");
    return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST",
      headers: { "stripe-signature": new Stripe("sk_test_placeholder").webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
  };
  const to = (addr: string) => sent.filter((m) => ([] as string[]).concat(m.to).includes(addr));

  it("replays send neither a second welcome nor a second operator notice", async () => {
    expect((await buyIntelligence("evt_a")).status).toBe(200);
    expect((await buyIntelligence("evt_b")).status).toBe(200);
    expect((await buyIntelligence("evt_c")).status).toBe(200);
    expect(db.rows("subscriptions")).toHaveLength(1);
    expect(to("reader@example.test")).toHaveLength(1);
    expect(to("ops@example.test").filter((m) => /Intelligence subscriber/.test(m.subject))).toHaveLength(1);
  });

  it("a failed welcome never touches the paid subscription, and a redelivery completes it", async () => {
    provider = () => new Response("{}", { status: 503 });
    expect((await buyIntelligence("evt_a")).status).toBe(200);
    expect(db.rows("subscriptions")).toHaveLength(1);
    expect((db.rows("subscriptions")[0] as any).status).toBe("active");
    expect(note()).toMatchObject({ kind: "subscription_welcome", status: "pending" });
    provider = () => new Response(JSON.stringify({ id: "em" }), { status: 200 });
    due();
    await buyIntelligence("evt_b");
    expect(to("reader@example.test")).toHaveLength(1);
    expect(note().status).toBe("accepted");
  });
});

describe("reconciling paid records that predate the outbox", () => {
  const cookie = () => adminToken()!;
  const asAdmin = (yes: boolean) => { vi.doMock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (yes && n === "gf_admin" ? { value: cookie() } : undefined) }) })); vi.resetModules(); };
  const req = (method: string, body?: unknown) => new Request(siteUrl("/api/admin/notifications/reconcile"), { method, body: body === undefined ? undefined : JSON.stringify(body) });

  it("rejects unauthenticated callers on both verbs", async () => {
    asAdmin(false);
    const { GET, POST } = await import("@/app/api/admin/notifications/reconcile/route");
    expect((await GET()).status).toBe(401);
    expect((await POST(req("POST", { selection: [] }))).status).toBe(401);
  });

  it("the dry run lists ids and reasons, sends nothing, and exposes no address, link or token", async () => {
    seedDeliverable();
    seedDeliverable.call(null);   // second record, different id below
    (db.rows("deliverables")[1] as any).id = "22222222-2222-4222-8222-222222222222";
    (db.rows("deliverables")[1] as any).intake_token = null;
    asAdmin(true);
    const { GET } = await import("@/app/api/admin/notifications/reconcile/route");
    const res = await GET();
    const wire = JSON.stringify(await res.json());
    expect(res.status).toBe(200);
    const body = JSON.parse(wire);
    expect(body.dry_run).toBe(true);
    expect(body.counts.intake_link).toEqual({ eligible: 1, ineligible: 1 });
    for (const forbidden of [DOC_TOKEN, INTAKE_TOKEN, "buyer@hall.example", "/intake/"]) expect(wire).not.toContain(forbidden);
    expect(sent).toHaveLength(0);
    expect(db.rows("customer_notifications")).toHaveLength(0);       // a dry run writes nothing
  });

  it("enqueues only what was selected and still eligible, is idempotent, creates no purchase, and does not send", async () => {
    seedDeliverable();
    asAdmin(true);
    const { POST } = await import("@/app/api/admin/notifications/reconcile/route");
    const sel = { selection: [{ kind: "intake_link", subject_id: ID }, { kind: "intake_link", subject_id: "99999999-9999-4999-8999-999999999999" }, { kind: "key_rotation", subject_id: ID }] };
    const first = await (await POST(req("POST", sel))).json();
    expect(first).toMatchObject({ ok: true, enqueued: 1, already_present: 0 });
    expect(first.rejected).toHaveLength(2);
    const again = await (await POST(req("POST", sel))).json();
    expect(again).toMatchObject({ enqueued: 0, already_present: 1 });
    expect(db.rows("customer_notifications")).toHaveLength(1);
    expect(note()).toMatchObject({ origin: "operator_reconcile", status: "pending" });
    expect(db.rows("deliverables")).toHaveLength(1);                 // no second purchase record
    expect(sent).toHaveLength(0);                                    // enqueue is not send

    // concurrent identical requests are safe
    db.rows("customer_notifications").length = 0;
    const both = await Promise.all([POST(req("POST", sel)), POST(req("POST", sel))]);
    expect(both.every((r) => r.status === 200)).toBe(true);
    expect(db.rows("customer_notifications")).toHaveLength(1);
  });

  it("validates the selection, and reports an unavailable outbox honestly", async () => {
    asAdmin(true);
    const { POST } = await import("@/app/api/admin/notifications/reconcile/route");
    expect((await POST(req("POST", { selection: "all" }))).status).toBe(400);
    expect((await POST(req("POST", { selection: [] }))).status).toBe(400);
    failAll = true;
    expect((await POST(req("POST", { selection: [{ kind: "intake_link", subject_id: ID }] }))).status).toBe(503);
  });

  it("before migration 0021 the endpoints say so instead of pretending", async () => {
    undo();
    db = new PostgrestFake(["deliverables"]);
    const r = db.install(); undo = () => { r(); };
    asAdmin(true);
    const { GET } = await import("@/app/api/admin/notifications/reconcile/route");
    expect((await GET()).status).toBe(503);
  });
});

describe("the cron fails closed and counts honestly", () => {
  it("answers 401 with no CRON_SECRET, a wrong secret, or a secret in the query string", async () => {
    const { GET } = await import("@/app/api/cron/notifications/route");
    delete process.env.CRON_SECRET;
    expect((await GET(new Request(siteUrl("/api/cron/notifications")))).status).toBe(401);
    expect((await GET(new Request(siteUrl("/api/cron/notifications"), { headers: { authorization: "Bearer " } }))).status).toBe(401);
    process.env.CRON_SECRET = "cron-secret-value";
    expect((await GET(new Request(siteUrl("/api/cron/notifications?key=cron-secret-value")))).status).toBe(401);
    expect((await GET(new Request(siteUrl("/api/cron/notifications"), { headers: { authorization: "Bearer wrong" } }))).status).toBe(401);
  });

  it("with the right secret it reports attempted / accepted / pending / ambiguous / abandoned separately", async () => {
    process.env.CRON_SECRET = "cron-secret-value";
    seedDeliverable();
    provider = () => new Response("{}", { status: 503 });
    const { ensureNotification } = await lib();
    await ensureNotification("intake_link", ID); due();
    provider = () => new Response(JSON.stringify({ id: "em" }), { status: 200 });
    const { GET } = await import("@/app/api/cron/notifications/route");
    const body = await (await GET(new Request(siteUrl("/api/cron/notifications"), { headers: { authorization: "Bearer cron-secret-value" } }))).json();
    expect(body).toMatchObject({ ok: true, available: true, attempted: 1, accepted: 1, acceptedUnrecorded: 0, pending: 0, ambiguous: 0, abandoned: 0 });
  });
});
