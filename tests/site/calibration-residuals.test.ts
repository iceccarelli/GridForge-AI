/**
 * The live residual status on /evidence: read from the engine's public GET /v1/calibration/residuals, with a timeout, and shown only if it
 * was read and has the documented shape. A failed read says it could not be read and shows no number from anywhere else; with no approved
 * records the page says "Uncalibrated: 0 approved production records" and shows the schema the report will carry. No accuracy claim.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CalibrationTransparency } from "@/components/CalibrationTransparency";
import { RESIDUAL_CELL_FIELDS, RESIDUALS_SCHEMA } from "@/lib/calibration-gates";
import { COUNT_MAX, RESIDUALS_MAX_BYTES, parseResiduals, readLiveResiduals } from "@/lib/calibration-residuals";

const text = (h: string) => h.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&rsquo;/g, "'").replace(/\s+/g, " ").trim();

/** The body the engine sends with no approved record (gridforge/calibration/residuals.py public_report over []). */
const EMPTY = {
  schema: RESIDUALS_SCHEMA, state: "uncalibrated", n_records: 0, n_sites: 0, headline: "Calibration is reported per subsystem; no single accuracy figure is produced.",
  requirements: { min_approved_observations_per_variable: 10, min_distinct_sites_per_variable: 3, low_quality_counts_toward_calibration: false },
  subsystem_states: { power: "UNCALIBRATED" },
  subsystems: {
    power: {
      state: "UNCALIBRATED", approved_observations: 0, distinct_sites: 0, statement: "power: UNCALIBRATED (n=0 approved observations).",
      variables: { btm_firm_MW: { unit: "MW", state: "UNCALIBRATED", approved_observations: 0, counting_toward_calibration: 0, distinct_sites: 0, still_needed: { observations: 10, sites: 3 } } },
    },
  },
  withheld_variables: ["capex_total_eur", "weeks_to_full"], note: "n",
};
/** A body with records in it (synthetic numbers, only to prove the page prints what it read and nothing more). */
const WITH_RECORDS = {
  ...EMPTY, state: "indicative", n_records: 4, n_sites: 2, subsystem_states: { power: "INDICATIVE" },
  subsystems: {
    power: {
      state: "INDICATIVE", approved_observations: 4, distinct_sites: 2, statement: "s",
      variables: {
        btm_firm_MW: {
          unit: "MW", state: "INDICATIVE", approved_observations: 4, counting_toward_calibration: 4, distinct_sites: 2, still_needed: { observations: 6, sites: 1 },
          residuals: { n: 4, sites: 2, suppressed: "fewer than 3 sites" },
        },
        grid_firm_MW: {
          unit: "MW", state: "INDICATIVE", approved_observations: 4, counting_toward_calibration: 4, distinct_sites: 3, still_needed: { observations: 6, sites: 0 },
          residuals: { n: 4, sites: 3, mean_abs_error: 1.2345678, median_abs_error: 1, max_abs_error: 2, mean_signed_error: -0.5, median_pct_error: 4, pct_error_defined_n: 4, pct_error_undefined_n: 0 },
        },
      },
    },
  },
};

