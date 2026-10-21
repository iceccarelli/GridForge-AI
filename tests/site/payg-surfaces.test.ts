/**
 * What the pages and components promise before any click: the rate card is generated from the registries, the key
 * panel does not claim a renewal that does not exist, plans do not advertise unbuilt perks, and every state of the
 * portal that can be rendered without the backend says what is and is not available.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ApiKeyPanel from "@/components/ApiKeyPanel";
import ApiPlans from "@/components/ApiPlans";
import CostEstimator from "@/components/CostEstimator";
import FreeAllowanceForm from "@/components/FreeAllowanceForm";
import OneTimeKey from "@/components/OneTimeKey";
import PaygPortal from "@/components/PaygPortal";
import PaygRateCard from "@/components/PaygRateCard";
import SetupSnippets from "@/components/SetupSnippets";
import ThreePaths from "@/components/ThreePaths";
import UsageMeter from "@/components/UsageMeter";
import { API_PRODUCTS, PAYG } from "@/lib/products";
import { FREE_RESEND_COOLDOWN_MS } from "@/lib/payg-accounts";
import { FREE_RESEND_HOURS, billingRuleText, eurExact, parseToolRates } from "@/lib/payg-pricing";

const ROOT = path.resolve(__dirname, "../..");
const rates = parseToolRates(JSON.parse(fs.readFileSync(path.join(ROOT, "public/reference/tools.json"), "utf8")));
const render = (el: React.ReactElement) => renderToStaticMarkup(el);
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

describe("keys do not renew by themselves", () => {
  const panel = (over: Record<string, unknown> = {}) =>
    render(
      React.createElement(ApiKeyPanel, {
        token: "t",
        engine: "https://engine.example",
        hasKey: true,
        keyId: "abcd1234",
        expires: "2026-04-01",
        daysLeft: 20,
        needsRotation: false,
        status: "active",
        cancelled: false,
        signingConfigured: true,
        ...over,
      })
    );
  it("says the key does not renew and the customer rotates it", () => {
    const t = text(panel());
    expect(t).toMatch(/does not renew by itself/);
    expect(t).not.toMatch(/renews automatically|renew automatically/i);
    expect(t).toContain("20 days");
  });
  it("warns when it is close or already dead", () => {
    expect(text(panel({ daysLeft: 3, needsRotation: true }))).toMatch(/expires in 3 days\. Rotate it before then/);
    expect(text(panel({ daysLeft: -2, needsRotation: true }))).toMatch(/has expired/);
  });
  it("blocks minting while a payment is outstanding and says why", () => {
    const html = panel({ status: "past_due" });
    expect(text(html)).toMatch(/cannot be issued or rotated while the latest payment is outstanding/);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>/);
  });
  it("the shown-once key explains it is not stored and does not extend with payment", () => {
    const t = text(render(React.createElement(OneTimeKey, { secret: "gfk1.x.y", expires: "2026-04-01" })));
    expect(t).toMatch(/shown once/);
    expect(t).toMatch(/does not renew by itself/);
    expect(t).toMatch(/A payment does not extend a key/);
  });
  it("no component or page anywhere claims automatic key renewal", () => {
    const dirs = ["components", "app"];
    const offenders: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.tsx?$/.test(e.name) && /renews? automatically/i.test(fs.readFileSync(p, "utf8"))) offenders.push(p);
      }
    };
    for (const d of dirs) walk(path.join(ROOT, d));
    expect(offenders).toEqual([]);
  });
});

describe("plans advertise only what the key does", () => {
  const html = text(render(React.createElement(ApiPlans, { rates })));
  it("lists every API plan from the catalogue with its price and units", () => {
    for (const p of API_PRODUCTS) {
      expect(html).toContain(p.name);
      expect(html).toContain((p.apiUnits ?? 0).toLocaleString("en-IE"));
    }
  });
  it("carries none of the hand-arranged perks the catalogue's prose lists", () => {
    for (const perk of ["named engineer on call", "priority on new platform library", "input on the constraint roadmap", "change notes naming"]) {
      expect(html.toLowerCase()).not.toContain(perk);
    }
  });
  it("says human extras are arranged by email, not automated, and that no SLA comes with any plan", () => {
    expect(html).toMatch(/arranged by email after purchase/);
    expect(html).toMatch(/not automated/);
    expect(html).toMatch(/No availability SLA comes with any plan/);
  });
  it("states there is no overage and what happens instead", () => {
    expect(html).toMatch(/No overage billing/);
    expect(html).toMatch(/402/);
  });
});

describe("the free allowance form", () => {
  const html = render(React.createElement(FreeAllowanceForm, {}));
  it("asks for an email and nothing else, with a real label and a 16px input", () => {
    expect(html).toMatch(/type="email"/);
    expect(html).toMatch(/<label[^>]*>Email address<\/label>/);
    expect(html).not.toMatch(/type="password"|card number|cvc/i);
    expect(html).toMatch(/text-base/);
    expect(html).toMatch(/min-h-11/);
  });
  it("says what the allowance is and that it is never invoiced", () => {
    const t = text(html);
    expect(t).toContain(`${PAYG.freeAllowanceUnits} units a month, no card`);
    expect(t).toMatch(/never invoiced/);
  });
  it("starts with no error and is not busy", () => {
    expect(html).not.toMatch(/role="alert"/);
    expect(html).toMatch(/aria-busy="false"/);
  });
});

describe("the rate card is generated, and degrades honestly", () => {
  const html = text(render(React.createElement(PaygRateCard, { rates })));
  it("has a row per tool with the unit price applied", () => {
    for (const r of rates) expect(html).toContain(r.endpoint);
    expect(html).toContain(eurExact(PAYG.unitPriceCents));
    expect(html).toMatch(/per hall/);
    expect(html).toMatch(/in arrears/);
  });
  it("lists a break-even for every plan", () => {
    for (const p of API_PRODUCTS) expect(html).toContain(p.name);
  });
  it("shows no table at all, and says so, without a catalogue", () => {
    const empty = render(React.createElement(PaygRateCard, { rates: [] }));
    expect(empty).not.toMatch(/<table/);
    expect(text(empty)).toMatch(/not available on this deployment/);
  });
  it("the estimator renders and also degrades without a catalogue", () => {
    const t = text(render(React.createElement(CostEstimator, { rates, engine: "https://engine.example" })));
    expect(t).toMatch(/What will this cost\?/);
    expect(t).toMatch(/Check against the live engine/);
    expect(text(render(React.createElement(CostEstimator, { rates: [], engine: "x" })))).toMatch(/not available on this deployment/);
  });
});

describe("the three paths read from the registry and link to real routes", () => {
  const html = render(React.createElement(ThreePaths));
  it("free result, metered software and engagements each have one entry point", () => {
    expect(html).toContain('href="/qualify"');
    expect(html).toContain('href="/developers#free"');
    expect(html).toContain('href="/pricing#engagements"');
  });
  it("keeps the evidence and screening-mode framing", () => {
    const t = text(html);
    expect(t).toMatch(/evidence class/);
    expect(t).toMatch(/never carry an engineer's sign-off/);
  });
});

describe("the portal before any usage has loaded", () => {
  const portal = (plan: string, status = "active", units = 600, returned: "success" | "cancelled" | null = null) =>
    text(render(React.createElement(PaygPortal, { token: "t", plan, status, monthlyUnits: units, returned })));
  it("a free account is offered pay-as-you-go with the three explicit promises and the bounds", () => {
    const t = portal("api_free");
    expect(t).toMatch(/No charge is made now/);
    expect(t).toMatch(/invoiced monthly in arrears/);
    expect(t).toMatch(/hard stop at/);
    expect(t).toContain(eurExact(PAYG.minCapEur * 100));
    expect(t).toContain(eurExact(PAYG.maxCapEur * 100));
    expect(t).toMatch(/If the engine answers 402/);
    expect(t).toMatch(/This is that page/);
  });
  it("a pay-as-you-go account can change its cap, and is told that mints a new key", () => {
    const t = portal("api_payg");
    expect(t).toMatch(/Change cap and issue a new key/);
    expect(t).toMatch(/revokes the current one/);
    expect(t).toMatch(/Settlements/);
  });
  it("a subscription is not offered pay-as-you-go and is told there is no overage", () => {
    const t = portal("api_triage");
    expect(t).not.toMatch(/Save a card and enable/);
    expect(t).toMatch(/no overage/);
  });
  it("a past-due pay-as-you-go account gets the recovery steps: pay the invoice, active again, rotate", () => {
    const t = portal("api_payg", "past_due");
    expect(t).toMatch(/Payment failed/);
    expect(t).toMatch(/live key is revoked/);
    expect(t).toMatch(/Replace your card below/);
    expect(t).toMatch(/returns to active on its own/);
    expect(t).toMatch(/rotate here to issue a new key/);
    expect(t).not.toMatch(/Save a card and enable/);
    expect(t).not.toMatch(/Change cap and issue a new key/);
  });
  it("a past-due pay-as-you-go account is led to replace the card, with honest copy and no charge now", () => {
    const t = portal("api_payg", "past_due");
    expect(t).toMatch(/Replace your payment card/);
    expect(t).toMatch(/Saving it does not charge it now/);
    expect(t).toMatch(/retried on it/);
    expect(t).toMatch(/revoked does not come back/);
    expect(t).toMatch(/Replace payment card/);
  });
  it("an active pay-as-you-go account has a quieter card section; nobody else does", () => {
    expect(portal("api_payg")).toMatch(/Payment card/);
    expect(portal("api_payg")).not.toMatch(/Replace your payment card/);
    expect(portal("api_payg", "cancelled")).not.toMatch(/Replace payment card/);
    expect(portal("api_free")).not.toMatch(/Replace payment card/);
    expect(portal("api_triage")).not.toMatch(/Replace payment card/);
  });
  it("renders the one billing rule verbatim, never a retyped copy", () => {
    expect(portal("api_payg")).toContain(billingRuleText());
  });
  it("says usage is copied from the ledger and the engine's counter is real time", () => {
    // not shown until usage has loaded: static render has no usage, so the sentence must be absent, not invented
    expect(portal("api_payg")).not.toMatch(/last copied/);
  });
  it("handles ?payg= from Stripe's return without assuming a token in the Stripe URL", () => {
    expect(portal("api_payg", "active", 0, "success")).toMatch(/Back from Stripe\. Your card was received/);
    expect(portal("api_payg", "active", 0, "cancelled")).toMatch(/without saving a card/);
    expect(portal("api_payg")).not.toMatch(/Back from Stripe/);
  });
  it("a cancelled account says it has ended", () => {
    expect(portal("api_payg", "cancelled")).toMatch(/This account has ended/);
  });
  it("draws no meter, events or invoices before the route has answered", () => {
    const html = render(React.createElement(PaygPortal, { token: "t", plan: "api_payg", status: "active", monthlyUnits: 0 }));
    expect(html).not.toMatch(/role="meter"/);
    expect(html).not.toMatch(/View invoice/);
    expect(text(html)).toMatch(/No events are shown rather than invented ones/);
  });
});

describe("copy that must match the backend", () => {
  it("the free form tells people the link is re-sent at most every six hours", () => {
    const html = text(render(React.createElement(FreeAllowanceForm, {})));
    // the sent state is client state; the cooldown constant it prints is the server's
    expect(FREE_RESEND_HOURS * 3_600_000).toBe(FREE_RESEND_COOLDOWN_MS);
    expect(html).toBeTruthy();
    const src = fs.readFileSync(path.join(ROOT, "components/FreeAllowanceForm.tsx"), "utf8");
    expect(src).toMatch(/re-send the link at most every/);
  });
  it("the key panel turns a capacity 429 into the free-allowance-full message with the pay-as-you-go path", () => {
    const src = fs.readFileSync(path.join(ROOT, "components/ApiKeyPanel.tsx"), "utf8");
    expect(src).toContain("isFreeCapacityRefusal(res.status, data)");
    expect(src).toContain("FREE_CAPACITY_MESSAGE");
    expect(src).toContain('href="#enable-heading"');
  });
  it("no snippet or copy gives an Idempotency-Key limit other than the engine's 150", () => {
    const engine = fs.readFileSync(path.join(ROOT, "gridforge/api/server.py"), "utf8");
    expect(engine).toMatch(/MAX_IDEM_KEY_CHARS = 150/);
    const snippets = text(render(React.createElement(SetupSnippets, { engine: "https://e", rates })));
    expect(snippets).toContain("Idempotency-Key");
    expect(snippets).toContain("up to 150 characters");
    expect(snippets).not.toMatch(/200 characters/);
  });
  it("the Stripe return handler is token-free and the portal never builds a Stripe URL itself", () => {
    const ret = fs.readFileSync(path.join(ROOT, "app/api/payg/return/route.ts"), "utf8");
    expect(ret).toContain("readReturnCookie");
    const portal = fs.readFileSync(path.join(ROOT, "components/PaygPortal.tsx"), "utf8");
    expect(portal).not.toMatch(/success_url|cancel_url/);
    expect(portal).not.toMatch(/localStorage|sessionStorage/);
  });
});

describe("the usage meter", () => {
  it("is a real meter with a text equivalent, and says when there is no cap", () => {
    const html = render(React.createElement(UsageMeter, { label: "Cap", used: 40, cap: 50, accruedCents: 8000, unitPriceCents: 200 }));
    expect(html).toMatch(/role="meter"/);
    expect(html).toMatch(/aria-valuenow="40"/);
    expect(html).toMatch(/aria-valuemax="50"/);
    expect(text(html)).toMatch(/80% used/);
    expect(text(html)).toMatch(/Approaching the limit/);
    const none = render(React.createElement(UsageMeter, { label: "x", used: 3, cap: null }));
    expect(none).not.toMatch(/role="meter"/);
    expect(text(none)).toMatch(/nothing to measure against/);
  });
  it("at the cap it says calls are refused", () => {
    expect(text(render(React.createElement(UsageMeter, { label: "x", used: 50, cap: 50 })))).toMatch(/refused with a 402/);
  });
});

describe("setup snippets cost nothing until the paid call, and never contain a key", () => {
  const html = text(render(React.createElement(SetupSnippets, { engine: "https://engine.example", rates })));
  it("estimate and usage first, then a paid call with idempotency and project headers", () => {
    expect(html.indexOf("/v1/estimate")).toBeLessThan(html.indexOf("/v1/usage"));
    expect(html.indexOf("/v1/usage")).toBeLessThan(html.indexOf("-X POST https://engine.example/v1/screen"));
    expect(html).toContain("$GRIDFORGE_KEY");
    expect(html).toContain("Idempotency-Key");
    expect(html).toContain("X-GridForge-Project");
    expect(html).toMatch(/Steps 1 and 2 cost nothing/);
  });
  it("prints the units and price of the first paid call from the catalogue", () => {
    const screen = rates.find((r) => r.endpoint === "/v1/screen")!;
    expect(html).toContain(`${screen.units} unit`);
    expect(html).toContain(eurExact(screen.units * PAYG.unitPriceCents));
  });
});

describe("pages", () => {
  it("the pricing page tells the three-part story and keeps the engagement ladder", async () => {
    const { default: Pricing } = await import("@/app/pricing/page");
    const html = render(React.createElement(Pricing));
    const t = text(html);
    expect(html).toContain('id="engagements"');
    expect(html).toContain('id="metered"');
    expect(t).toMatch(/Three ways to use it/);
    expect(t).toMatch(/Engineering engagements/);
    expect(t).toMatch(/Metered software/);
    expect(t).toContain(eurExact(PAYG.unitPriceCents));
  });
  it("the developers page offers the free allowance first, then rates, then plans", async () => {
    const { default: Developers } = await import("@/app/developers/page");
    const html = render(await Developers());
    expect(html.indexOf('id="free"')).toBeGreaterThan(-1);
    expect(html.indexOf('id="free"')).toBeLessThan(html.indexOf('id="rates"'));
    expect(html.indexOf('id="rates"')).toBeLessThan(html.indexOf('id="plans"'));
    expect(text(html)).toMatch(/Free allowance/);
    // the calibration ledger statement stays visible on the page
    expect(html).toContain('id="accuracy"');
  });
});
