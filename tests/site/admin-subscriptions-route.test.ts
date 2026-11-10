/**
 * app/api/admin/subscriptions -- the operator's view of the Intelligence subscription store: counts by plan and status, behind the admin
 * cookie, with no address in it, and a store that cannot be read is a 503 and never an empty list (which would read as "no subscribers").
 */
import { adminToken } from "@/lib/admin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => jar.find((c) => c.name === name) }),
}));

const realFetch = globalThis.fetch;
let calls: string[];

function stubStore(answer: () => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (input: unknown) => {
    calls.push(String(input));
    return answer();
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jar.length = 0;
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-for-tests-only";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

const signIn = () => jar.push({ name: "gf_admin", value: adminToken()! });
const route = () => import("@/app/api/admin/subscriptions/route");

describe("GET /api/admin/subscriptions", () => {
  it("refuses an unauthenticated request without asking the store", async () => {
    stubStore(() => new Response("[]"));
    const res = (await route()).GET;
    expect((await res()).status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("returns counts by plan and status and no address or identifier", async () => {
    signIn();
    stubStore(
      () =>
        new Response(
          JSON.stringify([
            { plan: "team", status: "active", created_at: "2026-11-02T10:00:00Z", email: "a@x.example", stripe_customer_id: "cus_1" },
            { plan: "team", status: "active", created_at: "2026-11-01T10:00:00Z", email: "b@x.example" },
            { plan: "developer", status: "past_due", created_at: "2026-10-01T10:00:00Z" },
            { plan: "developer", status: "cancelled", created_at: "2026-09-01T10:00:00Z" },
          ]),
          { status: 200 },
        ),
    );
    const res = await (await route()).GET();
    const raw = await res.text();
    expect(res.status).toBe(200);
    const body = JSON.parse(raw);
    expect(body.ok).toBe(true);
    expect(body.entitling).toBe(3);
    expect(body.newestAt).toBe("2026-11-02T10:00:00Z");
    expect(body.counts).toEqual([
      { plan: "developer", status: "cancelled", rows: 1 },
      { plan: "developer", status: "past_due", rows: 1 },
      { plan: "team", status: "active", rows: 2 },
    ]);
    expect(raw).not.toMatch(/@|cus_|email/);
    // INTENTIONAL CHANGE (review finding 3): the first store request is now the admin-session denylist read (migration 0055, lib/admin.ts verifyAdminCookie);
    // the subscriptions query is the next one. What this asserts -- that the query selects only plan, status and created_at -- is unchanged.
    const queries = calls.filter((c) => !c.includes("/rpc/gf_admin_session_revoked"));
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("select=plan,status,created_at");
  });

  it("answers 503, not an empty list, when the store cannot be read", async () => {
    signIn();
    stubStore(() => new Response("nope", { status: 404 }));
    const res = await (await route()).GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.counts).toBeUndefined();
  });

  it("answers 503 when the store is unreachable or not configured", async () => {
    signIn();
    stubStore(() => {
      throw new Error("network down");
    });
    expect((await (await route()).GET()).status).toBe(503);
    delete process.env.SUPABASE_URL;
    expect((await (await route()).GET()).status).toBe(503);
  });

  it("the admin page says Unavailable for an unreadable store, not zero", async () => {
    const page = (await import("node:fs")).readFileSync("app/admin/page.tsx", "utf8");
    expect(page).toContain("subscriptionOverview");
    expect(page).toContain("This is not a count of zero");
  });
});
