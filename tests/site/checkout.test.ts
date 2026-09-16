/**
 * app/api/checkout — where a read becomes a purchase.
 *
 * Two things are asserted here and they pull in opposite directions.
 *
 * The price may never come from the caller. It is read from lib/products.ts and
 * the Founding credit is applied server-side against foundingSlotsRemaining().
 *
 * And the qualification id, which is a convenience, must never be able to break a
 * purchase. `deliverables.qualification_id` is a uuid with a foreign key; anything
 * else fails the insert. Since a failed fulfilment now correctly returns 500 so
 * Stripe redelivers, a malformed id from the client would turn a REAL PAYMENT into
 * one that can never be fulfilled and is retried until Stripe gives up. So an id
 * that cannot possibly be valid is dropped and the sale proceeds unattached.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";

const created: Record<string, unknown>[] = [];

vi.mock("stripe", () => {
  return {
    default: class {
      coupons = {
        create: async () => ({ id: "coupon_test" }),
      };
      checkout = {
        sessions: {
          create: async (params: Record<string, unknown>) => {
            created.push(params);
            return { url: "https://checkout.stripe.test/session" };
          },
        },
      };
    },
  };
});

async function route() {
  return await import("@/app/api/checkout/route");
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(siteUrl("/api/checkout"), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const UUID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";

beforeEach(() => {
  process.env.STRIPE_SECRET_KEY = "sk_test_checkout";
  created.length = 0;
});

afterEach(() => {
  delete process.env.STRIPE_SECRET_KEY;
});

describe("the price is ours, never the caller's", () => {
  it("reads the amount from the catalogue", async () => {
    const { POST } = await route();
    const res = await POST(post({ product: "density_screen" }));
    expect(res.status).toBe(200);
    const line = (created[0].line_items as Record<string, any>[])[0];
    expect(line.price_data.unit_amount).toBe(450_000);
  });

  it("ignores an amount supplied by the caller", async () => {
    const { POST } = await route();
    await POST(post({ product: "density_screen", amountCents: 1, unit_amount: 1, price: 1 }));
    const line = (created[0].line_items as Record<string, any>[])[0];
    expect(line.price_data.unit_amount).toBe(450_000);
  });

  it("ignores a product id that is not in the catalogue and falls back to the deposit", async () => {
    const { POST } = await route();
    await POST(post({ product: "free_everything" }));
    const line = (created[0].line_items as Record<string, any>[])[0];
    expect(line.price_data.unit_amount).toBeGreaterThan(0);
    expect(created[0].metadata).toMatchObject({ kind: "engagement_deposit" });
  });

  it("is unavailable rather than broken when Stripe is not configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const { POST } = await route();
    const res = await POST(post({ product: "density_screen" }));
    expect(res.status).toBe(503);
  });
});

describe("the qualification id cannot break a purchase", () => {
  it("carries a real uuid into the session", async () => {
    const { POST } = await route();
    await POST(post({ product: "density_screen", qualificationId: UUID }));
    expect(created[0].metadata).toMatchObject({ qualification_id: UUID });
  });

  it("drops one that could never be stored — THE regression", async () => {
    // Previously this reached Stripe metadata, then the webhook, then an insert
    // against a uuid foreign key, which fails. With the fulfilment fix in place
    // that is a 500 and an endless Stripe retry on a payment already taken.
    const { POST } = await route();
    const res = await POST(post({ product: "density_screen", qualificationId: "'; drop table--" }));
    expect(res.status).toBe(200);
    expect(created[0].metadata).toMatchObject({ qualification_id: "" });
  });

  it.each(["", "   ", "not-a-uuid", "12345", UUID + "extra", "../../etc/passwd", "null"])(
    "drops %j rather than carrying it into a payment",
    async (bad) => {
      const { POST } = await route();
      await POST(post({ product: "density_screen", qualificationId: bad }));
      expect((created[0].metadata as Record<string, string>).qualification_id).toBe("");
    }
  );

  it("ignores a non-string id", async () => {
    const { POST } = await route();
    await POST(post({ product: "density_screen", qualificationId: { toString: "no" } }));
    expect((created[0].metadata as Record<string, string>).qualification_id).toBe("");
  });

  it("accepts an uppercase uuid, because Postgres does", async () => {
    const { POST } = await route();
    await POST(post({ product: "density_screen", qualificationId: UUID.toUpperCase() }));
    expect((created[0].metadata as Record<string, string>).qualification_id).toBe(UUID.toUpperCase());
  });
});

describe("where the customer is sent afterwards", () => {
  it("refuses an origin that is not ours", async () => {
    const { POST } = await route();
    await POST(post({ product: "density_screen" }, { origin: "https://evil.example" }));
    expect(String(created[0].success_url)).not.toContain("evil.example");
    expect(String(created[0].cancel_url)).not.toContain("evil.example");
  });

  it("sends a purchased engagement to the commissioned page", async () => {
    const { POST } = await route();
    await POST(post({ product: "density_screen" }));
    expect(String(created[0].success_url)).toContain("/commissioned");
  });
});
