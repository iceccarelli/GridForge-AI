/**
 * The typed clients for the billing routes. The routes are built elsewhere and may be absent or failing closed on a
 * deployment; every helper must turn that into an honest "not available", never a throw and never a made-up figure.
 */
import { describe, expect, it } from "vitest";
import { PAYG } from "@/lib/products";
import {
  UNAVAILABLE_MESSAGE,
  changeCap,
  enablePayg,
  FREE_CAPACITY_MESSAGE,
  failureFor,
  isFreeCapacityRefusal,
  replaceCard,
  getEngineEstimate,
  getUsage,
  meterState,
  parseUsage,
  planLabel,
  requestFreeAccount,
  safeCheckoutUrl,
  safeInvoiceUrl,
  validateEmail,
  type FetchLike,
} from "@/lib/payg-client";

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
const html404 = () => new Response("<html>404</html>", { status: 404 });
const fetching = (r: Response | (() => Response)): FetchLike & { calls: [string, RequestInit | undefined][] } => {
  const calls: [string, RequestInit | undefined][] = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    return typeof r === "function" ? r() : r;
  }) as FetchLike & { calls: typeof calls };
  f.calls = calls;
  return f;
};
const offline: FetchLike = async () => {
  throw new TypeError("failed to fetch");
};

describe("validateEmail", () => {
  it("accepts ordinary addresses and trims", () => {
    expect(validateEmail("  a@b.co ")).toEqual({ ok: true, email: "a@b.co", error: null });
  });
  it("refuses empty, spaced, malformed and absurdly long", () => {
    for (const v of ["", "   ", "a@", "@b.co", "a b@c.de", "a@b", "a@@b.co", `${"x".repeat(250)}@b.co`]) {
      expect(validateEmail(v).ok, v).toBe(false);
    }
  });
});

describe("failureFor maps status to an honest kind", () => {
  const f = (status: number, body: Record<string, unknown> | null = null, retryAfter?: number) =>
    failureFor({ status, json: body, retryAfter });
  it("a missing or failing-closed route is 'not available on this deployment'", () => {
    for (const s of [404, 405, 501, 503]) {
      const x = f(s);
      expect(x.kind).toBe("unavailable");
      expect(x.message).toContain(UNAVAILABLE_MESSAGE);
    }
    expect(f(503, { error: "store not configured" }).message).toContain("store not configured");
  });
  it("429 keeps retry-after, 402 and 4xx keep the server's reason", () => {
    expect(f(429, null, 30)).toMatchObject({ kind: "rate_limited", retryAfterSeconds: 30 });
    expect(f(402, { error: "past due" })).toMatchObject({ kind: "payment_required", message: "past due" });
    expect(f(422, { error: "bad cap" })).toMatchObject({ kind: "invalid", message: "bad cap" });
    expect(f(401).kind).toBe("unauthorized");
    expect(f(500).kind).toBe("server");
  });
});

describe("requestFreeAccount (POST /api/free-account)", () => {
  it("posts email only and reports success without saying whether the address existed", async () => {
    const fetchFn = fetching(json({ ok: true }));
    const r = await requestFreeAccount({ email: " Dev@Example.com " }, fetchFn);
    expect(r).toEqual({ ok: true, data: { email: "Dev@Example.com" } });
    const [url, init] = fetchFn.calls[0];
    expect(url).toBe("/api/free-account");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ email: "Dev@Example.com" });
  });
  it("includes a company only when given", async () => {
    const fetchFn = fetching(json({ ok: true }));
    await requestFreeAccount({ email: "a@b.co", company: " Acme " }, fetchFn);
    expect(JSON.parse(String(fetchFn.calls[0][1]?.body))).toEqual({ email: "a@b.co", company: "Acme" });
  });
  it("never calls the network for an invalid address", async () => {
    const fetchFn = fetching(json({ ok: true }));
    const r = await requestFreeAccount({ email: "nope" }, fetchFn);
    expect(r).toMatchObject({ ok: false, kind: "invalid" });
    expect(fetchFn.calls).toHaveLength(0);
  });
  it("degrades: 404 page, 503, 429, network failure", async () => {
    expect(await requestFreeAccount({ email: "a@b.co" }, fetching(html404()))).toMatchObject({ ok: false, kind: "unavailable" });
    expect(await requestFreeAccount({ email: "a@b.co" }, fetching(json({ ok: false, error: "x" }, 503)))).toMatchObject({ kind: "unavailable" });
    expect(await requestFreeAccount({ email: "a@b.co" }, fetching(json({ ok: false }, 429, { "retry-after": "60" })))).toMatchObject({
      kind: "rate_limited",
      retryAfterSeconds: 60,
    });
    expect(await requestFreeAccount({ email: "a@b.co" }, offline)).toMatchObject({ ok: false, kind: "network", status: 0 });
  });
  it("a 200 that says ok:false is a failure, not a success", async () => {
    const r = await requestFreeAccount({ email: "a@b.co" }, fetching(json({ ok: false, error: "no" }, 200)));
    expect(r.ok).toBe(false);
  });
});

