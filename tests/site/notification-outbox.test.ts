/**
 * The customer's access email is a durable, recoverable obligation -- separate from the payment.
 *
 * A verified Stripe event writes ONE business record. The email that carries the buyer's only way in is its
 * own row (customer_notifications, migration 0021): attempted immediately, retried (bounded, leased) when the
 * provider fails, picked up again by a webhook redelivery or the cron sweep, and never reconstructed from a
 * log, because no link ever goes to one.
 *
 * FAKE-BACKED store (the same obligations are exercised against real PostgreSQL in the realdb suite);
 * email is intercepted, Resend is never contacted.
 */
import { adminToken } from "@/lib/admin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const WH = "whsec_notification_outbox";
type Sent = { from: string; to: string[] | string; subject: string; text: string; key: string | null };
let db: PostgrestFake;
let undo: () => void;
let sent: Sent[];
let logged: string[];
let provider: (n: number) => Response | Promise<Response>;
let calls: number;
let attempted: string[];

function install(withOutbox: boolean) {
  db = new PostgrestFake(["deliverables", "leads", "qualifications", ...(withOutbox ? ["customer_notifications"] : [])]);
  db.uniqueKeys.set("deliverables", [["stripe_session_id"]]);
  if (withOutbox) {
    db.uniqueKeys.set("customer_notifications", [["dedupe_key"]]);
    db.rowDefaults.set("customer_notifications", () => ({
      status: "pending", attempts: 0, max_attempts: 6, next_attempt_at: new Date(0).toISOString(),
      claimed_until: null, last_error: null, last_http_status: null, provider_message_id: null, accepted_at: null,
    }));
  }
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (url.startsWith("https://api.resend.com")) {
      calls++;
      attempted.push(([] as string[]).concat(JSON.parse(String(init?.body)).to).join(","));
      const res = await provider(calls);
      if (res.ok) {
        const b = JSON.parse(String(init?.body));
        sent.push({ ...b, key: (init?.headers as Record<string, string>)["Idempotency-Key"] ?? null });
      }
      return res;
    }
    return dbFetch(i as RequestInfo, init);
  }) as typeof fetch;
  undo = () => { globalThis.fetch = dbFetch; restoreDb(); };
}

const accept = () => new Response(JSON.stringify({ id: `em_${Math.random().toString(36).slice(2)}` }), { status: 200 });

beforeEach(() => {
  sent = []; logged = []; calls = 0; attempted = [];
  provider = () => accept();
  const sink = (...a: unknown[]) => { logged.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); };
  vi.spyOn(console, "error").mockImplementation(sink);
  vi.spyOn(console, "log").mockImplementation(sink);
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = WH;
  process.env.RESEND_API_KEY = "re_test";
  process.env.LEAD_FROM_EMAIL = "Time to Power <power@timetopower.ai>";
  process.env.LEAD_TO_EMAIL = "ops@example.test";
  delete process.env.RESEND_FROM;
  install(true);
});
afterEach(() => { undo(); vi.restoreAllMocks(); });

const stripe = new Stripe("sk_test_placeholder");
async function buy(evt = "evt_1") {
  const payload = JSON.stringify({ id: evt, type: "checkout.session.completed", data: { object: {
    id: "cs_ds_1", object: "checkout_session", customer_email: "buyer@hall.example", customer: "cus_1", amount_total: 450_000,
    metadata: { kind: "density_screen", company: "Hall Co" } } } });
  const { POST } = await import("@/app/api/stripe/webhook/route");
  return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST",
    headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
}
const toBuyer = () => sent.filter((m) => ([] as string[]).concat(m.to).includes("buyer@hall.example"));
const deliverable = () => db.rows("deliverables")[0] as any;
const note = () => db.rows("customer_notifications")[0] as any;
const makeDue = () => { for (const n of db.rows("customer_notifications") as any[]) n.next_attempt_at = new Date(0).toISOString(); };
const secretsInLogs = () => {
  const d = deliverable();
  const all = logged.join("\n");
  return [d.token, d.intake_token, "/intake/", "buyer@hall.example"].filter((s) => s && all.includes(s));
};

