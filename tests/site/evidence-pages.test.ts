import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CLAIM_FLOORS, EVIDENCE_CLASSES } from "@/lib/evidence-classes";
import sitemap from "@/app/sitemap";
import { FOOTER_GROUPS } from "@/lib/nav";

const py = readFileSync("gridforge/validation/evidence.py", "utf8");
const text = (h: string) => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("the evidence-class table is the engine's, not a copy that can drift", () => {
  it("has exactly the classes, numbers and descriptions the engine defines", () => {
    const defined = [...py.matchAll(/^\s+(E(\d)_[A-Z_]+)\s*=\s*(\d+)\s*#\s*(.+)$/gm)];
    expect(defined.length).toBe(EVIDENCE_CLASSES.length);
    for (const [, name, digit, num] of defined) {
      expect(num).toBe(digit);
      const doc = EVIDENCE_CLASSES.find((c) => c.code === `E${digit}`)!;
      expect(doc.name).toBe(name);
    }
    for (const c of EVIDENCE_CLASSES) {
      // The verb the engine uses to describe a figure of this class.
      expect(py).toContain(`: "${c.verb}"`);
    }
  });

  it("states the same claim floors as CLAIM_FLOOR", () => {
    const block = py.slice(py.indexOf("CLAIM_FLOOR"));
    for (const f of CLAIM_FLOORS) {
      expect(block).toMatch(new RegExp(`"${f.kind}":\\s*EvidenceClass\\.${f.floor}_`));
    }
    expect(CLAIM_FLOORS.length).toBe([...block.matchAll(/"[a-z_]+":\s*EvidenceClass\./g)].length);
  });
});

describe("/evidence", () => {
  it("renders the live calibration record, and says the model is not yet validated while that is true", async () => {
    const cal = JSON.parse(readFileSync("public/reference/calibration.json", "utf8"));
    const { default: Page } = await import("@/app/evidence/page");
    // The page reads the engine's residual report; this test is about the committed record, so the engine is unreachable, deterministically.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("engine unreachable"); }) as typeof fetch;
    let html: string;
    try {
      html = renderToStaticMarkup(await Page());
    } finally {
      globalThis.fetch = realFetch;
    }
    const t = text(html);
    expect(t).toContain(cal.statement.replace(/\s+/g, " ").slice(0, 60));
    if (cal.observations === 0) expect(t).toContain("Not yet.");
    expect(html).toContain("FAQPage");
    // the markup and the visible questions are one list
    for (const q of ["Is the engine validated against real sites?", "What does an evidence class mean?"]) expect(t).toContain(q);
  });
});

describe("/lead-times", () => {
  it("lists every constraint that has a range, with the library's own numbers", async () => {
    const ref = JSON.parse(readFileSync("public/reference/constraints.json", "utf8"));
    const { default: Page } = await import("@/app/lead-times/page");
    const t = text(renderToStaticMarkup(await Page()));
    for (const c of ref.constraints.filter((x: any) => x.lead_time_weeks)) {
      expect(t).toContain(c.name);
      expect(t).toContain(`${c.lead_time_weeks.low} to ${c.lead_time_weeks.high} weeks`);
    }
  });

  it("never presents a range as a quotation or a promise", async () => {
    const { default: Page } = await import("@/app/lead-times/page");
    const t = text(renderToStaticMarkup(await Page())).toLowerCase();
    expect(t).toContain("not quotations");
    expect(t).not.toMatch(/guaranteed|we will deliver|within \d+ weeks of order/);
  });
});

describe("discovery", () => {
  it("both pages are in the sitemap and the footer", async () => {
    const urls = (await sitemap()).map((e) => e.url);
    const hrefs = FOOTER_GROUPS.flatMap((g) => g.links.map((l) => l.href));
    for (const p of ["/evidence", "/lead-times"]) {
      expect(urls.some((u) => u.endsWith(p))).toBe(true);
      expect(hrefs).toContain(p);
    }
  });
});

describe("landmarks", () => {
  it("the layout owns the one <main>; no page or component nests another", async () => {
    const { execFileSync } = await import("node:child_process");
    const files = execFileSync("grep", ["-rl", "<main", "app", "components", "--include=*.tsx"], { encoding: "utf8" }).split("\n").filter(Boolean);
    expect(files).toEqual(["app/layout.tsx"]);
  });
});
