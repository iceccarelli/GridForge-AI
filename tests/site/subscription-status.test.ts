/**
 * app/api/subscription-status — what /account gates the paid view on.
 *
 * The distinction this file defends: `active: false` must mean "this person is
 * not a subscriber" and nothing else. For two releases it also meant "we could
 * not reach the store", because the `subscriptions` table had no migration and
 * the 404 was swallowed — so the one customer paying the most was shown the
 * upgrade prompt, indefinitely, with no log line anywhere.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const SUBSCRIBER = "ops@northhall.example";

let db: PostgrestFake;
let restore: () => void;

async function route() {
  return await import("@/app/api/subscription-status/route");
}

function ask(body: unknown) {
  return new Request(siteUrl("/api/subscription-status"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  db = new PostgrestFake(["subscriptions"]);
  restore = db.install();
});

afterEach(() => restore());

it("reports an active subscriber and the plan they are on", async () => {
  db.seed("subscriptions", [
    { email: SUBSCRIBER, plan: "enterprise", status: "active", created_at: "2026-01-01T00:00:00Z" },
  ]);
  const { POST } = await route();
  const body = await (await POST(ask({ email: SUBSCRIBER }))).json();
  expect(body).toMatchObject({ ok: true, active: true, plan: "enterprise" });
});

it("reports the newest plan after an upgrade", async () => {
  db.seed("subscriptions", [
    { email: SUBSCRIBER, plan: "team", status: "superseded", created_at: "2026-01-01T00:00:00Z" },
    { email: SUBSCRIBER, plan: "enterprise", status: "active", created_at: "2026-06-01T00:00:00Z" },
  ]);
  const { POST } = await route();
  const body = await (await POST(ask({ email: SUBSCRIBER }))).json();
  expect(body.plan).toBe("enterprise");
});

it("reports a non-subscriber as inactive", async () => {
  const { POST } = await route();
  const body = await (await POST(ask({ email: "stranger@example.com" }))).json();
  expect(body).toMatchObject({ ok: true, active: false });
});

it("does not report a store it could not reach as 'not subscribed' — THE regression", async () => {
  db.dropTable("subscriptions");
  const { POST } = await route();
  const res = await POST(ask({ email: SUBSCRIBER }));
  // The old code answered 200 { active: false } here, which is a claim about the
  // customer. It is a claim about us.
  expect(res.status).toBe(503);
  expect((await res.json()).ok).toBe(false);
});

it("says so when Supabase is not configured rather than denying the customer", async () => {
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const { POST } = await route();
  expect((await POST(ask({ email: SUBSCRIBER }))).status).toBe(503);
});

it("rejects a malformed body", async () => {
  const { POST } = await route();
  expect((await POST(ask("{oops"))).status).toBe(400);
});

it("treats a missing email as inactive without touching the store", async () => {
  const { POST } = await route();
  const res = await POST(ask({}));
  expect(res.status).toBe(200);
  expect((await res.json()).active).toBe(false);
  expect(db.calls).toHaveLength(0);
});

it("matches an email the user typed with different capitalisation", async () => {
  db.seed("subscriptions", [
    { email: SUBSCRIBER, plan: "team", status: "active", created_at: "2026-01-01T00:00:00Z" },
  ]);
  const { POST } = await route();
  const body = await (await POST(ask({ email: " OPS@NorthHall.Example " }))).json();
  expect(body.active).toBe(true);
});

it("keeps a subscriber active while Stripe retries a failed payment", async () => {
  db.seed("subscriptions", [
    { email: SUBSCRIBER, plan: "team", status: "past_due", created_at: "2026-01-01T00:00:00Z" },
  ]);
  const { POST } = await route();
  expect((await (await POST(ask({ email: SUBSCRIBER }))).json()).active).toBe(true);
});

it("drops a cancelled subscriber", async () => {
  db.seed("subscriptions", [
    { email: SUBSCRIBER, plan: "team", status: "cancelled", created_at: "2026-01-01T00:00:00Z" },
  ]);
  const { POST } = await route();
  expect((await (await POST(ask({ email: SUBSCRIBER }))).json()).active).toBe(false);
});
