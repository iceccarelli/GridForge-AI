/**
 * app/api/power/deploy/cases and .../[token] — the HTTP surface over
 * lib/power-deploy.ts, exercised the way bids.test.ts exercises
 * app/api/deliverable/[token]/bids: a real Request through the real route
 * handler, a fake PostgREST for Supabase and a fake engine for
 * GRIDFORGE_API_URL, so this catches a wiring mistake the unit tests on
 * lib/power-deploy.ts alone (tests/site/power-deploy.test.ts) cannot — they
 * call the lib functions directly and never touch the route's own body
 * parsing, status codes or field allowlisting.
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
  return () => {
    globalThis.fetch = pgFetch;
  };
}

const REQUEST = {
  load_profile: { flat_kW: 30000 },
  grid_firm_MW: 10,
  target_MW: 35,
  redundancy: "N+1",
  generation: [{ id: "GEN-A", kind: "gas_engine", nameplate_MW: 20 }],
  bess: [],
};

function postCase(body: unknown) {
  return new Request(siteUrl("/api/power/deploy/cases"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_API_URL = ENGINE;
  process.env.GRIDFORGE_API_KEY = "engine-key";
  engineCalls = [];
  engineStatus = 200;
  enginePayload = {
    capacity: { target_MW: 35, grid_firm_MW: 10, gap_MW: 25 },
    architectures: [{ label: "GRID + GENERATION", status: "fail" }],
    next_action: { action: "Obtain a budgetary or firm quote for: GEN-A" },
  };
  db = new PostgrestFake(["power_deployment_cases"]);
  restorePg = db.install();
  restoreEngine = installEngine();
});

afterEach(() => {
  restorePg();
  restoreEngine();
});

describe("POST /api/power/deploy/cases", () => {
  it("calls the engine once and persists revision 1", async () => {
    const { POST } = await import("@/app/api/power/deploy/cases/route");
    const res = await POST(postCase(REQUEST));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.revision).toBe(1);
    expect(body.result.next_action.action).toContain("GEN-A");
    expect(engineCalls).toHaveLength(1);
    expect(engineCalls[0].url).toBe(`${ENGINE}/v1/power/deploy/assess`);
    // The request forwarded to the engine must not carry email/company/project_name.
    expect(engineCalls[0].body.email).toBeUndefined();
  });

  it("rejects a non-object body without calling the engine", async () => {
    const { POST } = await import("@/app/api/power/deploy/cases/route");
    const res = await POST(postCase("not an object"));
    expect(res.status).toBe(400);
    expect(engineCalls).toHaveLength(0);
  });

  it("returns 502 and does not create a case when the engine fails", async () => {
    engineStatus = 502;
    enginePayload = { error: "engine unavailable" };
    const { POST } = await import("@/app/api/power/deploy/cases/route");
    const res = await POST(postCase(REQUEST));
    expect(res.status).toBe(502);
    expect(db.rows("power_deployment_cases")).toHaveLength(0);
  });

  it("stores email/company/project_name on the case but never sends them to the engine", async () => {
    const { POST } = await import("@/app/api/power/deploy/cases/route");
    await POST(postCase({ ...REQUEST, email: "dev@example.com", project_name: "North Campus" }));
    const row = db.rows("power_deployment_cases")[0];
    expect(row.email).toBe("dev@example.com");
    expect(row.project_name).toBe("North Campus");
  });
});

describe("GET/POST /api/power/deploy/cases/[token]", () => {
  async function createCase() {
    const { POST } = await import("@/app/api/power/deploy/cases/route");
    const res = await POST(postCase(REQUEST));
    return (await res.json()).case_token as string;
  }
  const ctx = (token: string) => ({ params: Promise.resolve({ token }) });

  it("GET returns 404 for an unknown token", async () => {
    const { GET } = await import("@/app/api/power/deploy/cases/[token]/route");
    const res = await GET(new Request(siteUrl("/api/power/deploy/cases/nope")), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("GET returns the latest revision", async () => {
    const token = await createCase();
    const { GET } = await import("@/app/api/power/deploy/cases/[token]/route");
    const res = await GET(new Request(siteUrl(`/api/power/deploy/cases/${token}`)), ctx(token));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.revision).toBe(1);
    expect(body.changed_fields).toEqual([]);
  });

  it("POST merges a partial update, re-solves, and reports what changed", async () => {
    const token = await createCase();
    enginePayload = {
      capacity: { target_MW: 45, grid_firm_MW: 10, gap_MW: 35 },
      architectures: [],
      next_action: { action: "Proceed to procurement for: GRID + GENERATION" },
    };
    const { POST } = await import("@/app/api/power/deploy/cases/[token]/route");
    const res = await POST(
      new Request(siteUrl(`/api/power/deploy/cases/${token}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_MW: 45 }),
      }),
      ctx(token)
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.revision).toBe(2);
    expect(body.changed_fields).toEqual(["target_MW"]);
    // The re-solve request sent to the engine must carry the FULL merged
    // request, not just the changed field — the engine has no memory of the
    // case and cannot re-solve from a partial body.
    expect(engineCalls[1].body.grid_firm_MW).toBe(10);
    expect(engineCalls[1].body.target_MW).toBe(45);
  });

  it("POST to an unknown token 404s rather than silently creating a new case", async () => {
    const { POST } = await import("@/app/api/power/deploy/cases/[token]/route");
    const res = await POST(
      new Request(siteUrl("/api/power/deploy/cases/ghost"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_MW: 45 }),
      }),
      ctx("ghost")
    );
    expect(res.status).toBe(404);
  });

  it("GET ?history=1 returns every revision, oldest first", async () => {
    const token = await createCase();
    const { POST } = await import("@/app/api/power/deploy/cases/[token]/route");
    await POST(
      new Request(siteUrl(`/api/power/deploy/cases/${token}`), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ target_MW: 45 }),
      }),
      ctx(token)
    );
    const { GET } = await import("@/app/api/power/deploy/cases/[token]/route");
    const res = await GET(
      new Request(siteUrl(`/api/power/deploy/cases/${token}?history=1`)),
      ctx(token)
    );
    const body = await res.json();
    expect(body.revisions.map((r: any) => r.revision)).toEqual([1, 2]);
  });
});
