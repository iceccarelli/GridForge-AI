import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  usePathname: () => "/",
}));

import { CapacityQualifier } from "@/components/CapacityQualifier";
import { Navbar } from "@/components/Navbar";

// Structural accessibility fixes. These read the rendered markup (or, for behaviour that needs a browser, the source) so a regression in a
// label, a role or a focus hand-off fails offline. The browser-level evidence (axe at 375 and 1440 px, keyboard runs, 320 px reflow) was
// produced with Playwright against a production build and is reported with the change; it is not re-run here.

const read = (f: string) => fs.readFileSync(f, "utf8");

describe("capacity qualifier form", () => {
  const out = renderToStaticMarkup(React.createElement(CapacityQualifier));
  const inputs = [...out.matchAll(/<(input|select)\b[^>]*>/g)].map((m) => m[0]);

  it("every field has a <label for> pointing at its id, and the label text is not the hint", () => {
    expect(inputs.length).toBeGreaterThanOrEqual(10);
    for (const tag of inputs) {
      const id = /\bid="([^"]+)"/.exec(tag)?.[1];
      expect(id, tag).toBeTruthy();
      expect(out, id).toMatch(new RegExp(`<label[^>]*for="${id}"`));
    }
    // The hint is its own element, tied to the field by aria-describedby, not folded into the accessible name.
    expect(out).toMatch(/aria-describedby="qualify-contractedMW-hint"/);
    expect(out).toContain('id="qualify-contractedMW-hint"');
    expect(out).not.toMatch(/<label[^>]*>[^<]*<span[^>]*>[^<]*<\/span><input/);
  });

  it("the optional fields say so in the label, not only in a placeholder", () => {
    expect(out).toContain("Site / hall (optional)");
    expect(out).toContain("Metro (optional)");
    expect(out).not.toContain('placeholder="optional"');
  });

  it("uses its own messages: native validation bubbles are off, fields are aria-required", () => {
    expect(out).toMatch(/<form[^>]*novalidate/i);
    expect(out.match(/aria-required="true"/g)?.length).toBe(7);
  });

  it("negative plant temperatures are allowed (the engine accepts -5 to 45 degrees C)", () => {
    expect(out).toMatch(/id="qualify-plantSupplyC"[^>]*min="-5"|min="-5"[^>]*id="qualify-plantSupplyC"/);
  });

  it("source: a failed submit moves focus to the first invalid field or to the alert, which is announced", () => {
    const t = read("components/CapacityQualifier.tsx");
    expect(t).toContain('aria-invalid={err ? true : undefined}');
    expect(t).toMatch(/focusField\(bad\[0\]\.key\)/);
    expect(t).toMatch(/role="alert"/);
    expect(t).toMatch(/alertRef\.current\?\.focus\(\)/);
    expect(t).toMatch(/tabIndex=\{-1\}/);
  });
});

describe("navigation", () => {
  const out = renderToStaticMarkup(React.createElement(Navbar));

  it("is a labelled landmark and the menu button is a real disclosure button", () => {
    expect(out).toContain('<nav aria-label="Primary"');
    expect(out).toMatch(/<button[^>]*type="button"[^>]*aria-label="Main menu"[^>]*aria-controls="mobile-nav"[^>]*aria-expanded="false"/);
  });

  it("the drawer closes on Escape and hands focus back to the button that opened it", () => {
    const t = read("components/Navbar.tsx");
    expect(t).toMatch(/e\.key === "Escape"/);
    expect(t).toMatch(/toggleRef\.current\?\.focus\(\)/);
    expect(t).toContain('id="mobile-nav"');
  });

  it("route entries in the drawer are links, not buttons that assign window.location", () => {
    const t = read("components/Navbar.tsx");
    const drawer = t.slice(t.indexOf('id="mobile-nav"'));
    expect(drawer).toMatch(/<Link\s+key=\{link\.href\}/);
  });

  it("decorative icons are hidden from assistive technology", () => {
    const t = read("components/Navbar.tsx");
    expect(t).toContain('<X size={22} aria-hidden="true"');
    expect(t).toContain('<Menu size={22} aria-hidden="true"');
  });
});

describe("reflow at 320 px and 200% text", () => {
  const css = read("app/globals.css");

  it("long words wrap and flex/grid children may shrink on small screens", () => {
    expect(css).toMatch(/overflow-wrap: break-word/);
    expect(css).toMatch(/@media \(max-width: 40rem\)[\s\S]*min-width: 0/);
  });

  it("no wrapping container carries a fixed rem minimum wider than a phone", () => {
    for (const f of [
      "app/constraints/page.tsx",
      "app/constraints/[slug]/page.tsx",
      "app/platforms/page.tsx",
      "app/reference/page.tsx",
      "app/developers/page.tsx",
      "app/q/[token]/page.tsx",
    ]) {
      expect(read(f), f).not.toMatch(/\bmin-w-64\b/);
    }
    expect(read("app/platforms/[id]/page.tsx")).not.toMatch(/"grid grid-cols-\[12rem_1fr\]/);
  });
});
