/**
 * app/api/admin/capability-audit -- auth-gated exactly like the other admin
 * routes; the report content itself is exercised by
 * tests/site/capability-registry.test.ts against the registry directly.
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
});

afterEach(() => {
  delete process.env.ADMIN_PASSWORD;
});

function signIn() {
  jar.push({ name: "gf_admin", value: createHash("sha256").update(process.env.ADMIN_PASSWORD!).digest("hex") });
}

describe("GET /api/admin/capability-audit", () => {
  it("refuses an unauthenticated request", async () => {
    const { GET } = await import("@/app/api/admin/capability-audit/route");
    const res = await GET();
    expect(res.status).toBe(401);
  });

  it("returns the audit summary for an authenticated admin", async () => {
    signIn();
    const { GET } = await import("@/app/api/admin/capability-audit/route");
    const res = await GET();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.audit.total).toBeGreaterThan(0);
    expect(body.audit.unmonetized).toEqual([]);
    expect(Array.isArray(body.audit.capabilities)).toBe(true);
  });
});
