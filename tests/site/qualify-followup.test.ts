/**
 * app/api/qualify/[token]/follow-up — the read asking for a human, once.
 *
 * The share link left a qualified prospect with exactly one next step: buy the
 * Density Screen cold. This route is the missing rung — "come and talk to me" —
 * and the whole point is that it fires once per qualification, sends nothing
 * automated afterwards, and never touches a qualification it was not addressed
 * to by token.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

let db: PostgrestFake;
let restorePg: () => void;
let resendCalls: { url: string; body: any }[] = [];

async function route() {
  return await import("@/app/api/qualify/[token]/follow-up/route");
}

function post(token: string, body: unknown) {
  return new Request(siteUrl(`/api/qualify/${token}/follow-up`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function ctx(token: string) {
  return { params: Promise.resolve({ token }) };
}

function seedScored(overrides: Record<string, unknown> = {}) {
  db.seed("qualifications", [
    {
      token: "tok_north_hall",
      site_name: "North Hall",
      hall_id: "H1",
      metro: "Dublin",
      country: "IE",
      platform: "gb300_nvl72",
      inputs: { contractedMW: 12 },
      racks_as_found: 14,
      racks_after_relief: 28,
      binding_constraint: "Rack feed / tap-off rating",
      intake_completeness: 0.5,
      company: "Acme Colo",
      email: null,
      status: "scored",
      follow_up_requested_at: null,
      ...overrides,
    },
  ]);
  return db.rows("qualifications")[0] as Record<string, any>;
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.RESEND_API_KEY = "test_key";
  process.env.LEAD_TO_EMAIL = "sales@timetopower.ai";
  resendCalls = [];
  db = new PostgrestFake(["qualifications"]);
  const restoreFake = db.install();
  const pgFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith("https://api.resend.com")) {
      resendCalls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
    }
    return pgFetch(input as RequestInfo, init);
  }) as typeof fetch;
  restorePg = () => {
    restoreFake();
  };
});

afterEach(() => {
  restorePg();
});

describe("a qualified read can ask for a human", () => {
  it("records the request and sends exactly one acknowledgment and one desk notice", async () => {
    seedScored();
    const { POST } = await route();
    const res = await POST(post("tok_north_hall", { email: "buyer@acme.example" }), ctx("tok_north_hall"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.alreadyRequested).toBe(false);

    const row = db.rows("qualifications")[0] as Record<string, any>;
    expect(row.follow_up_requested_at).toBeTruthy();
    expect(row.follow_up_email).toBe("buyer@acme.example");

    expect(resendCalls).toHaveLength(2);
  });

  it("grounds the acknowledgment in stored data only — nothing fabricated", async () => {
    seedScored();
    const { POST } = await route();
    await POST(post("tok_north_hall", { email: "buyer@acme.example" }), ctx("tok_north_hall"));
    const toBuyer = resendCalls.find((c) => c.body.to.includes("buyer@acme.example"));
    expect(toBuyer).toBeTruthy();
    expect(toBuyer!.body.text).toContain("North Hall");
    expect(toBuyer!.body.text).toContain("Rack feed / tap-off rating");
    expect(toBuyer!.body.text).toContain("14");
    // No invented savings, urgency or false claims of measurement on this hall.
    expect(toBuyer!.body.text.toLowerCase()).not.toMatch(
      /guarantee|save you|we have measured|this hall has been verified/
    );
  });

  it("is idempotent — a second request sends no second email", async () => {
    seedScored();
    const { POST } = await route();
    await POST(post("tok_north_hall", { email: "buyer@acme.example" }), ctx("tok_north_hall"));
    expect(resendCalls).toHaveLength(2);

    const res2 = await POST(post("tok_north_hall", { email: "buyer@acme.example" }), ctx("tok_north_hall"));
    const body2 = await res2.json();
    expect(body2.ok).toBe(true);
    expect(body2.alreadyRequested).toBe(true);
    expect(resendCalls).toHaveLength(2); // unchanged
  });

  it("404s on a token that does not exist — no cross-qualification leakage", async () => {
    seedScored();
    const { POST } = await route();
    const res = await POST(post("does-not-exist", { email: "attacker@example.com" }), ctx("does-not-exist"));
    expect(res.status).toBe(404);
    expect(resendCalls).toHaveLength(0);
    // The real row is untouched.
    expect((db.rows("qualifications")[0] as Record<string, any>).follow_up_requested_at).toBeNull();
  });

  it("refuses an invalid email", async () => {
    seedScored();
    const { POST } = await route();
    const res = await POST(post("tok_north_hall", { email: "not-an-email" }), ctx("tok_north_hall"));
    expect(res.status).toBe(422);
    expect(resendCalls).toHaveLength(0);
  });

  it("refuses a qualification with no result to follow up on", async () => {
    seedScored({ status: "engine_unavailable", binding_constraint: null });
    const { POST } = await route();
    const res = await POST(post("tok_north_hall", { email: "buyer@acme.example" }), ctx("tok_north_hall"));
    expect(res.status).toBe(422);
    expect(resendCalls).toHaveLength(0);
  });

  it("still records the request when no email provider is configured, and does not throw", async () => {
    seedScored();
    delete process.env.RESEND_API_KEY;
    const { POST } = await route();
    const res = await POST(post("tok_north_hall", { email: "buyer@acme.example" }), ctx("tok_north_hall"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(resendCalls).toHaveLength(0);
    expect((db.rows("qualifications")[0] as Record<string, any>).follow_up_requested_at).toBeTruthy();
  });
});
