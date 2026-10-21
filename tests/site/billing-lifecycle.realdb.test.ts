/**
 * The constraints behind the billing-lifecycle review fixes, against REAL PostgreSQL through REAL PostgREST (scripts/realdb-up.sh, with
 * migration 0039 applied): the once-only operator ledger (a UNIQUE key and ON CONFLICT DO NOTHING through `resolution=ignore-duplicates`),
 * the conditional PATCH the cancellation compare-and-sets on (`key_id=eq.` matching no row when a mint landed), the sweep's
 * `ORDER BY last_revocation_attempt_at ASC NULLS FIRST`, and the new clock columns on watches and subscriptions driven through the real
 * webhook route. The only stand-ins are Stripe (MockStripe), Resend and the engine's /v1/revoke + /v1/version (mockEngine): no live
 * provider is contacted.
 *
 * Skipped unless GF_PGRST_URL and GF_PGRST_JWT are set -- a skip is a gap in what was checked; GF_REQUIRE_REALDB=1 turns it into a failure.
 */
import http from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";
import { siteUrl } from "@/lib/site";
import { cancelApiAccount, retryRevocations, type ApiAccount } from "@/lib/api-access";
import { rest } from "@/lib/pgrest";
import { setPaygStripeForTests } from "@/lib/payg-stripe";
import { notifyOperatorOnce } from "@/lib/payg-operator";
import { MockStripe, mockEngine, type MockEngine } from "./payg-harness";

const PGRST = process.env.GF_PGRST_URL ?? "";
const JWT = process.env.GF_PGRST_JWT ?? "";
const enabled = !!PGRST && !!JWT;
const required = process.env.GF_REQUIRE_REALDB === "1";
const WH = "whsec_review_realdb";
const sdk = new Stripe("sk_test_placeholder");

describe("real-database prerequisites (billing lifecycle)", () => {
  it.runIf(required)("are present when the real database is required", () => {
    expect(PGRST).not.toBe("");
    expect(JWT).not.toBe("");
  });
  it.runIf(required && enabled)("migration 0039 is applied", async () => {
    for (const q of ["watches?select=last_billing_event_ts&limit=1", "subscriptions?select=last_billing_event_ts&limit=1", "api_accounts?select=last_revocation_attempt_at&limit=1", "operator_notices?select=dedupe_key&limit=1"]) {
      const r = await fetch(`${PGRST}/${q}`, { headers: { Authorization: `Bearer ${JWT}` } });
      expect(r.status, q).toBe(200);
    }
  });
});

const realFetch = globalThis.fetch;
let gateway: http.Server | null = null;
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
afterAll(() => { gateway?.close(); });

const uid = () => Math.random().toString(36).slice(2, 10);
let engine: MockEngine;
let mail: { to: string; subject: string; text: string }[];

