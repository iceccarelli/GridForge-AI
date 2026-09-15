/**
 * app/api/qualify — the free read, and the id that joins it to a later sale.
 *
 * The shareable read carried its qualification into checkout. The tab the read was
 * produced in did not — so the commonest path of all, qualify and then commission
 * in the same tab, opened an empty intake form and asked the customer to retype
 * the seven numbers they had just entered, after paying.
 *
 * The id is not a credential. The token in `share` is; /q/ already renders the id.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const ENGINE = "http://engine.test";
let db: PostgrestFake;
let restorePg: () => void;
let restoreEngine: () => void;
let engineOk = true;

async function route() {
  return await import("@/app/api/qualify/route");
}

const SEVEN = {
  siteName: "North Hall",
  platform: "gb300_nvl72",
  contractedMW: 12,
  currentPeakMW: 7.4,
  currentItLoadMW: 4.9,
  buswayAmpacityA: 400,
  tapoffMaxA: 63,
  plantSupplyC: 6,
  positionsAvailable: 180,
};

function post(body: unknown) {
  return new Request(siteUrl("/api/qualify"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function installEngine() {
  const pgFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(ENGINE)) return pgFetch(input as RequestInfo, init);
    if (!engineOk) return new Response("{}", { status: 503 });
    return new Response(
      JSON.stringify({
        platform: { id: "gb300_nvl72", name: "NVIDIA GB300 NVL72" },
        as_found: { racks: 0, binding_constraint: "Rack feed / tap-off rating", domain: "lv", basis: "b" },
        after_relief: { racks: 28, architecture: "full_dlc", then_binds_on: null, sets_the_date: "plant" },
        first_three_constraints: [],
        intake: { completeness: 0.5, required_inputs_missing: 8, recommended_engagement: "density_screen" },
        notice: "n",
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;
  return () => { globalThis.fetch = pgFetch; };
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  engineOk = true;
  db = new PostgrestFake(["qualifications"]);
  restorePg = db.install();
  restoreEngine = installEngine();
});

afterEach(() => {
  restoreEngine();
  restorePg();
});

describe("the read can become a sale that remembers it", () => {
  it("returns the qualification id — THE regression", async () => {
    const { POST } = await route();
    const body = await (await POST(post(SEVEN))).json();
    expect(body.ok).toBe(true);
    expect(typeof body.qualificationId).toBe("string");
    expect(body.qualificationId).toBe(db.rows("qualifications")[0].id);
  });

  it("stores the numbers the intake will later be seeded from", async () => {
    const { POST } = await route();
    await POST(post(SEVEN));
    const stored = db.rows("qualifications")[0] as Record<string, any>;
    expect(stored.inputs.contractedMW).toBe(12);
    expect(stored.inputs.tapoffMaxA).toBe(63);
  });

  it("still offers the share link alongside it", async () => {
    const { POST } = await route();
    const body = await (await POST(post(SEVEN))).json();
    expect(String(body.share)).toMatch(/^\/q\/.+/);
  });

  it("offers neither when the row did not land", async () => {
    // A share link to a row that was never written is a 404 sent to somebody's
    // director, and an id that references nothing would fail the foreign key on
    // the deliverable later.
    db.dropTable("qualifications");
    const { POST } = await route();
    const body = await (await POST(post(SEVEN))).json();
    expect(body.share).toBeNull();
    expect(body.qualificationId).toBeNull();
  });

  it("offers neither when Supabase is not configured", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { POST } = await route();
    const body = await (await POST(post(SEVEN))).json();
    expect(body.ok).toBe(true);
    expect(body.share).toBeNull();
    expect(body.qualificationId).toBeNull();
  });
});

describe("the free tier stays free and stays honest", () => {
  it("leaks no priced content", async () => {
    const { POST } = await route();
    const blob = JSON.stringify(await (await POST(post(SEVEN))).json());
    expect(blob).not.toContain("EUR");
    expect(blob).not.toContain("capex");
  });

  it("refuses a malformed body", async () => {
    const { POST } = await route();
    expect((await POST(post("{oops"))).status).toBe(400);
  });

  it("names the field when a number is missing", async () => {
    const { POST } = await route();
    const body: Record<string, unknown> = { ...SEVEN };
    delete body.tapoffMaxA;
    const res = await POST(post(body));
    expect(res.status).toBe(422);
    expect(JSON.stringify(await res.json())).toContain("tapoffMaxA");
  });

  it("refuses a peak above the contracted capacity, and explains why", async () => {
    const { POST } = await route();
    const res = await POST(post({ ...SEVEN, currentPeakMW: 99 }));
    expect(res.status).toBe(422);
    expect(String((await res.json()).error)).toMatch(/exceeds contracted/i);
  });

  it("invents nothing when the engine is unreachable, and still keeps the enquiry", async () => {
    engineOk = false;
    const { POST } = await route();
    const res = await POST(post(SEVEN));
    expect([502, 503]).toContain(res.status);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.result).toBeUndefined();
    expect(db.rows("qualifications")).toHaveLength(1);
    expect(db.rows("qualifications")[0].status).toBe("engine_unavailable");
  });
});
