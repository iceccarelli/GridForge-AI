import { describe, expect, it } from "vitest";
import { PORTFOLIO_MAX_HALLS, PORTFOLIO_MIN_HALLS, isPortfolioKind, portfolioAssumed, portfolioIntakeSchema, toPortfolioDocument } from "@/lib/engagement-intake";
import { PORTFOLIO_COLUMNS, parsePortfolioCsv, portfolioTemplate, splitRows } from "@/lib/portfolio-csv";
import { HALL_PACK_PREFIX, packArtifacts, packState } from "@/lib/deliverables";
import { deliverableEndpoint } from "@/lib/products";

const hall = (n: number, over: Record<string, unknown> = {}) => ({
  siteName: `Site ${n}`, hallId: "H1", contractedMW: 12, currentPeakMW: 7, currentItLoadMW: 5, buswayAmpacityA: 400, tapoffMaxA: 63,
  positionsAvailable: 100, plantSupplyC: 6, ...over,
});

describe("the portfolio intake schema", () => {
  it("accepts two to fifteen halls and refuses one and sixteen", () => {
    const halls = (n: number) => Array.from({ length: n }, (_, i) => hall(i + 1));
    expect(portfolioIntakeSchema.safeParse({ halls: halls(PORTFOLIO_MIN_HALLS) }).success).toBe(true);
    expect(portfolioIntakeSchema.safeParse({ halls: halls(PORTFOLIO_MAX_HALLS) }).success).toBe(true);
    expect(portfolioIntakeSchema.safeParse({ halls: halls(1) }).success).toBe(false);
    expect(portfolioIntakeSchema.safeParse({ halls: halls(PORTFOLIO_MAX_HALLS + 1) }).success).toBe(false);
  });

  it("refuses a repeated site and hall, naming both rows (ignoring case)", () => {
    const r = portfolioIntakeSchema.safeParse({ halls: [hall(1), hall(2), hall(1, { siteName: "SITE 1", hallId: "h1" })] });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.message).join(" ")).toMatch(/hall 3 repeats .* \(hall 1\)/);
  });

  it("a hall is held to the Density Screen's bar: a missing required figure is refused, the three optional ones are not", () => {
    expect(portfolioIntakeSchema.safeParse({ halls: [hall(1), hall(2, { contractedMW: undefined })] }).success).toBe(false);
    const ok = portfolioIntakeSchema.safeParse({ halls: [hall(1), hall(2)] });
    expect(ok.success).toBe(true);
  });

  it("refuses an unknown objective and a hostile client name", () => {
    expect(portfolioIntakeSchema.safeParse({ objective: "cheapest", halls: [hall(1), hall(2)] }).success).toBe(false);
    expect(portfolioIntakeSchema.safeParse({ client: "x".repeat(121), halls: [hall(1), hall(2)] }).success).toBe(false);
  });

  it("names, hall by hall, what each left to an assumption", () => {
    const p = portfolioIntakeSchema.parse({ halls: [hall(1, { firmCapacityMVA: 15, floorLoadingKPa: 12, plantCapacityKW: 6000 }), hall(2)] });
    const gaps = portfolioAssumed(p);
    expect(gaps.filter((g) => g.hall === "Site 1 / H1")).toEqual([]);
    expect(gaps.filter((g) => g.hall === "Site 2 / H1").map((g) => g.field).sort()).toEqual(["firmCapacityMVA", "floorLoadingKPa", "plantCapacityKW"]);
  });

  it("hands the engine one intake per hall, with a site id derived from the site name so two H1s never share a pack name", () => {
    const p = portfolioIntakeSchema.parse({ client: "Estate", objective: "fastest", halls: [hall(1), hall(2)] });
    const doc = toPortfolioDocument(p) as { client: string; objective: string; intakes: { site: { id: string; name: string }; hall: { id: string } }[] };
    expect(doc).toMatchObject({ client: "Estate", objective: "fastest" });
    expect(doc.intakes.map((i) => i.site.id)).toEqual(["SITE-1", "SITE-2"]);
    expect(doc.intakes.map((i) => i.hall.id)).toEqual(["H1", "H1"]);
  });
});

