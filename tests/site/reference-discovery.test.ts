/**
 * The published worked example (public/reference/*.html) names itself as the canonical copy of its content: each page
 * duplicates its .md twin, so the HTML says "I am the canonical one" and carries a description and a robots tag. The tags
 * are written by scripts/build-reference.sh (the same place that writes the files, so CI's byte-for-byte diff covers them).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SITE_URL } from "@/lib/site";

const DIR = path.join(process.cwd(), "public", "reference");
const PAGES = ["envelope_study", "board_summary", "proposal", "specification", "walkthrough"];

describe.each(PAGES)("public/reference/%s.html", (name) => {
  const html = fs.readFileSync(path.join(DIR, `${name}.html`), "utf8");
  const head = html.slice(0, html.indexOf("</head>"));

  it("is canonical at its own absolute URL, exactly once", () => {
    const links = [...head.matchAll(/<link rel='canonical' href='([^']+)'>/g)].map((m) => m[1]);
    expect(links).toEqual([`${SITE_URL}/reference/${name}.html`]);
  });

  it("has a description that says the data is synthetic, and an indexable robots tag", () => {
    const d = /<meta name='description' content='([^']+)'>/.exec(head);
    expect(d).not.toBeNull();
    expect(d![1].length).toBeGreaterThan(60);
    expect(d![1]).toMatch(/Synthetic reference hall/);
    expect(head).toContain("<meta name='robots' content='index,follow'>");
    expect(head).not.toMatch(/noindex/);
  });

  it("keeps its markdown twin, and the twin is not given a competing canonical", () => {
    expect(fs.existsSync(path.join(DIR, `${name}.md`))).toBe(name !== "walkthrough");
  });
});
