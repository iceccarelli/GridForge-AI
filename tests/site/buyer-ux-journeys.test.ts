import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assumedText } from "@/lib/assumed-text";

// Buyer-experience defects found by driving the production build at 375 and 1440 px (see the commit that adds this file). Each
// assertion below fails on the code as it was: a dead-end "Not found", a /commissioned page claiming a payment that was never made,
// "[]" shown as an assumed value, required intake fields with no hint of where the number lives, a hall-list table whose columns
// were cut off on a phone, and controls under 44 px.

const read = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);

const saved = { ...process.env };
beforeEach(() => {
  // No database configured: every token lookup finds nothing, which is the state a mistyped or truncated link produces.
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  delete process.env.STRIPE_SECRET_KEY;
});
afterEach(() => {
  process.env = { ...saved };
});

describe("a private link that matches nothing is not a dead end", () => {
  it.each([
    ["/deliverable/[token]", async () => (await import("@/app/deliverable/[token]/page")).default({ params: Promise.resolve({ token: "no-such-token" }) })],
    ["/watch/[token]", async () => (await import("@/app/watch/[token]/page")).default({ params: Promise.resolve({ token: "no-such-token" }) })],
  ])("%s names the usual cause, an address to write to, and two pages to go to", async (_n, render) => {
    const html = renderToStaticMarkup((await render()) as React.ReactElement);
    const links = hrefs(html);
    expect(links).toContain("/contact");
    expect(links).toContain("/products");
    expect(links.some((h) => h.startsWith("mailto:power@"))).toBe(true);
    expect(text(html)).toMatch(/cut short/);
    // Every link on it is large enough to press on a phone.
    for (const a of html.match(/<a [^>]*>/g) ?? []) if (!a.includes("mailto:")) expect(a).toContain("min-h-11");
  });
});

describe("/commissioned only speaks of a payment when it was opened from one", () => {
  it("with no session id it does not say a payment was received or that an engagement is open", async () => {
    const { default: Page } = await import("@/app/commissioned/page");
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    expect(text(html)).not.toMatch(/payment received|engagement is open/i);
    expect(hrefs(html)).toEqual(expect.arrayContaining(["/products", "/contact"]));
  });

  it("with a session id nobody recorded it still gives the buyer an address to write to", async () => {
    const { default: Page } = await import("@/app/commissioned/page");
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({ session_id: "cs_unknown_1" }) }));
    expect(hrefs(html).some((h) => h.startsWith("mailto:power@"))).toBe(true);
  });
});

describe("the free qualifier's table of assumed inputs reads as words", () => {
  it.each(["[]", " [] ", "", "{}", "null"])("%j is not shown raw", (raw) => {
    expect(assumedText(raw)).toMatch(/^Nothing supplied/);
  });
  it("a real assumed value is shown unchanged", () => {
    expect(assumedText("2,000 [1,400–2,600] m2 (E0)")).toBe("2,000 [1,400–2,600] m2 (E0)");
  });
  it("the table says where to find each input, and what the asterisk means", () => {
    const src = read("components/CapacityQualifier.tsx");
    expect(src).toContain("Where to find it: {g.how_to_get_it}");
    expect(src).toContain("A * marks an input the paid document requires.");
  });
});

describe("the free-allowance notice is a sentence", () => {
  it("does not splice a lower-cased button label into the middle of a sentence", () => {
    const src = read("components/FreeAllowanceForm.tsx");
    expect(src).not.toContain("QUALIFY_LINK.label.toLowerCase()");
  });
});

describe("the engagement intake form helps the buyer find each number", () => {
  const src = read("components/EngagementIntake.tsx");
  const fields = [...src.matchAll(/<Field label="([^"]+)"([^>]*)>/g)].map((m) => ({ label: m[1], attrs: m[2] }));

  it("every required field says where its number comes from", () => {
    expect(fields.length).toBeGreaterThan(20);
    const bare = fields.filter((f) => /\brequired\b/.test(f.attrs) && !/\bhint="/.test(f.attrs)).map((f) => f.label);
    expect(bare).toEqual([]);
  });

  it("its section headings are h2, so the page never jumps from h1 to h3", () => {
    expect(src).not.toMatch(/<h3\b/);
  });

  it("a failed submission is announced, not only painted", () => {
    expect(src).toMatch(/<div role="alert"[^>]*border-flag\/40/);
  });

  it("its controls are at least 44 px high", () => {
    expect(src).toMatch(/const inputCls =\s*"min-h-11 /);
    expect(src).toMatch(/type="submit"[\s\S]{0,200}min-h-11/);
  });
});

describe("the Portfolio Screen hall-list form works on a phone", () => {
  it("lists every column, with what is needed and where it comes from, stacked below the sm breakpoint instead of scrolling sideways", async () => {
    const { PortfolioIntake } = await import("@/components/PortfolioIntake");
    const html = renderToStaticMarkup(React.createElement(PortfolioIntake, { token: "t", minHalls: 2, maxHalls: 15 }));
    // No horizontal scroller (and no fixed 640 px minimum) under sm; the table layout is restored from sm up.
    expect(html).not.toMatch(/class="[^"]*(?<![:\w-])overflow-x-auto/);
    expect(html).toContain("sm:min-w-[640px]");
    expect(html).toContain("sm:table-cell");
    expect(html).toContain("before:content-[&#x27;Needed:_&#x27;]");
  });

  it("says why Submit is unavailable until a list is pasted", async () => {
    const { PortfolioIntake } = await import("@/components/PortfolioIntake");
    const html = renderToStaticMarkup(React.createElement(PortfolioIntake, { token: "t", minHalls: 2, maxHalls: 15 }));
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="portfolio-submit-note"/);
    expect(text(html)).toMatch(/This unlocks once there is a hall list above \(2 to 15 halls\)/);
  });

  it("its fields have a visible focus ring", async () => {
    const { PortfolioIntake } = await import("@/components/PortfolioIntake");
    const html = renderToStaticMarkup(React.createElement(PortfolioIntake, { token: "t", minHalls: 2, maxHalls: 15 }));
    for (const tag of html.match(/<(textarea|select|input type="text")[^>]*>|<input value[^>]*>/g) ?? []) expect(tag).toContain("focus:ring-2");
  });
});

describe("shared chrome meets the 44 px target on a phone", () => {
  it("every footer link, the footer buttons and the section rail are tall enough", async () => {
    const { Footer } = await import("@/components/Footer");
    const html = renderToStaticMarkup(React.createElement(Footer));
    const tags = html.match(/<(a|button) [^>]*>/g) ?? [];
    expect(tags.length).toBeGreaterThan(20);
    // The two brand/logo links carry their own larger boxes; every other link and button must say min-h-11 or w-11 h-11.
    const small = tags.filter((t) => !/min-h-11|w-11 h-11/.test(t));
    expect(small, small.join("\n")).toEqual([]);
    expect(read("components/SectionNav.tsx")).toContain("min-h-11");
  });
});
