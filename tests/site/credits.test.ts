/**
 * creditsToward — what a customer has already paid that credits against a quote.
 *
 * Two customer-facing surfaces promise the Density Screen "credits in full against
 * the full study", and lib/products.ts has always declared `creditsAgainst`.
 * Nothing read it, so honouring the credit depended on whoever raised the invoice
 * remembering a purchase that could be months old. Forgetting it breaks a written
 * promise; remembering it twice gives the money away twice.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgrestFake } from "./postgrest-fake";

let db: PostgrestFake;
let restore: () => void;

async function lib() {
  return await import("@/lib/deliverables");
}

const BUYER = "director@northhall.example";

function paidScreen(over: Record<string, unknown> = {}) {
  return {
    email: BUYER,
    kind: "density_screen",
    token: "tok-screen",
    amount_cents: 450_000,
    status: "released",
    ...over,
  };
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  db = new PostgrestFake(["deliverables"]);
  restore = db.install();
});

afterEach(() => restore());

describe("what credits against what", () => {
  it("finds a paid Density Screen against the Envelope Study — THE regression", async () => {
    db.seed("deliverables", [paidScreen()]);
    const { creditsToward } = await lib();
    const c = await creditsToward(BUYER, "envelope_study");
    expect(c.cents).toBe(450_000);
    expect(c.from).toHaveLength(1);
    expect(c.from[0].kind).toBe("density_screen");
  });

  it("credits nothing against an engagement it does not credit against", async () => {
    // The Screen credits against the Study. It does not credit against a
    // Portfolio Screen, and inventing that would give money away.
    db.seed("deliverables", [paidScreen()]);
    const { creditsToward } = await lib();
    expect((await creditsToward(BUYER, "portfolio_screen")).cents).toBe(0);
    expect((await creditsToward(BUYER, "density_screen")).cents).toBe(0);
  });

  it("sums more than one qualifying purchase", async () => {
    db.seed("deliverables", [paidScreen(), paidScreen({ token: "tok-screen-2" })]);
    const { creditsToward } = await lib();
    expect((await creditsToward(BUYER, "envelope_study")).cents).toBe(900_000);
  });

  it("never credits another customer's purchase", async () => {
    db.seed("deliverables", [paidScreen({ email: "someone.else@rival.example" })]);
    const { creditsToward } = await lib();
    expect((await creditsToward(BUYER, "envelope_study")).cents).toBe(0);
  });

  it("matches the email regardless of case", async () => {
    db.seed("deliverables", [paidScreen()]);
    const { creditsToward } = await lib();
    expect((await creditsToward(BUYER.toUpperCase(), "envelope_study")).cents).toBe(450_000);
  });

  it("falls back to the catalogue price when the row recorded no amount", async () => {
    db.seed("deliverables", [paidScreen({ amount_cents: null })]);
    const { creditsToward } = await lib();
    expect((await creditsToward(BUYER, "envelope_study")).cents).toBe(450_000);
  });

  it("reports no credit rather than guessing one when the store cannot be read", async () => {
    // Reporting none is recoverable by a human reading the pipeline. Inventing one
    // is money given away on our own arithmetic.
    db.dropTable("deliverables");
    const { creditsToward } = await lib();
    expect((await creditsToward(BUYER, "envelope_study")).cents).toBe(0);
  });

  it("returns nothing for an empty email or engagement", async () => {
    db.seed("deliverables", [paidScreen()]);
    const { creditsToward } = await lib();
    expect((await creditsToward("", "envelope_study")).cents).toBe(0);
    expect((await creditsToward(BUYER, "")).cents).toBe(0);
  });

  it("does not touch the store at all when there is nothing that could credit", async () => {
    db.seed("deliverables", [paidScreen()]);
    const { creditsToward } = await lib();
    const before = db.calls.length;
    await creditsToward(BUYER, "density_screen");
    expect(db.calls.length).toBe(before);
  });
});
