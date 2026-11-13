/**
 * "Cancel anytime" on the page that sells GridForge Intelligence was a promise with no path behind it: the signed-in account page had no cancel
 * control, and nothing said what cancelling does. Now:
 *
 *   - ONE sentence (INTELLIGENCE_CANCEL_TERMS, lib/subscription-manage.ts) says what cancelling does, taken from what the code does, and the sales
 *     page, the signed-in account page and the Terms print THAT constant, not copies of it;
 *   - the billing owner has the control (components/IntelligenceManage.tsx -> POST /api/billing/portal, route tested in
 *     intelligence-billing-portal.test.ts); a seat member is told the owner manages billing;
 *   - a guard fails if "Cancel anytime" / "cancel any time" is typed on any page: the only place that wording may be typed is Hall Watch's own
 *     constant, which WatchManage backs, plus one literal in a file this change does not own, pinned to that constant's exact text.
 *
 * What no test here can prove: that the Stripe Billing Portal is configured to allow cancelling, or whether it cancels at once or at the end of the
 * paid period (the Stripe dashboard). The sentence does not claim either.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IntelligenceClient } from "@/components/IntelligenceClient";
import { IntelligenceManage, SuspendedAccessNote, requestIntelligencePortal } from "@/components/IntelligenceManage";
import { EngagementLadder } from "@/components/EngagementLadder";
import { PRODUCT_PAGES } from "@/lib/product-pages";
import Terms from "@/app/legal/terms/page";
import { SITE } from "@/lib/site";
import { lookupEntitlement } from "@/lib/subscribers";
import { installWithAuth } from "./auth-fake";
import { newPaygDb } from "./payg-harness";
import { installTeamRpcs } from "./team-rpc-fake";
import type { PostgrestFake } from "./postgrest-fake";
import { openIntelligencePortal } from "@/lib/payg-client";
import {
  CANCEL_TIMING_NOTE,
  HALL_WATCH_CANCEL_NOTE,
  INTELLIGENCE_PORTAL_EXPLANATION,
  INTELLIGENCE_CANCEL_TERMS,
  INTELLIGENCE_PORTAL_REQUEST,
  MANAGE_SUBSCRIPTION_LABEL,
  memberBillingNote,
  portalUnavailableMessage,
} from "@/lib/subscription-manage";

const ROOT = process.cwd();
const read = (f: string) => fs.readFileSync(path.join(ROOT, f), "utf8");
const text = (html: string) =>
  html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const noHeaders = async () => ({ authorization: "Bearer t" });

/** The wording this change replaced, in the spellings a person would type. */
const CANCEL_ANYTIME = /cancel(?:lation)?\s*(?:at\s*)?any\s*-?\s*time/i;

describe("the one sentence on what cancelling does", () => {
  it("names the control by the constant the button renders, and names the contact address for a suspended owner", () => {
    expect(INTELLIGENCE_CANCEL_TERMS).toContain(`“${MANAGE_SUBSCRIPTION_LABEL}”`);
    expect(INTELLIGENCE_CANCEL_TERMS).toContain(`write to ${SITE.email} from the address you signed in with`);
    expect(INTELLIGENCE_CANCEL_TERMS).toContain("Stripe's billing page");
  });

  it("promises nothing the code cannot establish: no timing, no period-end, no pro-rata, no money back (a full refund appears only as a CAUSE of suspension)", () => {
    expect(INTELLIGENCE_CANCEL_TERMS).toContain("When the cancellation takes effect is Stripe's");
    expect(INTELLIGENCE_CANCEL_TERMS).not.toMatch(CANCEL_ANYTIME);
    expect(INTELLIGENCE_CANCEL_TERMS).not.toMatch(/end of (?:the|your) (?:paid |billing )?(?:period|term|month)|immediately|at once|pro-?rat|money back|no questions/i);
    // "refund" is allowed in exactly two phrases: the cause ("a full refund") and the disclaimer ("refunds nothing automatically").
    const rest = INTELLIGENCE_CANCEL_TERMS.replace("for a full refund,", "").replace("this site refunds nothing automatically when one ends", "");
    expect(rest, "a refund promise").not.toMatch(/refund/i);
  });

  it("claims no reinstatement of a cancelled subscription and no automatic refund", () => {
    expect(INTELLIGENCE_CANCEL_TERMS).toContain("An ended subscription is not reinstated (subscribing again is a new purchase)");
    expect(INTELLIGENCE_CANCEL_TERMS).toContain("this site refunds nothing automatically when one ends");
  });

  it("is printed by the sales page", () => {
    const page = text(renderToStaticMarkup(React.createElement(IntelligenceClient)));
    expect(page).toContain(INTELLIGENCE_CANCEL_TERMS);
    expect(page).not.toMatch(CANCEL_ANYTIME);
  });

  it("is printed by the signed-in account page's billing section for the owner", () => {
    const html = renderToStaticMarkup(React.createElement(IntelligenceManage, { role: "owner", ownerEmail: null, authHeaders: noHeaders }));
    expect(text(html)).toContain(INTELLIGENCE_CANCEL_TERMS);
    expect(text(html)).not.toMatch(CANCEL_ANYTIME);
  });

  it("is printed by the Terms", () => {
    const html = text(renderToStaticMarkup(Terms()));
    expect(html).toContain(INTELLIGENCE_CANCEL_TERMS);
    expect(html).toContain("Cancelling a GridForge Intelligence subscription.");
  });

  it("is imported by each of those pages, not typed again", () => {
    for (const f of ["components/IntelligenceClient.tsx", "components/IntelligenceManage.tsx", "app/legal/terms/page.tsx"]) {
      const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
      expect(src, f).toContain("INTELLIGENCE_CANCEL_TERMS");
      expect(src, f).not.toContain("this site ends access only when Stripe reports");
      expect(src, f).not.toMatch(CANCEL_ANYTIME);
    }
  });
});

