/**
 * The real Stripe client billing builds (lib/payg-stripe.ts) and how a timeout is recognised. The SDK is replaced by a recorder here: no
 * live call is made and nothing proves how the live SDK behaves beyond the options it is given and the error shapes it documents.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const made: { key: string; opts: Record<string, unknown> }[] = [];
vi.mock("stripe", async (orig) => {
  const real = await orig<typeof import("stripe")>();
  class Recorder {
    static errors = real.default.errors;
    constructor(key: string, opts: Record<string, unknown>) { made.push({ key, opts }); }
    invoices = { retrieve: async () => ({ id: "in_1" }) };
  }
  return { ...real, default: Recorder };
});

beforeEach(() => { made.length = 0; process.env.STRIPE_SECRET_KEY = "sk_test_placeholder"; });
afterEach(() => { delete process.env.STRIPE_CALL_TIMEOUT_MS; });

describe("paygStripe() builds a client whose SDK limits sit OUTSIDE the race", () => {
  it("the SDK timeout is the bound plus a second and the SDK never retries by itself", async () => {
    const { paygStripe, setPaygStripeForTests } = await import("@/lib/payg-stripe");
    setPaygStripeForTests(null);
    expect(paygStripe()).not.toBeNull();
    expect(made.at(-1)!.opts).toMatchObject({ timeout: 9_000, maxNetworkRetries: 0 });
    process.env.STRIPE_CALL_TIMEOUT_MS = "3000";
    paygStripe();
    expect(made.at(-1)!.opts).toMatchObject({ timeout: 4_000, maxNetworkRetries: 0 });
  });
});

describe("isStripeTimeout recognises a timeout from either side", () => {
  it("our bound, and the SDK's own request timeout (a StripeConnectionError that says so), but not a refusal or an answer", async () => {
    const { isStripeTimeout } = await import("@/lib/stripe-timeout");
    const Stripe = (await import("stripe")).default as unknown as { errors: Record<string, new (raw: Record<string, unknown>) => Error> };
    const sdkTimeout = new Stripe.errors.StripeConnectionError({ message: "Request aborted due to timeout being reached (9000ms)", detail: Object.assign(new Error("x"), { code: "ETIMEDOUT" }) });
    expect(isStripeTimeout(sdkTimeout)).toBe(true);
    expect(isStripeTimeout(Object.assign(new Error("x"), { type: "StripeConnectionError", detail: { code: "ETIMEDOUT" } }))).toBe(true);
    expect(isStripeTimeout(Object.assign(new Error("x"), { type: "StripeConnectionError", code: "stripe_call_timeout" }))).toBe(true);
    // not timeouts: the connection was refused / reset, Stripe answered with an error, a card was declined, a plain bug
    expect(isStripeTimeout(new Stripe.errors.StripeConnectionError({ message: "An error occurred with our connection to Stripe. Request was retried 1 times.", detail: Object.assign(new Error("x"), { code: "ECONNRESET" }) }))).toBe(false);
    expect(isStripeTimeout(Object.assign(new Error("simulated Stripe outage"), { type: "StripeConnectionError", statusCode: 503 }))).toBe(false);
    expect(isStripeTimeout(Object.assign(new Error("declined"), { type: "StripeCardError", code: "card_declined" }))).toBe(false);
    expect(isStripeTimeout(new Error("timed out waiting for the database"))).toBe(false);
    expect(isStripeTimeout(null)).toBe(false);
  });

  it("an SDK timeout counts as a timeout in the settlement report (breaker and mail apply), not as an ordinary failure", async () => {
    const { MockStripe, newPaygDb, paygAccount, ledgerEvent, ledgerFetcherOver, resetSeq } = await import("./payg-harness");
    Object.assign(process.env, { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", GRIDFORGE_KEY_SECRET: "test-signing-secret" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    resetSeq();
    const db = newPaygDb();
    const restore = db.install();
    try {
      paygAccount(db);
      const { ingestLedger } = await import("@/lib/payg-usage");
      await ingestLedger(ledgerFetcherOver([ledgerEvent({ units: 10 })]));
      const stripe = new MockStripe();
      stripe.invoices.list = async () => {
        throw Object.assign(new Error("Request aborted due to timeout being reached (9000ms)"), { type: "StripeConnectionError", detail: { code: "ETIMEDOUT" } });
      };
      const { settleClosedMonths } = await import("@/lib/payg-settle");
      const r = await settleClosedMonths(stripe, new Date("2026-10-21T03:23:00Z"));
      expect(r).toMatchObject({ timedOut: 1, invoiced: 0 });
      expect((db.rows("usage_settlements") as { status: string }[])[0].status).toBe("pending");
    } finally {
      restore();
      vi.restoreAllMocks();
    }
  });
});
