/**
 * Third-pass copy findings: what is free and what is paid, no promised reply time, a hero that matches what the engine
 * models, a privacy page written from the code, no stray "1" unit, and the subscription management control.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import PaygPortal from "@/components/PaygPortal";
import { displayUnit, quantityText } from "@/lib/quantity-text";
import { UNAVAILABLE_MESSAGE, openBillingPortal, type FetchLike } from "@/lib/payg-client";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

describe("what is free and what is paid is said truthfully", () => {
  it("the qualifier page names the free comparison and where the paid line really is", async () => {
    const { default: Qualify } = await import("@/app/qualify/page");
    const t = text(renderToStaticMarkup(React.createElement(Qualify)));
    expect(t).toContain("Where the paid line is");
    expect(t).toContain("The free qualifier shows the binding constraint and the rack count.");
    expect(t).toContain("The free Time-to-Power comparison also shows scenarios with indicative capital cost and time to full capacity, each with its evidence class");
    expect(t).toContain("human-reviewed engagements, and metered engine usage beyond the free allowance");
    expect(t).not.toMatch(/withholds them server-side/);
    expect(t).not.toMatch(/Those are the paid engagement/);
  });
  it("no free surface still says capital cost or programme duration are withheld or paid-only", () => {
    for (const f of ["app/qualify/page.tsx", "components/CapacityQualifier.tsx", "components/HomeClient.tsx", "app/q/[token]/page.tsx"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/capital cost and programme duration are (part of the engagement|the paid engagement)/i);
      expect(src, f).not.toMatch(/withholds them server-side|engine withholds/i);
      expect(src, f).not.toMatch(/Capital cost, programme duration,? (in weeks, )?the full constraint/i);
    }
  });
});

describe("no promise about when we will reply", () => {
  it("the enquiry and chat emails promise nothing about timing", () => {
    for (const f of ["app/api/audit/route.ts", "app/api/chat/route.ts"]) {
      const src = read(f);
      expect(src, f).not.toMatch(/business days?|within \d/i);
      expect(src, f).toContain("We make no promise about when we will reply.");
    }
  });
  it("llms.txt stays consistent: no response time is promised", () => {
    const llms = read("app/llms.txt/route.ts");
    expect(llms).toMatch(/no response time is\s+promised/);
    expect(llms).not.toMatch(/business days?/i);
  });
});

describe("the hero describes what the engine models", () => {
  it("existing halls, a time-to-power estimate and its evidence class; no 'proposed site' and no 'go live'", () => {
    for (const f of ["components/HomeClient.tsx", "components/Footer.tsx"]) {
      const t = read(f).replace(/\s+/g, " ");
      expect(t, f).not.toMatch(/existing or proposed AI/i);
      expect(t, f).not.toMatch(/when the compute can go live/i);
    }
    const home = read("components/HomeClient.tsx").replace(/\s+/g, " ");
    expect(home).toContain("Give us the technical information for an existing AI hall");
    expect(home).toContain("the time to full capacity, with the evidence class behind each figure");
    expect(home).toContain("labelled as one, not as a date");
    expect(read("components/Footer.tsx").replace(/\s+/g, " ")).toContain("the owner of an existing AI hall");
  });
});

describe("the privacy page is a factual description written from the code", () => {
  it("lists each service and what it receives, and says what is stored", async () => {
    const { default: Privacy } = await import("@/app/legal/privacy/page");
    const t = text(renderToStaticMarkup(React.createElement(Privacy)));
    for (const s of ["Supabase", "Stripe", "Resend", "Anthropic", "Vercel", "Fly.io"]) expect(t).toContain(s);
    expect(t).toContain("What you type into the chat or the siting analyst");
    expect(t).toContain("Card details never reach this site's servers");
    expect(t).toContain("The numbers you enter, the optional site name");
    expect(t).toContain("anyone who holds it can read that stored read");
  });
  it("makes no compliance or retention promise, and is marked for the operator's legal review", async () => {
    const { default: Privacy } = await import("@/app/legal/privacy/page");
    const t = text(renderToStaticMarkup(React.createElement(Privacy)));
    expect(t).not.toMatch(/GDPR|compliant|compliance with|we retain|retention period|EU-hosted|certified/i);
    expect(t).toContain("draft for the operator's legal review");
    expect(t).toContain("No automatic deletion is built into the site");
    expect(t).toContain("TEMPLATE NOTICE");
  });
  it("every service it names is really called by the code", () => {
    expect(read("lib/mail.ts")).toContain("https://api.resend.com/emails");
    expect(read("lib/ai/agent.ts")).toContain("@anthropic-ai/sdk");
    expect(read("app/api/siting-analysis/route.ts")).toContain("anthropic.messages.create");
    expect(read("app/api/qualify/route.ts")).toContain("/rest/v1/qualifications");
    expect(read("fly.toml")).toContain('app = "gridforge-engine"');
    expect(read("vercel.json").length).toBeGreaterThan(2);
    expect(read("app/api/checkout/route.ts")).toMatch(/stripe/i);
    // the claims about the absence of trackers: no analytics package is a dependency
    const pkg = JSON.parse(read("package.json"));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(" ");
    expect(deps).not.toMatch(/analytics|gtag|posthog|plausible|sentry|segment|hotjar/i);
  });
  it("no retention is implemented that the page could have promised", () => {
    const sql = fs.readdirSync(path.join(ROOT, "supabase/migrations")).map((f) => read(`supabase/migrations/${f}`)).join("\n");
    expect(sql).not.toMatch(/qualifications[^;]*retention|delete from (public\.)?(qualifications|leads)\b/i);
  });
});

describe("dimensionless values carry no stray unit", () => {
  it("'0.97 1' and '0.9 1' print as '0.97' and '0.9'", () => {
    expect(quantityText(0.97, "1")).toBe("0.97");
    expect(quantityText(0.9, "1")).toBe("0.9");
    for (const u of ["", " 1 ", "-", "—", "dimensionless", "Ratio", null, undefined, 1]) expect(quantityText(0.5, u)).toBe("0.5");
  });
  it("real units keep their spacing", () => {
    expect(quantityText(38, "°C")).toBe("38 °C");
    expect(quantityText(1200, "kW")).toBe("1200 kW");
    expect(quantityText("+0.40", "%")).toBe("+0.40 %");
    expect(displayUnit("racks")).toBe("racks");
    expect(displayUnit("1")).toBe("");
  });
  it("the pages that print a value and a unit use the helper, not a template", () => {
    for (const f of ["app/deliverable/[token]/page.tsx", "components/ai/ProjectPanel.tsx", "components/ai/CapacityCard.tsx", "components/ai/HeadroomLadderCard.tsx"]) {
      expect(read(f), f).toContain('from "@/lib/quantity-text"');
    }
    expect(read("app/deliverable/[token]/page.tsx")).not.toMatch(/\$\{c\.value\}\$\{c\.unit/);
    expect(read("components/ai/ProjectPanel.tsx")).not.toMatch(/\$\{o\.(predicted|observed)_value\} \$\{o\.unit\}/);
  });
});

describe("manage or cancel subscription", () => {
  const portal = (plan: string, status = "active", hasStripeCustomer = true) =>
    text(renderToStaticMarkup(React.createElement(PaygPortal, { token: "t", plan, status, monthlyUnits: 600, hasStripeCustomer })));
  it("is offered to a subscription with a Stripe customer, with the honest copy", () => {
    const t = portal("api_triage");
    expect(t).toContain("Manage or cancel subscription");
    expect(t).toContain("follows the terms Stripe shows you there");
    expect(t).toContain("a revoked key does not return");
  });
  it("is not offered without a customer, on a cancelled account, or to free and pay-as-you-go accounts", () => {
    expect(portal("api_triage", "active", false)).not.toContain("Manage or cancel subscription");
    expect(portal("api_triage", "cancelled")).not.toContain("Manage or cancel subscription");
    expect(portal("api_free")).not.toContain("Manage or cancel subscription");
    expect(portal("api_payg")).not.toContain("Manage or cancel subscription");
  });
  it("past-due subscriptions can still reach it", () => {
    expect(portal("api_scale", "past_due")).toContain("Manage or cancel subscription");
  });
});

describe("openBillingPortal (POST /api/billing/portal)", () => {
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  const f = (r: Response): FetchLike & { calls: [string, RequestInit | undefined][] } => {
    const calls: [string, RequestInit | undefined][] = [];
    const fn = (async (u: string, i?: RequestInit) => {
      calls.push([u, i]);
      return r;
    }) as FetchLike & { calls: typeof calls };
    fn.calls = calls;
    return fn;
  };
  it("posts the token and returns Stripe's https url", async () => {
    const fetchFn = f(json({ ok: true, url: "https://billing.stripe.com/p/session/x" }));
    expect(await openBillingPortal("tok", fetchFn)).toEqual({ ok: true, data: { url: "https://billing.stripe.com/p/session/x" } });
    expect(fetchFn.calls[0][0]).toBe("/api/billing/portal");
    expect(JSON.parse(String(fetchFn.calls[0][1]?.body))).toEqual({ token: "tok" });
  });
  it("409 is a refusal the control hides on; 404 and 503 are 'not available on this deployment'", async () => {
    expect(await openBillingPortal("t", f(json({ ok: false, error: "no customer" }, 409)))).toMatchObject({ ok: false, kind: "invalid", status: 409 });
    for (const status of [404, 503]) {
      const r = await openBillingPortal("t", f(new Response("<html>", { status })));
      expect(r).toMatchObject({ ok: false, kind: "unavailable" });
      if (!r.ok) expect(r.message).toContain(UNAVAILABLE_MESSAGE);
    }
    expect(await openBillingPortal("t", f(json({ ok: true, url: "http://x" })))).toMatchObject({ ok: false });
  });
  it("the control hides itself on 409", () => {
    expect(read("components/PaygPortal.tsx")).toMatch(/res\.status === 409[\s\S]{0,80}setHidden\(true\)/);
  });
});
