/**
 * Hall Watch: seeding the hall from an earlier engagement, ONLY through the project link that holds both.
 *
 * The cross-tenant negatives are the point. The watch carries the Stripe checkout email; the deliverable carries a session id
 * and an email typed at checkout. Neither is proof of ownership, so neither is used to find the other.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engagementIntakeSchema, toIntakeDocument } from "@/lib/engagement-intake";
import { intakeDocToForm, seedForWatch } from "@/lib/project-watch-seed";
import { PostgrestFake } from "./postgrest-fake";

let db: PostgrestFake;
let restore: () => void;

const FORM_FULL = {
  siteName: "North Hall", hallId: "H1", metro: "Dublin", country: "IE", buildYear: "2016", floorType: "slab",
  dso: "SECRET-DSO-A", firmCapacityMVA: "15", contractedMW: "12", currentPeakMW: "7.4", currentItLoadMW: "4.9",
  powerFactor: "0.95", queueNote: "SECRET-QUEUE-NOTE-A", buswayAmpacityA: "400", buswayRuns: "4", tapoffMaxA: "63",
  voltageV: "415", floorLoadingKPa: "12", positionsAvailable: "180", rackPositions: "200", netWhiteSpaceM2: "900",
  clearHeightM: "4.2", aislePitchM: "3.6", designDensityKWPerRack: "40", plantCapacityKW: "6000", plantSupplyC: "6",
  plantReturnC: "12", pumpFlowLPerMin: "9000", existingFlowLPerMin: "3000", existingNonItHeatKW: "400",
  residualAirKWPerRack: "20", designDrybulbC: "28", platform: "gb200_nvl72", utilisation: "0.8",
  transformers: [{ id: "TX-1", unit_rating_MVA: 2.5, units: 4, redundancy: "N+1" }],
  ups: [{ id: "UPS-1", unit_rating_kW: 800, units: 3, redundancy: "2N" }],
};

const docOf = (form: Record<string, unknown>, company = "Acme") => toIntakeDocument(engagementIntakeSchema.parse(form), company);
const formB = { ...FORM_FULL, siteName: "South Hall", hallId: "B9", dso: "SECRET-DSO-B", queueNote: "SECRET-QUEUE-NOTE-B" };

describe("intakeDocToForm is the inverse of toIntakeDocument", () => {
  it("round-trips a full intake exactly", () => {
    const doc = docOf(FORM_FULL);
    const back = intakeDocToForm(doc);
    expect(docOf({ ...back.fields, transformers: back.transformers.map((r) => ({ id: r.id, unit_rating_MVA: r.rating, units: r.units, redundancy: r.redundancy })), ups: back.ups.map((r) => ({ id: r.id, unit_rating_kW: r.rating, units: r.units, redundancy: r.redundancy })) })).toEqual(doc);
  });

  it("round-trips a thin intake without inventing the fields it left blank", () => {
    const thin = { siteName: "S", hallId: "H", contractedMW: 1, currentPeakMW: 1, currentItLoadMW: 1, buswayAmpacityA: 400, tapoffMaxA: 63, positionsAvailable: 10, plantSupplyC: 6, firmCapacityMVA: 5, floorLoadingKPa: 10, plantCapacityKW: 100 };
    const { fields } = intakeDocToForm(docOf(thin));
    expect(fields).not.toHaveProperty("dso");
    expect(fields).not.toHaveProperty("rackPositions");
    expect(fields.siteName).toBe("S");
  });

  it("reads known keys only: our own block and unknown keys never reach the form", () => {
    const doc = { ...docOf(FORM_FULL), _gridforge: { review: { by: "SECRET-REVIEWER" }, spec_request: { constraint_id: "x" } }, evil: "SECRET-X" };
    expect(JSON.stringify(intakeDocToForm(doc))).not.toMatch(/SECRET-REVIEWER|SECRET-X|spec_request/);
  });

  it("tolerates garbage", () => {
    for (const v of [null, undefined, 3, "x", [], { site: 3, hall: [], thermal: { plant: null } }]) {
      expect(() => intakeDocToForm(v)).not.toThrow();
    }
  });
});

// ------------------------------------------------------------------ the links

const P_A = "00000000-0000-4000-8000-0000000000a1";
const P_B = "00000000-0000-4000-8000-0000000000b1";
const W_A = "00000000-0000-4000-8000-0000000000a2";
const W_B = "00000000-0000-4000-8000-0000000000b2";
const D_A = "00000000-0000-4000-8000-0000000000a3";
const D_B = "00000000-0000-4000-8000-0000000000b3";

function world(extra: { deliverables?: Record<string, unknown>[]; links?: Record<string, unknown>[]; watches?: Record<string, unknown>[] } = {}) {
  db.seed("watches", [
    { id: W_A, token: "watch-token-a", status: "active", cadence: "quarterly", email: "same@buyer.example", company: "A", intake: null, last_state: null },
    { id: W_B, token: "watch-token-b", status: "active", cadence: "quarterly", email: "same@buyer.example", company: "B", intake: null, last_state: null },
    ...(extra.watches ?? []),
  ]);
  db.seed("deliverables", [
    { id: D_A, token: "doc-a", kind: "density_screen", status: "released", email: "same@buyer.example", created_at: "2026-10-01T00:00:00Z", intake: { ...docOf(FORM_FULL), _gridforge: { x: 1 } } },
    { id: D_B, token: "doc-b", kind: "density_screen", status: "released", email: "same@buyer.example", created_at: "2026-10-02T00:00:00Z", intake: docOf(formB, "B") },
    ...(extra.deliverables ?? []),
  ]);
  db.seed("project_links", [
    { id: "l1", project_id: P_A, object_type: "watch", object_id: W_A },
    { id: "l2", project_id: P_A, object_type: "deliverable", object_id: D_A },
    { id: "l3", project_id: P_B, object_type: "watch", object_id: W_B },
    { id: "l4", project_id: P_B, object_type: "deliverable", object_id: D_B },
    ...(extra.links ?? []),
  ]);
}

const watch = (id: string, over: Record<string, unknown> = {}) => ({ id, status: "active" as const, intake: null, ...over });

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  db = new PostgrestFake(["watches", "deliverables", "project_links", "watch_notes"]);
  restore = db.install();
});
afterEach(() => restore());

describe("seedForWatch: only through the project that holds both", () => {
  it("offers the linked engagement's numbers", async () => {
    world();
    const seed = await seedForWatch(watch(W_A));
    expect(seed?.source).toEqual({ kind: "density_screen", product: expect.stringMatching(/Density Screen/i) });
    expect(seed?.fields.siteName).toBe("North Hall");
    expect(seed?.fields.firmCapacityMVA).toBe("15");
    expect(seed?.transformers).toEqual([{ id: "TX-1", rating: 2.5, units: 4, redundancy: "N+1" }]);
  });

  it("CROSS-TENANT: watch A never receives B's intake, and B never A's, even with the same checkout email", async () => {
    world();
    const a = JSON.stringify(await seedForWatch(watch(W_A)));
    const b = JSON.stringify(await seedForWatch(watch(W_B)));
    expect(a).toContain("SECRET-DSO-A");
    expect(a).not.toMatch(/SECRET-DSO-B|SECRET-QUEUE-NOTE-B|South Hall|B9/);
    expect(b).toContain("SECRET-DSO-B");
    expect(b).not.toMatch(/SECRET-DSO-A|SECRET-QUEUE-NOTE-A|North Hall/);
  });

  it("an unlinked watch gets nothing even when a deliverable carries the very same email", async () => {
    world({ watches: [{ id: "00000000-0000-4000-8000-0000000000c2", token: "watch-token-c", status: "active", cadence: "quarterly", email: "same@buyer.example", intake: null }] });
    expect(await seedForWatch(watch("00000000-0000-4000-8000-0000000000c2"))).toBeNull();
    // and no deliverable was ever queried by email
    expect(db.calls.map((c) => c.url).join("\n")).not.toMatch(/email=/);
  });

  it("a watch linked to two projects is ambiguous and gets nothing", async () => {
    world({ links: [{ id: "l9", project_id: P_B, object_type: "watch", object_id: W_A }] });
    expect(await seedForWatch(watch(W_A))).toBeNull(); // ambiguous: two projects
  });

  it("a deliverable in ANOTHER project is not reachable from this watch even if it shares a company", async () => {
    world();
    db.tables.set("project_links", (db.tables.get("project_links") ?? []).filter((l) => l.id !== "l2"));
    expect(await seedForWatch(watch(W_A))).toBeNull();
  });

  it("only a watch with no numbers yet, and only while active", async () => {
    world();
    expect(await seedForWatch(watch(W_A, { intake: { site: {} } }))).toBeNull();
    for (const status of ["paused", "cancelled"] as const) expect(await seedForWatch(watch(W_A, { status }))).toBeNull();
    expect(await seedForWatch(watch("local"))).toBeNull();
  });

  it("never offers a refunded or disputed purchase, an unsubmitted intake, or an engagement of another product", async () => {
    world();
    for (const over of [{ billing_hold: "refunded" }, { billing_hold: "disputed" }, { status: "awaiting_intake" }, { intake: null }, { kind: "api_triage" }]) {
      db.tables.set("deliverables", (db.tables.get("deliverables") ?? []).map((d) => (d.id === D_A ? { ...d, ...over } : d)));
      expect(await seedForWatch(watch(W_A)), JSON.stringify(over)).toBeNull();
    }
  });

  it("takes the newest eligible engagement of its project", async () => {
    world({
      deliverables: [{ id: "00000000-0000-4000-8000-0000000000a4", token: "doc-a2", kind: "procurement_spec", status: "draft", created_at: "2026-10-20T00:00:00Z", intake: docOf({ ...FORM_FULL, siteName: "North Hall v2" }) }],
      links: [{ id: "l5", project_id: P_A, object_type: "deliverable", object_id: "00000000-0000-4000-8000-0000000000a4" }],
    });
    expect((await seedForWatch(watch(W_A)))?.fields.siteName).toBe("North Hall v2");
  });

  it("an unreadable store gives no seed rather than an error", async () => {
    world();
    db.failNext = { status: 500, body: "boom" };
    expect(await seedForWatch(watch(W_A))).toBeNull();
  });
});

describe("the watch page hands the form only its own seed", () => {
  type El = { type?: unknown; props?: { children?: unknown; seed?: unknown; token?: string } };
  function findIntake(node: unknown): El | null {
    if (!node || typeof node !== "object") return null;
    const el = node as El;
    if (Array.isArray(node)) {
      for (const n of node) {
        const f = findIntake(n);
        if (f) return f;
      }
      return null;
    }
    if (typeof el.type === "function" && (el.type as { name?: string }).name === "EngagementIntake") return el;
    return findIntake(el.props?.children);
  }
  async function seedPropFor(token: string) {
    const { default: Page } = await import("@/app/watch/[token]/page");
    const tree = await Page({ params: Promise.resolve({ token }) });
    return findIntake(tree)?.props?.seed ?? null;
  }

  it("token A's page carries A's seed only; token B's carries B's", async () => {
    world();
    const a = JSON.stringify(await seedPropFor("watch-token-a"));
    const b = JSON.stringify(await seedPropFor("watch-token-b"));
    expect(a).toContain("North Hall");
    expect(a).not.toMatch(/South Hall|SECRET-DSO-B/);
    expect(b).toContain("South Hall");
    expect(b).not.toMatch(/North Hall|SECRET-DSO-A/);
  });

  it("an unknown token is not found and reads nothing of anyone's", async () => {
    world();
    const { default: Page } = await import("@/app/watch/[token]/page");
    const tree = JSON.stringify(await Page({ params: Promise.resolve({ token: "nope" }) }), (_k, v) => (typeof v === "function" ? "fn" : v));
    expect(tree).not.toMatch(/North Hall|South Hall|SECRET/);
  });

  it("a watch with numbers already is offered no seed (a re-solve is never silently overwritten)", async () => {
    world();
    db.tables.set("watches", (db.tables.get("watches") ?? []).map((w) => (w.id === W_A ? { ...w, intake: { site: { name: "X" } } } : w)));
    expect(await seedPropFor("watch-token-a")).toBeNull();
  });
});
