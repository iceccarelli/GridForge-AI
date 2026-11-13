/**
 * /commissioned, after a deposit is paid: the page says "No contact from us?" and must give a way to make contact other than replying to a
 * Stripe receipt. The non-deposit branch already carried the site's contact address; the deposit branch (the buyer of a four- or five-figure
 * deposit, who is waiting for a person to call) did not.
 *
 * The address is the site's single contact constant (lib/site.ts SITE.email). It is never typed in the page, and the test reads it from there.
 */
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestFake } from "./postgrest-fake";

(globalThis as { React?: unknown }).React = React;

let db: PostgrestFake;
let restore: () => void;

beforeEach(() => {
  vi.resetModules();
  process.env.SUPABASE_URL = "https://stub.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_test";
  delete process.env.STRIPE_SECRET_KEY;
  db = new PostgrestFake(["engagement_deposits", "deliverables", "api_accounts", "watches"]);
  restore = db.install();
});
afterEach(() => {
  restore();
  vi.doUnmock("@/lib/site");
});

function deposit(status: string, over: Record<string, unknown> = {}) {
  db.seed("engagement_deposits", [
    { stripe_session_id: "cs_dep", kind: "envelope_study_deposit", amount_cents: 900_000, currency: "eur", email: "buyer@hall.example", status, owner: "Ada", paid_at: new Date().toISOString(), ...over },
  ]);
}
async function page(): Promise<string> {
  const { default: Page } = await import("@/app/commissioned/page");
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ session_id: "cs_dep" }) })).replace(/<!-- -->/g, "");
}

describe("the deposit branch of /commissioned", () => {
  it.each(["paid", "contacted", "scoped", "delivered"])("a %s deposit carries the site's contact address as a mailto link", async (status) => {
    deposit(status);
    const { SITE } = await import("@/lib/site");
    const html = await page();
    expect(html).toContain("No contact from us?");
    expect(html).toContain(`href="mailto:${SITE.email}"`);
    expect(html).toContain(`>${SITE.email}</a>`);
    // The Stripe-receipt route is still offered, as before.
    expect(html).toContain("Reply to the Stripe receipt");
  });

  it("is the same contact line the non-deposit branch uses: the address comes from SITE, so changing it changes both", async () => {
    vi.doMock("@/lib/site", async (orig) => {
      const real = await orig<typeof import("@/lib/site")>();
      return { ...real, SITE: { ...real.SITE, email: "someone.else@example.test" } };
    });
    deposit("paid");
    const html = await page();
    expect(html).toContain('href="mailto:someone.else@example.test"');
    expect(html).not.toContain("power@timetopower.ai");
  });

  it("the page source types no email address of its own", () => {
    const code = fs.readFileSync("app/commissioned/page.tsx", "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });
});
