import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(p, "utf8");

// Defects an independent real-browser review proved on 2026-11-10 (axe, keyboard, 320-1440 px). Each is pinned so it cannot come back unnoticed.
describe("accessibility defects found in a real browser", () => {
  it("the mobile menu scrolls inside itself, locks the page behind it and sits in a banner landmark", () => {
    const nav = read("components/Navbar.tsx");
    expect(nav).toMatch(/id="mobile-nav"[^>]*max-h-\[calc\(100dvh-5rem\)\][^>]*overflow-y-auto/);
    expect(nav).not.toMatch(/id="mobile-nav"[^>]*overflow-hidden/);
    expect(nav).toMatch(/document\.body\.style\.overflow = "hidden"/);
    expect(nav).toMatch(/<header>\s*<nav\s+aria-label="Primary"/);
  });

  it("a submit button that starts a request is aria-disabled, never `disabled` (disabled drops keyboard focus to <body>)", () => {
    const q = read("components/CapacityQualifier.tsx");
    const form = q.slice(q.indexOf('type="submit"'), q.indexOf('type="submit"') + 200);
    expect(form).toContain("aria-disabled={busy}");
    expect(form).not.toMatch(/(^|[^-])disabled=\{busy\}/);
    expect(read("components/TtpCompare.tsx")).toMatch(/type="submit" aria-disabled=\{busy\}/);
    expect(read("components/PowerDeployCaseForm.tsx")).toMatch(/aria-disabled=\{state === "busy"\}/);
    for (const f of ["components/CapacityQualifier.tsx", "components/TtpCompare.tsx", "components/PowerDeployCaseForm.tsx"]) {
      expect(read(f), f).toMatch(/if \((busy|state === "busy")\) return;/);
    }
  });

  it("a result that appears below a form takes focus, so a screen reader announces it", () => {
    expect(read("components/CapacityQualifier.tsx")).toMatch(/headlineRef\.current\?\.focus\(\)/);
    expect(read("components/TtpCompare.tsx")).toMatch(/aria-label="Comparison result"[^>]*tabIndex=\{-1\}|tabIndex=\{-1\} aria-label="Comparison result"/);
  });

  it("the last footer links are not left under the fixed launcher and the sticky bar", () => {
    expect(read("components/Footer.tsx")).toMatch(/<footer className="[^"]*pb-28/);
  });

  it("the scenario selector's buttons are at least 24 px wide and 44 px high, named and mark the current one", () => {
    const t = read("components/TimeToPower.tsx");
    expect(t).toMatch(/aria-label=\{sc\.title\}/);
    expect(t).toMatch(/aria-current=\{i === sceneIdx/);
    expect(t).toMatch(/inline-flex h-11 min-w-6/);
  });

  it("the sticky mobile bar is a landmark and the workspace has one visible-to-AT H1", () => {
    expect(read("components/StickyMobileCTA.tsx")).toMatch(/<aside\s+aria-label="Quick actions"/);
    expect(read("app/workspace/WorkspaceClient.tsx")).toMatch(/<h1 className="sr-only">/);
    expect(read("components/ai/Canvas.tsx")).not.toMatch(/<h1/);
  });

  it("the site has a print stylesheet that drops the chrome", () => {
    const css = read("app/globals.css");
    expect(css).toMatch(/@media print/);
    expect(css.slice(css.indexOf("@media print"))).toMatch(/nav,\s*footer/);
  });

  it("the reference documents' scrollable tables are keyboard-focusable regions and the walkthrough text clears 4.5:1", () => {
    expect(read("gridforge/reporting/render.py")).not.toMatch(/<div class='tablewrap'>/);
    expect(read("gridforge/reporting/render.py")).toMatch(/class='tablewrap' tabindex='0' role='region'/);
    expect(read("gridforge/reporting/deck.py")).not.toMatch(/#5A6478/i);
  });
});
