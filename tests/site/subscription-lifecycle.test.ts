/**
 * API plans, Hall Watch and Intelligence: from the billing events to what the customer can actually do.
 *
 * Labels (never upgraded into one another):
 *   REAL ENGINE  — the Python engine, a subprocess, verifies the minted key and its revocation
 *   FAKE STORE   — PostgREST is the in-memory fake, with injected failures; the database-level
 *                  guarantees (unique per subscription) are proven in the real-database suite
 *   NOT PROVEN   — a hosted Stripe Checkout / real Stripe event stream (no test-mode credential)
 *
 * The properties: a billing event that could not be applied must be retried, never acknowledged;
 * a key the account does not record is never handed over; a cancelled subscription ends access.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const WH = "whsec_subscription_lifecycle_secret";
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const SIGNING = "lifecycle-signing-secret";
const ADMIN = "lifecycle-admin-key";
let engine: ChildProcess | null = null;
let ENGINE = "";
let revokedFile = "";
let db: PostgrestFake;
let undo: () => void;
const realFetch = globalThis.fetch;
/** Injected store failures: any request whose method+table matches fails with 503. */
let failing: { method: string; table: string }[] = [];

async function startEngine(): Promise<string> {
  revokedFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "gf-revoked-")), "revoked.json");
  const code = [
    "import os",
    `os.environ['GRIDFORGE_KEY_SECRET']='${SIGNING}'`,
    `os.environ['GRIDFORGE_ADMIN_KEY']='${ADMIN}'`,
    `os.environ['GRIDFORGE_REVOKED_FILE']='${revokedFile}'`,
    "os.environ['GRIDFORGE_RATE_LIMIT']='0'",
    "from gridforge.api.server import Handler, make_server", "Handler.limiter.per_minute=0",
    "h=make_server('127.0.0.1',0)", "print(h.server_address[1],flush=True)", "h.serve_forever()",
  ].join("\n");
  engine = spawn("python3", ["-c", code], { cwd: process.cwd(), stdio: ["ignore", "pipe", "inherit"] });
  return await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error("engine did not start")), 20_000);
    engine!.stdout!.once("data", (d) => { clearTimeout(t); res(`http://127.0.0.1:${String(d).trim()}`); });
  });
}
beforeAll(async () => { if (hasPython) ENGINE = await startEngine(); }, 30_000);
afterAll(() => engine?.kill());

beforeEach(() => {
  failing = [];
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = WH;
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_ADMIN_KEY = ADMIN;
  process.env.GRIDFORGE_KEY_SECRET = SIGNING;
  delete process.env.RESEND_API_KEY;
  db = new PostgrestFake(["api_accounts", "watches", "watch_notes", "subscriptions", "leads", "deliverables"]);
  // as 0007 declares them: one account per subscription AND a globally unique billing identity
  db.uniqueKeys.set("api_accounts", [["stripe_subscription_id"], ["account"]]);
  db.uniqueKeys.set("watches", [["stripe_subscription_id"]]);
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof i === "string" ? i : i instanceof URL ? i.href : i.url;
    if (ENGINE && url.startsWith(ENGINE)) return realFetch(i as RequestInfo, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const hit = failing.find((f) => f.method === method && url.includes(`/rest/v1/${f.table}`));
    if (hit) return new Response(JSON.stringify({ message: "injected outage" }), { status: 503 });
    return dbFetch(i as RequestInfo, init);
  }) as typeof fetch;
  undo = () => { globalThis.fetch = realFetch; restoreDb(); };
});
afterEach(() => undo());

