/**
 * The 404 page: its own title, one robots tag, and still a not-found page.
 *
 * What the live page showed: a title identical to the home page's, and two robots tags (Next's own `noindex` for every not-found response,
 * and the root layout's `index, follow`, inherited because app/not-found.tsx exported no metadata). Next's behaviour is what makes the
 * contradiction, so the unit test pins the two things this repository controls (the page's metadata, and the layout it must differ from);
 * the rendered HTML of a real 404 is checked against a built site by scripts/check-share-cards.mjs in CI (status 404, its own title, exactly
 * one robots tag), and was checked here against `next dev` before and after.
 */
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

const layout = fs.readFileSync("app/layout.tsx", "utf8");
const homeTitle = /default:\s*"([^"]+)"/.exec(layout)![1];

describe("app/not-found.tsx", () => {
  it("has a title of its own, distinct from the home page's", async () => {
    const { metadata } = await import("@/app/not-found");
    expect(typeof metadata.title).toBe("string");
    expect(String(metadata.title)).toMatch(/not found/i);
    expect(String(metadata.title)).not.toBe(homeTitle);
    // The root template wraps it like any other page's, so the tab reads "Page not found · Time to Power".
    expect(layout).toMatch(/template:\s*"%s · Time to Power"/);
  });

  it("does not repeat the layout's robots tag: Next writes the one noindex, and a second tag would be a chance to disagree", async () => {
    const { metadata } = await import("@/app/not-found");
    // The layout sets `index, follow`; a key present with a null value replaces it in Next's metadata merge, so no tag is emitted from metadata.
    expect(layout).toMatch(/robots:\s*\{\s*index:\s*true,\s*follow:\s*true\s*\}/);
    expect("robots" in metadata).toBe(true);
    expect(metadata.robots).toBeNull();
  });

  it("is still the not-found page: a 404 marker, a heading and a way home", async () => {
    const { default: NotFound } = await import("@/app/not-found");
    const html = renderToStaticMarkup(React.createElement(NotFound));
    expect(html).toContain("404");
    expect(html).toMatch(/<h1[^>]*>/);
    expect(html).toContain('href="/"');
  });

  it("states no status of its own: the HTTP 404 is Next's, so nothing here can turn it into a 200", () => {
    const code = fs.readFileSync("app/not-found.tsx", "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/status|redirect\(|NextResponse/);
  });
});

describe("the CI check on a built site covers the 404", () => {
  it("scripts/check-share-cards.mjs asserts status, title and the single robots tag on a missing URL", () => {
    const script = fs.readFileSync("scripts/check-share-cards.mjs", "utf8");
    expect(script).toContain("/this-page-does-not-exist");
    expect(script).toMatch(/res\.status === 404/);
    expect(script).toMatch(/robots\.length === 1 && robots\[0\] === "noindex"/);
    expect(script).toMatch(/titles\[0\] !== homeTitle/);
  });
});