describe("the portfolio is a product, not a special case", () => {
  it("is the portfolio deposit's endpoint, and only that deposit's", () => {
    expect(deliverableEndpoint("portfolio_screen_deposit")).toBe("portfolio");
    expect(isPortfolioKind("portfolio_screen_deposit")).toBe(true);
    for (const k of ["density_screen", "envelope_study_deposit", "procurement_spec", "hall_watch", "nonsense"]) expect(isPortfolioKind(k)).toBe(false);
  });

  it("promises the ranking document and a pack for every hall, and is not complete without both", () => {
    expect(packArtifacts("portfolio_screen_deposit")).toEqual(["study", "hall_model_packs"]);
    const manifest = JSON.stringify({ expected: packArtifacts("portfolio_screen_deposit") });
    const base = { kind: "portfolio_screen_deposit", document_html: "<p>ranking</p>" };
    expect(packState({ ...base, working_files: { "bundle.json": manifest } }).missing).toEqual(["hall_model_packs"]);
    expect(packState({ ...base, document_html: null, working_files: { "bundle.json": manifest, [`${HALL_PACK_PREFIX}A_H1.json`]: "{}" } }).missing).toEqual(["study"]);
    expect(packState({ ...base, working_files: { "bundle.json": manifest, [`${HALL_PACK_PREFIX}A_H1.json`]: "{}" } }).complete).toBe(true);
    // an empty pack file is not a pack
    expect(packState({ ...base, working_files: { "bundle.json": manifest, [`${HALL_PACK_PREFIX}A_H1.json`]: "" } }).complete).toBe(false);
  });
});

describe("the hall-list CSV", () => {
  const text = portfolioTemplate() + "North,H1,Dublin,IE,12,7.4,4.9,400,63,180,6,15,12,6000,gb300_nvl72\nSouth,H2,,,\"30\",18,12,1600,250,400,7,,,,\n";

  it("the template is exactly the documented columns, in order", () => {
    expect(portfolioTemplate().trim().split(",")).toEqual(PORTFOLIO_COLUMNS.map((c) => c.key));
  });

  it("reads numbers as numbers and blanks as absent", () => {
    const r = parsePortfolioCsv(text);
    expect(r.errors).toEqual([]);
    expect(r.halls).toHaveLength(2);
    expect(r.halls[0]).toMatchObject({ siteName: "North", hallId: "H1", contractedMW: 12, platform: "gb300_nvl72" });
    expect(r.halls[1]).not.toHaveProperty("firmCapacityMVA");
    expect(r.halls[1].contractedMW).toBe(30);
  });

  it("is accepted by the server's schema as parsed (what the form sends is what the server takes)", () => {
    const r = parsePortfolioCsv(text);
    expect(portfolioIntakeSchema.safeParse({ halls: r.halls }).success).toBe(true);
  });

  it("says what is wrong before anything is sent", () => {
    expect(parsePortfolioCsv("").errors[0]).toMatch(/Paste/);
    expect(parsePortfolioCsv("siteName,hallId,bogus\nA,B,C").errors.join(" ")).toMatch(/Unknown column: bogus[\s\S]*Missing required columns/);
    expect(parsePortfolioCsv("siteName,hallId,siteName\nA,B,C").errors.join(" ")).toMatch(/Repeated column: siteName/);
    expect(parsePortfolioCsv(portfolioTemplate() + "N,H,,,twelve,7,5,400,63,10,6,,,,\n").errors.join(" ")).toMatch(/Hall 1, contractedMW: "twelve" is not a number/);
  });

  it("copes with quotes, embedded commas and newlines, CRLF, a BOM and tab-separated spreadsheet paste", () => {
    expect(splitRows('a,"b,c","d ""q"""\r\n1,2,3\r\n')).toEqual([["a", "b,c", 'd "q"'], ["1", "2", "3"]]);
    expect(splitRows('"x\ny",z')).toEqual([["x\ny", "z"]]);
    const tsv = "siteName\thallId\tcontractedMW\tcurrentPeakMW\tcurrentItLoadMW\tbuswayAmpacityA\ttapoffMaxA\tpositionsAvailable\tplantSupplyC\nA\tH1\t12\t7\t5\t400\t63\t100\t6";
    expect(parsePortfolioCsv("﻿" + tsv).errors).toEqual([]);
    expect(parsePortfolioCsv(tsv).halls[0]).toMatchObject({ siteName: "A", contractedMW: 12 });
  });

  it("never throws and never hangs on hostile input", () => {
    for (const s of ["\"", "\"\"\"\"", ",".repeat(5000), "a\n".repeat(2000), "\u0000\u0001", "siteName,hallId\n" + "x,y\n".repeat(5000)]) {
      expect(() => parsePortfolioCsv(s)).not.toThrow();
    }
  });
});
