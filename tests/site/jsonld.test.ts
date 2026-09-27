/**
 * Structured data for the constraint reference (HANDOFF.md §6e #21).
 *
 * The pages already carried `TechArticle` JSON-LD; this covers the `Dataset` /
 * `PropertyValue` layer added alongside it so a crawler citing a number has a
 * machine-readable copy to fetch, not just an article to scrape. Tested against
 * the real generated reference file so this cannot silently diverge from what
 * `gridforge reference` actually produces — the same discipline
 * test_reference_layer.py applies on the Python side.
 *
 * What is asserted is narrow and deliberate: every distribution URL is one this
 * site actually serves, every numeric value traces back to the reference record
 * it came from, and no property implies a measurement or a fact-check we have
 * not done (no `Claim`, no `QuantitativeValue` presented as verified).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { constraintCatalogueJsonLd, constraintRecordJsonLd } from "@/lib/jsonld";
import type { ConstraintReference } from "@/lib/constraints";

const REF: ConstraintReference = JSON.parse(
  fs.readFileSync(
    path.join(process.cwd(), "public", "reference", "constraints.json"),
    "utf8"
  )
);

describe("constraintCatalogueJsonLd", () => {
  const ld = constraintCatalogueJsonLd(REF);

  it("is a Dataset, not a Claim or a verified measurement", () => {
    expect(ld["@type"]).toBe("Dataset");
  });

  it("carries the engine's own honesty notice verbatim, not a paraphrase", () => {
    expect(ld.description).toBe(REF.notice);
  });

  it("points at the machine-readable copies this site actually serves", () => {
    const urls = ld.distribution.map((d) => d.contentUrl);
    expect(urls).toContain("https://timetopower.ai/reference/constraints.json");
    expect(urls).toContain("https://timetopower.ai/api/constraints");
  });

  it("lists every constraint by name, once", () => {
    expect(ld.variableMeasured).toEqual(REF.constraints.map((c) => c.name));
  });

  it("cites the citation endpoint rather than restating its own licence text", () => {
    expect(ld.citation).toBe("https://timetopower.ai/api/cite");
  });
});

describe("constraintRecordJsonLd", () => {
  const c = REF.constraints.find((x) => x.worked_example && x.cost_basis) ?? REF.constraints[0];
  const ld = constraintRecordJsonLd(c, REF);

  it("is a Dataset scoped to this one constraint", () => {
    expect(ld["@type"]).toBe("Dataset");
    expect(ld.identifier).toBe(c.id);
    expect(ld.url).toBe(`https://timetopower.ai/constraints/${c.slug}`);
  });

  it("is part of the catalogue dataset, not a free-standing page", () => {
    expect(ld.isPartOf.url).toBe("https://timetopower.ai/constraints");
  });

  it("distributes through the per-slug machine-readable endpoint", () => {
    expect(ld.distribution.contentUrl).toBe(
      `https://timetopower.ai/api/constraints?slug=${c.slug}`
    );
  });

  it("carries the lead-time range as a PropertyValue with an explicit unit, when the constraint has one", () => {
    if (!c.lead_time_weeks) return;
    const prop = ld.variableMeasured.find((v) => v.name === "Indicative relief lead time");
    expect(prop).toBeDefined();
    expect(prop).toMatchObject({
      "@type": "PropertyValue",
      minValue: c.lead_time_weeks.low,
      maxValue: c.lead_time_weeks.high,
      unitText: "weeks",
    });
  });

  it("carries the cost basis's own evidence class, never a stronger one", () => {
    if (!c.cost_basis) return;
    const prop = ld.variableMeasured.find((v) => v.name === "Cost basis evidence class");
    expect(prop?.value).toBe(c.cost_basis.evidence);
  });

  it("never uses a schema type that implies a fact-check or a measurement", () => {
    const flat = JSON.stringify(ld);
    expect(flat).not.toContain('"@type":"Claim"');
    expect(flat).not.toContain('"@type":"QuantitativeValue"');
  });

  it("holds for every published constraint, not just the one under test", () => {
    for (const constraint of REF.constraints) {
      const rec = constraintRecordJsonLd(constraint, REF);
      expect(rec.identifier).toBe(constraint.id);
      expect(rec["@type"]).toBe("Dataset");
    }
  });
});
