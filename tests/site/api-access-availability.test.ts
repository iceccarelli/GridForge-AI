/**
 * The customer's API account page lists what they are billed for. While the deployed engine does not serve an operation,
 * it must not be listed as billable and no snippet may teach the customer to call it; when the engine serves it, the
 * page follows without a site redeploy.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NOT_YET_AVAILABLE } from "@/lib/payg-pricing";
import { FULL_ENGINE, STALE_ENGINE, stubEngine } from "./engine-stub";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }), notFound: () => { throw new Error("notFound"); } }));
vi.mock("@/lib/api-access", async (orig) => ({
  ...(await orig<typeof import("@/lib/api-access")>()),
  getApiAccount: async () => ({
    account: "acct_test", plan: "api_payg", status: "active", monthly_units: 0, key_id: null, key_expires_at: null,
    stripe_customer_id: null, revoked_key_ids: [], token: "tok",
  }),
  signingConfigured: () => true,
}));

async function render(routes: string[] | "down") {
  const stop = stubEngine(routes);
  try {
    const Page = (await import("@/app/api-access/[token]/page")).default;
    const el = await Page({ params: Promise.resolve({ token: "tok" }), searchParams: Promise.resolve({}) });
    return renderToStaticMarkup(el).replace(/<!-- -->/g, "");
  } finally {
    stop();
  }
}

describe("/api-access/[token] follows the deployed engine", () => {
  it("stale engine: unserved operations are not billable, say so, and no snippet teaches the customer to call them", async () => {
    const html = await render(STALE_ENGINE);
    for (const unserved of ["/v1/compare", "/v1/power/assess", "/v1/power/deploy/assess"]) {
      expect(html, unserved).toContain(unserved); // named, so the customer can see why it is missing...
    }
    expect(html).toContain(NOT_YET_AVAILABLE);
    expect(html).toMatch(/Not billable until it is served/);
    expect(html).not.toMatch(/curl[^<]*\/v1\/compare/); // ...but never offered as a call
    expect(html).not.toMatch(/curl[^<]*\/v1\/estimate/);
  });

  it("engine unreachable: nothing is presented as callable or billable", async () => {
    const html = await render("down");
    expect(html).not.toMatch(/curl[^<]*\/v1\/(compare|estimate|power)/);
    expect(html).toMatch(/not confirmed|Not yet available/i);
  });

  it("fully deployed engine: the operations are billable again and nothing is flagged unserved", async () => {
    const html = await render(FULL_ENGINE);
    expect(html).not.toMatch(/Not billable until it is served/);
    expect(html).toContain("/v1/compare");
  });
});