/**
 * The causes that end or suspend access are READ FROM THE CODE here (lib/billing-holds.ts, lib/subscribers.ts), not from the sentence: a sentence
 * that is checked only against its own words cannot be wrong. A cause the code has and this test has no wording for fails; a cause the code has
 * and the sentence does not name fails.
 */
describe("the sentence names every cause that ends or suspends access, derived from the code", () => {
  const union = (src: string, re: RegExp): string[] => {
    const m = re.exec(src);
    if (!m) throw new Error(`could not read a union with ${re} (the code moved: update the test, do not skip it)`);
    return [...m[1].matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);
  };
  const holds = read("lib/billing-holds.ts");
  const subs = read("lib/subscribers.ts");
  /** The hold kinds: what takes PAID access away while the Stripe subscription goes on. */
  const holdKinds = union(holds, /export type HoldKind = ([^;]+);/);
  /** Every status a subscription row can have, and the extra one a hold writes. */
  const rowStatuses = [...union(subs, /export type SubscriptionStatus = ([^;]+);/), ...union(holds, /status: SubscriptionRecord\["status"\] \| ("[a-z_]+"(?: \| "[a-z_]+")*)/)];
  const entitling = union(subs, /const ENTITLING_STATUSES[^=]*=\s*new Set\(\[([^\]]+)\]\)/);
  const nonEntitling = rowStatuses.filter((s) => !entitling.includes(s));

  /** How the sentence names each cause. A cause the code gains must be given words HERE and in the sentence. */
  const NAMED_BY: Record<string, RegExp> = {
    cancelled: /ends access when Stripe reports the subscription as ended/,
    superseded: /subscribing again is a new purchase/,
    suspended: /suspends it for/,
    refunded: /for a full refund/,
    disputed: /an open dispute/,
    paused: /a pause once the period already paid for is over/,
  };

  it("reads a meaningful set (the parse did not silently find nothing)", () => {
    expect(holdKinds.sort()).toEqual(["disputed", "paused", "refunded"]);
    expect(entitling.sort()).toEqual(["active", "past_due"]);
    expect(nonEntitling.sort()).toEqual(["cancelled", "superseded", "suspended"]);
  });

  it("names each hold kind in lib/billing-holds.ts", () => {
    for (const k of holdKinds) {
      expect(NAMED_BY[k], `hold kind ${k}: the code suspends access for it, so the sentence must say so`).toBeDefined();
      expect(INTELLIGENCE_CANCEL_TERMS, `hold kind ${k}`).toMatch(NAMED_BY[k]);
    }
  });

  it("names each non-entitling status in lib/subscribers.ts / lib/billing-holds.ts", () => {
    for (const s of nonEntitling) {
      expect(NAMED_BY[s], `status ${s}: access ends or is suspended for it, so the sentence must say so`).toBeDefined();
      expect(INTELLIGENCE_CANCEL_TERMS, `status ${s}`).toMatch(NAMED_BY[s]);
    }
  });

  describe("and the access check really denies exactly those causes", () => {
    let db: PostgrestFake;
    let restore: () => void;
    beforeEach(() => {
      Object.assign(process.env, { SUPABASE_URL: "https://stub.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test" });
      vi.spyOn(console, "error").mockImplementation(() => {});
      db = newPaygDb();
      installTeamRpcs(db);
      restore = installWithAuth(db).restore;
    });
    afterEach(() => {
      restore();
      vi.restoreAllMocks();
    });
    const row = (over: Record<string, unknown>) =>
      db.insertRow("subscriptions", { email: "o@team.example", plan: "team", status: "active", stripe_customer_id: "cus_o", stripe_subscription_id: "sub_o", stripe_session_id: "cs_o", ...over });
    const entitled = async () => (await lookupEntitlement("o@team.example")).entitlement !== null;

    it("every status the code entitles is entitled, every other status is not", async () => {
      for (const s of [...entitling, ...nonEntitling]) {
        db = newPaygDb();
        installTeamRpcs(db);
        restore();
        restore = installWithAuth(db).restore;
        row({ status: s });
        expect(await entitled(), `status ${s}`).toBe(entitling.includes(s));
      }
    });

    it("a pause whose paid period is over denies; one still ahead does not (the `paused` cause is the period, not the pause alone)", async () => {
      row({ billing_pause_from: new Date(Date.now() + 5 * 86_400_000).toISOString() });
      expect(await entitled(), "pause ahead").toBe(true);
      db = newPaygDb();
      installTeamRpcs(db);
      restore();
      restore = installWithAuth(db).restore;
      row({ billing_pause_from: new Date(Date.now() - 86_400_000).toISOString() });
      expect(await entitled(), "pause due").toBe(false);
      expect(INTELLIGENCE_CANCEL_TERMS).toMatch(NAMED_BY.paused);
    });
  });
});

