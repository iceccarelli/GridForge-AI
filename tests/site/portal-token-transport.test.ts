/**
 * The account portal token is a bearer credential: it reads the account's email and company, and POST /api/keys with it mints or rotates a live API
 * key. A credential in a URL is written to access logs, browser history, proxies and Referer headers, so it travels in the Authorization header (or
 * a POST body). The old query form keeps working for ONE release so a script already calling it does not break, but its response says so
 * (`Deprecation: true`) and the log line never carries the token.
 *
 * Stand-ins: the in-memory PostgREST fake and the pay-as-you-go harness. No live Stripe, Supabase or engine call is made.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { siteUrl } from "@/lib/site";
import { resetMemoryLimiter } from "@/lib/rate-limit";
import { securityHeaderRules, TOKEN_ROUTES } from "@/lib/security-headers";
import { getUsage } from "@/lib/payg-client";
import { mockEngine, newPaygDb, paygAccount, type MockEngine } from "./payg-harness";
import type { PostgrestFake } from "./postgrest-fake";

// Next's own compiled matcher (the one that applies `headers()` sources); it ships no types.
const { match } = createRequire(import.meta.url)("next/dist/compiled/path-to-regexp") as { match: (source: string) => (path: string) => unknown };
const TOKEN = "token-for-acme-0123456789abcd";
let db: PostgrestFake;
let restore: () => void;
let engine: MockEngine;
let logs: string[];

beforeEach(() => {
  Object.assign(process.env, {
    SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", STRIPE_SECRET_KEY: "sk_test_placeholder",
    GRIDFORGE_KEY_SECRET: "test-signing-secret",
  });
  delete process.env.RESEND_API_KEY;
  delete process.env.LEAD_TO_EMAIL;
  logs = [];
  for (const m of ["error", "warn", "log", "info", "debug"] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ")); });
  }
  resetMemoryLimiter();
  db = newPaygDb();
  restore = db.install();
  engine = mockEngine([]);
  paygAccount(db, { account: "acme-aaaaaa", token: TOKEN, email: "ops@acme.example", company: "Acme", key_id: null, key_expires_at: null });
});
afterEach(() => { engine.restore(); restore(); vi.restoreAllMocks(); });

let n = 0;
const ip = () => `10.7.${Math.floor(++n / 250)}.${(n % 250) + 1}`;
const req = (path: string, init: { method?: string; bearer?: string; body?: unknown } = {}) =>
  new Request(siteUrl(path), {
    method: init.method ?? "GET",
    headers: {
      "x-real-ip": ip(),
      ...(init.bearer !== undefined ? { authorization: `Bearer ${init.bearer}` } : {}),
      ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
const keys = () => import("@/app/api/keys/route");
const usage = () => import("@/app/api/usage/route");

describe("GET /api/usage", () => {
  it("accepts the token in the Authorization header, with no deprecation notice, and is never cached", async () => {
    const res = await (await usage()).GET(req("/api/usage", { bearer: TOKEN }));
    expect(res.status).toBe(200);
    expect(res.headers.get("deprecation")).toBeNull();
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });
  it("still accepts the query form for one release, but says it is deprecated and never logs the token", async () => {
    const res = await (await usage()).GET(req(`/api/usage?token=${TOKEN}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("deprecation")).toBe("true");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(logs.some((l) => /deprecated/i.test(l) && l.includes("/api/usage"))).toBe(true);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
  it("a wrong header token is the same 404 as before, uncached, and the query is NOT consulted when a header is present", async () => {
    const { GET } = await usage();
    const bad = await GET(req(`/api/usage?token=${TOKEN}`, { bearer: "not-a-token" }));
    expect(bad.status).toBe(404);
    expect(bad.headers.get("cache-control")).toMatch(/no-store/);
    expect((await GET(req("/api/usage"))).status).toBe(404);
  });
});

describe("/api/keys", () => {
  it("GET with the header returns the account, uncached, with no deprecation notice", async () => {
    const res = await (await keys()).GET(req("/api/keys", { bearer: TOKEN }));
    expect(res.status).toBe(200);
    expect((await res.json()).account.email).toBe("ops@acme.example");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("deprecation")).toBeNull();
  });
  it("GET with the query still works for one release: Deprecation header, no-store, and a log line without the token", async () => {
    const res = await (await keys()).GET(req(`/api/keys?token=${TOKEN}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("deprecation")).toBe("true");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(logs.some((l) => /deprecated/i.test(l) && l.includes("/api/keys"))).toBe(true);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
  it("an unknown account is 404 and uncached", async () => {
    const res = await (await keys()).GET(req("/api/keys", { bearer: "nope" }));
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
  });
  it("POST mints with the token in the Authorization header alone, and the response that carries the key is uncached", async () => {
    const res = await (await keys()).POST(req("/api/keys", { method: "POST", bearer: TOKEN, body: { rotate: false } }));
    const j = await res.json();
    expect(res.status).toBe(200);
    expect(j.issued).toBe(true);
    expect(String(j.key).startsWith("gfk1.")).toBe(true);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });
  it("POST with the token in the body keeps working (the portal page sends it that way)", async () => {
    const res = await (await keys()).POST(req("/api/keys", { method: "POST", body: { token: TOKEN } }));
    expect((await res.json()).issued).toBe(true);
  });
  it("POST never takes the token from the query string: that form never worked and must not start to", async () => {
    const res = await (await keys()).POST(req(`/api/keys?token=${TOKEN}`, { method: "POST", body: {} }));
    expect(res.status).toBe(404);
  });
});

describe("the browser client does not put the token in a URL", () => {
  it("getUsage sends it as a Bearer header to a token-free URL", async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const f = async (input: string, init?: RequestInit) => { calls.push([input, init]); return new Response("{}", { status: 404 }); };
    await getUsage("tok/with space", f);
    expect(calls[0][0]).toBe("/api/usage");
    expect((calls[0][1]?.headers as Record<string, string>).Authorization).toBe("Bearer tok/with space");
  });
});

describe("the real header configuration covers both routes", () => {
  const rules = securityHeaderRules();
  /** What a request for `path` is served with: every matching rule applies and a later rule wins a key an earlier one set. */
  function served(path: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const r of rules) if (match(r.source)(path)) for (const h of r.headers) out[h.key] = h.value;
    return out;
  }
  it("/api/keys and /api/usage get the token-route headers: no-store, no-referrer, noindex", () => {
    expect(TOKEN_ROUTES).toContain("/api/keys");
    expect(TOKEN_ROUTES).toContain("/api/usage");
    for (const p of ["/api/keys", "/api/usage"]) {
      const h = served(p);
      expect(h["Cache-Control"], p).toMatch(/no-store/);
      expect(h["Referrer-Policy"], p).toBe("no-referrer");
      expect(h["X-Robots-Tag"], p).toMatch(/noindex/);
    }
  });
  it("the patterns are exact: they do not spill onto a sibling route, and the other token routes still match their tokens", () => {
    expect(served("/api/keys-other")["Cache-Control"]).toBeUndefined();
    expect(served("/api/chat")["Cache-Control"]).toBeUndefined();
    expect(served("/q/abc123")["Cache-Control"]).toMatch(/no-store/);
  });
});
