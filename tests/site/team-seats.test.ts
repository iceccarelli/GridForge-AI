/**
 * Seat and membership invariants, in-memory backend. The same scenarios run against REAL PostgreSQL in team-seats.realdb.test.ts;
 * this file keeps them running where there is no database, and holds the checks that only make sense against the fake
 * (the deploy window before migration 0027).
 */
import { describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";
import { installWithAuth, bearerFor } from "./auth-fake";
import { installTeamRpcs } from "./team-rpc-fake";
import { defineTeamScenarios } from "./team-scenarios";

function fakeDb(): PostgrestFake {
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  const db = new PostgrestFake(["subscriptions", "scenarios", "customer_notifications"]);
  db.uniqueKeys.set("customer_notifications", [["dedupe_key"]]);
  db.rowDefaults.set("customer_notifications", () => ({
    status: "pending", attempts: 0, max_attempts: 6, next_attempt_at: new Date(0).toISOString(), claimed_until: null, last_error: null,
    last_http_status: null, provider_message_id: null, accepted_at: null, origin: "webhook", reopened_count: 0,
  }));
  installTeamRpcs(db);
  return db;
}

describe("team seats — in-memory PostgREST", () => {
  defineTeamScenarios({
    async install() {
      const db = fakeDb();
      const undo = db.install();
      return undo;
    },
  });
});

describe("the deploy window: code live before migration 0027", () => {
  it("a non-subscriber is still a 402 and a subscriber is untouched, when the membership function does not exist yet", async () => {
    const db = fakeDb();
    db.rpcs.delete("gf_member_entitlement");
    db.seed("subscriptions", [{ email: "ops@northhall.example", plan: "team", status: "active", created_at: "2026-01-01T00:00:00Z" }]);
    const { restore } = installWithAuth(db);
    try {
      const { GET } = await import("@/app/api/scenarios/route");
      const get = (as: string) => GET(new Request(siteUrl("/api/scenarios"), { headers: bearerFor(as) }));
      expect((await get("someone@else.example")).status).toBe(402);
      expect((await get("ops@northhall.example")).status).toBe(200);
    } finally {
      restore();
    }
  });

  it("any other failure of the membership lookup is a 503, never a 402", async () => {
    const db = fakeDb();
    db.rpcs.set("gf_member_entitlement", () => { throw new Error("boom"); });
    const { restore } = installWithAuth(db);
    try {
      const { GET } = await import("@/app/api/scenarios/route");
      const r = await GET(new Request(siteUrl("/api/scenarios"), { headers: bearerFor("someone@else.example") }));
      expect(r.status).toBe(503);
    } finally {
      restore();
    }
  });

  it("a malformed answer from the lookup grants nothing", async () => {
    const db = fakeDb();
    db.rpcs.set("gf_member_entitlement", () => ({ owner_email: "a@b.example", subscription: { id: "x", email: "a@b.example", plan: "team", status: "cancelled" } }));
    const { restore } = installWithAuth(db);
    try {
      const { GET } = await import("@/app/api/scenarios/route");
      const r = await GET(new Request(siteUrl("/api/scenarios"), { headers: bearerFor("someone@else.example") }));
      expect(r.status).toBe(402);
    } finally {
      restore();
    }
  });
});
