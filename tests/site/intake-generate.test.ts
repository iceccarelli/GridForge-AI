/**
 * app/api/intake/[token] — the client's numbers become the document they bought.
 *
 * The defect this exists for is a conversion one, and it was running on every
 * Density Screen ever sold.
 *
 * `bindingFrom()` read the binding constraint out of `scenarios.csv` in the
 * working-file bundle. A Density Screen does not produce one: its catalogue entry
 * promises the document, the ladder and the data request and no working files,
 * and `/v1/screen` has no csv format at all — correctly, because none was sold.
 *
 * So `_gridforge.binding` was never set for a Screen, and the follow-on offer
 * named a generic constraint instead of the customer's own. The Density Screen is
 * the EUR 4,500 entry product whose entire commercial purpose is to credit against
 * the Envelope Study, which makes that the most valuable upsell in the business —
 * and the figure was one field away in the payload the engine already returns.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const ENGINE = "http://engine.test";
const BINDING = "Rack feed / tap-off rating";

let db: PostgrestFake;
let restorePg: () => void;
let engineCalls: { url: string; format: string | null; body: string }[] = [];

async function route() {
  return await import("@/app/api/intake/[token]/route");
}

/** A complete intake, so validation is never what a test is measuring. */
const INTAKE = {
  siteName: "North Hall",
  hallId: "H1",
  metro: "Dublin",
  firmCapacityMVA: 15,
  contractedMW: 12,
  currentPeakMW: 7.4,
  currentItLoadMW: 4.9,
  buswayAmpacityA: 400,
  tapoffMaxA: 63,
  floorLoadingKPa: 12,
  positionsAvailable: 180,
  plantCapacityKW: 6000,
  plantSupplyC: 6,
  platform: "gb300_nvl72",
};