describe("a verified payment and its email are two durable facts", () => {
  it("one deliverable, one accepted notification, one message carrying the INTAKE link (never the document token)", async () => {
    expect((await buy()).status).toBe(200);
    expect(db.rows("deliverables")).toHaveLength(1);
    expect(db.rows("customer_notifications")).toHaveLength(1);
    expect(note()).toMatchObject({ kind: "intake_link", status: "accepted", subject_id: deliverable().id });
    expect(toBuyer()).toHaveLength(1);
    expect(toBuyer()[0].from).toBe("Time to Power <power@timetopower.ai>");
    expect(toBuyer()[0].text).toContain(`/intake/${deliverable().intake_token}`);
    expect(toBuyer()[0].text).not.toContain(deliverable().token);
    expect(toBuyer()[0].key).toBe(note().dedupe_key);
    expect(JSON.stringify(db.rows("customer_notifications"))).not.toContain(deliverable().intake_token);   // no token in the queue
  });

  it("a Stripe redelivery after acceptance neither creates a second record nor sends a second message (the operator's 'paid' notice included)", async () => {
    await buy(); await buy("evt_retry"); await buy("evt_retry_2");
    expect(sent.filter((m) => ([] as string[]).concat(m.to).includes("ops@example.test"))).toHaveLength(1);
    expect(db.rows("deliverables")).toHaveLength(1);
    expect(db.rows("customer_notifications")).toHaveLength(1);
    expect(toBuyer()).toHaveLength(1);
  });
});

describe("a provider failure is visible and recoverable without touching the payment", () => {
  it("HTTP 500 leaves the notification pending (never 'accepted'); the NEXT webhook redelivery completes it", async () => {
    provider = () => new Response(JSON.stringify({ name: "internal_server_error", message: "buyer@hall.example secret detail" }), { status: 500 });
    expect((await buy()).status).toBe(200);                     // the payment is still fulfilled
    expect(db.rows("deliverables")).toHaveLength(1);
    expect(note()).toMatchObject({ status: "pending", attempts: 1, last_error: "provider_error", last_http_status: 500 });
    expect(toBuyer()).toHaveLength(0);

    provider = () => accept();
    expect((await buy("evt_retry")).status).toBe(200);          // not due yet (backoff) -> left alone
    expect(note().status).toBe("pending");
    makeDue();
    expect((await buy("evt_retry_2")).status).toBe(200);        // due -> the redelivery sends it
    expect(note()).toMatchObject({ status: "accepted", attempts: 2 });
    expect(db.rows("deliverables")).toHaveLength(1);
    expect(toBuyer()).toHaveLength(1);
    expect(secretsInLogs()).toEqual([]);
  });

  it("an HTTP rejection is never mistaken for a send, and a permanent one is abandoned with one operator notice that carries no link", async () => {
    provider = () => new Response(JSON.stringify({ name: "validation_error" }), { status: 422 });
    await buy();
    expect(note()).toMatchObject({ status: "abandoned", last_error: "rejected", last_http_status: 422 });
    expect(toBuyer()).toHaveLength(0);
    provider = () => accept();
    await buy("evt_retry");                                     // abandoned stays abandoned until an operator acts
    expect(note().status).toBe("abandoned");
    const op = sent.filter((m) => ([] as string[]).concat(m.to).includes("ops@example.test"));
    expect(op.filter((m) => /could not be delivered/.test(m.subject))).toHaveLength(0);   // provider was down for it too: logged, not lost
    expect(JSON.stringify(sent)).not.toContain(deliverable().intake_token);
  });

  it("a timeout is recorded as 'may have been accepted', not as confirmed non-delivery, and the retry reuses the same idempotency key", async () => {
    provider = () => { const e = new Error("t"); e.name = "TimeoutError"; throw e; };
    await buy();
    expect(note()).toMatchObject({ status: "pending", last_error: "timeout_maybe_accepted" });
    const key = note().dedupe_key;
    provider = () => accept();
    makeDue();
    await buy("evt_retry");
    expect(note().status).toBe("accepted");
    expect(toBuyer()).toHaveLength(1);
    expect(toBuyer()[0].key).toBe(key);                              // the provider can dedupe the ambiguous first try
  });

  it("attempts are bounded: after max_attempts the notification is abandoned and an operator is told", async () => {
    provider = () => new Response("{}", { status: 503 });
    await buy();
    for (let i = 0; i < 8; i++) { makeDue(); await buy(`evt_r${i}`); }
    expect(note()).toMatchObject({ status: "abandoned", attempts: 6 });
    expect(attempted.filter((to) => to === "buyer@hall.example")).toHaveLength(6);   // exactly max_attempts, then it stops
  });
});

