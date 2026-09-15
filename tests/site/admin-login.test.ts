/**
 * app/api/admin/login — the gate in front of the commercial asset.
 *
 * Behind this password sit every lead the business has (name, company, site,
 * contracted megawatts, score, pipeline status) and the button that releases a
 * paid deliverable to a client. That is the thing an acquirer is buying and the
 * thing a competitor would most like to read.
 *
 * There was no throttle of any kind, so the password's strength was the whole
 * defence and a guess was free. The throttle is deliberately modest — in-memory,
 * therefore per-instance on a serverless platform — and these tests hold it to
 * what it actually claims rather than to a lockout it cannot deliver.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { siteUrl } from "@/lib/site";

/**
 * next/headers' cookies() needs a Next request scope, which calling a handler
 * directly does not create. The store is recorded here so the session cookie's
 * attributes can still be asserted — httpOnly is the difference between a
 * session a script on the page can steal and one it cannot.
 */
const jar: { name: string; value: string; opts: Record<string, unknown> }[] = [];
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const hit = [...jar].reverse().find((c) => c.name === name);
      return hit ? { name, value: hit.value } : undefined;
    },
    set: (name: string, value: string, opts: Record<string, unknown> = {}) => {
      jar.push({ name, value, opts });
    },
  }),
}));

const PASSWORD = "a-long-random-admin-password";

async function route() {
  return await import("@/app/api/admin/login/route");
}

async function admin() {
  return await import("@/lib/admin");
}

function login(password: unknown, ip = "203.0.113.10") {
  return new Request(siteUrl("/api/admin/login"), {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ password }),
  });
}

beforeEach(async () => {
  process.env.ADMIN_PASSWORD = PASSWORD;
  jar.length = 0;
  (await admin()).resetLoginThrottle();
});

afterEach(() => {
  delete process.env.ADMIN_PASSWORD;
});

describe("the password check itself", () => {
  it("accepts the password and sets a session", async () => {
    const { POST } = await route();
    const res = await POST(login(PASSWORD));
    expect(res.status).toBe(200);
    expect(jar.map((c) => c.name)).toContain("gf_admin");
  });

  it("refuses a wrong password", async () => {
    const { POST } = await route();
    expect((await POST(login("wrong"))).status).toBe(401);
  });

  it("refuses an empty password even though the comparison is length-sensitive", async () => {
    const { POST } = await route();
    expect((await POST(login(""))).status).toBe(401);
  });

  it("refuses a non-string password rather than coercing it", async () => {
    const { POST } = await route();
    expect((await POST(login({ toString: "nope" }))).status).toBe(401);
    (await admin()).resetLoginThrottle();
    expect((await POST(login(true))).status).toBe(401);
  });

  it("refuses everything when no password is configured", async () => {
    delete process.env.ADMIN_PASSWORD;
    const { POST } = await route();
    const res = await POST(login(""));
    expect(res.status).toBe(503);
    expect(jar).toHaveLength(0);
  });

  it("sets an httpOnly cookie, so a script on the page cannot read the session", async () => {
    const { POST } = await route();
    await POST(login(PASSWORD));
    const session = jar.find((c) => c.name === "gf_admin");
    expect(session?.opts.httpOnly).toBe(true);
    expect(session?.opts.sameSite).toBe("lax");
  });
});

describe("a guess must cost something", () => {
  it("stops answering after a burst of attempts — THE regression", async () => {
    const { POST } = await route();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await POST(login("guess-" + i))).status;
    expect(last).toBe(429);
  });

  it("says how long to wait", async () => {
    const { POST } = await route();
    let res = new Response();
    for (let i = 0; i < 12; i++) res = await POST(login("guess-" + i));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("counts successful attempts too, so they cannot be used to reset the count", async () => {
    // A throttle that only counts failures lets an attacker interleave a request
    // it will answer and guess forever.
    const { POST } = await route();
    for (let i = 0; i < 8; i++) await POST(login(PASSWORD));
    expect((await POST(login(PASSWORD))).status).toBe(429);
  });

  it("throttles before it compares, so a locked-out caller learns nothing", async () => {
    const { POST } = await route();
    for (let i = 0; i < 8; i++) await POST(login("guess-" + i));
    // The correct password now gets the same answer as a wrong one.
    const right = await POST(login(PASSWORD));
    const wrong = await POST(login("still-wrong"));
    expect(right.status).toBe(429);
    expect(wrong.status).toBe(429);
    expect(jar).toHaveLength(0);
  });

  it("does not punish an unrelated caller for someone else's guessing", async () => {
    const { POST } = await route();
    for (let i = 0; i < 12; i++) await POST(login("guess-" + i, "203.0.113.10"));
    expect((await POST(login(PASSWORD, "198.51.100.77"))).status).toBe(200);
  });

  it("reads only the first hop of x-forwarded-for, which a client cannot append to", async () => {
    const { throttleLogin, resetLoginThrottle, requestKey } = await admin();
    resetLoginThrottle();
    const spoofed = new Request(siteUrl("/api/admin/login"), {
      method: "POST",
      headers: { "x-forwarded-for": "203.0.113.10, 10.0.0.1, 10.0.0.2" },
    });
    expect(requestKey(spoofed)).toBe("203.0.113.10");
    expect(throttleLogin("203.0.113.10")).toBe(0);
  });

  it("lets the window pass", async () => {
    const { throttleLogin, resetLoginThrottle } = await admin();
    resetLoginThrottle();
    const t0 = 1_000_000;
    for (let i = 0; i < 8; i++) expect(throttleLogin("k", t0)).toBe(0);
    expect(throttleLogin("k", t0)).toBeGreaterThan(0);
    // Eleven minutes later the window has rolled off.
    expect(throttleLogin("k", t0 + 11 * 60 * 1000)).toBe(0);
  });
});
