/**
 * What the site says about cancelling is what the product does.
 *
 * /developers (components/ApiPlans.tsx) used to say "To cancel, write to <address>" while the account page of the very same plan offered a
 * self-service "Manage or cancel subscription" button that opens Stripe's billing portal. Each place now says what is true of it, and the
 * sentence is tied to the capability: the sales copy names the control by the SAME constant the account page renders (lib/subscription-manage.ts),
 * and a test renders the account page for every plan the sales copy sells.
 *
 * Which plan kinds have self-service cancel (read from components/PaygPortal.tsx, components/WatchManage.tsx and app/api/billing/portal/route.ts):
 *   - the API subscription plans (api_triage, api_scale, api_platform): yes, from the account page, when a Stripe customer is on record;
 *   - Hall Watch: yes, from its page (components/WatchManage.tsx);
 *   - the free allowance and pay-as-you-go: there is no subscription to cancel, and no button.
 * What no test here can prove is that the Stripe Billing Portal is configured to allow cancelling (it lives in the Stripe dashboard).
 */
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ApiPlans from "@/components/ApiPlans";
import PaygPortal from "@/components/PaygPortal";
import { WatchManage } from "@/components/WatchManage";
import { API_PRODUCTS } from "@/lib/products";
import { SITE } from "@/lib/site";
import { MANAGE_SUBSCRIPTION_LABEL } from "@/lib/subscription-manage";

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
// A tag becomes a space in `text`, so a link at the end of a sentence leaves " ." behind; the copy under test has no such space.
const plans = () => text(renderToStaticMarkup(React.createElement(ApiPlans, { rates: [] }))).replace(/ ([.,;])/g, "$1");
const portal = (plan: string, status = "active", hasStripeCustomer = true) =>
  text(renderToStaticMarkup(React.createElement(PaygPortal, { token: "t", plan, status, monthlyUnits: 600, hasStripeCustomer })));

describe("the page that sells the API subscriptions", () => {
  it("sells subscription plans only: every card is a recurring plan with a Stripe customer behind it", () => {
    expect(API_PRODUCTS.map((p) => p.id)).toEqual(["api_triage", "api_scale", "api_platform"]);
    for (const p of API_PRODUCTS) expect(p.recurring, p.id).toBeTruthy();
  });

  it("says how to cancel in the way the account page offers it, and keeps the email as the other route", () => {
    const t = plans();
    expect(t).toContain(`To cancel, open your account page (the link is in your access email) and choose \u201c${MANAGE_SUBSCRIPTION_LABEL}\u201d, which opens Stripe's billing page; or write to ${SITE.email}.`);
    // It no longer says email is the way to cancel.
    expect(t).not.toMatch(/To cancel, write to/);
    // The rest of the paragraph is unchanged.
    expect(t).toContain("No overage billing");
    expect(t).toContain("No availability SLA comes with any plan.");
  });

  it("the control it names is on the account page of EVERY plan it sells", () => {
    for (const p of API_PRODUCTS) {
      const t = portal(p.id);
      expect(t, p.id).toContain(MANAGE_SUBSCRIPTION_LABEL);
      expect(t, p.id).toContain("opens Stripe's billing page for your subscription");
      expect(t, p.id).toContain("update the card, see invoices and cancel");
    }
  });

  it("the account page of a plan with no Stripe customer, or an already-cancelled one, does not claim the control", () => {
    for (const p of API_PRODUCTS) {
      expect(portal(p.id, "active", false), p.id).not.toContain(MANAGE_SUBSCRIPTION_LABEL);
      expect(portal(p.id, "cancelled"), p.id).not.toContain(MANAGE_SUBSCRIPTION_LABEL);
    }
  });

  it("the sales copy follows the constant: it carries the label the account page renders, not a copy of it", () => {
    const src = fs.readFileSync("components/ApiPlans.tsx", "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(src).toContain("MANAGE_SUBSCRIPTION_LABEL");
    expect(src).not.toContain("Manage or cancel subscription");
    const portalSrc = fs.readFileSync("components/PaygPortal.tsx", "utf8");
    expect(portalSrc).not.toMatch(/>\s*Manage or cancel subscription\s*</);
    expect(portalSrc).not.toMatch(/"Manage or cancel subscription"/);
  });
});

describe("the accounts with nothing to cancel say so, and offer no cancel control", () => {
  it("the free allowance: nothing to cancel", () => {
    const t = portal("api_free");
    expect(t).toContain("Nothing to cancel: the free allowance has no card and no invoice");
    expect(t).not.toContain(MANAGE_SUBSCRIPTION_LABEL);
  });

  it("pay-as-you-go: no subscription to cancel", () => {
    const t = portal("api_payg");
    expect(t).toContain("There is no subscription to cancel");
    expect(t).not.toContain(MANAGE_SUBSCRIPTION_LABEL);
  });
});

describe("Hall Watch has the same control on its own page", () => {
  it("offers the same label, and falls back to email only when the portal cannot be opened", () => {
    const t = text(renderToStaticMarkup(React.createElement(WatchManage, { token: "t", email: SITE.email })));
    expect(t).toContain(MANAGE_SUBSCRIPTION_LABEL);
    expect(t).toContain("Nothing is cancelled by opening the portal");
    // The email route is shown only after a failed attempt (it is state), never as the first instruction.
    expect(t).not.toContain("To cancel or change it now, email");
  });
});