const usageBody = {
  ok: true,
  account: { plan: "api_payg", status: "active", scope: "payg", cap_units: 50, cap_eur: 100 },
  month: "2026-03",
  units_used: 12,
  units_cap: 50,
  eur_accrued_cents: 2400,
  remaining_units: 38,
  unit_price_cents: 200,
  events: [
    { ts: "2026-03-02T10:00:00Z", endpoint: "/v1/study", units: 5, kind: "charge", project: "alpha", key_id: "k1" },
    { ts: "2026-03-02T10:01:00Z", endpoint: "/v1/study", units: 5, kind: "refund", project: "alpha", key_id: "k1" },
    { endpoint: "broken" },
  ],
  settlements: [
    { month: "2026-02", units: 9, amount_cents: 1800, status: "paid", hosted_invoice_url: "https://invoice.stripe.com/i/acct_1/test_abc" },
    { month: "2026-01", units: 1, amount_cents: 200, status: "carried", hosted_invoice_url: "http://evil.example/inv" },
    { month: "2025-12", status: "weird" },
    { nothing: true },
  ],
};

describe("getUsage (GET /api/usage)", () => {
  it("parses the contract shape, keeps only well-formed rows and only Stripe https invoice links", async () => {
    const fetchFn = fetching(json(usageBody));
    const r = await getUsage("tok/with space", fetchFn);
    expect(fetchFn.calls[0][0]).toBe("/api/usage?token=tok%2Fwith%20space");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = r.data;
    expect(u.account).toMatchObject({ plan: "api_payg", capEur: 100, capUnits: 50 });
    expect(u.unitsUsed).toBe(12);
    expect(u.events).toHaveLength(2);
    expect(u.events[1].kind).toBe("refund");
    expect(u.settlements.map((s) => s.month)).toEqual(["2026-02", "2026-01", "2025-12"]);
    expect(u.settlements[0].invoiceUrl).toBe("https://invoice.stripe.com/i/acct_1/test_abc");
    expect(u.settlements[1].invoiceUrl).toBeNull();
    expect(u.settlements[2]).toMatchObject({ status: "unknown", units: null, amountCents: null });
  });
  it("returns no data, never a guess, when the essentials are missing", () => {
    expect(parseUsage({ ok: true })).toBeNull();
    expect(parseUsage({ account: { plan: "x", status: "active" } })).toBeNull(); // no units_used
    expect(parseUsage({ account: { plan: "x" }, units_used: 1 })).toBeNull();
  });
  it("an unrecognised answer is a server failure, a missing route is 'unavailable'", async () => {
    expect(await getUsage("t", fetching(json({ ok: true, hello: 1 })))).toMatchObject({ ok: false, kind: "server" });
    expect(await getUsage("t", fetching(html404()))).toMatchObject({ ok: false, kind: "unavailable" });
    expect(await getUsage("t", fetching(json({ ok: false, error: "x" }, 503)))).toMatchObject({ kind: "unavailable" });
    expect(await getUsage("t", offline)).toMatchObject({ kind: "network" });
  });
});

describe("safe links", () => {
  it("invoice links must be https on stripe.com", () => {
    expect(safeInvoiceUrl("https://invoice.stripe.com/i/x")).toBeTruthy();
    expect(safeInvoiceUrl("https://stripe.com/x")).toBeTruthy();
    for (const bad of ["http://invoice.stripe.com/x", "https://evilstripe.com/x", "https://stripe.com.evil.io/x", "javascript:alert(1)", "", null, 5, "not a url"]) {
      expect(safeInvoiceUrl(bad), String(bad)).toBeNull();
    }
  });
  it("checkout links must be https", () => {
    expect(safeCheckoutUrl("https://checkout.stripe.com/c/pay/x")).toBeTruthy();
    expect(safeCheckoutUrl("http://checkout.stripe.com/x")).toBeNull();
    expect(safeCheckoutUrl("javascript:alert(1)")).toBeNull();
  });
});

