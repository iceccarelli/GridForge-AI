/**
 * app/api/admin/stripe-health -- auth-gated exactly like the other admin
 * routes (tests/site/admin-login.test.ts covers the gate itself); this only
 * checks that an unauthenticated caller is refused and an authenticated one
 * gets back the same shape lib/stripe-health.ts produces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

const jar: { name: string; value: string }[] = [];
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => jar.find((c) => c.name === name),
  }),
}));

beforeEach(() => {
  jar.length = 0;
  process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
  delete process.env.STRIPE_SECRET_KEY;
});

afterEach(() => {
  delete process.env.ADMIN_PASSWORD;
  delete process.env.STRIPE_SECRET_KEY;
});

function signIn() {
  jar.push({ name: "gf_admin", value: createHash("sha256").update(process.env.ADMIN_PASSWORD!).digest("hex") });
}

describe("GET /api/admin/stripe-health", () => {
  it("refuses an unauthenticated request", async () => {
    const { GET } = await import("@/app/api/admin/stripe-health/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("reports unconfigured when STRIPE_SECRET_KEY is unset, for an authenticated admin", async () => {
    signIn();
    const { GET } = await import("@/app/api/admin/stripe-health/route");
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.health.configured).toBe(false);
    expect(body.health.healthy).toBe(false);
  });
});
