/**
 * Small hardening fixes: admin session token, unpersisted-order fallbacks, lead logs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";

const SECRET_EMAIL = "buyer.secret@hall.example";

describe("admin session token", () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = "a-long-random-admin-password";
    delete process.env.ADMIN_SESSION_SECRET;
  });
  afterEach(() => { delete process.env.ADMIN_PASSWORD; delete process.env.ADMIN_SESSION_SECRET; });

  it("accepts a fresh signed token and is not the bare password hash", async () => {
    const { adminToken, verifyAdminCookie } = await import("@/lib/admin");
    const t = adminToken()!;
    expect(verifyAdminCookie(t)).toBe(true);
    const { createHash } = await import("node:crypto");
    expect(t).not.toBe(createHash("sha256").update(process.env.ADMIN_PASSWORD!).digest("hex"));
    expect(verifyAdminCookie(createHash("sha256").update(process.env.ADMIN_PASSWORD!).digest("hex"))).toBe(false);
  });

  it("expires after 12 hours", async () => {
    const { adminToken, verifyAdminCookie, ADMIN_SESSION_SECONDS } = await import("@/lib/admin");
    const t = adminToken()!;
    expect(ADMIN_SESSION_SECONDS).toBe(12 * 3600);
    expect(verifyAdminCookie(t, Date.now() + 11 * 3600_000)).toBe(true);
    expect(verifyAdminCookie(t, Date.now() + 13 * 3600_000)).toBe(false);
  });

  it("rejects a tampered expiry or signature", async () => {
    const { adminToken, verifyAdminCookie } = await import("@/lib/admin");
    const [exp, nonce, mac] = adminToken()!.split(".");
    expect(verifyAdminCookie(`${Number(exp) + 999999999}.${nonce}.${mac}`)).toBe(false);
    expect(verifyAdminCookie(`${exp}.${nonce}.${"0".repeat(mac.length)}`)).toBe(false);
    expect(verifyAdminCookie(undefined)).toBe(false);
    expect(verifyAdminCookie("garbage")).toBe(false);
  });

  it("can be invalidated by rotating ADMIN_SESSION_SECRET", async () => {
    const { adminToken, verifyAdminCookie } = await import("@/lib/admin");
    process.env.ADMIN_SESSION_SECRET = "first-secret";
    const t = adminToken()!;
    expect(verifyAdminCookie(t)).toBe(true);
    process.env.ADMIN_SESSION_SECRET = "second-secret";
    expect(verifyAdminCookie(t)).toBe(false);
  });
});

describe("no store: an order is not silently 'created'", () => {
  let logs: string[];
  beforeEach(() => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    logs = [];
    for (const m of ["log", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    }
  });
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

  it("createDeliverable returns null in production and logs no secrets", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { createDeliverable } = await import("@/lib/deliverables");
    const row = await createDeliverable({ kind: "density_screen", email: SECRET_EMAIL, token: "doc-secret-token", intake_token: "intake-secret-token" });
    expect(row).toBeNull();
    const out = logs.join("\n");
    for (const s of [SECRET_EMAIL, "doc-secret-token", "intake-secret-token"]) expect(out).not.toContain(s);
  });

  it("createWatch returns null in production and logs no secrets", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { createWatch } = await import("@/lib/watches");
    expect(await createWatch({ email: SECRET_EMAIL, token: "watch-secret-token" })).toBeNull();
    const out = logs.join("\n");
    expect(out).not.toContain(SECRET_EMAIL);
    expect(out).not.toContain("watch-secret-token");
  });

  it("also fails under test, and only `next dev` gets the labelled local stand-in (still no secrets logged)", async () => {
    const { createDeliverable } = await import("@/lib/deliverables");
    expect(await createDeliverable({ kind: "density_screen", email: SECRET_EMAIL })).toBeNull();
    vi.stubEnv("NODE_ENV", "development");
    const dev = await createDeliverable({ kind: "density_screen", email: SECRET_EMAIL, token: "dev-token-xyz" });
    expect(dev?.id).toBe("local");
    expect(logs.join("\n")).not.toContain(SECRET_EMAIL);
    expect(logs.join("\n")).not.toContain("dev-token-xyz");
  });
});

describe("lead capture logs", () => {
  afterEach(() => vi.restoreAllMocks());
  it("never writes the lead's name, email or message to stdout", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.RESEND_API_KEY;
    delete process.env.LEAD_TO_EMAIL;
    delete process.env.FORMSPREE_FORM_ID;
    delete process.env.NEXT_PUBLIC_FORMSPREE_ID;
    const logs: string[] = [];
    for (const m of ["log", "warn", "error"] as const) {
      vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); });
    }
    const { POST } = await import("@/app/api/audit/route");
    const res = await POST(new Request(siteUrl("/api/audit"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Zed Secretname", company: "Hall Co", email: SECRET_EMAIL, location: "Dublin",
        capacity: "40 MW", urgency: "immediate", gridStatus: "in_queue",
        message: "very private message text here", services: ["Not sure yet — need a recommendation"],
      }),
    }));
    expect(res.status, await res.clone().text()).toBe(200);
    const out = logs.join("\n");
    expect(out).toMatch(/not persisted|NOT persisted/i);
    for (const s of ["Zed Secretname", SECRET_EMAIL, "very private message"]) expect(out).not.toContain(s);
  });
});