function post(token: string, body: unknown = INTAKE) {
  return new Request(siteUrl(`/api/intake/${token}`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Stand in for the capacity engine, in front of the PostgREST fake.
 *
 * `screen` answers exactly as the real one does: html and md render, the default
 * JSON body carries the binding constraint, and a csv request is NOT special-cased
 * — it falls through to the JSON payload, which is what made the old code read an
 * empty bundle and give up.
 */
function installEngine(opts: { csvBundle?: Record<string, string> } = {}) {
  const pgFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(ENGINE)) return pgFetch(input as RequestInfo, init);
    const raw = String(init?.body ?? "{}");
    const body = JSON.parse(raw);
    const format = body.format ?? null;
    engineCalls.push({ url, format, body: raw });

    if (format === "html" || format === "md") {
      return new Response(
        JSON.stringify({ format, title: "Density Screen — North Hall, hall H1", document: `<p>${BINDING}</p>` }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (format === "csv") {
      // The real /v1/screen ignores csv and returns the JSON payload. Only a
      // caller that explicitly bundles files gets one.
      if (opts.csvBundle) {
        return new Response(JSON.stringify({ format: "csv", files: opts.csvBundle }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
    }
    return new Response(
      JSON.stringify({
        project: {},
        recommended: "full_dlc",
        scenarios: [
          { id: "retained_air", as_found: { racks: 0, binding_name: BINDING } },
          { id: "full_dlc", as_found: { racks: 0, binding_name: "Chilled-water plant capacity" } },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  return () => {
    globalThis.fetch = pgFetch;
  };
}

let restoreEngine: () => void;

function seedEngagement(kind = "density_screen", over: Record<string, unknown> = {}) {
  db.seed("deliverables", [
    { token: "engagement-token", kind, status: "awaiting_intake", company: "North Hall",
      stripe_session_id: "cs_1", ...over },
  ]);
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = "engine-key";
  engineCalls = [];
  db = new PostgrestFake(["deliverables"]);
  restorePg = db.install();
  restoreEngine = installEngine();
});

afterEach(() => {
  restoreEngine();
  restorePg();
});

describe("the follow-on offer names the customer's own constraint", () => {
  it("captures the binding constraint for a Density Screen — THE regression", async () => {
    seedEngagement("density_screen");
    const { POST } = await route();
    const res = await POST(post("engagement-token"), { params: Promise.resolve({ token: "engagement-token" }) });
    expect(res.status).toBe(200);

    const row = db.rows("deliverables")[0] as Record<string, any>;
    expect(row.status).toBe("draft");
    expect(row.intake?._gridforge?.binding).toBe(BINDING);
  });

  it("still reads it from the working files when a bundle is produced", async () => {
    // The Study path, which always had one. The structured field is preferred,
    // but losing the fallback would quietly change what a Study reports.
    restoreEngine();
    restoreEngine = installEngine({
      csvBundle: { "scenarios.csv": "name,binds_first\nRetained air,Busway ampacity\n" },
    });
    seedEngagement("density_screen");
    const { POST } = await route();
    await POST(post("engagement-token"), { params: Promise.resolve({ token: "engagement-token" }) });
    const row = db.rows("deliverables")[0] as Record<string, any>;
    // The engine's own field wins; the bundle is the fallback, not the source.
    expect(row.intake?._gridforge?.binding).toBe(BINDING);
    expect(row.working_files?.["scenarios.csv"]).toContain("binds_first");
  });

  it("leaves the client's own intake exactly as they entered it", async () => {
    seedEngagement("density_screen");
    const { POST } = await route();
    await POST(post("engagement-token"), { params: Promise.resolve({ token: "engagement-token" }) });
    const row = db.rows("deliverables")[0] as Record<string, any>;
    expect(row.intake.grid.contracted_MW).toBe(12);
    expect(row.intake.lv.tapoff_max_A).toBe(63);
  });
});

describe("a thin intake — the product the engine recommends for exactly this case", () => {
  /**
   * The free qualifier answers on seven numbers. A customer who ran it, saw a real
   * binding constraint and paid EUR 4,500 was then asked for three more the free
   * tier had never needed: the firm connection capacity, the floor loading and the
   * plant capacity — a DSO agreement, a structural record and a mechanical
   * schedule. The buyer most likely to convert was the one most likely to be
   * blocked, after paying.
   *
   * Asked directly with those three removed, the engine returns the same binding
   * constraint, the same basis and the same rack counts, and moves from five named
   * gaps to eight. The gaps are the deliverable.
   */
  const THIN = { ...INTAKE };
  delete (THIN as Record<string, unknown>).firmCapacityMVA;
  delete (THIN as Record<string, unknown>).floorLoadingKPa;
  delete (THIN as Record<string, unknown>).plantCapacityKW;

  it("a Density Screen accepts it — THE regression", async () => {
    seedEngagement("density_screen");
    const { POST } = await route();
    const res = await POST(post("engagement-token", THIN), {
      params: Promise.resolve({ token: "engagement-token" }),
    });
    expect(res.status).toBe(200);
    expect(db.rows("deliverables")[0].status).toBe("draft");
  });

  it("and still names what binds the hall", async () => {
    seedEngagement("density_screen");
    const { POST } = await route();
    await POST(post("engagement-token", THIN), { params: Promise.resolve({ token: "engagement-token" }) });
    const row = db.rows("deliverables")[0] as Record<string, any>;
    expect(row.intake?._gridforge?.binding).toBe(BINDING);
  });

  it("tells the customer what was assumed, and where to get it", async () => {
    seedEngagement("density_screen");
    const { POST } = await route();
    const body = await (
      await POST(post("engagement-token", THIN), { params: Promise.resolve({ token: "engagement-token" }) })
    ).json();
    const fields = (body.assumed ?? []).map((a: { field: string }) => a.field).sort();
    expect(fields).toEqual(["firmCapacityMVA", "floorLoadingKPa", "plantCapacityKW"]);
    for (const a of body.assumed) expect(String(a.source).length).toBeGreaterThan(8);
  });

  it("sends the blanks to the engine as GAPS rather than as zeroes", async () => {
    // A zero is a measurement. An absent key is a gap the engine fills from the
    // library and names as an assumption. Sending 0 would assert that this hall
    // has no firm connection and no chilled water.
    seedEngagement("density_screen");
    const { POST } = await route();
    await POST(post("engagement-token", THIN), { params: Promise.resolve({ token: "engagement-token" }) });
    const sent = JSON.parse(String(engineCalls.at(-1)?.body ?? "{}")).intake ?? {};
    expect(sent.grid).not.toHaveProperty("firm_capacity_MVA");
    expect(sent.hall).not.toHaveProperty("floor_loading_kPa");
    expect(sent.thermal?.plant ?? {}).not.toHaveProperty("chilled_water_capacity_kW");
    // The numbers they DID give must still be there, untouched.
    expect(sent.grid.contracted_MW).toBe(12);
    expect(sent.lv.tapoff_max_A).toBe(63);
  });

  it("reports nothing assumed when the customer filled everything in", async () => {
    seedEngagement("density_screen");
    const { POST } = await route();
    const body = await (
      await POST(post("engagement-token"), { params: Promise.resolve({ token: "engagement-token" }) })
    ).json();
    expect(body.assumed).toEqual([]);
  });

  it("still refuses an intake thinner than the FREE qualifier answers on", async () => {
    // The floor is the free tier's own bar. Below it a screen has no
    // site-specific content to sell, and selling one would be worse than the
    // friction this change removed.
    seedEngagement("density_screen");
    const { POST } = await route();
    for (const missing of ["contractedMW", "tapoffMaxA", "buswayAmpacityA", "plantSupplyC", "positionsAvailable"]) {
      const body: Record<string, unknown> = { ...THIN };
      delete body[missing];
      const res = await POST(post("engagement-token", body), {
        params: Promise.resolve({ token: "engagement-token" }),
      });
      expect(res.status, `omitting ${missing} should be refused`).toBe(422);
    }
  });

  it("still requires the hall's identity", async () => {
    seedEngagement("density_screen");
    const { POST } = await route();
    const body: Record<string, unknown> = { ...THIN };
    delete body.hallId;
    const res = await POST(post("engagement-token", body), {
      params: Promise.resolve({ token: "engagement-token" }),
    });
    expect(res.status).toBe(422);
  });
});

describe("the EUR 18,000 Procurement Specification did NOT get relaxed", () => {
  /**
   * A specification states duties a supplier quotes against and a purchase order
   * is raised from. Sizing plant from an assumed plant capacity is not a gap in a
   * report — it is a number on an order. It keeps asking for all of them.
   */
  const THIN = { ...INTAKE };
  delete (THIN as Record<string, unknown>).firmCapacityMVA;
  delete (THIN as Record<string, unknown>).floorLoadingKPa;
  delete (THIN as Record<string, unknown>).plantCapacityKW;

  it("refuses a thin intake", async () => {
    seedEngagement("procurement_spec");
    const { POST } = await route();
    const res = await POST(post("engagement-token", THIN), {
      params: Promise.resolve({ token: "engagement-token" }),
    });
    expect(res.status).toBe(422);
    expect(engineCalls).toHaveLength(0);
  });

  it("accepts a complete one", async () => {
    seedEngagement("procurement_spec");
    const { POST } = await route();
    const res = await POST(post("engagement-token"), {
      params: Promise.resolve({ token: "engagement-token" }),
    });
    expect(res.status).toBe(200);
  });

  it("an unknown product kind asks for everything, rather than the least", async () => {
    // A product added to the catalogue without a decision must fail toward the
    // strict shape: the cost is a form field, not a wrong number in a document.
    seedEngagement("some_future_product");
    const { POST } = await route();
    const res = await POST(post("engagement-token", THIN), {
      params: Promise.resolve({ token: "engagement-token" }),
    });
    expect(res.status).not.toBe(200);
  });
});

describe("generation", () => {
  it("leaves the document as a DRAFT — release is a human act", async () => {
    seedEngagement();
    const { POST } = await route();
    const body = await (
      await POST(post("engagement-token"), { params: Promise.resolve({ token: "engagement-token" }) })
    ).json();
    expect(body.status).toBe("draft");
    const row = db.rows("deliverables")[0] as Record<string, any>;
    expect(row.status).toBe("draft");
    expect(row.document_html).toBeTruthy();
    expect(row.document_md).toBeTruthy();
  });

  it("records the engine being unreachable rather than inventing a document", async () => {
    restoreEngine();
    const pgFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith(ENGINE)) throw new Error("connection refused");
      return pgFetch(input as RequestInfo, init);
    }) as typeof fetch;
    restoreEngine = () => { globalThis.fetch = pgFetch; };

    seedEngagement();
    const { POST } = await route();
    const res = await POST(post("engagement-token"), { params: Promise.resolve({ token: "engagement-token" }) });
    expect(res.status).toBe(502);
    const row = db.rows("deliverables")[0] as Record<string, any>;
    expect(row.status).toBe("engine_unavailable");
    expect(row.document_html).toBeFalsy();
  });

  it("refuses an unknown token", async () => {
    seedEngagement();
    const { POST } = await route();
    const res = await POST(post("not-a-token"), { params: Promise.resolve({ token: "not-a-token" }) });
    expect(res.status).toBe(404);
  });

  it("refuses to regenerate something already delivered", async () => {
    seedEngagement("density_screen", { status: "released" });
    const { POST } = await route();
    const res = await POST(post("engagement-token"), { params: Promise.resolve({ token: "engagement-token" }) });
    expect(res.status).toBe(409);
  });

  it("rejects a malformed body before touching the engine", async () => {
    seedEngagement();
    const { POST } = await route();
    const req = new Request(siteUrl("/api/intake/engagement-token"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    const res = await POST(req, { params: Promise.resolve({ token: "engagement-token" }) });
    expect(res.status).toBe(400);
    expect(engineCalls).toHaveLength(0);
  });

  it("rejects an incomplete intake without charging the engine for it", async () => {
    seedEngagement();
    const { POST } = await route();
    const res = await POST(post("engagement-token", { siteName: "North Hall" }), {
      params: Promise.resolve({ token: "engagement-token" }),
    });
    expect(res.status).toBe(422);
    expect(engineCalls).toHaveLength(0);
  });
});
