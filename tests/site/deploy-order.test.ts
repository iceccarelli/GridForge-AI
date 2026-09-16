/**
 * The window between deploying code and applying its migration.
 *
 * The standing order's sequence is merge, then apply migrations. Between those two
 * moments the live site runs code that writes `deliverables.intake_token` against a
 * database where 0012 has not been applied.
 *
 * PostgREST refuses an insert naming an unknown column — 400 PGRST204, it does not
 * ignore it. createDeliverable would return null, openDeliverable would return
 * false, the webhook would return 500, and Stripe would retry until it gave up. So
 * every Density Screen sold in that window is a payment taken and an engagement
 * never opened. That is the primary cash product.
 *
 * The fix is not to change the deploy order. It is to make the order not matter.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgrestFake } from "./postgrest-fake";

let db: PostgrestFake;
let restore: () => void;

async function lib() {
  return await import("@/lib/deliverables");
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  db = new PostgrestFake(["deliverables"]);
  restore = db.install();
});

afterEach(() => restore());

describe("a purchase must survive the deploy window", () => {
  it("opens the engagement even though 0012 is not applied yet — THE regression", async () => {
    db.dropColumn("deliverables", "intake_token");
    const { createDeliverable } = await lib();
    const row = await createDeliverable({ kind: "density_screen", email: "buyer@northhall.example" });
    expect(row).not.toBeNull();
    expect(row?.token).toBeTruthy();
    expect(db.rows("deliverables")).toHaveLength(1);
  });

  it("and the intake link still resolves, on the token that does exist", async () => {
    db.dropColumn("deliverables", "intake_token");
    const { createDeliverable, getByIntakeToken } = await lib();
    const row = await createDeliverable({ kind: "density_screen" });
    const found = await getByIntakeToken(row!.token);
    expect(found?.token).toBe(row!.token);
  });

  it("uses the separate credential once the migration IS applied", async () => {
    const { createDeliverable } = await lib();
    const row = await createDeliverable({ kind: "density_screen" });
    expect(row?.intake_token).toBeTruthy();
    expect(row?.intake_token).not.toBe(row?.token);
  });

  it("still fails loudly when the table itself is missing", async () => {
    // Degrading past a missing COLUMN must not become degrading past anything.
    db.dropTable("deliverables");
    const { createDeliverable } = await lib();
    expect(await createDeliverable({ kind: "density_screen" })).toBeNull();
  });

  it("does not retry forever on an unrelated failure", async () => {
    db.failMethod = { method: "POST", status: 500, body: "boom" };
    const { createDeliverable } = await lib();
    expect(await createDeliverable({ kind: "density_screen" })).toBeNull();
    const inserts = db.calls.filter((c) => c.method === "POST");
    expect(inserts.length).toBeLessThanOrEqual(2);
  });
});
