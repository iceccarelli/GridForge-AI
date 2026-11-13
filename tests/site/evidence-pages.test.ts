import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CLAIM_FLOORS, E3_ESTIMATE, E3_MEANING, E3_NOT_SIGNOFF, E3_REVIEW_RECORDED, EVIDENCE_CLASSES } from "@/lib/evidence-classes";
import { EVIDENCE_BANDS } from "@/lib/evidence-bands";
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

// E3 is the highest class the engine's own arithmetic can carry (gridforge/common.py ESTIMATED, procurement SPEC_CEILING, the intake's supplied_evidence),
// for every hall, with no engineer having reviewed that hall. It used to be defined everywhere as "model plus review by a qualified engineer against
// practice", which the code never did. The definition below is the one that is true; these tests pin the Python comment, the site table and the
// other surfaces to it, and fail if the old meaning comes back.
describe("E3 is the engine's own estimate, not an engineer's sign-off on a hall", () => {
  // The Python comment, with a comment that wraps onto the next `#` line read as one sentence.
  const pyFlat = py.replace(/\s*\n\s*#\s*/g, " ");
  const e3Comment = /^\s+E3_ENGINEERING_ESTIMATE\s*=\s*3\s*#\s*(.+)$/m.exec(py)?.[1].trim() ?? "";
  const e3 = EVIDENCE_CLASSES.find((c) => c.code === "E3")!;
  // The words of the old definition ("model plus review by a qualified engineer against practice"). Statements that a named engineer reviews and
  // releases each ENGAGEMENT document are correct and are not matched.
  const OLD = /qualified engineer|against practice|model\s*(?:plus|\+)\s*review|model reviewed by an engineer|engineer.reviewed model/i;

  it("the comment on the Python member is the first sentence of the site table's meaning, word for word", () => {
    expect(e3Comment).not.toBe("");
    expect(`${e3Comment}.`.toLowerCase()).toBe(E3_ESTIMATE.toLowerCase());
    expect(e3.meaning.toLowerCase().startsWith(`${e3Comment}.`.toLowerCase())).toBe(true);
    expect(e3Comment.toLowerCase()).toContain("estimated by the engine's documented method from the stated inputs");
    expect(e3Comment.toLowerCase()).toContain("the highest class the engine's own arithmetic can carry");
  });

  it("the Python file and the site table both say what E3 is not, and that a release review does not raise a class", () => {
    expect(pyFlat).toContain(E3_NOT_SIGNOFF);
    expect(pyFlat).toContain(E3_REVIEW_RECORDED);
    expect(e3.meaning).toBe(E3_MEANING);
    expect(e3.meaning).toContain(E3_NOT_SIGNOFF);
    expect(e3.meaning).toContain(E3_REVIEW_RECORDED);
  });

  it("the old definition is gone from the table, the bands, the Python file and every page, guide and document under app, lib, components, gridforge and docs", () => {
    expect(e3.meaning).not.toMatch(OLD);
    expect(py).not.toMatch(OLD);
    for (const b of EVIDENCE_BANDS) expect(b.reading, b.id).not.toMatch(OLD);
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next" || name === "__pycache__" || name === "reference" || name === "observatory") continue;
        const p = path.join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(?:tsx?|py|md|mjs|json|txt)$/.test(name) && OLD.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    for (const root of ["app", "lib", "components", "gridforge", "docs"]) walk(root);
    expect(hits, "a page, guide or document equates E3 with a qualified engineer's review").toEqual([]);
  });

  it("the guard itself can fail: the old Python comment and the old table row are what it matches", () => {
    expect("E3_ENGINEERING_ESTIMATE = 3  # model + reviewed by a qualified engineer against practice").toMatch(OLD);
    expect("Model plus review by a qualified engineer against practice.").toMatch(OLD);
    expect("a simulation, or a model reviewed by an engineer.").toMatch(OLD);
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

  it("prints E3 as the engine's own estimate in the class table, and answers the engineer-review question in the page and in the FAQPage markup", async () => {
    const { default: Page } = await import("@/app/evidence/page");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => { throw new Error("engine unreachable"); }) as typeof fetch;
    let html: string;
    try {
      html = renderToStaticMarkup(await Page());
    } finally {
      globalThis.fetch = realFetch;
    }
    const decode = (h: string) => text(h).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    const t = decode(html);
    expect(t).toContain(E3_MEANING);
    expect(t).toContain("Does an engineer's review make a figure E3?");
    expect(t).toContain("No. E3 means: estimated by the engine's documented method from the stated inputs");
    expect(t).toContain("each engagement document is reviewed and released by a named engineer");
    const ld = [...html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join("\n");
    expect(ld).toContain("Does an engineer");
    expect(t).not.toMatch(/qualified engineer|against practice|reviewed by an engineer/i);
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