describe("/account, for a visitor it shows no subscription for", () => {
  const src = read("app/account/page.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

  it("names the next step for a suspended subscription, and does not print the owner's cancel sentence", () => {
    const note = text(renderToStaticMarkup(React.createElement(SuspendedAccessNote)));
    expect(note).toContain(`write to ${SITE.email} from the address you signed in with`);
    expect(note).toMatch(/suspended/);
    expect(note).not.toMatch(/can cancel from the account page/);
    expect(note).not.toContain(MANAGE_SUBSCRIPTION_LABEL);
    expect(src).toMatch(/function Gate\(\)[\s\S]*?<SuspendedAccessNote \/>[\s\S]*?\n}\n/);
    // The sentence and the control exist only for `active && role`, never in the Gate.
    expect(src).not.toContain("INTELLIGENCE_CANCEL_TERMS");
  });
});

describe("the account page gives the BILLING OWNER the control", () => {
  const owner = () => renderToStaticMarkup(React.createElement(IntelligenceManage, { role: "owner", ownerEmail: null, authHeaders: noHeaders }));

  it("says only what is true of the portal: it opens Stripe's billing page, what that page lets you change is set in Stripe, and cancelling there is what ends the subscription", () => {
    const t = text(owner());
    expect(t).toContain("This opens Stripe's billing page.");
    expect(t).toContain("What it lets you change is set in Stripe");
    expect(t).toContain("cancelling there is what ends the subscription");
    // The portal's configuration lives in the Stripe dashboard and no code here can see it: the card and invoices are not promised.
    expect(t).not.toMatch(/update the card|see invoices|invoices|replace (?:the|your) card/i);
    // ...and the sentence is the constant's, typed nowhere else.
    expect(INTELLIGENCE_PORTAL_EXPLANATION).toBe(
      "This opens Stripe's billing page. What it lets you change is set in Stripe, and cancelling there is what ends the subscription. Nothing is cancelled by opening it."
    );
    expect(t).toContain(INTELLIGENCE_PORTAL_EXPLANATION);
  });

  it("renders the one label as heading and as a button", () => {
    const html = owner();
    expect(html).toMatch(new RegExp(`<button[^>]*>${MANAGE_SUBSCRIPTION_LABEL}</button>`));
    expect(html).toMatch(new RegExp(`<h2[^>]*>${MANAGE_SUBSCRIPTION_LABEL}</h2>`));
    expect(text(html)).toContain("Nothing is cancelled by opening it");
    // The label is the constant's: not typed again in the component.
    const src = read("components/IntelligenceManage.tsx").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
    expect(src).toContain("MANAGE_SUBSCRIPTION_LABEL");
    expect(src).not.toMatch(/>\s*Manage or cancel subscription\s*</);
  });

  it("is wired into app/account/page.tsx for a subscriber with a role, with the page's own session headers", () => {
    const src = read("app/account/page.tsx");
    expect(src).toContain('import { IntelligenceManage, SuspendedAccessNote } from "@/components/IntelligenceManage"');
    expect(src).toMatch(/active && role && <IntelligenceManage role=\{role\} ownerEmail=\{ownerEmail\} authHeaders=\{authHeaders\} \/>/);
    expect(src).not.toMatch(CANCEL_ANYTIME);
  });
});

