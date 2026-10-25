/**
 * The parts of the site shell that touch /observatory: no checkout push and no assistant launcher over a demonstration page, a
 * skip link that is the first focusable thing (and absent from the link-free presenter), and focus that fixed chrome cannot cover.
 */
import React from "react";
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { nodeVisuals } from "@/components/observatory/scene-visuals";
import { FIXTURE_SCENARIO_FILE, fixtureBuildSceneModel } from "./observatory-ui-fixtures";

const pathname = vi.hoisted(() => ({ value: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => pathname.value, useRouter: () => ({ push: () => {}, replace: () => {} }) }));

const read = (rel: string) => readFileSync(path.resolve(__dirname, "../..", rel), "utf8");

describe("no checkout push from /observatory", () => {
  it("the sticky mobile bar (which carries the Density Screen checkout button) is hidden on /observatory and below it, and still shown elsewhere", async () => {
    const { HIDDEN_ON, isHiddenOn } = await import("@/components/StickyMobileCTA");
    expect(HIDDEN_ON).toContain("/observatory");
    for (const p of ["/observatory", "/observatory/", "/observatory/presenter"]) expect(isHiddenOn(p), p).toBe(true);
    for (const p of ["/", "/pricing", "/qualify", "/reference", null, undefined, ""]) expect(isHiddenOn(p as string | null | undefined), String(p)).toBe(false);
    for (const p of ["/dashboard", "/checkout", "/workspace", "/api-access"]) expect(isHiddenOn(p), p).toBe(true); // unchanged
  });
  it("the scoping assistant launcher is not rendered on /observatory, but is on other pages", async () => {
    const { ScopingAgent } = await import("@/components/ScopingAgent");
    pathname.value = "/observatory";
    expect(renderToStaticMarkup(React.createElement(ScopingAgent))).toBe("");
    pathname.value = "/observatory/presenter";
    expect(renderToStaticMarkup(React.createElement(ScopingAgent))).toBe("");
    pathname.value = "/pricing";
    expect(renderToStaticMarkup(React.createElement(ScopingAgent))).toContain("Open scoping engineer");
    pathname.value = "/workspace";
    expect(renderToStaticMarkup(React.createElement(ScopingAgent))).toBe("");
  });
});

describe("keyboard access around fixed chrome", () => {
  it("the root layout has a skip link before the navigation, inside the shell (so the link-free presenter route has none), pointing at <main id>", () => {
    const src = read("app/layout.tsx");
    const skip = src.indexOf('href="#main-content"');
    const nav = src.indexOf("<Navbar");
    const chrome = src.indexOf("<SiteChrome>");
    expect(skip).toBeGreaterThan(-1);
    expect(chrome).toBeGreaterThan(-1);
    expect(chrome).toBeLessThan(skip);
    expect(skip).toBeLessThan(nav);
    expect(src).toMatch(/<main id="main-content" tabIndex=\{-1\}/);
    expect(src).toContain("focus:not-sr-only");
    // the whole page still goes through SiteChrome, so the bare presenter route keeps carrying no link
    expect(src).toMatch(/<SiteChrome>[\s\S]*Skip to the main content[\s\S]*<\/SiteChrome>/);
  });
  it("fixed chrome cannot cover the element that has focus: scroll padding for the top bar and the bottom bar", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/html\s*\{[^}]*scroll-padding-top:\s*8rem;[^}]*scroll-padding-bottom:\s*7rem;/);
  });
});

describe("the diagram data never carries an after-plan utilisation", () => {
  const model = fixtureBuildSceneModel(FIXTURE_SCENARIO_FILE.scenarios[0], "busway");
  const visuals = nodeVisuals(model);
  it("has no utilAfter at all, so no renderer can draw or announce one", () => {
    for (const v of visuals) expect("utilAfter" in v).toBe(false);
  });
  it("overFound is true only for load as found above capacity as found", () => {
    const by = Object.fromEntries(visuals.map((v) => [v.id, v]));
    expect(by.rack_feed.overFound).toBe(true); // 205 A against 63 A, as found
    expect(by.ups.overFound).toBe(false); // 9.6 MW after the plan against 8 MW as found is NOT over capacity
    expect(by.transformer.overFound).toBe(false); // MVA against MW: not comparable
    expect(by.ups.utilFound).toBeCloseTo(4.4 / 8);
  });
});