describe.skipIf(!enabled)("billing lifecycle fixes — real PostgreSQL via PostgREST", () => {
  beforeEach(async () => {
    process.env.SUPABASE_URL = gateway ? `http://127.0.0.1:${(gateway.address() as { port: number }).port}` : await startGateway();
    process.env.SUPABASE_SERVICE_ROLE_KEY = JWT;
    Object.assign(process.env, { GRIDFORGE_KEY_SECRET: "test-signing-secret", RESEND_API_KEY: "re_test", LEAD_TO_EMAIL: "ops@example.test", LEAD_FROM_EMAIL: "Time to Power <power@timetopower.ai>", STRIPE_SECRET_KEY: "sk_test_placeholder", STRIPE_WEBHOOK_SECRET: WH, RATE_LIMIT_HMAC_KEY: "r".repeat(40) });
    for (const m of ["error", "log", "warn"] as const) vi.spyOn(console, m).mockImplementation(() => {});
    mail = [];
    engine = mockEngine(mail);
    setPaygStripeForTests(new MockStripe());
  });
  afterEach(() => { setPaygStripeForTests(null); engine.restore(); vi.restoreAllMocks(); });

  async function newAccount(over: Record<string, unknown> = {}): Promise<ApiAccount> {
    const account = `bl-${uid()}`;
    const r = await rest<ApiAccount[]>("POST", "api_accounts", {
      token: `tok-${uid()}${uid()}${uid()}`, account, email: `${account}@example.test`, plan: "api_scale", monthly_units: 2500, status: "active", ...over,
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    return (r as { data: ApiAccount[] }).data[0];
  }
  const fresh = async (token: string) => ((await rest<ApiAccount[]>("GET", `api_accounts?token=eq.${token}`)) as { data: ApiAccount[] }).data[0];

  it("operator_notices: the UNIQUE key makes a notice once-only, five concurrent senders mail ONCE, and a mail that did not go out gives the claim back", async () => {
    const key = `bl:${uid()}:${uid()}`;
    const results = await Promise.all(Array.from({ length: 5 }, () => notifyOperatorOnce(key, "Billing notice", "body without customer data")));
    expect(results.filter((r) => r === "sent")).toHaveLength(1);
    expect(results.filter((r) => r === "duplicate")).toHaveLength(4);
    expect(mail.filter((m) => m.subject === "Billing notice")).toHaveLength(1);
    expect(await notifyOperatorOnce(key, "Billing notice", "again")).toBe("duplicate");
    // the provider refuses: nothing is sent, the claim is released, and the next try mails
    const key2 = `bl:${uid()}:${uid()}`;
    const inner = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => (String(i).startsWith("https://api.resend.com") ? new Response("{}", { status: 503 }) : inner(i as RequestInfo, init))) as typeof fetch;
    expect(await notifyOperatorOnce(key2, "Billing notice 2", "x")).toBe("unsent");
    globalThis.fetch = inner;
    expect(await notifyOperatorOnce(key2, "Billing notice 2", "x")).toBe("sent");
    // the table holds digests only, never the key the caller built from Stripe ids
    const rows = ((await rest<{ dedupe_key: string }[]>("GET", "operator_notices?select=dedupe_key&limit=500")) as { data: { dedupe_key: string }[] }).data;
    expect(rows.some((r) => r.dedupe_key.includes("bl:"))).toBe(false);
  });

  it("cancellation compare-and-set: a mint that lands after the read makes the conditional PATCH match nothing, and the retry revokes the NEW id too", async () => {
    const a = await newAccount({ key_id: "rd-old-key", key_scope: "machine", key_issued_at: "2026-10-01", key_expires_at: "2026-11-05" });
    const inner = globalThis.fetch;
    let raced = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!raced && init?.method === "PATCH" && String(input).includes("/rest/v1/api_accounts") && String(init.body).includes('"cancelled"')) {
        raced++;
        // the customer's mint lands now, through the real database: previous id recorded, a new id live
        await rest("PATCH", `api_accounts?token=eq.${a.token}`, { key_id: "rd-new-key", revoked_key_ids: ["rd-old-key"] });
      }
      return inner(input as RequestInfo, init);
    }) as typeof fetch;
    const out = await cancelApiAccount(a.token);
    globalThis.fetch = inner;
    expect(raced).toBe(1);
    expect(out.ok).toBe(true);
    const row = await fresh(a.token);
    expect(row.status).toBe("cancelled");
    expect(row.revoked_key_ids).toEqual(expect.arrayContaining(["rd-old-key", "rd-new-key"]));
    expect(row.revocation_pending).toBe(true); // nothing confirmed yet: the sweep and the webhook push them
  });

  it("the sweep reads the least recently attempted accounts first, never-attempted ahead of all (real ORDER BY ... NULLS FIRST), and stamps what it examined", async () => {
    const mk = (n: string, at: string | null) => newAccount({ status: "cancelled", key_id: `live-${n}`, revoked_key_ids: [`ord-${n}`], last_revocation_attempt_at: at });
    const [never, recent, old] = [await mk(`n${uid()}`, null), await mk(`r${uid()}`, "2026-03-01T00:00:00Z"), await mk(`o${uid()}`, "2025-01-01T00:00:00Z")];
    const idOf = (a: ApiAccount) => (a.revoked_key_ids as string[])[0];
    const r = await retryRevocations(200, new Date("2026-10-21T03:23:00Z"));
    expect(r.confirmed).toBeGreaterThanOrEqual(3);
    const mine = engine.revokeCalls.filter((id) => [never, recent, old].map(idOf).includes(id));
    expect(mine).toEqual([idOf(never), idOf(old), idOf(recent)]);
    for (const a of [never, recent, old]) expect((await fresh(a.token)).last_revocation_attempt_at).toMatch(/^2026-10-21T03:23:00/);
  });

  it("the sweep's read is the same query the application issues: a held-back (engine-unverifiable) active row does not block a cancelled one behind it", async () => {
    const held = await newAccount({ status: "active", key_id: `h-${uid()}`, key_scope: "machine", revoked_key_ids: [`held-${uid()}`], last_revocation_attempt_at: "2024-01-01T00:00:00Z" });
    const cut = await newAccount({ status: "cancelled", key_id: `c-${uid()}`, revoked_key_ids: [`cut-${uid()}`], last_revocation_attempt_at: "2024-06-01T00:00:00Z" });
    engine.down = true; // verification cannot pass: active rows are held back, cancelled rows are pushed regardless
    await retryRevocations(200, new Date());
    expect(engine.revokeCalls).toContain((cut.revoked_key_ids as string[])[0]);
    expect(engine.revokeCalls).not.toContain((held.revoked_key_ids as string[])[0]);
    expect((await fresh(held.token)).revocation_pending).toBe(true);
  });

  const send = async (type: string, object: Record<string, unknown>, created: number) => {
    const payload = JSON.stringify({ id: `evt_${uid()}`, type, created, data: { object } });
    const { POST } = await import("@/app/api/stripe/webhook/route");
    return POST(new Request(siteUrl("/api/stripe/webhook"), { method: "POST", headers: { "stripe-signature": sdk.webhooks.generateTestHeaderString({ payload, secret: WH }) }, body: payload }));
  };

  it("watches: a payment_failed older than the paid that cleared it leaves the watch active, through the webhook against the real bigint clock column", async () => {
    const sub = `sub_w_${uid()}`;
    const token = `w${uid()}${uid()}${uid()}${uid()}`;
    const ins = await rest<{ id: string }[]>("POST", "watches", { token, status: "active", cadence: "quarterly", email: `${uid()}@example.test`, stripe_subscription_id: sub });
    expect(ins.ok).toBe(true);
    const now = Math.floor(Date.now() / 1000);
    expect((await send("invoice.paid", { id: `in_${uid()}`, subscription: sub }, now)).status).toBe(200);
    expect((await send("invoice.payment_failed", { id: `in_${uid()}`, subscription: sub }, now - 3600)).status).toBe(200);
    const row = ((await rest<any[]>("GET", `watches?token=eq.${token}`)) as { data: any[] }).data[0];
    expect(row).toMatchObject({ status: "active", last_billing_event_ts: now });
    // a failure that is genuinely newer pauses it; a payment older than THAT failure, delivered late, does not reinstate it
    await send("invoice.payment_failed", { id: `in_${uid()}`, subscription: sub }, now + 100);
    await send("invoice.paid", { id: `in_${uid()}`, subscription: sub }, now + 50);
    const after = ((await rest<any[]>("GET", `watches?token=eq.${token}`)) as { data: any[] }).data[0];
    expect(after).toMatchObject({ status: "paused", last_billing_event_ts: now + 100 });
  });

  it("subscriptions (Intelligence): the same ordering through the real column", async () => {
    const sub = `sub_s_${uid()}`;
    const email = `${uid()}@example.test`;
    const ins = await rest<{ id: string }[]>("POST", "subscriptions", { email, plan: "team", status: "active", stripe_session_id: `cs_${uid()}`, stripe_subscription_id: sub });
    expect(ins.ok, JSON.stringify(ins)).toBe(true);
    const now = Math.floor(Date.now() / 1000);
    await send("invoice.paid", { id: `in_${uid()}`, subscription: sub }, now);
    await send("invoice.payment_failed", { id: `in_${uid()}`, subscription: sub }, now - 3600);
    const row = ((await rest<any[]>("GET", `subscriptions?stripe_subscription_id=eq.${sub}`)) as { data: any[] }).data[0];
    expect(row).toMatchObject({ status: "active", last_billing_event_ts: now });
  });
});
