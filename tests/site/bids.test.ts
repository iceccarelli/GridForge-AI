/**
 * app/api/deliverable/[token]/bids — the third thing the Procurement
 * Specification promises, and the only one that had no surface.
 *
 * The Procurement Specification's catalogue entry has always stated its deliverable
 * as three things: the specification, a machine-readable response schedule, and
 * "a bid comparison against the capacity model showing what each response does to
 * the energisation date". The site delivered the first two. The third had no
 * surface anywhere — the engine has been able to do it since before the product was
 * priced, and nothing called it.
 *
 * A customer paid, received a specification, collected four supplier quotes, and
 * had nowhere to put them.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const ENGINE = "http://engine.test";
let db: PostgrestFake;
let restorePg: () => void;
let restoreEngine: () => void;
let engineCalls: { url: string; body: any }[] = [];
let engineStatus = 200;
let enginePayload: Record<string, unknown> = {};

async function route() {
  return await import("@/app/api/deliverable/[token]/bids/route");
}

function installEngine() {
  const pgFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(ENGINE)) return pgFetch(input as RequestInfo, init);
    engineCalls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(enginePayload), {
      status: engineStatus,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return () => { globalThis.fetch = pgFetch; };
}

const INTAKE = {
  grid: { contracted_MW: 12 },
  lv: { tapoff_max_A: 63 },
  _gridforge: { binding: "Rack feed / tap-off rating", spec: { constraint_id: "rack_feed_tapoff" } },
};

function seed(over: Record<string, unknown> = {}) {
  db.seed("deliverables", [
    {
      token: "doc-tok",
      intake_token: "intake-tok",
      kind: "procurement_spec",
      status: "released",
      intake: INTAKE,
      working_files: { "response_template.json": "{}" },
      ...over,
    },
  ]);
}

function post(body: unknown, token = "doc-tok") {
  return new Request(siteUrl(`/api/deliverable/${token}/bids`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const ctx = (token = "doc-tok") => ({ params: Promise.resolve({ token }) });

const RESPONSES = [
  { supplier: "Alpha", values: { capex_eur: 480000, lead_time_weeks: 20 } },
  { supplier: "Beta", values: { capex_eur: 392000, lead_time_weeks: 44 } },
];

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = "engine-key";
  engineCalls = [];
  engineStatus = 200;
  enginePayload = {
    relief: "Higher-rated tap-off units",
    sized_for_racks: 28,
    ranked: [
      { rank: 1, supplier: "Alpha", capex_eur: 480000, weeks_to_energised: 26, score: 65 },
      { rank: 2, supplier: "Beta", capex_eur: 392000, weeks_to_energised: 50, score: 40 },
    ],
    leading: "Alpha",
    note: "Installation method is scored by the engineer, not by this tool.",
  };
  db = new PostgrestFake(["deliverables"]);
  restorePg = db.install();
  restoreEngine = installEngine();
});

afterEach(() => { restoreEngine(); restorePg(); });

describe("the comparison the product promised", () => {
  it("ranks the responses — THE regression", async () => {
    seed();
    const { POST } = await route();
    const res = await POST(post({ responses: RESPONSES }), ctx());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.ranked).toHaveLength(2);
    expect(body.ranked[0].supplier).toBe("Alpha");
  });

  it("judges them against the relief the SPECIFICATION was written for", async () => {
    // Not against whatever binds the hall today. Four quotes answered one
    // requirement; re-deriving it could compare them against a different one.
    seed();
    const { POST } = await route();
    await POST(post({ responses: RESPONSES }), ctx());
    expect(engineCalls[0].body.constraint).toBe("rack_feed_tapoff");
  });

  it("sends the customer's own numbers and not our bookkeeping", async () => {
    seed();
    const { POST } = await route();
    await POST(post({ responses: RESPONSES }), ctx());
    expect(engineCalls[0].body.intake.grid.contracted_MW).toBe(12);
    expect(engineCalls[0].body.intake).not.toHaveProperty("_gridforge");
  });

  it("keeps the comparison with the engagement, as a downloadable working file", async () => {
    seed();
    const { POST } = await route();
    const body = await (await POST(post({ responses: RESPONSES }), ctx())).json();
    expect(body.saved).toBe(true);
    const files = db.rows("deliverables")[0].working_files as Record<string, string>;
    expect(Object.keys(files)).toContain("bid_comparison.json");
    expect(JSON.parse(files["bid_comparison.json"]).ranked[0].supplier).toBe("Alpha");
    // and it must not have destroyed what was already there
    expect(files["response_template.json"]).toBe("{}");
  });

  it("still returns the comparison when it could not be stored, and says so", async () => {
    seed();
    const { POST } = await route();
    // The read works; the write does not. That is the case worth covering.
    db.failMethod = { method: "PATCH", status: 500, body: "nope" };
    const body = await (await POST(post({ responses: RESPONSES }), ctx())).json();
    expect(body.ok).toBe(true);
    expect(body.ranked).toHaveLength(2);
    expect(body.saved).toBe(false);
  });
});

describe("it cannot be used on the wrong thing", () => {
  it("refuses an engagement that is not a Procurement Specification", async () => {
    seed({ kind: "density_screen" });
    const { POST } = await route();
    const res = await POST(post({ responses: RESPONSES }), ctx());
    expect(res.status).toBe(409);
    expect(engineCalls).toHaveLength(0);
  });

  it("refuses before the specification has been released", async () => {
    // Comparing bids against a specification nobody has signed off is the same
    // mistake as publishing the opinion itself unreviewed.
    seed({ status: "draft" });
    const { POST } = await route();
    expect((await POST(post({ responses: RESPONSES }), ctx())).status).toBe(409);
    expect(engineCalls).toHaveLength(0);
  });

  it("refuses an engagement with no intake yet", async () => {
    seed({ intake: null });
    const { POST } = await route();
    expect((await POST(post({ responses: RESPONSES }), ctx())).status).toBe(409);
  });

  it("refuses an unknown token", async () => {
    seed();
    const { POST } = await route();
    expect((await POST(post({ responses: RESPONSES }, "nope"), ctx("nope"))).status).toBe(404);
  });

  it("refuses the INTAKE token — it does not grant the document's surfaces", async () => {
    seed();
    const { POST } = await route();
    const res = await POST(post({ responses: RESPONSES }, "intake-tok"), ctx("intake-tok"));
    expect(res.status).toBe(404);
  });
});

describe("what it will not accept", () => {
  it("rejects a malformed body", async () => {
    seed();
    const { POST } = await route();
    expect((await POST(post("{oops"), ctx())).status).toBe(400);
  });

  it.each([[{}], [{ responses: [] }], [{ responses: "Alpha" }], [{ responses: {} }]])(
    "rejects %j",
    async (body) => {
      seed();
      const { POST } = await route();
      expect((await POST(post(body), ctx())).status).toBe(422);
      expect(engineCalls).toHaveLength(0);
    }
  );

  it("rejects responses that do not name a supplier", async () => {
    seed();
    const { POST } = await route();
    const res = await POST(post({ responses: [{ values: { capex_eur: 1 } }] }), ctx());
    expect(res.status).toBe(422);
    expect(String((await res.json()).error)).toMatch(/supplier/i);
  });

  it("rejects an absurd number of responses rather than handing them to the engine", async () => {
    seed();
    const { POST } = await route();
    const many = Array.from({ length: 50 }, (_, i) => ({ supplier: `S${i}` }));
    expect((await POST(post({ responses: many }), ctx())).status).toBe(422);
    expect(engineCalls).toHaveLength(0);
  });

  it("passes the engine's own complaint back when it rejects the responses", async () => {
    seed();
    engineStatus = 422;
    enginePayload = { error: "response schedule is missing lead_time_weeks" };
    const { POST } = await route();
    const res = await POST(post({ responses: RESPONSES }), ctx());
    expect(res.status).toBe(422);
    expect(String((await res.json()).error)).toMatch(/lead_time_weeks/);
  });

  it("does not blame the customer for our own engine being down", async () => {
    seed();
    engineStatus = 500;
    enginePayload = { error: "boom" };
    const { POST } = await route();
    expect((await POST(post({ responses: RESPONSES }), ctx())).status).toBe(502);
  });

  it("is unavailable rather than broken when the engine is not connected", async () => {
    delete process.env.GRIDFORGE_API_URL;
    seed();
    const { POST } = await route();
    expect((await POST(post({ responses: RESPONSES }), ctx())).status).toBe(503);
  });
});