describe("missing configuration is observable and survives until fixed", () => {
  it("with no sender the notification stays pending without burning attempts; once configured the sweep sends it", async () => {
    delete process.env.LEAD_FROM_EMAIL;
    expect((await buy()).status).toBe(200);
    expect(note()).toMatchObject({ status: "pending", attempts: 0, last_error: "not_configured" });
    expect(toBuyer()).toHaveLength(0);
    expect(secretsInLogs()).toEqual([]);

    process.env.LEAD_FROM_EMAIL = "Time to Power <power@timetopower.ai>";
    makeDue();
    const { sweepNotifications } = await import("@/lib/notifications");
    const s = await sweepNotifications();
    expect(s.outcomes.map((o) => o.state)).toEqual(["accepted"]);
    expect(toBuyer()).toHaveLength(1);
  });

  it("RESEND_FROM still wins over LEAD_FROM_EMAIL", async () => {
    process.env.RESEND_FROM = "R <r@timetopower.ai>";
    await buy();
    expect(toBuyer()[0].from).toBe("R <r@timetopower.ai>");
  });
});

describe("concurrent runs cannot double-send", () => {
  it("two simultaneous attempts on one due notification send exactly one message", async () => {
    provider = () => new Response("{}", { status: 503 });
    await buy();
    provider = async () => { await new Promise((r) => setTimeout(r, 20)); return accept(); };
    makeDue();
    const { ensureNotification } = await import("@/lib/notifications");
    const [a, b] = await Promise.all([ensureNotification("intake_link", deliverable().id), ensureNotification("intake_link", deliverable().id)]);
    expect([a.state, b.state].sort()).toEqual(["accepted", "skipped"]);
    expect(toBuyer()).toHaveLength(1);
  });
});

describe("an operator can recover from the persisted record, through an authenticated route only", () => {
  it("lists open notifications without any recipient, link or token, and retries an abandoned one", async () => {
    const { createHash } = await import("node:crypto");
    process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
    const cookie = adminToken()!;
    vi.doMock("next/headers", () => ({ cookies: async () => ({ get: (n: string) => (n === "gf_admin" ? { value: cookie } : undefined) }) }));
    vi.resetModules();

    provider = () => new Response("{}", { status: 422 });
    await buy();
    expect(note().status).toBe("abandoned");

    const { GET, POST } = await import("@/app/api/admin/notifications/route");
    const list = await (await GET(new Request(siteUrl("/api/admin/notifications")))).json();
    expect(list.items).toHaveLength(1);
    const wire = JSON.stringify(list);
    for (const forbidden of [deliverable().intake_token, deliverable().token, "buyer@hall.example", "/intake/"]) expect(wire).not.toContain(forbidden);

    provider = () => accept();
    const res = await POST(new Request(siteUrl("/api/admin/notifications"), { method: "POST", body: JSON.stringify({ id: list.items[0].id }) }));
    expect((await res.json()).outcome.state).toBe("accepted");
    expect(toBuyer()).toHaveLength(1);
    vi.doUnmock("next/headers");
  });

  it("refuses an unauthenticated caller", async () => {
    vi.doMock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
    vi.resetModules();
    const { GET, POST } = await import("@/app/api/admin/notifications/route");
    expect((await GET(new Request(siteUrl("/api/admin/notifications")))).status).toBe(401);
    expect((await POST(new Request(siteUrl("/api/admin/notifications"), { method: "POST", body: "{}" }))).status).toBe(401);
    vi.doUnmock("next/headers");
  });
});

describe("before migration 0021 is applied", () => {
  it("falls back to one direct send; a failure is logged by record id and category only, with no link", async () => {
    undo(); install(false);
    provider = () => new Response("{}", { status: 500 });
    expect((await buy()).status).toBe(200);
    expect(db.rows("deliverables")).toHaveLength(1);
    const line = logged.find((l) => l.includes("email NOT sent"));
    expect(line).toContain(deliverable().id);
    expect(line).toContain("provider_error");
    expect(secretsInLogs()).toEqual([]);
  });
});
