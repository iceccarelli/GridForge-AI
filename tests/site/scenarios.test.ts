/**
 * app/api/scenarios — the paid surface a GridForge Intelligence subscriber uses.
 *
 * The handlers are imported and called. Nothing here reads source text.
 *
 * The defect these exist for: `scenarios` and `subscriptions` had no migration,
 * PostgREST answered 404, `fetch` does not reject on 404, and every call site
 * caught only thrown errors. The route therefore answered `{ ok: true,
 * scenarios: [] }` to a paying subscriber whose saved work was never written, and
 * `{ ok: true }` to a save that did not happen.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const SUBSCRIBER = "ops@northhall.example";
const OTHER = "someone.else@rival.example";

let db: PostgrestFake;
let restore: () => void;

async function route() {
  return await import("@/app/api/scenarios/route");
}

function get(email?: string) {
  const qs = email === undefined ? "" : `?email=${encodeURIComponent(email)}`;
  return new Request(siteUrl(`/api/scenarios${qs}`));
}

function post(body: unknown) {
  return new Request(siteUrl("/api/scenarios"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function del(email: string, id: string) {
  return new Request(
    siteUrl(`/api/scenarios?email=${encodeURIComponent(email)}&id=${encodeURIComponent(id)}`),
    { method: "DELETE" }
  );
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  db = new PostgrestFake(["subscriptions", "scenarios"]);
  db.seed("subscriptions", [
    { email: SUBSCRIBER, plan: "team", status: "active", created_at: "2026-01-01T00:00:00Z" },
  ]);
  restore = db.install();
});

afterEach(() => restore());

describe("entitlement", () => {
  it("refuses a caller with no subscription, and says why", async () => {
    const { GET } = await route();
    const res = await GET(get(OTHER));
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(String(body.error)).toMatch(/subscription/i);
  });

  it("serves a subscriber", async () => {
    db.seed("scenarios", [{ email: SUBSCRIBER, name: "Hall A", avoided_eur: 10 }]);
    const { GET } = await route();
    const res = await GET(get(SUBSCRIBER));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.scenarios).toHaveLength(1);
  });

  it("keeps serving a subscriber whose payment is being retried", async () => {
    // Stripe retries for days before it gives up. Cutting access off at the first
    // failed invoice would lock out a customer whose card clears on Thursday.
    db.rows("subscriptions")[0].status = "past_due";
    const { GET } = await route();
    expect((await GET(get(SUBSCRIBER))).status).toBe(200);
  });

  it("drops a cancelled subscriber to the free view", async () => {
    db.rows("subscriptions")[0].status = "cancelled";
    const { GET } = await route();
    expect((await GET(get(SUBSCRIBER))).status).toBe(402);
  });

  it("drops a superseded row — an upgrade must not leave two live entitlements", async () => {
    db.rows("subscriptions")[0].status = "superseded";
    const { GET } = await route();
    expect((await GET(get(SUBSCRIBER))).status).toBe(402);
  });
});

describe("a store that cannot answer", () => {
  it("is a 503, never an empty list — THE regression", async () => {
    // This is the original defect, reproduced exactly: the table does not exist,
    // PostgREST answers 404, and the old code turned that into `ok: true,
    // scenarios: []`. A subscriber was told they had saved nothing.
    db.dropTable("scenarios");
    const { GET } = await route();
    const res = await GET(get(SUBSCRIBER));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.scenarios).toBeUndefined();
  });

  it("refuses rather than reporting a save that did not happen", async () => {
    db.dropTable("scenarios");
    const { POST } = await route();
    const res = await POST(post({ email: SUBSCRIBER, name: "Hall B", mw: 12 }));
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });

  it("does not claim a subscriber is unsubscribed when the subscriptions table is gone", async () => {
    db.dropTable("subscriptions");
    const { GET } = await route();
    const res = await GET(get(SUBSCRIBER));
    // Denied either way, because failing closed is correct. But 402 is a claim
    // about the CUSTOMER — "you have not subscribed" — and an unreachable store is
    // a claim about US. It must be the second one.
    expect(res.status).toBe(503);
  });

  it("is a 503 when Supabase is not configured at all", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { GET } = await route();
    expect((await GET(get(SUBSCRIBER))).status).toBe(503);
  });
});

describe("input", () => {
  it("rejects a missing email", async () => {
    const { GET } = await route();
    expect((await GET(get())).status).toBe(400);
  });

  it("rejects an empty email", async () => {
    const { GET } = await route();
    expect((await GET(get("   "))).status).toBe(400);
  });

  it("rejects a body that is not JSON", async () => {
    const { POST } = await route();
    expect((await POST(post("{not json"))).status).toBe(400);
  });

  it("rejects an empty body", async () => {
    const { POST } = await route();
    expect((await POST(post(""))).status).toBe(400);
  });

  it("rejects a JSON array where an object was expected", async () => {
    const { POST } = await route();
    expect((await POST(post([1, 2, 3]))).status).toBe(400);
  });

  it("rejects a null body", async () => {
    const { POST } = await route();
    expect((await POST(post(null))).status).toBe(400);
  });

  it("matches an email regardless of case or surrounding space", async () => {
    const { GET } = await route();
    const res = await GET(get(`  ${SUBSCRIBER.toUpperCase()}  `));
    expect(res.status).toBe(200);
  });

  it("truncates an oversized name instead of passing it to the database", async () => {
    const { POST } = await route();
    const res = await POST(post({ email: SUBSCRIBER, name: "x".repeat(5000), mw: 1 }));
    expect(res.status).toBe(200);
    const saved = db.rows("scenarios")[0];
    expect(String(saved.name)).toHaveLength(80);
  });

  it("never writes NaN into a NOT NULL numeric column", async () => {
    // Number("banana") is NaN, JSON.stringify turns NaN into null, and null in a
    // NOT NULL column is a 400 from Postgres that reads like our own bug.
    const { POST } = await route();
    const res = await POST(post({ email: SUBSCRIBER, name: "Hall C", mw: "banana", avoidedEur: {} }));
    expect(res.status).toBe(200);
    const saved = db.rows("scenarios")[0];
    expect(saved.mw).toBe(0);
    expect(saved.avoided_eur).toBe(0);
    expect(JSON.stringify(saved)).not.toContain("null");
  });

  it("falls back to a usable name when none is given", async () => {
    const { POST } = await route();
    await POST(post({ email: SUBSCRIBER, mw: 4 }));
    expect(db.rows("scenarios")[0].name).toBe("Untitled site");
  });
});

describe("cross-tenant access", () => {
  it("will not let one subscriber delete another's scenario", async () => {
    db.seed("subscriptions", [
      { email: OTHER, plan: "developer", status: "active", created_at: "2026-02-01T00:00:00Z" },
    ]);
    db.seed("scenarios", [{ email: SUBSCRIBER, name: "Private hall", avoided_eur: 1 }]);
    const victimId = String(db.rows("scenarios")[0].id);

    const { DELETE } = await route();
    const res = await DELETE(del(OTHER, victimId));

    // A miss, not a success — indistinguishable from a row that never existed.
    expect(res.status).toBe(404);
    expect(db.rows("scenarios")).toHaveLength(1);
  });

  it("will not let one subscriber list another's scenarios", async () => {
    db.seed("subscriptions", [
      { email: OTHER, plan: "developer", status: "active", created_at: "2026-02-01T00:00:00Z" },
    ]);
    db.seed("scenarios", [{ email: SUBSCRIBER, name: "Private hall", avoided_eur: 1 }]);
    const { GET } = await route();
    const body = await (await GET(get(OTHER))).json();
    expect(body.scenarios).toEqual([]);
  });

  it("deletes the caller's own scenario", async () => {
    db.seed("scenarios", [{ email: SUBSCRIBER, name: "Mine", avoided_eur: 1 }]);
    const id = String(db.rows("scenarios")[0].id);
    const { DELETE } = await route();
    expect((await DELETE(del(SUBSCRIBER, id))).status).toBe(200);
    expect(db.rows("scenarios")).toHaveLength(0);
  });

  it("reports a repeated delete as a miss rather than a success", async () => {
    db.seed("scenarios", [{ email: SUBSCRIBER, name: "Mine", avoided_eur: 1 }]);
    const id = String(db.rows("scenarios")[0].id);
    const { DELETE } = await route();
    expect((await DELETE(del(SUBSCRIBER, id))).status).toBe(200);
    expect((await DELETE(del(SUBSCRIBER, id))).status).toBe(404);
  });

  it("requires both an email and an id to delete", async () => {
    const { DELETE } = await route();
    const res = await DELETE(
      new Request(siteUrl("/api/scenarios?email=" + SUBSCRIBER), { method: "DELETE" })
    );
    expect(res.status).toBe(400);
  });
});
