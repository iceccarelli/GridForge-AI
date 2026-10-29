/**
 * The Stripe client a checkout, subscription, webhook delivery, admin health check or post-purchase landing page waits on is bounded
 * (lib/stripe-client.ts): a call with no answer in STRIPE_CALL_TIMEOUT_MS fails as a timeout ("cannot say"), instead of holding the request
 * for the SDK's long default until the platform kills it. The SDK is replaced by a recorder here: no live call is made and nothing proves how
 * the live SDK behaves beyond the options it is given and the error shape it documents.
 *
 * The guard at the end is a source scan: it reads `new Stripe(` in app/ and lib/, so it cannot see a client built another way (a re-export, an
 * alias). It fails when a new unbounded construction appears, which is the mistake that left five routes without a bound.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const made: { key: string; opts: Record<string, unknown> }[] = [];
vi.mock("stripe", async (orig) => {
  const real = await orig<typeof import("stripe")>();
  class Recorder {
    static errors = real.default.errors;
    opts: Record<string, unknown>;
    constructor(key: string, opts: Record<string, unknown>) {
      this.opts = opts;
      made.push({ key, opts });
    }
    checkout = {
      sessions: {
        create: () => new Promise(() => {}), // never answers
        retrieve: async (id: string) => ({ id }), // not a session fixture: the answer is only passed through
      },
    };
    webhooks = { constructEvent: () => ({ id: "evt_sync", type: "test.event" }) };
  }
  return { ...real, default: Recorder };
});

beforeEach(() => {
  made.length = 0;
  process.env.STRIPE_CALL_TIMEOUT_MS = "40";
});
afterEach(() => {
  delete process.env.STRIPE_CALL_TIMEOUT_MS;
});

describe("boundedStripeClient", () => {
  it("gives the SDK a timeout one second outside the race and never lets it retry by itself", async () => {
    const { boundedStripeClient } = await import("@/lib/stripe-client");
    boundedStripeClient("sk_test_placeholder");
    expect(made.at(-1)!.key).toBe("sk_test_placeholder");
    expect(made.at(-1)!.opts).toMatchObject({ timeout: 1_040, maxNetworkRetries: 0 });
    process.env.STRIPE_CALL_TIMEOUT_MS = "3000";
    boundedStripeClient("sk_test_placeholder");
    expect(made.at(-1)!.opts).toMatchObject({ timeout: 4_000, maxNetworkRetries: 0 });
  });

  it("a call that never answers fails within the bound, as a timeout and not as an outcome", async () => {
    const { boundedStripeClient } = await import("@/lib/stripe-client");
    const { isStripeTimeout, STRIPE_TIMEOUT_CODE } = await import("@/lib/stripe-timeout");
    const stripe = boundedStripeClient("sk_test_placeholder");
    const started = Date.now();
    const err = await stripe.checkout.sessions.create({} as never).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeNull();
    expect((err as { code?: string }).code).toBe(STRIPE_TIMEOUT_CODE);
    expect(isStripeTimeout(err)).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("a call that answers in time is returned unchanged, and a synchronous method is not turned into a promise", async () => {
    const { boundedStripeClient } = await import("@/lib/stripe-client");
    const stripe = boundedStripeClient("sk_test_placeholder");
    await expect(stripe.checkout.sessions.retrieve("cs_test_1")).resolves.toMatchObject({ id: "cs_test_1" });
    const event = stripe.webhooks.constructEvent("payload", "sig", "whsec");
    expect(event).toEqual({ id: "evt_sync", type: "test.event" });
    expect(typeof (event as unknown as { then?: unknown }).then).toBe("undefined");
  });
});

describe("no route or library builds an unbounded Stripe client", () => {
  /** Files that may call `new Stripe(`: the two bounded builders, and payment-standing, which sets its own 8 s SDK timeout and one retry. */
  const ALLOWED = new Set(["lib/stripe-client.ts", "lib/payg-stripe.ts", "lib/payment-standing.ts"]);

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...sources(full));
      else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  it("every `new Stripe(` in app/ and lib/ is in an allowed file", () => {
    const root = process.cwd();
    const offenders: string[] = [];
    for (const dir of ["app", "lib"]) {
      for (const file of sources(path.join(root, dir))) {
        const rel = path.relative(root, file).split(path.sep).join("/");
        if (ALLOWED.has(rel)) continue;
        fs.readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (/\bnew Stripe\(/.test(line) && !line.trim().startsWith("//")) offenders.push(`${rel}:${i + 1}`);
          });
      }
    }
    expect(offenders, "build the client with boundedStripeClient() (lib/stripe-client.ts)").toEqual([]);
  });
});