describe("a seat member is not offered a control the server would refuse", () => {
  const member = (ownerEmail: string | null) => renderToStaticMarkup(React.createElement(IntelligenceManage, { role: "member", ownerEmail, authHeaders: noHeaders }));

  it("sees that the owner manages billing and whose it is (the address the page already shows to members), and no button", () => {
    const html = member("boss@team.example");
    expect(html).not.toContain("<button");
    expect(html).not.toContain(MANAGE_SUBSCRIPTION_LABEL);
    expect(text(html)).toContain("The account owner (boss@team.example) manages billing.");
    expect(text(html)).toContain("Only the billing owner can change seats, manage billing or cancel the subscription.");
    expect(text(html)).not.toContain(INTELLIGENCE_CANCEL_TERMS);
  });

  it("without an owner address says 'the account owner' and shows no address", () => {
    const t = text(member(null));
    expect(t).toContain("The account owner manages billing.");
    expect(t).not.toMatch(/@/);
    expect(memberBillingNote(null)).not.toMatch(/@/);
  });
});

describe("the browser side of the control", () => {
  const fake = (res: () => Response | Promise<Response>, seen: { url?: string; init?: RequestInit } = {}) => async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return res();
  };
  const json = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("posts { account: 'intelligence' } with the session's Authorization header and names no customer", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const out = await requestIntelligencePortal(noHeaders, fake(json(200, { ok: true, url: "https://billing.stripe.test/p/1" }), seen));
    expect(out).toEqual({ url: "https://billing.stripe.test/p/1" });
    expect(seen.url).toBe("/api/billing/portal");
    expect(seen.init?.method).toBe("POST");
    expect(JSON.parse(String(seen.init?.body))).toEqual(INTELLIGENCE_PORTAL_REQUEST);
    expect(JSON.stringify(seen.init?.body)).not.toMatch(/cus_|customer/);
    expect((seen.init?.headers as Record<string, string>).authorization).toBe("Bearer t");
  });

  it("follows only an https portal address", async () => {
    const r = await openIntelligencePortal({ authorization: "Bearer t" }, fake(json(200, { ok: true, url: "http://evil.example/x" })));
    expect(r.ok).toBe(false);
    const r2 = await openIntelligencePortal({ authorization: "Bearer t" }, fake(json(200, { ok: true, url: "javascript:alert(1)" })));
    expect(r2.ok).toBe(false);
  });

  it("a refusal about WHO the caller is keeps the server's words (a seat member is told to ask the owner, not to write in)", async () => {
    const msg = "Only the billing owner can manage billing or cancel the subscription. Ask the account owner.";
    const out = await requestIntelligencePortal(noHeaders, fake(json(403, { ok: false, error: msg })));
    expect(out).toEqual({ message: msg });
  });

  it("a portal that cannot be opened names the one next step: write to the contact address", async () => {
    const down = await requestIntelligencePortal(noHeaders, fake(json(502, { ok: false, error: "Managing billing here is not available right now: write to x. Nothing was changed.", reason: "portal_unavailable" })));
    expect(down).toEqual({ message: expect.stringContaining("write to ") });
    for (const res of [
      fake(json(404, "x")),
      fake(json(503, { ok: false })),
      fake(() => { throw new Error("offline"); }),
      fake(json(500, { ok: false })),
    ]) {
      const out = await requestIntelligencePortal(noHeaders, res);
      expect("message" in out && out.message, "a failure with no next step in it").toContain(`write to ${SITE.email}`);
    }
    expect(portalUnavailableMessage()).toContain("not available right now");
  });

  it("a session that cannot be read says to sign in again, and sends nothing", async () => {
    let called = false;
    const out = await requestIntelligencePortal(async () => { throw new Error("no session"); }, fake(() => { called = true; return new Response("{}"); }));
    expect(out).toEqual({ message: expect.stringMatching(/sign in again/i) });
    expect(called).toBe(false);
  });
});

