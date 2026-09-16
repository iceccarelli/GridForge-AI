/**
 * app/api/insights — the published distribution of what actually binds.
 *
 * This route is the growth loop and the moat in one: anyone can rebuild the
 * constraint physics, nobody else is accumulating a record of what stops real
 * halls. Which means the two ways it can destroy value are not downtime.
 *
 *   1. It publishes something that points at a customer. One identifiable hall
 *      and the record stops being something people are willing to feed.
 *   2. It publishes a figure whose stated basis does not match its arithmetic.
 *      This practice sells numbers that carry their evidence; a published median
 *      drawn from a population the basis statement does not describe is the one
 *      claim that costs more than it earns.
 *
 * Both were live: the MIN_HALLS gate counted halls that produced a result, while
 * the medians and the metro list were computed over every row — so an enquiry the
 * engine could not answer still had its metro published, in a distribution its
 * owner was never part of.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PostgrestFake } from "./postgrest-fake";

let db: PostgrestFake;
let restore: () => void;

async function route() {
  return await import("@/app/api/insights/route");
}

/** A hall that made it through the engine. */
function scored(over: Record<string, unknown> = {}) {
  return {
    binding_constraint: "Rack feed / tap-off rating",
    racks_as_found: 0,
    metro: "Dublin",
    inputs: { contractedMW: 12, currentPeakMW: 7.4, tapoffMaxA: 63, buswayAmpacityA: 400, plantSupplyC: 6 },
    ...over,
  };
}

/** An enquiry the engine never answered. It still stored what was typed in. */
function unscored(over: Record<string, unknown> = {}) {
  return {
    binding_constraint: null,
    racks_as_found: null,
    metro: "Reykjavik",
    company: "Distinctive Operator Ltd",
    email: "someone@distinctive.example",
    site_name: "The One Hall In That Town",
    inputs: { contractedMW: 400, currentPeakMW: 1, tapoffMaxA: 1600, buswayAmpacityA: 6300, plantSupplyC: 45 },
    ...over,
  };
}

function seed(rows: Record<string, unknown>[]) {
  db.seed("qualifications", rows.map((r, i) => ({ created_at: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`, ...r })));
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  db = new PostgrestFake(["qualifications"]);
  restore = db.install();
});

afterEach(() => restore());

describe("the small-sample floor", () => {
  it("publishes nothing below the threshold, and says why", async () => {
    seed(Array.from({ length: 7 }, () => scored()));
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.published).toBe(false);
    expect(body.constraints).toBeUndefined();
    expect(body.medians).toBeUndefined();
    expect(body.metros).toBeUndefined();
  });

  it("publishes nothing when the store cannot be read", async () => {
    db.dropTable("qualifications");
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.published).toBe(false);
  });

  it("does not let unanswered enquiries push it over the threshold", async () => {
    // Seven halls were solved. Ten enquiries failed. That is seven halls.
    seed([...Array.from({ length: 7 }, () => scored()), ...Array.from({ length: 10 }, () => unscored())]);
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.published).toBe(false);
    expect(body.halls).toBe(7);
  });

  it("publishes once enough halls have actually been solved", async () => {
    seed(Array.from({ length: 8 }, () => scored()));
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.published).toBe(true);
    expect(body.halls).toBe(8);
  });
});

describe("nothing identifying leaves this route", () => {
  it("never publishes a company, an email, a site name or a token", async () => {
    seed([
      ...Array.from({ length: 8 }, () =>
        scored({ company: "Acme", email: "ops@acme.example", site_name: "North Hall", token: "secret-token" })
      ),
    ]);
    const { GET } = await route();
    const blob = JSON.stringify(await (await GET()).json());
    for (const secret of ["Acme", "ops@acme.example", "North Hall", "secret-token"]) {
      expect(blob).not.toContain(secret);
    }
  });

  it("does not publish the metro of a hall it never answered — THE regression", async () => {
    // Eight halls scored, so the gate opens. A ninth enquiry failed. Its metro
    // used to be published anyway: a distinctive location, attached to somebody
    // who got nothing and was never part of the distribution.
    seed([...Array.from({ length: 8 }, () => scored()), unscored()]);
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.published).toBe(true);
    expect(body.metros).toContain("Dublin");
    expect(body.metros).not.toContain("Reykjavik");
  });
});

describe("the published basis must match the arithmetic", () => {
  it("draws the medians from the halls the basis statement describes", async () => {
    // Eight identical solved halls: every median is theirs. Eight unanswered
    // enquiries carry extreme values at every input — enough of them to drag a
    // median over all rows well away from the solved halls' own, so this fails
    // loudly if the population ever silently widens again.
    seed([
      ...Array.from({ length: 8 }, () => scored()),
      ...Array.from({ length: 8 }, () => unscored()),
    ]);
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.medians.tapoff_A).toBe(63);
    expect(body.medians.busway_A).toBe(400);
    expect(body.medians.plant_supply_C).toBe(6);
    // (12 - 7.4) / 12 = 38.33% -> 38
    expect(body.medians.contracted_headroom_pct).toBe(38);
  });

  it("counts shares against the solved halls, so they still sum to one", async () => {
    seed([
      ...Array.from({ length: 6 }, () => scored()),
      ...Array.from({ length: 2 }, () => scored({ binding_constraint: "Busway ampacity" })),
      unscored(),
    ]);
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.halls).toBe(8);
    const total = body.constraints.reduce((a: number, c: { share: number }) => a + c.share, 0);
    expect(Math.abs(total - 1)).toBeLessThan(0.005);
    expect(body.constraints[0].halls).toBe(6);
  });

  it("still states its basis and its self-selection", async () => {
    seed(Array.from({ length: 8 }, () => scored()));
    const { GET } = await route();
    const body = await (await GET()).json();
    expect(body.basis).toMatch(/self-selected/i);
    expect(body.basis).toMatch(/assumptions/i);
  });
});
