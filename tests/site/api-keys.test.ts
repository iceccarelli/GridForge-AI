/**
 * app/api/keys — the self-serve portal for a metered API subscription.
 *
 * This is recurring revenue with no human in the loop, so the failure that costs
 * most is not a stranger getting in. It is a PAYING customer being locked out and
 * quietly churning.
 *
 * Signed keys are stateless and expire in 35 days. The subscription renews
 * monthly. Nothing reissues the key on renewal — the webhook's own comment says
 * "reissue silently" and the code only sets a status field — so a paying
 * customer's agents stop dead at day 35. The engine's expiry message tells them to
 * "reissue from your account page"; the account page's own docstring promises to
 * mint "when the current one is near expiry"; and the code did neither, answering
 * "a key is already live for this account" to somebody holding a dead one.
 *
 * That closed loop is what these tests exist to keep closed.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

let db: PostgrestFake;
let restore: () => void;

async function route() {
  return await import("@/app/api/keys/route");
}

const TOKEN = "portal-token-for-acme";

function get(token: string) {
  return new Request(siteUrl(`/api/keys?token=${encodeURIComponent(token)}`));
}

function post(body: unknown) {
  return new Request(siteUrl("/api/keys"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** An ISO date `days` from today; negative is in the past. */
function iso(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function seedAccount(over: Record<string, unknown> = {}) {
  db.seed("api_accounts", [
    {
      token: TOKEN,
      account: "acme",
      email: "ops@acme.example",
      company: "Acme",
      plan: "api_scale",
      monthly_units: 2500,
      status: "active",
      key_id: "aabbccdd",
      key_issued_at: iso(-30),
      key_expires_at: iso(5),
      revoked_key_ids: [],
      ...over,
    },
  ]);
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.GRIDFORGE_KEY_SECRET = "test-signing-secret";
  db = new PostgrestFake(["api_accounts"]);
  restore = db.install();
});

afterEach(() => restore());