describe("guard: a cancellation promise is typed nowhere but in the shared constants", () => {
  /** Every .ts/.tsx under the directories a visitor's page, email or agent text can come from (not tests, not generated data). */
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name === "node_modules" || e.name === ".next") continue;
        walk(rel, out);
      } else if (/\.(tsx?|mdx?|txt)$/.test(e.name)) out.push(rel);
    }
    return out;
  }
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
  const files = ["app", "components", "lib"].flatMap((d) => walk(d));

  it("scans a meaningful set of files", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files).toContain("components/IntelligenceClient.tsx");
    expect(files).toContain("app/llms.txt/route.ts");
  });

  it("'Cancel anytime' / 'cancel any time' is not typed in any page, component, library text or route", () => {
    // lib/subscription-manage.ts DEFINES Hall Watch's own note (its first sentence is typed there; the timing sentence is CANCEL_TIMING_NOTE);
    // the price ladder and the upsell read it from there.
    const allowed = new Map<string, string>([
      ["lib/subscription-manage.ts", "Cancel any time; no minimum term."],
    ]);
    const offenders: string[] = [];
    for (const f of files) {
      const src = strip(read(f));
      const hits = [...src.matchAll(new RegExp(CANCEL_ANYTIME.source, "gi"))];
      if (!hits.length) continue;
      const only = allowed.get(f);
      if (only && hits.every((h) => src.slice(h.index!, h.index! + only.length) === only)) continue;
      offenders.push(`${f}: ${hits.map((h) => JSON.stringify(src.slice(h.index!, h.index! + 40))).join(", ")}`);
    }
    expect(offenders, "a cancellation promise typed outside the shared constants").toEqual([]);
  });

  it("the allowed literal is Hall Watch's own, and WatchUpsell reads it from the constant", () => {
    expect(HALL_WATCH_CANCEL_NOTE).toBe("Cancel any time; no minimum term. When a cancellation takes effect is set in Stripe's billing page.");
    expect(HALL_WATCH_CANCEL_NOTE).toBe(`Cancel any time; no minimum term. ${CANCEL_TIMING_NOTE}`);
    const upsell = strip(read("components/WatchUpsell.tsx"));
    expect(upsell).toContain("HALL_WATCH_CANCEL_NOTE");
    expect(upsell).not.toMatch(CANCEL_ANYTIME);
    // Hall Watch's promise is backed by a control: the same label, on its own page, through the same route.
    expect(read("components/WatchManage.tsx")).toContain("/api/billing/portal");
  });

  it("Hall Watch's note says when a cancellation takes effect is set in Stripe's billing page, from the shared constant, wherever the note is printed", () => {
    expect(CANCEL_TIMING_NOTE).toBe("When a cancellation takes effect is set in Stripe's billing page.");
    const rendered = text(renderToStaticMarkup(React.createElement(EngagementLadder)));
    expect(rendered).toContain(HALL_WATCH_CANCEL_NOTE);
    // The product page's limits line reads the constant for the timing sentence; it does not type its own.
    const pageSrc = strip(read("lib/product-pages.ts"));
    expect(pageSrc).toContain("CANCEL_TIMING_NOTE");
    expect(pageSrc).not.toContain("takes effect is set in Stripe");
    const limits = PRODUCT_PAGES.find((p) => p.productId === "hall_watch")!.limits.join(" ");
    expect(limits).toContain(CANCEL_TIMING_NOTE);
    expect(limits).toContain("There is no minimum term.");
  });

  it("'no minimum term' is backed by the code: no checkout, webhook or product setting imposes one (no cancel_at, schedule, iterations, trial or commitment)", () => {
    const TERM = /cancel_at\b|cancel_at_period_end|subscription_schedule|\biterations\b|trial_period|trial_end|\bminimum[_ -]?(?:term|commit\w*|duration)\b|\bcommitment\b/i;
    for (const f of ["app/api/checkout/route.ts", "app/api/stripe/webhook/route.ts", "lib/products.ts"]) {
      const src = strip(read(f));
      expect(src, `${f}: a term the site imposes would make "no minimum term" untrue`).not.toMatch(TERM);
    }
    // The only thing a subscription-mode checkout sets on the subscription is metadata.
    const checkout = strip(read("app/api/checkout/route.ts"));
    const block = /subscription_data:\s*\{([\s\S]*?)\n\s{12}\},/.exec(checkout)?.[1] ?? "";
    expect(block.length, "found the subscription_data block").toBeGreaterThan(0);
    expect(block.replace(/metadata:\s*\{[\s\S]*?\n\s{14}\},?/, "").trim(), "subscription_data holds metadata and nothing else").toBe("");
  });

  it("the Intelligence plans are not described as cancellable 'anytime' anywhere a plan is sold (pricing, products, llms.txt, FAQ)", () => {
    for (const f of ["app/pricing/page.tsx", "app/products/page.tsx", "app/llms.txt/route.ts", "lib/site.ts", "lib/subscriptions.ts", "lib/product-pages.ts"]) {
      expect(strip(read(f)), f).not.toMatch(CANCEL_ANYTIME);
    }
  });
});
