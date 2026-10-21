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
import { PostgrestFake } from "./postgrest-fake";

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

  it("rejects an explicit product id that is not in the catalogue", async () => {
    const { POST } = await route();
    const res = await POST(post({ product: "free_everything" }));
    expect(res.status).toBe(400);
    expect(created).toHaveLength(0);
  });

  it.each(["productId", "sku", "product_id", "priceId", "price_id"])(
    "rejects legacy selector %s instead of silently charging the reservation deposit",
    async (selector) => {
      const { POST } = await route();
      const res = await POST(post({ [selector]: "density_screen" }));
      expect(res.status).toBe(400);
      expect(created).toHaveLength(0);
    }
  );

  it("is unavailable rather than broken when Stripe is not configured", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const { POST } = await route();
    const res = await POST(post({ product: "density_screen" }));
    expect(res.status).toBe(503);
  });
});

describe("the qualification id cannot break a purchase, and cannot be borrowed (F7)", () => {
  const TOKEN = "q-token-of-the-read-0123456789";
  const OTHER = "q-token-of-somebody-else-9876";
  const OTHER_ID = "9b2f0c1e-4f89-41d3-9a0c-0305e82c0002";
  let db: PostgrestFake;
  let restorePg: () => void;

  function seed(createdAt: string) {
    db.seed("qualifications", [
      { id: UUID, token: TOKEN, created_at: createdAt, inputs: { siteName: "North Hall", contractedMW: 12 } },
      { id: OTHER_ID, token: OTHER, created_at: new Date().toISOString(), inputs: { siteName: "Someone Else's Hall" } },
    ]);
  }
  const meta = () => (created[0].metadata as Record<string, string>).qualification_id;

  beforeEach(() => {
    process.env.SUPABASE_URL = "https://stub.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
    db = new PostgrestFake(["qualifications"]);
    restorePg = db.install();
    seed(new Date(Date.now() - 60_000).toISOString());
  });
  afterEach(() => {
    restorePg();
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  });

  it("carries the id of a read the caller presents the q-token of", async () => {
    const { POST } = await route();
    await POST(post({ product: "density_screen", qualificationId: UUID, qualificationToken: TOKEN }));
    expect(created[0].metadata).toMatchObject({ qualification_id: UUID });
  });

  it("derives the id from the token when only the token is sent", async () => {
    const { POST } = await route();
    await POST(post({ product: "density_screen", qualificationToken: TOKEN }));
    expect(meta()).toBe(UUID);
  });

  it("accepts an uppercase uuid for the same read, and carries the stored (lowercase) one", async () => {
    const { POST } = await route();
    await POST(post({ product: "density_screen", qualificationId: UUID.toUpperCase(), qualificationToken: TOKEN }));
    expect(meta()).toBe(UUID);
  });

  it("drops an id that exists but is named WITHOUT its token -- another buyer's read cannot be borrowed", async () => {
    const { POST } = await route();
    const res = await POST(post({ product: "density_screen", qualificationId: OTHER_ID }));
    expect(res.status).toBe(200);                                  // the sale is not broken ...
    expect(meta()).toBe("");                                       // ... it simply arrives unattached
  });

  it("drops an id paired with somebody ELSE's token, and a token paired with another read's id", async () => {
    const { POST } = await route();
    await POST(post({ product: "density_screen", qualificationId: UUID, qualificationToken: OTHER }));
    expect(meta()).toBe("");
    created.length = 0;
    await POST(post({ product: "density_screen", qualificationId: OTHER_ID, qualificationToken: TOKEN }));
    expect(meta()).toBe("");
  });

  it("drops a token that matches nothing, and an id that does not exist", async () => {
    const { POST } = await route();
    await POST(post({ product: "density_screen", qualificationId: UUID, qualificationToken: "guess" }));
    expect(meta()).toBe("");
    created.length = 0;
    await POST(post({ product: "density_screen", qualificationId: "3f2504e0-4f89-41d3-9a0c-0305e82c9999", qualificationToken: TOKEN }));
    expect(meta()).toBe("");
  });

  it("drops a read older than 24 hours even with its token", async () => {
    restorePg();
    db = new PostgrestFake(["qualifications"]);
    restorePg = db.install();
    seed(new Date(Date.now() - 25 * 3600_000).toISOString());
    const { POST } = await route();
    await POST(post({ product: "density_screen", qualificationId: UUID, qualificationToken: TOKEN }));
    expect(meta()).toBe("");
  });

  it("still accepts one that is 23 hours old", async () => {
    restorePg();
    db = new PostgrestFake(["qualifications"]);
    restorePg = db.install();
    seed(new Date(Date.now() - 23 * 3600_000).toISOString());
    const { POST } = await route();
    await POST(post({ product: "density_screen", qualificationId: UUID, qualificationToken: TOKEN }));
    expect(meta()).toBe(UUID);
  });

  it("drops one that could never be stored -- THE original regression", async () => {
    // A malformed id would reach Stripe metadata, then the webhook, then an insert against a uuid foreign key, which fails.
    // With fulfilment returning 500 for a failed insert that is an endless Stripe retry on a payment already taken.
    const { POST } = await route();
    const res = await POST(post({ product: "density_screen", qualificationId: "'; drop table--", qualificationToken: TOKEN }));
    expect(res.status).toBe(200);
    expect(created[0].metadata).toMatchObject({ qualification_id: "" });
  });

  it.each(["", "   ", "not-a-uuid", "12345", UUID + "extra", "../../etc/passwd", "null"])(
    "drops %j rather than carrying it into a payment",
    async (bad) => {
      const { POST } = await route();
      await POST(post({ product: "density_screen", qualificationId: bad, qualificationToken: TOKEN }));
      expect(meta()).toBe(bad.trim() === "" ? UUID : "");          // an empty id with a valid token is just the token
    }
  );

  it("ignores a non-string id and a non-string token", async () => {
    const { POST } = await route();
    await POST(post({ product: "density_screen", qualificationId: { toString: "no" }, qualificationToken: TOKEN }));
    expect(meta()).toBe(UUID);                                     // the object is ignored; the token alone names the read
    created.length = 0;
    await POST(post({ product: "density_screen", qualificationId: UUID, qualificationToken: { a: 1 } }));
    expect(meta()).toBe("");
  });

  it("proceeds unattached when the store is unreachable", async () => {
    restorePg();
    delete process.env.SUPABASE_URL;
    const { POST } = await route();
    const res = await POST(post({ product: "density_screen", qualificationId: UUID, qualificationToken: TOKEN }));
    expect(res.status).toBe(200);
    expect(meta()).toBe("");
    restorePg = db.install();
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