describe("a paying customer must never be stranded", () => {
  it("mints a replacement when the current key has already expired", async () => {
    // The defect: this answered `issued: false, "A key is already live for this
    // account"` to a customer whose key died yesterday, with no way forward that
    // the UI or the engine's own error message told them about.
    seedAccount({ key_expires_at: iso(-1) });
    const { POST } = await route();
    const res = await POST(post({ token: TOKEN }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.issued).toBe(true);
    expect(typeof body.key).toBe("string");
    expect(body.key.startsWith("gfk1.")).toBe(true);
  });

  it("mints a replacement when the current key is near expiry", async () => {
    // The behaviour the route's own docstring promised and did not implement.
    seedAccount({ key_expires_at: iso(2) });
    const { POST } = await route();
    const body = await (await POST(post({ token: TOKEN }))).json();
    expect(body.issued).toBe(true);
  });

  it("revokes the dead key it replaces, rather than leaving two live", async () => {
    seedAccount({ key_expires_at: iso(-1) });
    const { POST } = await route();
    await POST(post({ token: TOKEN }));
    const row = db.rows("api_accounts")[0];
    expect(row.revoked_key_ids).toContain("aabbccdd");
    expect(row.key_id).not.toBe("aabbccdd");
  });

  it("still does NOT mint when a healthy key is live", async () => {
    // A key is shown once. Reissuing on every visit would hand out a new
    // credential to anyone who reloads the page, and silently strand the one the
    // customer already deployed.
    seedAccount({ key_expires_at: iso(20) });
    const { POST } = await route();
    const body = await (await POST(post({ token: TOKEN }))).json();
    expect(body.issued).toBe(false);
    expect(body.key).toBeUndefined();
  });

  it("mints on a first visit, when there is no key at all", async () => {
    seedAccount({ key_id: null, key_expires_at: null });
    const { POST } = await route();
    const body = await (await POST(post({ token: TOKEN }))).json();
    expect(body.issued).toBe(true);
  });

  it("tells the portal how long is left, so it can warn before the silence", async () => {
    seedAccount({ key_expires_at: iso(3) });
    const { GET } = await route();
    const body = await (await GET(get(TOKEN))).json();
    expect(body.account.expired).toBe(false);
    expect(body.account.days_left).toBe(3);
    expect(body.account.needs_rotation).toBe(true);
  });

  it("says plainly that a key is dead rather than reporting it as live", async () => {
    seedAccount({ key_expires_at: iso(-4) });
    const { GET } = await route();
    const body = await (await GET(get(TOKEN))).json();
    expect(body.account.has_key).toBe(true);
    expect(body.account.expired).toBe(true);
    expect(body.account.days_left).toBeLessThan(0);
  });
});

describe("the expiry boundary, where a paying customer gets wrongly blocked", () => {
  // The site and the engine both take "today" as the UTC date — the engine in
  // gridforge/api/keys.py:today(), deliberately NOT the pinnable report date, and
  // the site through toISOString(). If those ever diverge, a key reads as live in
  // the portal and dead at the engine for up to a day, and the customer is told
  // nothing is wrong while nothing works.
  it("treats a key expiring today as still live, exactly as the engine does", async () => {
    seedAccount({ key_expires_at: iso(0) });
    const { GET } = await route();
    const body = await (await GET(get(TOKEN))).json();
    expect(body.account.days_left).toBe(0);
    expect(body.account.expired).toBe(false);
  });

  it("treats yesterday as dead", async () => {
    seedAccount({ key_expires_at: iso(-1) });
    const { GET } = await route();
    const body = await (await GET(get(TOKEN))).json();
    expect(body.account.days_left).toBe(-1);
    expect(body.account.expired).toBe(true);
  });

  it("does not report an unreadable expiry date as a healthy key", async () => {
    seedAccount({ key_expires_at: "not-a-date" });
    const { GET } = await route();
    const body = await (await GET(get(TOKEN))).json();
    expect(body.account.expired).toBe(true);
    expect(body.account.needs_rotation).toBe(true);
  });
});

describe("the paid boundary still holds", () => {
  it("refuses a cancelled subscription", async () => {
    seedAccount({ status: "cancelled", key_expires_at: iso(-1) });
    const { POST } = await route();
    const res = await POST(post({ token: TOKEN }));
    // Expiry must not become a way back in for somebody who stopped paying.
    expect(res.status).toBe(402);
    expect(db.rows("api_accounts")[0].key_id).toBe("aabbccdd");
  });

  it("still serves an account whose payment is being retried", async () => {
    // past_due is Stripe retrying, not a cancellation — same rule as everywhere else.
    seedAccount({ status: "past_due", key_expires_at: iso(-1) });
    const { POST } = await route();
    expect((await POST(post({ token: TOKEN }))).status).toBe(200);
  });

  it("refuses an unknown portal token", async () => {
    seedAccount();
    const { POST } = await route();
    expect((await POST(post({ token: "not-a-real-token" }))).status).toBe(404);
  });

  it("refuses a missing token rather than serving the first account it finds", async () => {
    seedAccount();
    const { POST } = await route();
    expect((await POST(post({}))).status).toBe(404);
    const { GET } = await route();
    expect((await GET(get(""))).status).toBe(404);
  });

  it("never returns the key on a read", async () => {
    // A key is shown once, at mint. Anything else means a working credential can
    // be read back by whoever holds the portal link.
    seedAccount();
    const { GET } = await route();
    const body = await (await GET(get(TOKEN))).json();
    expect(JSON.stringify(body)).not.toContain("gfk1.");
    expect(body.account.key).toBeUndefined();
  });

  it("refuses to mint when signing is not configured, rather than issuing junk", async () => {
    delete process.env.GRIDFORGE_KEY_SECRET;
    seedAccount({ key_expires_at: iso(-1) });
    const { POST } = await route();
    expect((await POST(post({ token: TOKEN }))).status).toBe(503);
  });

  it("does not leak another account's state through a guessed token", async () => {
    seedAccount();
    db.seed("api_accounts", [
      { token: "someone-elses-token", account: "rival", email: "x@rival.example",
        plan: "api_triage", monthly_units: 500, status: "active", key_id: "11223344",
        key_expires_at: iso(10), revoked_key_ids: [] },
    ]);
    const { GET } = await route();
    const body = await (await GET(get(TOKEN))).json();
    expect(body.account.account).toBe("acme");
    expect(JSON.stringify(body)).not.toContain("rival");
  });
});