describe("enablePayg / changeCap", () => {
  it("enable posts the token and cap and returns a checkout url", async () => {
    const fetchFn = fetching(json({ ok: true, url: "https://checkout.stripe.com/c/x" }));
    const r = await enablePayg("tok", 100, fetchFn);
    expect(r).toEqual({ ok: true, data: { url: "https://checkout.stripe.com/c/x" } });
    expect(fetchFn.calls[0][0]).toBe("/api/payg/enable");
    expect(JSON.parse(String(fetchFn.calls[0][1]?.body))).toEqual({ token: "tok", cap_eur: 100 });
  });
  it("enable refuses a non-https url and surfaces 402 for a past-due account", async () => {
    expect(await enablePayg("t", 50, fetching(json({ ok: true, url: "http://x" })))).toMatchObject({ ok: false, kind: "server" });
    expect(await enablePayg("t", 50, fetching(json({ ok: false, error: "account is past due" }, 402)))).toMatchObject({
      kind: "payment_required",
      message: "account is past due",
    });
    expect(await enablePayg("t", 50, fetching(html404()))).toMatchObject({ kind: "unavailable" });
  });
  it("cap change returns the new key once, with revocation caveats", async () => {
    const fetchFn = fetching(json({ ok: true, issued: true, key: "gfk1.a.b", expires: "2026-04-01", revocation_pending: true, revocation_note: "retrying" }));
    const r = await changeCap("tok", 300, fetchFn);
    // A verified rotation carries no unverified-key caveat: the two rotation fields are present, false and null (an absent field is
    // not a quiet success; the client always says which it is).
    expect(r).toEqual({
      ok: true,
      data: { key: "gfk1.a.b", expires: "2026-04-01", revocationPending: true, revocationNote: "retrying", newKeyUnverified: false, rotationNote: null },
    });
    expect(await changeCap("t", 300, fetching(json({ ok: true })))).toMatchObject({ ok: false });
  });
  it("a rotation whose new key the engine could not verify says so: the previous key was NOT revoked, and the caveat reaches the customer", async () => {
    const body = {
      ok: true, issued: true, key: "gfk1.a.b", expires: "2026-04-01",
      rotation_deferred: true, new_key_unverified: true,
      rotation_note: "We could not confirm with the engine that this new key works yet, so your previous key stays valid for now.",
      revocation_pending: true, revocation_note: "the previous key id is recorded and will be revoked once the engine verifies keys",
    };
    const r = await changeCap("tok", 300, fetching(json(body)));
    expect(r).toMatchObject({ ok: true, data: { newKeyUnverified: true, revocationPending: true } });
    expect(r.ok && r.data.rotationNote).toMatch(/previous key stays valid/);
  });
  it("only a literal true counts as the unverified-key flag (a string or number is not the server's answer)", async () => {
    for (const odd of ["true", 1, "yes", {}]) {
      const r = await changeCap("tok", 300, fetching(json({ ok: true, issued: true, key: "gfk1.a.b", new_key_unverified: odd })));
      expect(r.ok && r.data.newKeyUnverified, JSON.stringify(odd)).toBe(false);
    }
  });
});

describe("getEngineEstimate (public GET /v1/estimate)", () => {
  const body = { endpoint: "/v1/portfolio", units: 20, unit_price_cents: 200, currency: "eur", estimated_cents: 4000, billable: true, basis: "1 unit per hall", free: false };
  it("builds the query, sends no custom headers beyond Accept, and parses the answer", async () => {
    const fetchFn = fetching(json(body));
    const r = await getEngineEstimate("https://engine.example/", "/v1/portfolio", 20, fetchFn);
    expect(fetchFn.calls[0][0]).toBe("https://engine.example/v1/estimate?endpoint=%2Fv1%2Fportfolio&hall_count=20");
    expect(Object.keys((fetchFn.calls[0][1]?.headers ?? {}) as object)).toEqual(["Accept"]);
    expect(r).toMatchObject({ ok: true, data: { units: 20, estimatedCents: 4000, free: false } });
  });
  it("omits hall_count when not per hall, and degrades when the engine lacks the route", async () => {
    const fetchFn = fetching(json(body));
    await getEngineEstimate("https://e", "/v1/study", null, fetchFn);
    expect(fetchFn.calls[0][0]).not.toContain("hall_count");
    expect(await getEngineEstimate("https://e", "/v1/study", null, fetching(json({ error: "not found" }, 404)))).toMatchObject({ kind: "unavailable" });
    expect(await getEngineEstimate("https://e", "/v1/study", null, offline)).toMatchObject({ kind: "network" });
  });
});

