/**
 * The retail-price panel tells a buyer what US customers paid for electricity on average, and in the same breath what that is not.
 *
 * It must show the published figures, put the engine's own price beside them without converting currency, say plainly that it is no tariff
 * for this site, attribute its source, and render nothing when the engine does not carry the block (an older engine).
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RetailPricePanel } from "@/components/RetailPricePanel";
import type { RetailPriceContext } from "@/lib/ttp-compare";

// The engine's placeholder electricity price, not a product price; built from a constant so no euro figure is written as text here.
const PLACEHOLDER_EUR_PER_MWH = 140;

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const CTX: RetailPriceContext = {
  kind: "context_only",
  source: { name: "U.S. Energy Information Administration, Electric Power Monthly, Table 5.6.A (Form EIA-861M)", release_date: "October 23, 2026", page_sha256: "042269100ad9e52865ce21692337baa25ef0385e653189f51001ba348d7e3603", measured_on: "2026-10-30" },
  observed: { area: "U.S. Total", period: "2026-08", unit: "US dollars per MWh", sectors: { commercial: { usd_per_MWh: 144.7, cents_per_kWh: 14.47 }, industrial: { usd_per_MWh: 96.4, cents_per_kWh: 9.64 } } },
  applicability: { site_country: "IE", level: "scale_reference_only" },
  assumed: { eur_per_MWh: PLACEHOLDER_EUR_PER_MWH, source: "library placeholder (evidence class E0); no contracted tariff supplied", evidence_class_unchanged: true },
  statements: [],
  limits: [],
};

const render = (ctx: RetailPriceContext | undefined) => text(renderToStaticMarkup(React.createElement(RetailPricePanel, { ctx })));

describe("the retail-price panel", () => {
  it("shows the published industrial and commercial averages with the area and month", () => {
    const t = render(CTX);
    expect(t).toContain("U.S. Total, 2026-08");
    expect(t).toContain("industrial customers paid $96.4/MWh");
    expect(t).toContain("commercial customers $144.7/MWh");
  });

  it("sets the engine's price beside it and refuses to convert the currencies", () => {
    const t = render(CTX);
    expect(t).toContain(`€${PLACEHOLDER_EUR_PER_MWH}/MWh`);
    expect(t).toContain("library placeholder");
    expect(t).toContain("not converted here");
  });

  it("says it is no tariff for this site, and what it changes", () => {
    const t = render(CTX);
    expect(t).toContain("scale reference at most");
    expect(t).toContain("changes no cost or evidence class");
    expect(t).toContain("not a data-centre price");
  });

  it("attributes the source and the independent parse", () => {
    const t = render(CTX);
    expect(t).toContain("Electric Power Monthly");
    expect(t).toContain("released October 23, 2026");
    expect(t).toContain("042269100ad9…");
  });

  it("renders nothing when the engine does not carry the block", () => {
    expect(render(undefined)).toBe("");
  });

  it("handles a sector EIA did not publish without printing a number for it", () => {
    const t = render({ ...CTX, observed: { ...CTX.observed, sectors: { commercial: null, industrial: CTX.observed.sectors.industrial } } });
    expect(t).toContain("commercial customers no published figure");
  });
});
