/**
 * The Envelope Study needs the redundancy configuration of the transformer, UPS and cooling banks, and the buyer is told so BEFORE they pay.
 *
 * The engine keeps the bar (gridforge/intake/loader.py `_bank_gaps`): a bank whose `redundancy` is omitted is computed with N+1 as an E0 assumption
 * and named as a REQUIRED gap, and an intake with a required gap is not one a full Study can be issued on (`can_issue`). The sentence that says so
 * is lib/study-needs.ts; this file pins that it is the sentence the engine's behaviour supports, and that every surface where the Study is
 * described, offered or filled in carries it.
 */
import fs from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { STUDY_REDUNDANCY_SENTENCE } from "@/lib/study-needs";
import { PRODUCT_PAGES } from "@/lib/product-pages";
import { studyOffer, studyOfferEmail } from "@/lib/study-offer";
import { EngagementLadder } from "@/components/EngagementLadder";
import { StudyRedundancyNote } from "@/components/EngagementIntake";
import { StudyUpsell } from "@/components/StudyUpsell";
import { FULL_ENGINE, stubEngine } from "./engine-stub";

vi.mock("next/font/local", () => ({ default: () => ({ variable: "", className: "" }) }));

const flat = (h: string) => h.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

describe("the sentence says what the engine does", () => {
  it("names the schemes, the three kinds of bank, why it matters and what happens without it", () => {
    for (const part of ["redundancy configuration", "N, N+1, N+2 or 2N", "transformer, UPS and cooling bank", "how many of a bank's units are usable", "N, N+1 or 2N-based", "required gap", "N+1 is assumed", "full Study can be issued"]) {
      expect(STUDY_REDUNDANCY_SENTENCE, part).toContain(part);
    }
    expect(STUDY_REDUNDANCY_SENTENCE).not.toMatch(/[€$%]|\bEUR\b|working days/);
  });

  it("the engine still names an omitted redundancy as a REQUIRED gap, assumes N+1 for it, and refuses to issue on a required gap", () => {
    const loader = fs.readFileSync("gridforge/intake/loader.py", "utf8");
    // the gap for a bank that omits `redundancy` is required, and its fallback is the labelled N+1 default
    expect(loader).toMatch(/if "redundancy" not in item:\s*\n\s*out\.append\(DataGap\(\s*\n\s*path=f"\{section\}\[\{ref\}\]\.redundancy"[^\n]*required=True/);
    expect(loader).toMatch(/DEFAULT_BANK_REDUNDANCY = "N\+1"/);
    // the three kinds of bank go through that one function: transformers, UPS blocks and CDU banks
    expect(loader).toMatch(/ups, cdu = section == "ups", section == "thermal\.cdus"/);
    // an intake with a required gap is not issuable
    const schema = fs.readFileSync("gridforge/intake/schema.py", "utf8");
    expect(schema).toMatch(/def can_issue\(self\) -> bool:[\s\S]{0,200}return not self\.required_gaps/);
    // the schemes it accepts are the four the sentence lists
    const power = fs.readFileSync("gridforge/power/redundancy.py", "utf8");
    expect(power).toMatch(/SCHEMES = \("N", "N\+1", "N\+2", "2N"\)/);
  });
});

describe("it is on every surface where the Study is described, offered or filled in", () => {
  it("the Study's product page lists it under what we need from you", () => {
    const page = PRODUCT_PAGES.find((p) => p.productId === "envelope_study_deposit")!;
    expect(page.inputs).toContain(STUDY_REDUNDANCY_SENTENCE);
  });

  it("no other product's page carries it (it is the Study's requirement)", () => {
    for (const p of PRODUCT_PAGES.filter((x) => x.productId !== "envelope_study_deposit")) {
      expect([...p.inputs, ...p.limits, ...p.flow], p.slug).not.toContain(STUDY_REDUNDANCY_SENTENCE);
    }
  });

  it("the engagement ladder carries it under the Study, where the deposit is offered", () => {
    const html = flat(renderToStaticMarkup(React.createElement(EngagementLadder)));
    expect(html).toContain(STUDY_REDUNDANCY_SENTENCE);
    expect(html.split(STUDY_REDUNDANCY_SENTENCE).length - 1).toBe(1);
  });

  it("the Study offer made after a released Density Screen carries it in its data, its page section and its email", () => {
    const offer = studyOffer("density_screen")!;
    expect(offer.needs).toBe(STUDY_REDUNDANCY_SENTENCE);
    expect(studyOfferEmail(offer, "https://example.invalid")).toContain(STUDY_REDUNDANCY_SENTENCE);
    const html = flat(renderToStaticMarkup(React.createElement(StudyUpsell, { kind: "density_screen" })));
    expect(html).toContain("What it needs from you");
    expect(html).toContain(STUDY_REDUNDANCY_SENTENCE);
  });

  it("the Study's intake form shows it above the schedules, for a Study and only for a Study", () => {
    expect(flat(renderToStaticMarkup(React.createElement(StudyRedundancyNote)))).toContain(STUDY_REDUNDANCY_SENTENCE);
    const src = fs.readFileSync("components/EngagementIntake.tsx", "utf8");
    // rendered under the transformer schedule heading, behind the Study's own kind
    expect(src).toMatch(/Transformer schedule<\/h2>\s*\n\s*\{meta\?\.kind === "envelope_study_deposit" \? <div className="mt-2"><StudyRedundancyNote \/><\/div> : null\}/);
    // the per-row option already says a Study needs the visitor's scheme
    expect(src).toMatch(/Not stated \(engine assumes \$\{ENGINE_LIBRARY_DEFAULTS\.redundancy\}; a Study needs yours\)/);
  });

  it("/llms.txt carries it for an agent that is about to pay", async () => {
    const stop = stubEngine(FULL_ENGINE);
    try {
      const { GET } = await import("@/app/llms.txt/route");
      const body = (await (await GET()).text()).replace(/\s+/g, " ");
      expect(body).toContain(`Envelope Study, before you pay: ${STUDY_REDUNDANCY_SENTENCE}`);
    } finally {
      stop();
    }
  });
});
