/**
 * The navigation, the fixed chrome and the shared design tokens around the first screen.
 *
 * Source and markup checks only (no browser): tests/e2e/first-screen-journey.mjs proves the rendered behaviour in Chromium (Tab counts, layout
 * shift, fixed-chrome pixels, no focusable control hidden from sight). These pin the decisions so they cannot drift back unnoticed.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FOOTER_GROUPS, NAV_LINKS, NO_PAID_CTA_ON, NO_SCOPING_AGENT_ON, MOBILE_MENU_BUTTON_ID, SIGN_IN_LABEL, SIGN_IN_LINKS, CLIENT_PORTAL_LINK, paidCtaAllowed, scopingAgentAvailable, QUALIFY_LINK } from "@/lib/nav";
import { DENSITY_SCREEN_CTA } from "@/lib/cta";

const mockPath = vi.hoisted(() => ({ value: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => mockPath.value, useRouter: () => ({ push: () => {}, replace: () => {} }) }));
vi.mock("next/font/local", () => ({ default: () => ({ variable: "font-var", className: "font-cls" }) }));

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const unesc = (s: string) => s.replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

describe("the header", () => {
  it("the primary navigation is five links plus one Sign in menu (six items); the header's two actions come on top, so its interactive controls number eight", async () => {
    expect(NAV_LINKS.length).toBe(5);
    expect(NAV_LINKS.length + 1).toBeLessThanOrEqual(6); // five links + the Sign in menu
    mockPath.value = "/";
    const { Navbar } = await import("@/components/Navbar");
    const html = renderToStaticMarkup(React.createElement(Navbar));
    const desktop = html.slice(html.indexOf('class="hidden xl:flex'), html.lastIndexOf("<button", html.indexOf("xl:hidden inline-flex")));
    const controls = desktop.match(/<(a|button)[ >]/g) ?? [];
    // 5 links + free check (filled) + paid screen (text) + Sign in button = 8 controls: the six navigation items and two actions.
    expect(controls.length).toBe(NAV_LINKS.length + 2 + 1);
    // and the Sign in menu is ONE control while closed, however many accounts it lists
    expect(desktop.match(/aria-controls="sign-in-menu"/g)).toHaveLength(1);
  });

  it("sends 'Product' to /products, not to a section of the home page", () => {
    const product = NAV_LINKS.find((l) => l.label === "Product")!;
    expect(product.href).toBe("/products");
    expect(product.hash).toBeUndefined();
    expect(fs.existsSync(path.join(ROOT, "app/products/page.tsx"))).toBe(true);
  });

  it("says 'How it works' once as a link: not in the footer, not in the section rail", () => {
    const labels = [...NAV_LINKS.map((l) => l.label), ...FOOTER_GROUPS.flatMap((g) => g.links.map((l) => l.label))];
    expect(labels.filter((l) => /^how it works$/i.test(l))).toHaveLength(1);
    const rail = [...read("components/SectionNav.tsx").matchAll(/label: "([^"]+)"/g)].map((m) => m[1]);
    expect(rail.filter((l) => /how it works/i.test(l))).toEqual([]);
    expect(rail).toContain("Method");
  });

  it("leads with the free check as the filled primary button; the paid screen is a quiet text button", async () => {
    mockPath.value = "/";
    const { Navbar } = await import("@/components/Navbar");
    const html = unesc(renderToStaticMarkup(React.createElement(Navbar)));
    expect(html).toMatch(new RegExp(`<a[^>]*class="[^"]*btn-primary[^"]*"[^>]*>${QUALIFY_LINK.label}`) );
    expect(html).toMatch(new RegExp(`<button[^>]*class="[^"]*btn-tertiary[^"]*"[^>]*>${DENSITY_SCREEN_CTA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(html.indexOf(QUALIFY_LINK.label)).toBeLessThan(html.indexOf(DENSITY_SCREEN_CTA));
  });

  it("has no filled paid button: 'btn-primary' is only ever on the free-check link", async () => {
    mockPath.value = "/";
    const { Navbar } = await import("@/components/Navbar");
    const html = renderToStaticMarkup(React.createElement(Navbar));
    for (const m of html.matchAll(/<(a|button)[^>]*class="[^"]*btn-primary[^"]*"[^>]*>/g)) expect(m[1]).toBe("a");
  });
});

describe("sign-in surfaces are labelled by what they open, and none of their destinations changed", () => {
  it("groups the two accounts under one 'Sign in' label, each item saying what it is for", () => {
    expect(SIGN_IN_LABEL).toBe("Sign in");
    expect(SIGN_IN_LINKS.map((l) => l.href)).toEqual(["/dashboard", "/account/login"]);
    expect(SIGN_IN_LINKS[0].label).toBe(CLIENT_PORTAL_LINK.label);
    expect(SIGN_IN_LINKS[1].label).toBe("Intelligence account");
    for (const l of SIGN_IN_LINKS) expect(l.note.length).toBeGreaterThan(20);
    expect(SIGN_IN_LINKS[0].note).toMatch(/engagements/i);
    expect(SIGN_IN_LINKS[1].note).toMatch(/subscription|siting/i);
  });

  it("the destinations are the ones the product already had: /dashboard, /account/login (which returns to /account)", () => {
    expect(CLIENT_PORTAL_LINK.href).toBe("/dashboard");
    expect(read("app/account/login/page.tsx")).toContain("${window.location.origin}/account");
    expect(fs.existsSync(path.join(ROOT, "app/account/page.tsx"))).toBe(true);
  });

  it("the footer uses the same labels, and the intelligence page no longer says 'the dashboard' for the account", () => {
    const customer = FOOTER_GROUPS.find((g) => g.heading === "Customer")!.links.map((l) => `${l.href}|${l.label}`);
    expect(customer).toContain("/dashboard|Sign in: Client portal");
    expect(customer).toContain("/account/login|Sign in: Intelligence account");
    expect(read("components/IntelligenceClient.tsx")).toContain("Open your Intelligence account");
    expect(read("components/IntelligenceClient.tsx")).not.toContain(">Open the dashboard<");
  });

  it("the menu is a disclosure: closed, its links are not in the page; it closes on Escape and on an outside click", async () => {
    mockPath.value = "/";
    const { Navbar } = await import("@/components/Navbar");
    const html = renderToStaticMarkup(React.createElement(Navbar));
    expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="sign-in-menu"/);
    expect(html).not.toContain('id="sign-in-menu"');
    const src = read("components/Navbar.tsx");
    expect(src).toMatch(/e\.key === "Escape"/);
    expect(src).toContain("mousedown");
  });

  it("tabbing out of the menu closes it: the wrapper closes on a blur whose next focus is outside it, and aria-expanded follows the same state", () => {
    const src = read("components/Navbar.tsx");
    expect(src).toMatch(/onBlur=\{\(e\) => \{\s*if \(!wrap\.current\?\.contains\(e\.relatedTarget as Node \| null\)\) setOpen\(false\);/);
    expect(src).toContain("aria-expanded={open}");
    expect(src).toMatch(/\{open && \(\s*<ul id="sign-in-menu"/); // the list exists only while open, driven by the same state
  });
});

describe("the paid call to action stays off the Observatory", () => {
  it("the chrome's list covers /observatory and the sticky bar hides on the same routes", async () => {
    expect(NO_PAID_CTA_ON).toContain("/observatory");
    const { HIDDEN_ON } = await import("@/components/StickyMobileCTA");
    for (const p of NO_PAID_CTA_ON) expect(HIDDEN_ON).toContain(p);
    expect(paidCtaAllowed("/observatory")).toBe(false);
    expect(paidCtaAllowed("/observatory/anything")).toBe(false);
    expect(paidCtaAllowed("/observatory-notes")).toBe(true);
    expect(paidCtaAllowed("/")).toBe(true);
    expect(paidCtaAllowed(null)).toBe(true);
  });

  it("the header and the footer draw no paid button on /observatory, and do elsewhere", async () => {
    const { Navbar } = await import("@/components/Navbar");
    const { Footer } = await import("@/components/Footer");
    for (const [p, expected] of [["/observatory", false], ["/", true], ["/pricing", true]] as const) {
      mockPath.value = p;
      for (const C of [Navbar, Footer]) {
        const html = unesc(renderToStaticMarkup(React.createElement(C)));
        expect(html.includes(DENSITY_SCREEN_CTA), `${C.name} on ${p}`).toBe(expected);
      }
    }
    mockPath.value = "/";
  });

  it("the free check is still offered on /observatory", async () => {
    mockPath.value = "/observatory";
    const { Navbar } = await import("@/components/Navbar");
    expect(renderToStaticMarkup(React.createElement(Navbar))).toContain(QUALIFY_LINK.label);
    mockPath.value = "/";
  });
});

describe("no focusable control is hidden from sight", () => {
  it("the section rail is invisible (not just transparent) until it is shown, and is not drawn on a phone", async () => {
    const { SectionNav } = await import("@/components/SectionNav");
    const html = renderToStaticMarkup(React.createElement(SectionNav));
    const root = /^<div class="([^"]*)"[^>]*aria-hidden="true"/.exec(html);
    expect(root, "the hidden rail keeps aria-hidden").not.toBeNull();
    expect(root![1]).toMatch(/\binvisible\b/);
    expect(root![1]).toMatch(/\bopacity-0\b/);
    expect(root![1]).toMatch(/\bhidden lg:block\b/);
    expect(root![1]).not.toMatch(/\bvisible opacity-100\b/);
  });

  it("the shown state is visible and the hidden one is never both aria-hidden and visible", () => {
    const src = read("components/SectionNav.tsx");
    expect(src).toMatch(/visible\s*\?\s*"visible opacity-100 translate-y-0"\s*:\s*"invisible opacity-0/);
    expect(src).toContain("aria-hidden={!visible}");
  });

  it("a reader can still jump: every rail target exists on the page, in order", async () => {
    const Page = (await import("@/app/page")).default;
    const html = renderToStaticMarkup(React.createElement(Page));
    const ids = [...read("components/SectionNav.tsx").matchAll(/\{ id: "([^"]+)"/g)].map((m) => m[1]);
    let at = -1;
    for (const id of ids) {
      const i = html.indexOf(`id="${id}"`);
      expect(i, id).toBeGreaterThan(at);
      at = i;
    }
  });
});

describe("the assistant's launcher does not float over a phone's page", () => {
  it("is not drawn below lg, and the mobile menu opens the assistant instead", () => {
    const agent = read("components/ScopingAgent.tsx");
    expect(agent).toMatch(/fixed z-\[60\] hidden lg:flex/);
    expect(agent).toContain("OPEN_SCOPING_AGENT_EVENT");
    const navbar = read("components/Navbar.tsx");
    expect(navbar).toContain("Ask the scoping assistant (AI)");
    expect(navbar).toContain("window.dispatchEvent(new Event(OPEN_SCOPING_AGENT_EVENT))");
  });

  it("the menu entry is offered only where the assistant exists: one shared route list gates both the launcher and the entry", () => {
    expect(NO_SCOPING_AGENT_ON).toEqual(expect.arrayContaining(["/workspace", "/observatory"]));
    for (const [p, ok] of [["/", true], ["/pricing", true], ["/qualify", true], ["/workspace", false], ["/workspace/abc", false], ["/observatory", false], ["/observatory/presenter", false], ["/workspaces", true], [null, true]] as const) {
      expect(scopingAgentAvailable(p), String(p)).toBe(ok);
    }
    expect(read("components/ScopingAgent.tsx")).toContain("if (!scopingAgentAvailable(pathname)) return null;");
    expect(read("components/ScopingAgent.tsx")).not.toMatch(/startsWith\("\/(workspace|observatory)"\)/);
    // the drawer is rendered only when open, so the Chromium journey checks the rendered entry; here the gate is pinned in source
    expect(read("components/Navbar.tsx")).toMatch(/\{showAssistant && \(\s*<button/);
  });

  it("closing the assistant returns focus to the launcher when it is drawn, and to the mobile menu's button when it is not (below lg)", () => {
    const agent = read("components/ScopingAgent.tsx");
    expect(agent).toContain("l.getClientRects().length > 0");
    expect(agent).toContain("document.getElementById(MOBILE_MENU_BUTTON_ID)?.focus()");
    expect(read("components/Navbar.tsx")).toContain("id={MOBILE_MENU_BUTTON_ID}");
    expect(MOBILE_MENU_BUTTON_ID).toBe("main-menu-toggle");
  });

  it("the chat panel labels a captured lead neutrally: no 'qualifies', no 'priority', no tier", async () => {
    const src = read("components/ScopingAgentPanel.tsx");
    expect(src).not.toMatch(/qualifies|priority/i);
    const { LEAD_CAPTURED_LABEL } = await import("@/components/ScopingAgentPanel");
    expect(LEAD_CAPTURED_LABEL).toBe("Captured: your project details");
    // the strip's label does not depend on the internal tier
    const label = /data-testid="lead-captured">\s*([^<]*?)\s*<\/div>/.exec(src)?.[1];
    expect(label).toBe("{LEAD_CAPTURED_LABEL}");
    // and the unsupported words are gone from every file that renders or tests the label
    for (const f of ["components/ScopingAgent.tsx", "lib/lead.ts", "app/api/chat/route.ts"]) expect(read(f)).not.toMatch(/Your site qualifies/);
  });
});

describe("the lazy tools reserve the height they render at", () => {
  // Rendered heights measured in Chromium after mount (360/390 px = base, 768 = md, 1280/1440 = lg). A reservation below these shifts the page
  // when the tool arrives; one above only leaves empty space under it.
  const MEASURED: Record<string, { base: number; md: number; lg: number }> = {
    liveConsole: { base: 1639, md: 1069, lg: 1022 },
    comparator: { base: 1081, md: 686, lg: 618 },
    timeToPower: { base: 949, md: 737, lg: 719 },
  };
  it("each island's reservation is at least its measured rendered height in every width band", () => {
    const src = read("components/home/Sections.tsx");
    for (const [which, m] of Object.entries(MEASURED)) {
      const re = new RegExp(`which="${which}" minHeight=\\{\\{ base: (\\d+), md: (\\d+), lg: (\\d+) \\}\\}`);
      const got = re.exec(src);
      expect(got, which).not.toBeNull();
      expect(Number(got![1]), `${which} base`).toBeGreaterThanOrEqual(m.base);
      expect(Number(got![2]), `${which} md`).toBeGreaterThanOrEqual(m.md);
      expect(Number(got![3]), `${which} lg`).toBeGreaterThanOrEqual(m.lg);
    }
  });

  it("the loader turns a per-band reservation into responsive min-height classes the stylesheet will generate", () => {
    const src = read("components/home/LazyIsland.tsx");
    expect(src).toContain("min-h-[var(--mh-base)] md:min-h-[var(--mh-md)] lg:min-h-[var(--mh-lg)]");
    expect(src).toContain("minHeight");
  });
});

describe("shared design tokens", () => {
  const css = read("app/globals.css");
  it("one radius token and one shared button shape and weight, applied on the first screen and the chrome", () => {
    expect(css).toMatch(/--radius-btn:\s*0\.75rem/);
    expect(css).toMatch(/\.btn-shape\s*\{[^}]*border-radius:\s*var\(--radius-btn\)[^}]*font-weight:\s*600/);
    expect(css).toMatch(/\.btn-tertiary\s*\{[^}]*border-radius:\s*var\(--radius-btn\)/);
    for (const f of ["components/home/Hero.tsx", "components/Navbar.tsx", "components/Footer.tsx", "components/StickyMobileCTA.tsx", "components/home/Sections.tsx"]) {
      expect(read(f), f).toMatch(/btn-shape|btn-tertiary/);
      expect(read(f), f).not.toMatch(/rounded-full[^"]*btn-primary|btn-primary[^"]*rounded-full/);
    }
  });

  it("the free path is never amber: the queue token is not a button colour anywhere on the first screen or the chrome", () => {
    for (const f of ["components/home/Hero.tsx", "components/home/WorkedResult.tsx", "components/Navbar.tsx", "components/Footer.tsx", "components/StickyMobileCTA.tsx"]) {
      expect(read(f), f).not.toMatch(/text-queue|bg-queue|border-queue|eyebrow-queue/);
    }
  });

  it("the page family shares one H1 scale (.page-title); the home page keeps its own larger .display", () => {
    expect(css).toMatch(/\.page-title\s*\{[^}]*font-size:\s*1\.875rem[^}]*letter-spacing:\s*-0\.02em/);
    // the comment names exactly the pages that use it
    for (const page of ["/qualify", "/intelligence", "/observatory", "/contact", "/about"]) expect(css).toContain(page);
    for (const f of ["app/qualify/page.tsx", "components/IntelligenceClient.tsx", "components/observatory/ObservatoryView.tsx", "app/contact/page.tsx", "app/about/page.tsx"]) {
      expect(read(f), f).toMatch(/<h1 className="page-title/);
    }
    expect(read("components/home/Hero.tsx")).toMatch(/<h1 className="display /);
  });
});
