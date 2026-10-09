/**
 * Where the buyer of an API plan or Hall Watch lands after paying.
 *
 * FAKE: PostgREST (in-memory) and Stripe's session RETRIEVAL (a stub). What is proven is the page's logic
 * given what Stripe says; that a real hosted Checkout redirects here with a real session id is NOT proven
 * (no test-mode credential).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PostgrestFake } from "./postgrest-fake";

(globalThis as { React?: unknown }).React = React;

const sessions = new Map<string, Record<string, unknown>>();
let retrieveFails = false;
vi.mock("stripe", async (orig) => {
  const real: any = await orig();
  return {
    default: class extends real.default {
      constructor(key: string) {
        super(key);
        (this as any).checkout = {
          sessions: {
            retrieve: async (id: string) => {
              if (retrieveFails) throw new Error("stripe unreachable");
              const s = sessions.get(id);
              if (!s) throw new Error("No such checkout session");
              return s;
            },
          },
        };
      }
    },
  };
});

let db: PostgrestFake;
let restore: () => void;
beforeEach(() => {
  sessions.clear();
  retrieveFails = false;
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  process.env.STRIPE_SECRET_KEY = "sk_test_placeholder";
  db = new PostgrestFake(["deliverables", "api_accounts", "watches"]);
  restore = db.install();
});
afterEach(() => restore());

const paid = (kind: string, sub: string, over: Record<string, unknown> = {}) => ({
  id: "x", status: "complete", payment_status: "paid", subscription: sub, metadata: { kind }, ...over,
});
async function page(sessionId: string) {
  const { default: Page } = await import("@/app/commissioned/page");
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ session_id: sessionId }) }));
}

describe("a paid API plan buyer reaches their account without depending on email", () => {
  it("links to THEIR account (and only theirs) with the plan's allowance", async () => {
    db.seed("api_accounts", [
      { token: "tok_mine", account: "a-1", plan: "api_scale", monthly_units: 2500, status: "active", stripe_subscription_id: "sub_mine" },
      { token: "tok_other", account: "a-2", plan: "api_scale", monthly_units: 2500, status: "active", stripe_subscription_id: "sub_other" },
    ]);
    sessions.set("cs_live_mine", paid("api_scale", "sub_mine"));
    const html = await page("cs_live_mine");
    expect(html).toContain("/api-access/tok_mine");
    expect(html).not.toContain("tok_other");
    expect(html).toContain("2,500 units a month");
    expect(html).not.toMatch(/intake/i);                                         // not the deliverable story
  });

  it("Hall Watch links to its watch", async () => {
    db.seed("watches", [{ token: "w_mine", status: "active", stripe_subscription_id: "sub_w" }]);
    sessions.set("cs_live_w", paid("hall_watch", "sub_w"));
    expect(await page("cs_live_w")).toContain("/watch/w_mine");
  });

  it("paid but not yet recorded: says so, offers no link, invents nothing", async () => {
    sessions.set("cs_live_p", paid("api_triage", "sub_not_yet"));
    const html = await page("cs_live_p");
    expect(html).toContain("being set up");
    expect(html).not.toContain("/api-access/");
  });
});

describe("the URL alone proves nothing: Stripe must say the session is complete and paid and ours", () => {
  it.each([
    ["unpaid", paid("api_triage", "sub_u", { payment_status: "unpaid" })],
    ["open (not completed)", paid("api_triage", "sub_u", { status: "open" })],
    ["no subscription", paid("api_triage", "", { subscription: null })],
    ["a kind that is not a subscription product", paid("density_screen", "sub_u")],
    ["an unknown kind", paid("something_else", "sub_u")],
  ])("%s -> no link", async (_n, session) => {
    db.seed("api_accounts", [{ token: "tok_u", account: "a-u", plan: "api_triage", monthly_units: 600, status: "active", stripe_subscription_id: "sub_u" }]);
    sessions.set("cs_live_u", session as Record<string, unknown>);
    expect(await page("cs_live_u")).not.toContain("tok_u");
  });

  it("a made-up session id, a malformed one, and an unreachable Stripe all fall back to the generic page", async () => {
    db.seed("api_accounts", [{ token: "tok_z", account: "a-z", plan: "api_triage", monthly_units: 600, status: "active", stripe_subscription_id: "sub_z" }]);
    expect(await page("cs_live_nope")).not.toContain("tok_z");
    expect(await page("../../etc/passwd")).not.toContain("tok_z");
    sessions.set("cs_live_z", paid("api_triage", "sub_z"));
    retrieveFails = true;
    expect(await page("cs_live_z")).not.toContain("tok_z");
  });

  it("a deliverable purchase is unchanged: it still gets its intake, not this page", async () => {
    db.seed("deliverables", [{ kind: "density_screen", status: "awaiting_intake", stripe_session_id: "cs_live_d", token: "doc", intake_token: "intk" }]);
    const html = await page("cs_live_d");
    expect(html).toContain("/intake/intk");
  });
});
