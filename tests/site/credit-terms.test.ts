/**
 * "Credits in full against the full study" was typed, with no condition, on a dozen pages, in an email and in an agent block. The code that
 * honours it applies several (lib/deliverables.ts creditsToward, lib/deposits.ts availableCredits / scope, migrations 0030 and 0045). A promise
 * about money says what the money has to satisfy, so there is ONE sentence (SCREEN_CREDIT_SENTENCE, lib/credits-terms.ts) and every surface that
 * makes the Density Screen -> Study promise prints it.
 *
 * What this file proves: each clause of the sentence is bound to a test that exercises the code behind it (the table below fails if that test is
 * renamed or removed), every surface prints the constant rather than a copy, and a guard fails if an unconditional "credits in full against" is typed
 * again. What it does not: Python surfaces (gridforge/) and components/EngagementLadder.tsx are owned elsewhere and still carry the old wording.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ThreePaths from "@/components/ThreePaths";
import ProductsIndex from "@/app/products/page";
import Terms from "@/app/legal/terms/page";
import { FinalCta, Services } from "@/components/home/Sections";
import { SCREEN_CREDIT_SENTENCE } from "@/lib/credits-terms";
import { creditedEarlier, depositTerms } from "@/lib/engagement-state";
import { engagementOfferBlock } from "@/lib/ai/responses";
import { FAQ, siteUrl } from "@/lib/site";
import { PRODUCTS } from "@/lib/products";
import { RATE_POLICIES, resetMemoryLimiter } from "@/lib/rate-limit";
import { PostgrestFake } from "./postgrest-fake";
import { installWithAuth } from "./auth-fake";

const ROOT = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const text = (html: string) =>
  html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

describe("the sentence states the conditions the code applies", () => {
  it("names each of them", () => {
    const s = SCREEN_CREDIT_SENTENCE;
    expect(s).toContain("credited once");
    expect(s).toContain("against the fee agreed for an Envelope Study");
    expect(s).toContain("for the same email address");
    expect(s).toContain("after we confirm it is the same buyer (the address typed at checkout is not verified)");
    expect(s).toContain("applied whole and only while the deposit and the credit together stay within the agreed fee");
    expect(s).toContain("reduces what is owed and is never paid out as cash");
    expect(s).toContain("a refunded or disputed purchase carries no credit");
  });

  it("claims nothing the code does not apply: no expiry, no percentage, no 'in full' without its conditions", () => {
    expect(SCREEN_CREDIT_SENTENCE).not.toMatch(/\bin full\b|expir|within \d+ (?:days|months)|\d+\s?%|always|guarantee/i);
  });

  it("agrees with the wording the deposit receipt already uses for the same credit (lib/engagement-state.ts creditedEarlier)", () => {
    const earlier = creditedEarlier("envelope_study_deposit");
    expect(earlier).not.toBeNull();
    for (const part of ["credited once", "same email address", "after we confirm it is the same buyer", "the address typed at checkout is not verified"]) {
      expect(earlier, part).toContain(part);
      expect(SCREEN_CREDIT_SENTENCE, part).toContain(part);
    }
    // ...and the deposit's own line (a different credit: the deposit against the agreed fee) is not the one this sentence changes.
    expect(depositTerms("envelope_study_deposit")!.credit).toContain("credited in full against the agreed fee");
  });

  it("each clause is bound to a test that exercises the code behind it", () => {
    const covers: { clause: string; file: string; title: string }[] = [
      { clause: "credited once", file: "tests/site/deposit-handoff.test.ts", title: "never credits the same Screen twice, against a second deposit" },
      { clause: "against the fee agreed for an Envelope Study", file: "tests/site/credits.test.ts", title: "finds a paid Density Screen against the Envelope Study" },
      { clause: "...and no other engagement", file: "tests/site/deposit-handoff.test.ts", title: "does not credit an engagement that credits nothing (the Portfolio Screen)" },
      { clause: "the same email address", file: "tests/site/credits.test.ts", title: "never credits another customer's purchase" },
      { clause: "after we confirm it is the same buyer", file: "tests/site/deposit-handoff.test.ts", title: "credits are applied only when the operator confirms them" },
      { clause: "applied whole, within the agreed fee", file: "tests/site/deposit-handoff.test.ts", title: "a credit never becomes a refund: one that would take deposit + credits past the fee is left unapplied" },
      { clause: "never paid out as cash", file: "tests/site/deposit-handoff.test.ts", title: "refuses a fee below the deposit itself" },
      { clause: "a refunded or disputed purchase carries no credit", file: "tests/site/one-time-purchase-holds.test.ts", title: "a refunded or disputed Density Screen is not offered as a credit" },
    ];
    for (const c of covers) expect(read(c.file), `${c.clause}: "${c.title}" in ${c.file}`).toContain(c.title);
  });
});

describe("every surface that makes the promise prints the constant", () => {
  it("the Terms (section 4)", () => {
    expect(text(renderToStaticMarkup(Terms()))).toContain(SCREEN_CREDIT_SENTENCE);
  });

  it("the three-paths cards on /pricing and /developers", () => {
    const t = text(renderToStaticMarkup(React.createElement(ThreePaths)));
    expect(t).toContain(SCREEN_CREDIT_SENTENCE);
    expect(t).not.toMatch(/credits in full against/i);
  });

  it("the engagements index (/products), where the deposit's own credit keeps its wording", () => {
    const t = text(renderToStaticMarkup(React.createElement(ProductsIndex)));
    expect(t).toContain(SCREEN_CREDIT_SENTENCE);
    expect(t).toContain("the deposit is credited in full against it");
    expect(t).not.toMatch(/Screen, which credits/i);
  });

  it("the home page's service line and final call to action", () => {
    expect(text(renderToStaticMarkup(React.createElement(Services)))).toContain(SCREEN_CREDIT_SENTENCE);
    const cta = text(renderToStaticMarkup(React.createElement(FinalCta)));
    expect(cta).toContain(SCREEN_CREDIT_SENTENCE);
    expect(cta).not.toMatch(/Credits in full against the full study/);
  });

  it("the home page FAQ, which also feeds the structured data", () => {
    const buy = FAQ.find((f) => f.q === "What can I actually buy today?");
    expect(buy?.a).toContain(SCREEN_CREDIT_SENTENCE);
    expect(buy?.a).not.toMatch(/credits in full/i);
  });

  it("the agent's engagement offer block (the label is the sentence, after the price)", () => {
    const block = engagementOfferBlock("gridforge_qualify");
    if (block.type !== "commercialAction") throw new Error("unreachable");
    expect(block.label).toContain(SCREEN_CREDIT_SENTENCE);
    expect(block.label).toContain(PRODUCTS.density_screen.name);
    expect(block.label).not.toMatch(/credits in full/i);
  });

  it("the pages that cannot be rendered here (a stored result, a share link, the pricing page's data, the qualifier's engagement text) import it and type no copy", () => {
    for (const f of ["app/q/[token]/page.tsx", "app/p/[shareToken]/page.tsx", "app/pricing/page.tsx", "lib/qualify-engagement.ts"]) {
      const src = strip(read(f));
      expect(src, f).toContain('from "@/lib/credits-terms"');
      expect(src, f).toContain("SCREEN_CREDIT_SENTENCE");
      expect(src, f).not.toMatch(/credits? in full against/i);
    }
  });

  it("the confirmation email to a hot enquiry (a real request through the audit route)", async () => {
    const mail: { to: string; text: string }[] = [];
    Object.assign(process.env, { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", RESEND_API_KEY: "test_key", LEAD_TO_EMAIL: "sales@timetopower.ai" });
    delete process.env.SLACK_WEBHOOK_URL;
    delete process.env.FORMSPREE_FORWARD_ID;
    delete process.env.NEXT_PUBLIC_FORMSPREE_ID;
    resetMemoryLimiter();
    const db = new PostgrestFake(["leads", "qualifications"]);
    const wired = installWithAuth(db);
    const below = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://api.resend.com")) {
        const b = JSON.parse(String(init?.body));
        mail.push({ to: String(b.to?.[0]), text: String(b.text) });
        return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
      }
      return below(input as RequestInfo, init);
    }) as typeof fetch;
    for (const m of ["log", "info", "warn", "error"] as const) vi.spyOn(console, m).mockImplementation(() => {});
    try {
      const { POST } = await import("@/app/api/audit/route");
      const res = await POST(
        new Request(siteUrl("/api/audit"), {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.91" },
          body: JSON.stringify({ name: "Dana", company: "Hall Co", email: "dana@hall.example", location: "Dublin", capacity: "40 MW", urgency: "immediate", gridStatus: "in_queue", message: "enquiry text", services: ["Not sure yet — need a recommendation"] }),
        })
      );
      expect(res.status).toBe(200);
      const toLead = mail.filter((m) => m.to === "dana@hall.example");
      expect(toLead).toHaveLength(1);
      expect(toLead[0].text).toContain(SCREEN_CREDIT_SENTENCE);
      expect(toLead[0].text).toContain(siteUrl("/pricing"));
      expect(toLead[0].text).not.toMatch(/credits in full/i);
      expect(RATE_POLICIES.audit.limit).toBeGreaterThan(0);
    } finally {
      globalThis.fetch = below;
      wired.restore();
      vi.restoreAllMocks();
    }
  });
});

describe("guard: the unconditional promise is typed nowhere in the site's own text", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && e.name !== ".next") walk(rel, out);
      } else if (/\.(tsx?|mdx?|txt)$/.test(e.name)) out.push(rel);
    }
    return out;
  }
  const files = ["app", "components", "lib"].flatMap((d) => walk(d));
  // The Density Screen -> Study promise, in the forms it was typed: "credits in full against", "Credits in full against the full study".
  const PROMISE = /credits?\s+in\s+full\s+against/i;

  it("'credits in full against' does not appear in any page, email, agent text or library string", () => {
    // No exemption: the price ladder reads SCREEN_CREDIT_SHORT from lib/credits-terms.ts like every other surface.
    const offenders = files.filter((f) => PROMISE.test(strip(read(f))));
    expect(offenders, "an unconditional credit promise typed outside lib/credits-terms.ts").toEqual([]);
  });

  it("the shared constant is imported by every file that prints it, and defined once", () => {
    const definers = files.filter((f) => /export const SCREEN_CREDIT_SENTENCE\b/.test(read(f)));
    expect(definers).toEqual(["lib/credits-terms.ts"]);
    const users = files.filter((f) => f !== "lib/credits-terms.ts" && strip(read(f)).includes("SCREEN_CREDIT_SENTENCE"));
    for (const f of users) expect(strip(read(f)), f).toContain('from "@/lib/credits-terms"');
    expect(users.length).toBeGreaterThanOrEqual(11);
  });
});