const stripe = new Stripe("sk_test_placeholder");
function event(type: string, object: Record<string, unknown>, id = `evt_${Math.random().toString(36).slice(2)}`) {
  const payload = JSON.stringify({ id, type, data: { object } });
  return new Request(siteUrl("/api/stripe/webhook"), {
    method: "POST",
    headers: { "stripe-signature": stripe.webhooks.generateTestHeaderString({ payload, secret: WH }) },
    body: payload,
  });
}
const hook = async (r: Request) => (await import("@/app/api/stripe/webhook/route")).POST(r);
const bought = (kind: string, sub: string, extra: Record<string, unknown> = {}) =>
  event("checkout.session.completed", {
    id: `cs_${sub}`, object: "checkout_session", customer_email: "buyer@hall.example", customer: `cus_${sub}`,
    subscription: sub, amount_total: 90_000, currency: "eur", metadata: { kind, company: "Hall Co", ...extra },
  });
const invoice = (type: "invoice.paid" | "invoice.payment_failed", sub: string) =>
  event(type, { id: `in_${sub}`, object: "invoice", subscription: sub });
const deleted = (sub: string, kind?: string) =>
  event("customer.subscription.deleted", { id: sub, object: "subscription", metadata: kind ? { kind } : {} });

async function keys(method: "GET" | "POST", body?: Record<string, unknown>, token?: string) {
  const { GET, POST } = await import("@/app/api/keys/route");
  if (method === "GET") return GET(new Request(siteUrl(`/api/keys?token=${token}`)));
  return POST(new Request(siteUrl("/api/keys"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}
const account = (sub: string) => (db.rows("api_accounts") as any[]).find((a) => a.stripe_subscription_id === sub);
const engineAccepts = async (key: string) => (await realFetch(`${ENGINE}/v1/usage`, { headers: { "x-api-key": key } })).status;

describe.runIf(hasPython)("API plan: payment -> account -> a key the published API accepts -> cancellation ends it (REAL ENGINE, FAKE STORE)", () => {
  it("a paid customer gets a key the engine accepts, entitled to the plan; cancelling revokes it on the engine", async () => {
    expect((await hook(bought("api_triage", "sub_a1"))).status).toBe(200);
    const acct = account("sub_a1");
    expect(acct).toMatchObject({ plan: "api_triage", status: "active", email: "buyer@hall.example", monthly_units: expect.any(Number) });
    expect(acct.monthly_units).toBeGreaterThan(0);

    const minted: any = await (await keys("POST", { token: acct.token })).json();
    expect(minted.ok && minted.issued).toBe(true);
    expect(await engineAccepts(minted.key)).toBe(200);                       // the engine, not a database row, accepts it
    expect(account("sub_a1").key_id).toBeTruthy();                           // and the account records which id is live

    // a payment failure is visible but does not itself end a paid-for key (it verifies offline)
    expect((await hook(invoice("invoice.payment_failed", "sub_a1"))).status).toBe(200);
    expect(account("sub_a1").status).toBe("past_due");
    expect((await hook(invoice("invoice.paid", "sub_a1"))).status).toBe(200);
    expect(account("sub_a1").status).toBe("active");

    expect((await hook(deleted("sub_a1", "api_triage"))).status).toBe(200);
    expect(account("sub_a1").status).toBe("cancelled");
    expect(await engineAccepts(minted.key)).not.toBe(200);                   // revoked on the REAL engine
    expect((await keys("POST", { token: acct.token })).status).toBe(402);    // and no new key can be minted
    expect((await keys("POST", { token: acct.token, rotate: true })).status).toBe(402);
  }, 40_000);

  it("a key is not handed over when the account could not record it", async () => {
    await hook(bought("api_scale", "sub_a2"));
    const acct = account("sub_a2");
    failing = [{ method: "PATCH", table: "api_accounts" }];
    const res = await keys("POST", { token: acct.token });
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/gfk|"key"/);        // no credential in the body
    expect(account("sub_a2").key_id ?? null).toBeNull();                      // nothing half-recorded
    failing = [];
    const retry: any = await (await keys("POST", { token: acct.token })).json();
    expect(retry.issued).toBe(true);
    expect(await engineAccepts(retry.key)).toBe(200);
  }, 40_000);

  it("a failed rotation write leaves the previous key as the recorded one and says so", async () => {
    await hook(bought("api_scale", "sub_a3"));
    const acct = account("sub_a3");
    const first: any = await (await keys("POST", { token: acct.token })).json();
    const liveId = account("sub_a3").key_id;
    failing = [{ method: "PATCH", table: "api_accounts" }];
    const res = await keys("POST", { token: acct.token, rotate: true });
    expect(res.status).toBe(500);
    expect(account("sub_a3").key_id).toBe(liveId);
    expect(account("sub_a3").revoked_key_ids ?? []).toEqual([]);              // nothing claimed as revoked
    expect(await engineAccepts(first.key)).toBe(200);                         // the old key was not touched
  }, 40_000);
});

describe("a lifecycle event that could not be applied is retried, never acknowledged (FAKE STORE with injected outages)", () => {
  it.each([
    ["API account", "api_triage", "api_accounts", (sub: string) => account(sub)?.status],
    ["Hall Watch", "hall_watch", "watches", (sub: string) => (db.rows("watches") as any[]).find((w) => w.stripe_subscription_id === sub)?.status],
  ])("%s: cancellation whose write fails answers 500, applies on redelivery, and is idempotent", async (_n, kind, table, statusOf) => {
    const sub = `sub_c_${kind}`;
    await hook(bought(kind, sub));
    failing = [{ method: "PATCH", table }];
    expect((await hook(deleted(sub, kind))).status).toBe(500);                 // Stripe will redeliver
    expect(statusOf(sub)).toBe("active");                                      // honest: it was NOT applied
    failing = [];
    expect((await hook(deleted(sub, kind))).status).toBe(200);
    expect((await hook(deleted(sub, kind))).status).toBe(200);
    expect(statusOf(sub)).toBe("cancelled");
  });

  it("Intelligence: cancellation whose write fails answers 500 and applies on redelivery", async () => {
    await hook(bought("intelligence_subscription", "sub_i1", { plan: "team" }));
    expect((db.rows("subscriptions") as any[])[0].status).toBe("active");
    failing = [{ method: "PATCH", table: "subscriptions" }];
    expect((await hook(deleted("sub_i1"))).status).toBe(500);
    expect((db.rows("subscriptions") as any[])[0].status).toBe("active");
    failing = [];
    expect((await hook(deleted("sub_i1"))).status).toBe(200);
    expect((db.rows("subscriptions") as any[])[0].status).toBe("cancelled");
  });

  it("a cancellation whose LOOKUP fails is not mistaken for 'no such account'", async () => {
    await hook(bought("api_triage", "sub_l1"));
    failing = [{ method: "GET", table: "api_accounts" }];
    expect((await hook(deleted("sub_l1", "api_triage"))).status).toBe(500);
    failing = [];
    expect((await hook(deleted("sub_l1", "api_triage"))).status).toBe(200);
    expect(account("sub_l1").status).toBe("cancelled");
  });

  it("a payment failure / recovery that cannot be written is retried too", async () => {
    await hook(bought("api_triage", "sub_p1"));
    failing = [{ method: "PATCH", table: "api_accounts" }];
    expect((await hook(invoice("invoice.payment_failed", "sub_p1"))).status).toBe(500);
    expect(account("sub_p1").status).toBe("active");
    failing = [];
    expect((await hook(invoice("invoice.payment_failed", "sub_p1"))).status).toBe(200);
    expect(account("sub_p1").status).toBe("past_due");
    failing = [{ method: "PATCH", table: "api_accounts" }];
    expect((await hook(invoice("invoice.paid", "sub_p1"))).status).toBe(500);
    expect(account("sub_p1").status).toBe("past_due");
    failing = [];
    expect((await hook(invoice("invoice.paid", "sub_p1"))).status).toBe(200);
    expect(account("sub_p1").status).toBe("active");
  });

  it("a cancellation for a subscription OF OURS that has no record yet is retried (it may have arrived before its checkout)", async () => {
    expect((await hook(deleted("sub_early", "api_triage"))).status).toBe(500);
    await hook(bought("api_triage", "sub_early"));
    expect((await hook(deleted("sub_early", "api_triage"))).status).toBe(200);
    expect(account("sub_early").status).toBe("cancelled");
  });

  it("a subscription that is not ours (no kind of ours) is acknowledged, not retried forever", async () => {
    expect((await hook(deleted("sub_someone_elses"))).status).toBe(200);
    expect((await hook(deleted("sub_someone_elses", "not_a_gridforge_kind"))).status).toBe(200);
    expect((await hook(invoice("invoice.payment_failed", "sub_someone_elses"))).status).toBe(200);
  });
});

describe("out-of-order events do not reopen a cancelled entitlement", () => {
  it("a late payment-failed notice after cancellation leaves the account cancelled and unable to mint", async () => {
    await hook(bought("api_triage", "sub_o1"));
    await hook(deleted("sub_o1", "api_triage"));
    expect((await hook(invoice("invoice.payment_failed", "sub_o1"))).status).toBe(200);
    expect(account("sub_o1").status).toBe("cancelled");
    expect((await keys("POST", { token: account("sub_o1").token })).status).toBe(402);
    expect((await hook(invoice("invoice.paid", "sub_o1"))).status).toBe(200);        // nor does a late paid notice
    expect(account("sub_o1").status).toBe("cancelled");
  });

  it("Hall Watch and Intelligence stay cancelled through late invoice events", async () => {
    await hook(bought("hall_watch", "sub_o2"));
    await hook(bought("intelligence_subscription", "sub_o3", { plan: "team" }));
    await hook(deleted("sub_o2", "hall_watch"));
    await hook(deleted("sub_o3", "intelligence_subscription"));
    for (const sub of ["sub_o2", "sub_o3"]) {
      await hook(invoice("invoice.payment_failed", sub));
      await hook(invoice("invoice.paid", sub));
    }
    expect((db.rows("watches") as any[])[0].status).toBe("cancelled");
    expect((db.rows("subscriptions") as any[])[0].status).toBe("cancelled");
  });
});

describe("one buyer, several subscriptions (REAL SCHEMA CONSTRAINT: api_accounts.account is unique)", () => {
  it("a customer who cancels and re-subscribes, or buys a second plan, gets a second account — the purchase is not lost", async () => {
    expect((await hook(bought("api_triage", "sub_s1"))).status).toBe(200);
    await hook(deleted("sub_s1", "api_triage"));
    // same email, same company, a new subscription ("a cancelled one does not come back by itself — that is a new sale")
    expect((await hook(bought("api_triage", "sub_s2"))).status).toBe(200);
    // and a different plan bought while the first is still live
    expect((await hook(bought("api_scale", "sub_s3"))).status).toBe(200);
    const accts = db.rows("api_accounts") as any[];
    expect(accts.map((a) => a.stripe_subscription_id).sort()).toEqual(["sub_s1", "sub_s2", "sub_s3"]);
    expect(new Set(accts.map((a) => a.account)).size).toBe(3);                 // separate billing identities, separate quotas
    expect(account("sub_s1").status).toBe("cancelled");
    expect(account("sub_s2").status).toBe("active");
    expect(account("sub_s3")).toMatchObject({ status: "active", plan: "api_scale" });
    // redelivery of any of them is still one account each
    for (const s of ["sub_s2", "sub_s3"]) await hook(bought(s === "sub_s2" ? "api_triage" : "api_scale", s));
    expect(db.rows("api_accounts")).toHaveLength(3);
  });
});

describe("replay", () => {
  it.each([["api_triage", "api_accounts"], ["hall_watch", "watches"]])("%s: the same checkout delivered 3× is one entitlement", async (kind, table) => {
    for (let i = 0; i < 3; i++) expect((await hook(bought(kind, `sub_r_${kind}`))).status).toBe(200);
    expect(db.rows(table)).toHaveLength(1);
  });
});