describe("presentation helpers", () => {
  it("meterState warns and stops at the registry's alert thresholds, and has no meter without a cap", () => {
    const warn = Math.min(...PAYG.alertPercents);
    const full = Math.max(...PAYG.alertPercents);
    expect(meterState(0, 100)).toMatchObject({ tone: "ok", percent: 0, remaining: 100 });
    expect(meterState(warn - 1, 100).tone).toBe("ok");
    expect(meterState(warn, 100).tone).toBe("warn");
    expect(meterState(full, 100).tone).toBe("full");
    expect(meterState(250, 100)).toMatchObject({ tone: "full", percent: 100, remaining: 0 });
    expect(meterState(5, null).tone).toBe("unknown");
    expect(meterState(5, 0).tone).toBe("unknown");
  });
  it("names the plans", () => {
    expect(planLabel("api_free")).toBe("Free allowance");
    expect(planLabel("api_payg")).toBe("Pay as you go");
    expect(planLabel("api_triage")).toBe("API — Triage");
    expect(planLabel("mystery")).toBe("mystery");
  });
});

describe("replaceCard (POST /api/payg/card)", () => {
  it("posts only the token and returns the Stripe setup url", async () => {
    const fetchFn = fetching(json({ ok: true, url: "https://checkout.stripe.com/c/setup" }));
    const r = await replaceCard("tok", fetchFn);
    expect(r).toEqual({ ok: true, data: { url: "https://checkout.stripe.com/c/setup" } });
    expect(fetchFn.calls[0][0]).toBe("/api/payg/card");
    expect(JSON.parse(String(fetchFn.calls[0][1]?.body))).toEqual({ token: "tok" });
  });
  it("carries the server's next step on 409, refuses a cancelled account on 402, degrades on 404/502/503", async () => {
    expect(await replaceCard("t", fetching(json({ ok: false, error: "no card", fix: "enable_payg" }, 409)))).toMatchObject({
      ok: false,
      kind: "invalid",
      status: 409,
      fix: "enable_payg",
      message: "no card",
    });
    expect(await replaceCard("t", fetching(json({ ok: false, error: "cancelled" }, 402)))).toMatchObject({ kind: "payment_required" });
    expect(await replaceCard("t", fetching(html404()))).toMatchObject({ kind: "unavailable" });
    expect(await replaceCard("t", fetching(json({ ok: false, error: "x" }, 503)))).toMatchObject({ kind: "unavailable" });
    expect(await replaceCard("t", fetching(json({ ok: false, error: "Could not start checkout" }, 502)))).toMatchObject({ kind: "server" });
    expect(await replaceCard("t", fetching(json({ ok: false }, 429)))).toMatchObject({ kind: "rate_limited" });
    expect(await replaceCard("t", fetching(json({ ok: true, url: "http://x" })))).toMatchObject({ ok: false });
    expect(await replaceCard("t", offline)).toMatchObject({ kind: "network" });
  });
});

describe("a free account's first key mint at capacity", () => {
  it("is recognised only as 429 with reason capacity", () => {
    expect(isFreeCapacityRefusal(429, { ok: false, reason: "capacity" })).toBe(true);
    expect(isFreeCapacityRefusal(429, { ok: false })).toBe(false);
    expect(isFreeCapacityRefusal(503, { reason: "capacity" })).toBe(false);
    expect(isFreeCapacityRefusal(429, null)).toBe(false);
  });
  it("the message says the allowance is full and that pay-as-you-go needs none", () => {
    expect(FREE_CAPACITY_MESSAGE).toMatch(/Free allowances are full this month/);
    expect(FREE_CAPACITY_MESSAGE).toMatch(/Pay as you go needs no free allowance/);
  });
});

describe("parseUsage reads the newer fields without inventing them", () => {
  it("keeps carried units, card flag, billable units, as_of and alert flags", () => {
    const r = parseUsage({
      ...usageBody,
      account: { ...usageBody.account, payment_method_saved: true },
      billable_units: 7,
      as_of: "2026-03-02T03:00:00Z",
      alerts: { "80": true, "100": false, junk: "x" },
      settlements: [{ month: "2026-02", units: 9, amount_cents: 1800, status: "invoiced", carried_units: 3 }],
    })!;
    expect(r.account.paymentMethodSaved).toBe(true);
    expect(r.billableUnits).toBe(7);
    expect(r.asOf).toBe("2026-03-02T03:00:00Z");
    expect(r.alerts).toEqual({ "80": true, "100": false });
    expect(r.settlements[0].carriedUnits).toBe(3);
  });
  it("leaves them null or empty when the route does not send them", () => {
    const r = parseUsage(usageBody)!;
    expect(r.account.paymentMethodSaved).toBeNull();
    expect(r.billableUnits).toBeNull();
    expect(r.asOf).toBeNull();
    expect(r.alerts).toEqual({});
  });
});
