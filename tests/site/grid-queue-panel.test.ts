/**
 * The grid-queue panel tells a buyer what completed US interconnections took, and in the same breath what that is not.
 *
 * It must show the measured figures and the survivorship share, say plainly that it is no date for this site, attribute its source, and
 * render nothing when the engine does not carry the block (an older engine).
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { GridQueuePanel } from "@/components/GridQueuePanel";
import type { GridQueueContext } from "@/lib/ttp-compare";

const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();

const CTX: GridQueueContext = {
  kind: "context_only",
  source: { name: "Lawrence Berkeley National Laboratory, Queued Up (2026 edition, data through 2025)", licence: "CC BY 4.0", workbook_sha256: "794582d3281c6a305e9615fcfec3fae9dc85be2165216d33760b677e976a08b6", measured_on: "2026-10-28" },
  observed: { name: "US, requests that reached operation 2018-2025", n: 1439, p25_years: 3.086, median_years: 4.394, p75_years: 5.844, p25_weeks: 161, median_weeks: 229.3, p75_weeks: 304.8 },
  survivorship: { entry_years: [2010, 2015], entered: 5633, operational: 1299, withdrawn: 4153, unresolved: 181, share_operational_of_entered: 0.231, statement: "x" },
  applicability: { site_country: "IE", context_geography: "US", level: "scale_reference_only" },
  statements: [],
  must_not_claim: [],
  limits: [],
};

const render = (ctx: GridQueueContext | undefined) => text(renderToStaticMarkup(React.createElement(GridQueuePanel, { ctx })));

describe("the grid-queue panel", () => {
  it("shows the measured median, the middle half and the sample, in months", () => {
    const t = render(CTX);
    expect(t).toContain("median of 53 months");
    expect(t).toContain("middle half 37–70 months");
    expect(t).toContain("1439");
    expect(t).toContain("US, requests that reached operation 2018-2025");
  });

  it("puts the survivorship in front of the buyer: most requests never reach operation", () => {
    const t = render(CTX);
    expect(t).toContain("Only 23% of the 5633 requests that entered a queue in 2010–2015 reached operation");
    expect(t).toContain("4153 were withdrawn");
    expect(t).toContain("describe only the ones that made it");
  });

  it("says what it is not, and that it changes nothing above it", () => {
    const t = render(CTX);
    expect(t).toContain("context, not this site's date");
    expect(t).toContain("not a connection time for a load or a data centre");
    expect(t).toContain("changes no date, figure or evidence class in the result above");
    expect(t).toContain("scale reference only");
  });

  it("says when the site is in the same country, and attributes the source", () => {
    const t = render({ ...CTX, applicability: { ...CTX.applicability, site_country: "US", level: "same_country_context" } });
    expect(t).toContain("same country as the observed data");
    expect(t).not.toContain("scale reference only");
    expect(t).toContain("CC BY 4.0");
    expect(t).toContain("Computed independently by the gridforge-stress harness");
    expect(t).toContain("794582d3281c");
  });

  it("renders nothing when the engine does not carry the block", () => {
    expect(renderToStaticMarkup(React.createElement(GridQueuePanel, { ctx: undefined }))).toBe("");
  });

  it("copes with a context that has no survivorship block rather than inventing one", () => {
    const t = render({ ...CTX, survivorship: null });
    expect(t).not.toContain("reached operation;");
    expect(t).toContain("median of 53 months");
  });
});
