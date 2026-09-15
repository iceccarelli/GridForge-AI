/**
 * app/api/siting-analysis — the AI siting analyst, sold only with a plan.
 *
 * The defect: the subscription check was wrapped in `if (url && skey)`. With
 * Supabase unconfigured the gate did not merely fail open, it was not executed at
 * all — the paid analyst answered anybody who posted an email address and a
 * sentence. A surface that reads as protected and is not is worse than one that
 * is openly free, because nobody goes looking.
 *
 * Every case below returns before the Anthropic client is ever constructed, so
 * nothing here reaches a model.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteUrl } from "@/lib/site";
import { PostgrestFake } from "./postgrest-fake";

const SUBSCRIBER = "ops@northhall.example";

let db: PostgrestFake;
let restore: () => void;

async function route() {
  return await import("@/app/api/siting-analysis/route");
}

function ask(body: unknown) {
  return new Request(siteUrl("/api/siting-analysis"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const BRIEF = { email: SUBSCRIBER, brief: "40 MW, Nordics, live Q3, training" };

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = "sk-ant-placeholder-never-called";
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  db = new PostgrestFake(["subscriptions"]);
  restore = db.install();
});

afterEach(() => restore());

describe("the gate", () => {
  it("refuses a caller with no subscription", async () => {
    const { POST } = await route();
    const res = await POST(ask(BRIEF));
    expect(res.status).toBe(402);
  });

  it("does NOT answer for free when Supabase is unconfigured — THE regression", async () => {
    // The old code skipped the entire check in this state and produced a paid
    // analysis for anybody who asked.
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { POST } = await route();
    const res = await POST(ask(BRIEF));
    expect(res.status).toBe(503);
    expect((await res.json()).ok).toBe(false);
  });

  it("does not answer when the subscriptions table cannot be read", async () => {
    db.dropTable("subscriptions");
    const { POST } = await route();
    // 503, not 402: refusing is right, blaming the customer for it is not.
    expect((await POST(ask(BRIEF))).status).toBe(503);
  });

  it("refuses a cancelled subscriber", async () => {
    db.seed("subscriptions", [
      { email: SUBSCRIBER, plan: "team", status: "cancelled", created_at: "2026-01-01T00:00:00Z" },
    ]);
    const { POST } = await route();
    expect((await POST(ask(BRIEF))).status).toBe(402);
  });

  it("will not answer for one subscriber's email on another's behalf", async () => {
    db.seed("subscriptions", [
      { email: SUBSCRIBER, plan: "team", status: "active", created_at: "2026-01-01T00:00:00Z" },
    ]);
    const { POST } = await route();
    const res = await POST(ask({ ...BRIEF, email: "gatecrasher@example.com" }));
    expect(res.status).toBe(402);
  });
});

describe("input", () => {
  it("rejects a malformed body before doing anything else", async () => {
    const { POST } = await route();
    expect((await POST(ask("{oops"))).status).toBe(400);
  });

  it("rejects a brief with no email", async () => {
    const { POST } = await route();
    expect((await POST(ask({ brief: "40 MW" }))).status).toBe(400);
  });

  it("rejects an email with no brief", async () => {
    const { POST } = await route();
    expect((await POST(ask({ email: SUBSCRIBER }))).status).toBe(400);
  });

  it("is unavailable rather than broken when the model key is absent", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const { POST } = await route();
    expect((await POST(ask(BRIEF))).status).toBe(503);
  });
});