let previous: typeof fetch;
beforeEach(() => { previous = globalThis.fetch; });
afterEach(() => { globalThis.fetch = previous; });
const serve = (body: unknown, status = 200) => {
  globalThis.fetch = (async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as typeof fetch;
};
const render = async () => text(renderToStaticMarkup(React.createElement(CalibrationTransparency, { live: await readLiveResiduals() })));

describe("parseResiduals keeps to the documented shape", () => {
  it("accepts the empty report and one with records", () => {
    expect(parseResiduals(EMPTY)).toMatchObject({ state: "uncalibrated", n_records: 0 });
    expect(parseResiduals(WITH_RECORDS)).toMatchObject({ state: "indicative", n_records: 4, n_sites: 2 });
  });
  it.each([
    ["null", null],
    ["another schema", { ...EMPTY, schema: "x/1" }],
    ["records but state uncalibrated", { ...EMPTY, n_records: 3 }],
    ["no records but state indicative", { ...EMPTY, state: "indicative" }],
    ["a negative count", { ...EMPTY, n_sites: -1 }],
    ["a fractional count", { ...EMPTY, n_records: 1.5, state: "indicative" }],
    ["a string count", { ...EMPTY, n_records: "0" }],
    ["unknown state", { ...EMPTY, state: "great" }],
    ["subsystems missing", { ...EMPTY, subsystems: undefined }],
    ["a variable without a unit", { ...EMPTY, subsystems: { power: { ...EMPTY.subsystems.power, variables: { x: { state: "U", approved_observations: 0, distinct_sites: 0 } } } } }],
  ])("refuses %s", (_n, body) => {
    expect(parseResiduals(body)).toBeNull();
  });
  it("never carries a non-finite statistic", () => {
    const r = parseResiduals({ ...WITH_RECORDS, subsystems: { power: { ...WITH_RECORDS.subsystems.power, variables: { grid_firm_MW: { ...WITH_RECORDS.subsystems.power.variables.grid_firm_MW, residuals: { n: 4, sites: 3, mean_abs_error: "NaN", median_abs_error: null } } } } } });
    expect(r!.subsystems[0].variables[0].residuals).toMatchObject({ mean_abs_error: null, median_abs_error: null });
  });
});

describe("readLiveResiduals", () => {
  it("reads the report", async () => {
    serve(EMPTY);
    expect(await readLiveResiduals()).toMatchObject({ status: "read", report: { n_records: 0 } });
  });
  it.each([
    ["the engine is unreachable", "unreachable"],
    ["answers 404 (an older engine)", "not_served"],
    ["answers 503 (a broken record store)", "http_error"],
    ["answers something that is not JSON", "malformed"],
    ["answers JSON of another shape", "malformed"],
  ])("when %s it is unreadable (%s)", async (when, reason) => {
    if (reason === "unreachable") globalThis.fetch = (async () => { throw new Error("down"); }) as typeof fetch;
    else if (reason === "not_served") serve({ error: "not found" }, 404);
    else if (reason === "http_error") serve({ error: "integrity", state: "unavailable" }, 503);
    else if (when.includes("not JSON")) serve("<html>", 200);
    else serve({ hello: "world" });
    expect(await readLiveResiduals()).toEqual({ status: "unreadable", reason });
  });
  it("asks the engine with a timeout (it cannot hang a render)", async () => {
    let signal: AbortSignal | null | undefined;
    globalThis.fetch = (async (_u: RequestInfo | URL, init?: RequestInit) => { signal = init?.signal; return new Response(JSON.stringify(EMPTY)); }) as typeof fetch;
    await readLiveResiduals();
    expect(signal).toBeInstanceOf(AbortSignal);
  });
});

describe("bounds on what is read", () => {
  it("refuses a body larger than the cap, whether declared or streamed", async () => {
    const big = JSON.stringify({ ...EMPTY, note: "x".repeat(RESIDUALS_MAX_BYTES + 10) });
    serve(big);
    expect(await readLiveResiduals()).toEqual({ status: "unreadable", reason: "malformed" });
    globalThis.fetch = (async () => new Response(JSON.stringify(EMPTY), { status: 200, headers: { "content-length": String(RESIDUALS_MAX_BYTES + 1) } })) as typeof fetch;
    expect(await readLiveResiduals()).toEqual({ status: "unreadable", reason: "malformed" });
  });
  it("refuses a count beyond a sane range (1e21 is not a number of records)", () => {
    expect(parseResiduals({ ...WITH_RECORDS, n_records: 1e21 })).toBeNull();
    expect(parseResiduals({ ...WITH_RECORDS, n_records: COUNT_MAX + 1 })).toBeNull();
    expect(parseResiduals({ ...WITH_RECORDS, n_records: COUNT_MAX })).not.toBeNull();
  });
  it("words the thresholds as the body's own when it states them, otherwise as documented", async () => {
    serve({ ...WITH_RECORDS, requirements: { min_approved_observations_per_variable: 12, min_distinct_sites_per_variable: 4 } });
    let t = await render();
    expect(t).toContain("As the report states it, a variable is called calibrated only with at least 12 approved");
    expect(t).toContain("from 4 distinct sites");
    serve({ ...WITH_RECORDS, requirements: undefined });
    t = await render();
    expect(t).toContain("By the engine's documented thresholds, a variable is called calibrated only with at least 10 approved");
  });
});

describe("the read time is shown, and nothing is called live", () => {
  it("renders when it was read and how often the page refreshes, for a read with and without records", async () => {
    for (const body of [EMPTY, WITH_RECORDS]) {
      serve(body);
      const read = await readLiveResiduals();
      expect(read.status).toBe("read");
      const t = text(renderToStaticMarkup(React.createElement(CalibrationTransparency, { live: read })));
      const at = (read as { readAt: string }).readAt.replace("T", " ").slice(0, 16);
      expect(t).toContain(`Read from the engine at ${at} UTC (this page refreshes about every five minutes)`);
      expect(t).not.toMatch(/\blive\b/i);
      expect(t).not.toMatch(/report, now/i);
    }
  });
  it("the not-read state names no time and no count", async () => {
    globalThis.fetch = (async () => { throw new Error("down"); }) as typeof fetch;
    const t = await render();
    expect(t).not.toContain("Read from the engine at");
    expect(t).not.toMatch(/\blive\b/i);
  });
});

describe("the public panel's live status", () => {
  it("with no approved records: uncalibrated, 0 approved production records, and the exact schema of what will populate", async () => {
    serve(EMPTY);
    const t = await render();
    expect(t).toContain("Uncalibrated: 0 approved production records.");
    expect(t).toContain("No residual has been computed, so none is shown");
    expect(t).toContain(RESIDUALS_SCHEMA);
    for (const f of RESIDUAL_CELL_FIELDS) expect(t).toContain(f.field);
    expect(t).toContain("mean_signed_error");
    expect(t).toMatch(/positive means the model over-predicts/);
    expect(t).toContain("btm_firm_MW");
    expect(t).toContain("capex_total_eur, weeks_to_full");
    // no accuracy claim, no table of figures
    expect(t).not.toMatch(/\baccura(te|cy) of\b|\b\d+(\.\d+)?% accura/i);
    expect(t).not.toContain("Mean absolute error");
  });

  it("when the read fails it says so and shows no count or residual from anywhere", async () => {
    globalThis.fetch = (async () => { throw new Error("down"); }) as typeof fetch;
    const t = await render();
    expect(t).toContain("The residual report could not be read.");
    expect(t).not.toContain("0 approved production records");
    expect(t).not.toContain("Uncalibrated:");
    expect(t).not.toMatch(/State: (indicative|calibrated)/);
    expect(t).toContain(RESIDUALS_SCHEMA); // the documented schema is not a reading
  });

  it("with records it prints what was read, labels it as past error at contributing sites, and withholds what the engine withheld", async () => {
    serve(WITH_RECORDS);
    const t = await render();
    expect(t).toContain("State: indicative. 4 approved records from 2 sites.");
    expect(t).toContain("not a guarantee for any other site");
    expect(t).toContain("withheld: fewer than three sites");
    expect(t).toContain("1.235 MW");
    expect(t).toContain("6 observations, 1 site");
    expect(t).not.toContain("Uncalibrated: 0 approved");
  });

  it("is rendered without any network when handed an unreadable state (static rendering never depends on it)", () => {
    globalThis.fetch = (async () => { throw new Error("a render must not fetch"); }) as typeof fetch;
    const t = text(renderToStaticMarkup(React.createElement(CalibrationTransparency, { live: { status: "unreadable", reason: "unreachable" } })));
    expect(t).toContain("could not be read");
  });
});

describe("/evidence and /reference", () => {
  it("/evidence renders the gates, the live status and the FAQ answer from one list, and says uncalibrated while the engine says 0", async () => {
    serve(EMPTY);
    const { default: Page } = await import("@/app/evidence/page");
    const html = renderToStaticMarkup(await Page());
    const t = text(html);
    expect(t).toContain("What a site measurement must clear before it can count");
    expect(t).toContain("Uncalibrated: 0 approved production records.");
    expect(t).toContain("What has to be true before a site measurement can count toward calibration?");
    expect(t).toMatch(/Six gates, applied together by one database view across 18 conditions/);
    expect(html).toContain('id="ledger-gates"');
    // the structured data carries the same answer
    expect(html).toContain("Clearing the gates makes an observation exportable, not accurate.");
  });

  it("/evidence when the engine cannot be read: could not be read, and the committed snapshot is labelled as one", async () => {
    globalThis.fetch = (async () => { throw new Error("down"); }) as typeof fetch;
    const { default: Page } = await import("@/app/evidence/page");
    const t = text(renderToStaticMarkup(await Page()));
    expect(t).toContain("The residual report could not be read.");
    expect(t).toContain("snapshot committed with this site");
  });

  it("exports a revalidating page (no build-time network dependence)", async () => {
    const mod = await import("@/app/evidence/page");
    expect(mod.revalidate).toBe(300);
  });

  it("/reference points at the gates and says uncalibrated from the committed record", async () => {
    const { default: Page } = await import("@/app/reference/page");
    const t = text(renderToStaticMarkup(await Page()));
    const cal = JSON.parse(readFileSync("public/reference/calibration.json", "utf8"));
    expect(t).toContain("Calibration: what these figures have and have not been checked against");
    if (cal.observations === 0) expect(t).toContain("Uncalibrated: the committed calibration record holds 0 reconciled observations.");
    expect(renderToStaticMarkup(await Page())).toContain('href="/evidence#ledger-gates"');
  });
});
