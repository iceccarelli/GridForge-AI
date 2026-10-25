/**
 * /observatory rendered to static markup with FIXTURES (tests/site/observatory-ui-fixtures.ts): no network, no browser, no
 * generated scenarios.json. The loaders and the scene builder belong to other workstreams and are mocked here; what is tested
 * is what the page does with whatever they return, including when they fail.
 */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PRODUCTS, eurFromCents } from "@/lib/products";
import { EVIDENCE_LEGEND, evidenceTitle } from "@/components/observatory/evidence";
import { fmtUnitValue } from "@/components/observatory/format";
import { TITLES, type ContextState } from "@/components/observatory/ContextPanel";
import { ObservatoryView, type FileState } from "@/components/observatory/ObservatoryView";
import { FIXTURE_NOW, FIXTURE_SCENARIO_FILE, REFERENCE_REGION_SENTENCE, fixtureBuildSceneModel, fixtureContext } from "./observatory-ui-fixtures";

/** An amount as the page prints it: through the production formatter, not a typed literal. */
const eur = (n: number) => fmtUnitValue(n, "EUR");
const loadScenarioFile = vi.fn();
const getLiveContext = vi.fn();
const override = vi.hoisted(() => ({ build: null as null | ((...a: unknown[]) => unknown) }));
vi.mock("@/lib/observatory/scene-model", async () => {
  const f = await import("./observatory-ui-fixtures");
  return { buildSceneModel: (...a: Parameters<typeof f.fixtureBuildSceneModel>) => (override.build ? override.build(...a) : f.fixtureBuildSceneModel(...a)) };
});
vi.mock("@/lib/observatory/scenario-data", () => ({ loadScenarioFile: () => loadScenarioFile(), parseScenarioFile: (x: unknown) => x }));
// The page's freshness wording uses the data layer's own rule (freshnessOf), so only the network entry point is replaced.
vi.mock("@/lib/observatory/sources", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/observatory/sources")>()), getLiveContext: () => getLiveContext() }));

const text = (html: string) =>
  html
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const okFile: FileState = { ok: true, file: FIXTURE_SCENARIO_FILE };
const okCtx = (over = {}): ContextState => ({ ok: true, context: fixtureContext(over) });
const render = (fileState: FileState = okFile, contextState: ContextState = okCtx()) =>
  renderToStaticMarkup(React.createElement(ObservatoryView, { fileState, contextState, now: FIXTURE_NOW }));

/** The markup from one section heading to the next top-level section (cards inside a section are <section>s too). */
const ORDER = ["path-h", "constraints-h", "outcomes-h", "context-h", "limitations-h", "next-h"];
function section(html: string, id: string): string {
  const start = html.indexOf(`id="${id}"`);
  expect(start, `section ${id}`).toBeGreaterThan(-1);
  const next = ORDER.slice(ORDER.indexOf(id) + 1).map((n) => html.indexOf(`id="${n}"`, start)).find((i) => i > -1);
  return html.slice(html.indexOf(">", start) + 1, next === undefined ? html.length : html.lastIndexOf("<h2", next));
}
const rows = (html: string) => html.split("<tr").slice(1).filter((r) => r.includes("<td") || r.includes("<th role=\"rowheader\""));

describe("the page as a whole", () => {
  const html = render();
  const t = text(html);

  it("has one h1, labelled sections, and a caption on every table (the skip link is the site's, in app/layout.tsx)", () => {
    expect((html.match(/<h1[ >]/g) ?? []).length).toBe(1);
    expect(t).not.toContain("Skip to the observatory");
    for (const id of ["path-h", "constraints-h", "outcomes-h", "context-h", "limitations-h"]) {
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(`aria-labelledby="${id}"`);
    }
    const tables = html.split("<table").length - 1;
    const captions = html.split("<caption").length - 1;
    expect(tables).toBeGreaterThan(0);
    expect(captions).toBe(tables);
  });

  it("every button has a name and every image-like element is hidden or described", () => {
    const buttons = html.split("<button").slice(1).map((b) => text(b.slice(0, b.indexOf("</button>"))));
    expect(buttons.length).toBeGreaterThan(5);
    for (const b of buttons) expect(b.length, b).toBeGreaterThan(0);
    expect(html).not.toMatch(/<img[^>]*>/);
  });

  it("shows the persistent basis banner from the scene model and the calibration statement", () => {
    expect(t).toContain("FIXTURE BANNER: synthetic hall, engine-modelled, not measured.");
    expect(html).toContain("data-basis-banner");
    expect(t).toContain(FIXTURE_SCENARIO_FILE.calibration.statement);
    expect(t).toContain("FIXTURE limitation: the hall is invented.");
  });

  it("offers the approved synthetic halls as a switcher, the first one pressed", () => {
    const sw = html.slice(html.indexOf('aria-label="Approved synthetic halls"'));
    expect(sw).toContain("Colocation hall, 12 MW");
    expect(sw).toContain("Enterprise hall, 4 MW");
    expect(sw.slice(0, sw.indexOf("</button>"))).toContain('aria-pressed="true"');
  });

  it("gives the scene a visible text description (the model's text alternative) the stage points at", () => {
    const model = fixtureBuildSceneModel(FIXTURE_SCENARIO_FILE.scenarios[0], "busway");
    expect(html).toContain("Text description of this scene");
    expect(t).toContain(model.textAlternative);
    expect(html).toMatch(/aria-describedby="[^"]+-scene-text"/);
    expect(html).toMatch(/id="[^"]+-scene-text"/);
  });

  it("the headline alternative is the one shown first", () => {
    expect(html).toMatch(/<option value="busway" selected/);
  });

  it("2D-only markup on the server: no canvas, no 3D", () => {
    expect(html).not.toContain("<canvas");
    expect(html).toContain('data-stage-mode="2d"');
  });
});

describe("the 2D stage", () => {
  const html = render();
  it("draws the same model twice (wide and narrow, switched by CSS) with focusable, named stage nodes", () => {
    expect(html.split("<svg").length - 1).toBe(2);
    expect(html).toMatch(/<svg[^>]*class="hidden[^"]*md:block"/);
    expect(html).toMatch(/<svg[^>]*class="[^"]*md:hidden"/);
    const nodes = html.match(/<g[^>]*role="button"[^>]*>/g) ?? [];
    expect(nodes.length).toBe(16); // 8 stages x 2 layouts
    for (const n of nodes) {
      expect(n).toContain('tabindex="0"');
      expect(n).toMatch(/aria-label="[^"]*Capacity[^"]*"/);
      expect(n).toMatch(/aria-pressed="(true|false)"/);
    }
  });
  it("names the binding stage in words on the card, not by colour alone", () => {
    expect(html).toContain("BINDS AS FOUND");
    expect(html).toMatch(/aria-label="Busway: Busway, hall A\.[^"]*Binds as found\./);
  });
  it("says 'not comparable' where capacity and load are in different units (MVA vs MW), instead of a percentage", () => {
    const transformer = html.match(/aria-label="Transformer: Main transformer T1 \(usable after derating\)\.[^"]*"/);
    expect(transformer).toBeTruthy();
    const start = html.indexOf("Power path, stage by stage");
    const tr = rows(html.slice(start, html.indexOf("</table>", start))).find((r) => r.includes("Main transformer T1"))!;
    expect(text(tr)).toContain("not comparable");
    expect(text(tr)).not.toMatch(/\d+%/);
  });
  it("shows the short title on the card and the parenthetical beside it in the table, not truncated", () => {
    const start = html.indexOf("Power path, stage by stage");
    const tr = rows(html.slice(start, html.indexOf("</table>", start))).find((r) => r.includes("Main transformer T1"))!;
    expect(text(tr)).toContain("usable after derating");
    expect(html).toMatch(/<text[^>]*>Main transformer T1<\/text>/);
  });
  it("rack rows: the existing racks are synthetic inputs, the new-platform count is an engine OUTPUT, and a null density says the real reason", () => {
    const start = html.indexOf("Rack rows. The existing racks");
    const rs = rows(html.slice(start, html.indexOf("</table>", start)));
    expect(rs).toHaveLength(3);
    // row A: existing, has a density as found
    expect(text(rs[0])).toContain("synthetic input");
    expect(text(rs[0])).not.toContain("engine output");
    expect(text(rs[0])).not.toContain("platform library figure");
    expect(text(rs[0])).toContain("24");
    // row B: no density as found, so no racks as found: what the plan adds, an engine output
    expect(text(rs[1])).toContain("engine output: deployable after the plan");
    expect(text(rs[1])).toContain("none: no racks of this row deploy as found");
    expect(text(rs[1])).toContain("platform library figure");
    expect(text(rs[1])).not.toContain("not supported by the inputs");
    expect(text(rs[1])).not.toMatch(/synthetic input(?!, not measured)/);
  });
});

describe("no after-plan utilisation against as-found capacity, anywhere (the false 'over capacity')", () => {
  const html = render();
  const start = html.indexOf("Power path, stage by stage");
  const table = rows(html.slice(start, html.indexOf("</table>", start)));
  it("a stage whose after-plan load exceeds its AS-FOUND capacity is not called over capacity (UPS: 4.4 MW found, 9.6 MW after, 8 MW capacity)", () => {
    const ups = table.find((r) => r.includes("UPS modules"))!;
    expect(text(ups)).toContain("55%");
    expect(text(ups)).not.toMatch(/120%|over capacity/i);
    expect(html).toMatch(/aria-label="UPS: UPS modules\.[^"]*Load after the plan 9\.6 MW[^"]*"/);
    const label = html.match(/aria-label="UPS: UPS modules\.[^"]*"/)![0];
    expect(label).not.toMatch(/exceeds/i);
  });
  it("the 2D diagram never draws OVER CAPACITY; it marks only a stage whose load AS FOUND exceeds its capacity as found (rack feed: 205 A against 63 A)", () => {
    expect(html).not.toContain("OVER CAPACITY");
    expect((html.match(/OVER AS FOUND/g) ?? []).length).toBe(2); // one card, two layouts
    expect(html).toMatch(/aria-label="Rack feed: Tap-off to rack, 63 A\.[^"]*Load as found exceeds capacity as found\./);
    const rf = table.find((r) => r.includes("Tap-off to rack"))!;
    expect(text(rf)).toContain("325%");
    expect(text(rf)).toContain("over capacity as found");
  });
  it("the after-plan load is shown as a plain figure with the reason there is no ratio", () => {
    expect(text(html)).toContain("the engine does not state the stage's capacity after the plan");
    expect(html).toContain("Utilisation as found");
    expect(html).not.toMatch(/→\s*\d+%/);
  });
  it("the table row's after-plan load keeps its evidence chip", () => {
    const ups = table.find((r) => r.includes("UPS modules"))!;
    expect((ups.match(/data-evidence="E\d"/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("(a) power path: every figure has its evidence class", () => {
  const html = render();
  const start = html.indexOf("Power path, stage by stage");
  const tableHtml = html.slice(start, html.indexOf("</table>", start));
  it("every stage row carries a chip beside capacity, load as found and load after the plan", () => {
    const rs = rows(tableHtml);
    expect(rs).toHaveLength(8);
    for (const r of rs) expect((r.match(/data-evidence="E\d"/g) ?? []).length, text(r).slice(0, 60)).toBeGreaterThanOrEqual(3);
  });
  it("the binding stage is flagged in words in the table", () => {
    const busway = rows(tableHtml).find((r) => r.includes("Busway, hall A"))!;
    expect(text(busway)).toContain("Binds as found");
    expect(rows(tableHtml).filter((r) => text(r).includes("Binds as found"))).toHaveLength(1);
  });
  it("the chips explain themselves (tooltip) and a legend lists E0 to E7", () => {
    expect(html).toMatch(/title="E1: Modelled\. Computed from a documented model on assumed inputs\."/);
    const legend = html.slice(html.indexOf("Evidence classes E0 to E7"), html.indexOf("Evidence classes E0 to E7") + 6000);
    for (const c of ["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"]) expect(legend).toContain(`data-evidence="${c}"`);
    expect(text(legend)).toContain("Nothing on this page is measured at a site.");
  });
  it("E5 and E3 are worded for invented inputs, in the legend, the chip text and the tooltip (never 'measured data' or 'engineer reviewed')", () => {
    const legend = text(html.slice(html.indexOf("Evidence classes E0 to E7"), html.indexOf("Evidence classes E0 to E7") + 6000));
    expect(legend).toContain("Supplied input. Invented here; not measured.");
    expect(legend).toContain("Engine estimate. No engineer review in this demonstration.");
    expect(legend).not.toMatch(/customer's own|measured data|qualified engineer|reviewed by/i);
    // chip text and tooltip for an E3 figure that is actually on the page (the liquid-cooling alternative)
    expect(html).toMatch(/<abbr title="E3: Engine estimate\. No engineer review in this demonstration\."[^>]*data-evidence="E3"[^>]*>E3<span[^>]*>Engine estimate<\/span><\/abbr>/);
    expect(EVIDENCE_LEGEND.E5).toEqual({ name: "Supplied input", meaning: "Invented here; not measured." });
    expect(evidenceTitle("E5")).toBe("E5: Supplied input. Invented here; not measured.");
    expect(html).not.toMatch(/Model reviewed by a qualified engineer/);
  });
  it("the invented hall's own inputs are tagged as synthetic inputs", () => {
    expect((text(html).match(/synthetic input/gi) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});

describe("(b) the constraints", () => {
  const html = render();
  const start = html.indexOf("constraints ranked by the racks");
  const tableHtml = html.slice(start, html.indexOf("</table>", start));
  const rs = rows(tableHtml);
  it("lists all 13, lowest first, with the binding one flagged and the constraint that passes last", () => {
    expect(rs).toHaveLength(13);
    expect(text(rs[0])).toContain("Busway ampacity");
    expect(text(rs[0])).toContain("Binds as found");
    expect(text(rs[12])).toContain("Fault level");
  });
  it("a constraint with no finite limit (passes) says it does not limit the hall: never 'no figure given', 'unranked' or 'unlimited'", () => {
    expect(text(rs[12])).toContain("does not limit the hall (passes)");
    expect(text(rs[12])).toContain("no rank: does not limit the hall");
    for (const r of rs) expect(text(r)).not.toMatch(/no figure given|unranked|unlimited|not supported by the inputs/i);
    expect(text(tableHtml)).not.toMatch(/no figure given|unranked|unlimited/i);
  });
  it("each row has its basis and an evidence chip", () => {
    for (const r of rs) {
      expect(r).toMatch(/data-evidence="E\d"/);
      expect(text(r).length).toBeGreaterThan(20);
    }
    expect(text(rs[0])).toContain("busway ampacity divided by the platform's per-rack draw");
  });
  it("marks the constraint that binds after the plan for the shown alternative", () => {
    expect(text(rs.find((r) => r.includes("UPS capacity"))!)).toContain("Binds after the plan");
  });
});

describe("(d) scenario outcomes", () => {
  const html = render();
  const start = html.indexOf("The alternatives the engine compared");
  const tableHtml = html.slice(start, html.indexOf("</table>", start));
  const rs = rows(tableHtml);
  const outcomesText = text(tableHtml);

  it("one row per alternative, each with racks as found and after and an evidence chip", () => {
    expect(rs).toHaveLength(4);
    expect(text(rs[0])).toContain("24 → 61 racks");
    expect(text(rs[1])).toContain("24 → 96 racks");
    for (const r of rs) expect(r).toMatch(/data-evidence="E\d"/);
  });
  it("the alternative shown on the stage is pressed", () => {
    const busway = rs[1];
    expect(busway).toContain('aria-pressed="true"');
    expect(text(busway)).toContain("Shown on the stage");
    expect(rs[0]).toContain('aria-pressed="false"');
  });
  it("not dated means not dated: no calendar date appears, and assumed lead times are said so", () => {
    expect(text(rs[0])).toContain("Not dated — lead times assumed");
    expect(text(rs[1])).toContain("Not dated — lead times assumed");
    expect(text(rs[1])).toContain("38 weeks on assumed lead times. It is not a date.");
    expect(outcomesText).not.toMatch(/\b20\d\d-\d\d-\d\d\b|\b(Q[1-4]) 20\d\d\b|\b(January|February|March|April|May|June|July|August|September|October|November|December) 20\d\d\b/);
    expect(text(rs[2])).toContain("30 weeks");
    expect(text(rs[2])).toContain("not a calendar date");
  });
  it("a partial capex is 'at least' with its priced-lines qualifier and NO upper bound; placeholders are named; the chip stays beside it", () => {
    expect(text(rs[0])).toContain("Not priced");
    expect(text(rs[0])).toContain("Unpriced: tap-off units, installation labour.");
    const busway = text(rs[1]);
    expect(busway).toContain(`at least ${eur(1800000)}`);
    expect(busway).toContain("(priced lines only)");
    expect(busway).toContain("library placeholder prices");
    expect(busway).toContain("Excludes commissioning. Not a complete price.");
    expect(busway).not.toMatch(new RegExp(`${eur(2300000)}|${eur(1500000)}|range ${eur(0).slice(0,1)}`)); // the engine's range has an upper bound this total does not have
    const cell = rs[1].slice(rs[1].indexOf("Capital cost"));
    expect(cell.slice(0, cell.indexOf("</td>"))).toMatch(/data-evidence="E0"/);
    // a complete figure resting on supplied prices is shown plainly, with no placeholder wording
    expect(text(rs[2])).toContain(`${eur(2340000)}`);
    expect(text(rs[2])).not.toMatch(/at least|placeholder/);
    expect(outcomesText).not.toMatch(new RegExp(`${eur(0).slice(0, 1)}\\s?0\\b`));
  });
  it("an alternative that deploys nothing says there is nothing to date, not 'lead times assumed'", () => {
    expect(text(rs[3])).toContain("0 → 0 racks");
    expect(text(rs[3])).toContain("Nothing deploys, so there is nothing to date");
    expect(text(rs[3])).not.toMatch(/lead times assumed/i);
  });
  it("names the constraint that binds after the plan in words", () => {
    expect(text(rs[0])).toContain("Busway ampacity");
    expect(text(rs[2])).toContain("Cooling plant capacity");
  });
});

describe("(c) market and grid conditions", () => {
  const html = render();
  const ctx = section(html, "context-h");
  const ctxText = text(ctx);

  it("shows the reference-region sentence verbatim, once, so the hall is not placed on that grid", () => {
    expect(ctxText).toContain(REFERENCE_REGION_SENTENCE);
    expect(ctxText.split(REFERENCE_REGION_SENTENCE).length - 1).toBe(1);
  });
  it("every feed has a provenance chip with source, what it describes, retrieval time, freshness and basis in words", () => {
    expect((ctx.match(/data-provenance="/g) ?? []).length).toBe(4);
    for (const label of ["Source", "Describes", "Retrieved", "Basis"]) expect((ctxText.match(new RegExp(`\\b${label}\\b`, "g")) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(ctxText).toContain("FIXTURE day-ahead auction");
    expect(ctxText).toContain("2026-10-25 12:00 UTC");
    expect(ctxText).toContain("2026-10-25 12:05 UTC");
    expect(ctxText).toContain("Fresh: within the allowed 2 h");
    expect(ctxText).toContain("A reading of the real world for a stated interval.");
  });
  it("the day-ahead price is a published auction price for this delivery hour, not a live reading", () => {
    const price = ctx.slice(ctx.indexOf('data-provenance="day_ahead_auction"'));
    const card = text(price.slice(0, price.indexOf("</section>")));
    expect(card).toContain("Published auction price for this delivery hour");
    expect(card).toContain("not a measurement of now");
    expect(card).not.toMatch(/\blive\b/i);
  });
  it("the queue is a published report as of its date", () => {
    expect(ctxText).toContain("Published report as of 2026-09-30");
  });
  it("'live' appears exactly once on the page: the observed generation mix read 20 minutes ago or less", () => {
    const all = text(html);
    expect(all.match(/\blive\b/gi) ?? []).toEqual(["Live"]);
    expect(ctxText).toContain("Live reading");
    expect(ctxText).not.toContain("Live observation");
  });
  it("a reading that is inside its allowance but not recent is 'Latest reading', never live, and says how long before the page it was retrieved", () => {
    const older = text(
      render(okFile, okCtx({ generationMix: { ...fixtureContext().generationMix, provenance: { ...fixtureContext().generationMix.provenance, observedAt: "2026-10-25T11:00:00Z", retrievedAt: "2026-10-25T11:05:00Z" } } })),
    );
    expect(older).not.toMatch(/\blive\b/i);
    expect(older).toContain("Latest reading");
    expect(older).toContain("Fresh: within the allowed 2 h");
    expect(older).toContain("1.3 h before this page was generated");
    expect(ctxText).toContain("15 min before this page was generated");
  });
  it("the freshness pill and the mix bars are never the green 'verified' tone", () => {
    expect(ctx).not.toMatch(/verified/);
  });
  it("every card names its own region, the section says the halls are not there, and no 'reference region' or 'That day' wording remains", () => {
    for (const t of ["Germany/Luxembourg market", "Generation mix: Germany grid", "US ISOs (ERCOT, PJM, MISO, SPP)", "Demand: US Lower 48"]) expect(ctxText).toContain(t);
    const all = text(html);
    expect(all).toContain("The invented halls have no location, so none of this is theirs.");
    expect(all.split(REFERENCE_REGION_SENTENCE).join("")).not.toMatch(/reference region|That day|national demand overlay/i);
    expect(all).not.toMatch(/pretend location|real hall would sit on/i);
  });
  it("min, average and highest are labelled with the published window, not a calendar day", () => {
    expect(ctxText).toContain("Over the published window 2026-10-25 12:00 UTC to 2026-10-26 12:00 UTC (about the next 24 hours): lowest");
  });
  it("a stale observation is not called live, and a fresh-marked one past its own limit is demoted to stale", () => {
    const stale = text(render(okFile, okCtx({ generationMix: { ...fixtureContext().generationMix, freshness: "stale" } })));
    expect(stale).not.toMatch(/\blive\b/i);
    expect(stale).toContain("Latest reading, stale");
    const old = text(
      render(okFile, okCtx({ generationMix: { ...fixtureContext().generationMix, provenance: { ...fixtureContext().generationMix.provenance, observedAt: "2026-10-25T06:00:00Z" } } })),
    );
    expect(old).not.toMatch(/\blive\b/i);
    expect(old).toContain("Stale: older than the allowed 2 h");
  });
  it("an unavailable feed says unavailable and why, and shows no number in its place", () => {
    const demand = ctx.slice(ctx.indexOf("Demand: US Lower 48"));
    const card = text(demand.slice(0, demand.indexOf("</section>")));
    expect(card).toContain("Unavailable.");
    expect(card).toContain("FIXTURE: no data key is configured.");
    expect(card).not.toMatch(/\d+\s*MW,/);
  });
  it("a feed with a value but marked unavailable shows nothing from it", () => {
    const out = text(render(okFile, okCtx({ dayAheadPrice: { ...fixtureContext().dayAheadPrice, freshness: "unavailable" } })));
    expect(out).not.toContain("87.4");
    expect(out).toContain("Unavailable.");
  });
  it("if the whole context fetch failed, every panel says unavailable and why, with no figures and no reference sentence", () => {
    const html2 = render(okFile, { ok: false, reason: "the request failed" });
    const c = section(html2, "context-h");
    const ct = text(c);
    expect((ct.match(/Unavailable\./g) ?? []).length).toBe(4);
    expect((ct.match(/the request failed/g) ?? []).length).toBe(4);
    expect(c).not.toContain("data-provenance");
    expect(ct).not.toContain(REFERENCE_REGION_SENTENCE);
    expect(Object.values(TITLES).reduce((a, t) => a.split(t).join(""), ct)).not.toMatch(/\d/); // the card titles name their regions (a "48" in US Lower 48); nothing else may carry a number
    // the scenario panels are unaffected
    expect(text(html2)).toContain("24 → 61 racks");
  });
});

describe("the funnel: calm, free first, no checkout, no login, no admin or billing", () => {
  const html = render();
  const t = text(html);
  it("offers the free qualifier and the Density Screen from the catalogue", () => {
    expect(html).toMatch(/<a[^>]*href="\/qualify"[^>]*>\s*Run the free qualifier on your hall/);
    expect(html).toContain('href="/pricing#engagements"');
    const screen = PRODUCTS.density_screen;
    expect(t).toContain(`${screen.name} (${eurFromCents(screen.amountCents)}, ${screen.turnaroundDays} working days)`);
  });
  it("says the halls are invented, not that everything is (the context cards are real published data)", () => {
    expect(t).toContain("The halls above are invented. The qualifier uses your numbers.");
    expect(t).not.toContain("Everything above is invented");
  });
  it("the hall has no location and the page says the market data is not its grid", () => {
    expect(t).toContain("invented site (no location)");
    expect(t).toContain("The hall is not in any real place, so the market and grid data below is not its grid.");
  });
  it("claims an evidence class only on engine figures", () => {
    expect(t).toContain("Every engine figure carries its evidence class");
    expect(t).not.toMatch(/Every figure carries its evidence class/);
  });
  it("links nowhere near checkout, sign-in, account, admin or billing, and has no form", () => {
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const h of hrefs) expect(h, h).not.toMatch(/checkout|login|signin|sign-in|account|admin|billing|dashboard|portal|stripe|\/api\/|payg|deposit/i);
    expect(html).not.toMatch(/<form|<input[^>]*type="(password|email)"|type="submit"/);
    expect(t).not.toMatch(/\b(buy now|checkout|pay now|subscribe|sign in|log in|add to cart)\b/i);
  });
});

describe("degradation", () => {
  it("a missing or malformed scenario file: says the demonstration data cannot be shown and renders no scenario figures", () => {
    const html = render({ ok: false });
    const t = text(html);
    expect(t).toContain("The demonstration data cannot be shown");
    expect(html).toContain('data-observatory="data-unavailable"');
    expect(html).not.toContain("data-evidence");
    expect(html).not.toContain("<svg");
    expect(t).not.toContain("FIXTURE");
    expect(t).not.toMatch(/\d+ racks/);
    expect(t).toContain("Run the free qualifier on your hall");
  });
  it("a file with no scenarios is treated the same way", () => {
    const html = render({ ok: true, file: { ...FIXTURE_SCENARIO_FILE, scenarios: [] } });
    expect(text(html)).toContain("The demonstration data cannot be shown");
  });
  it("a scene that cannot be built shows no figures from that scenario", () => {
    override.build = () => {
      throw new Error("boom");
    };
    try {
      const html = render();
      const t = text(html);
      expect(t).toContain("This scenario cannot be shown.");
      expect(html).toContain('data-observatory="scenario-unavailable"');
      expect(html).not.toContain("<svg");
      expect(t).not.toMatch(/\d+ racks/);
    } finally {
      override.build = null;
    }
  });
});

describe("app/observatory/page.tsx: the server component", () => {
  beforeEach(() => {
    loadScenarioFile.mockReset();
    getLiveContext.mockReset();
  });
  it("is rendered per request so every retrieval timestamp is the real one, not a statically regenerated page's", async () => {
    const mod = await import("@/app/observatory/page");
    expect(mod.dynamic).toBe("force-dynamic");
    expect((mod as { revalidate?: number }).revalidate).toBeUndefined();
    expect((mod.metadata.alternates as { canonical: string }).canonical).toBe("/observatory");
    expect(String(mod.metadata.description)).toContain("an evidence class on every engine figure");
    expect(String(mod.metadata.description)).not.toMatch(/evidence class on every figure/);
  });
  it("loads the scenario file and the live context, and renders both", async () => {
    loadScenarioFile.mockReturnValue(FIXTURE_SCENARIO_FILE);
    getLiveContext.mockResolvedValue(fixtureContext());
    const { default: Page } = await import("@/app/observatory/page");
    const t = text(renderToStaticMarkup(await Page()));
    expect(t).toContain("24 → 96 racks");
    expect(t).toContain(REFERENCE_REGION_SENTENCE);
    expect(getLiveContext).toHaveBeenCalledTimes(1);
  });
  it("a failing context fetch degrades each panel to unavailable; the scenarios still show", async () => {
    loadScenarioFile.mockReturnValue(FIXTURE_SCENARIO_FILE);
    getLiveContext.mockRejectedValue(new Error("ECONNRESET secret-host.example"));
    const { default: Page } = await import("@/app/observatory/page");
    const t = text(renderToStaticMarkup(await Page()));
    expect((t.match(/Unavailable\./g) ?? []).length).toBe(4);
    expect(t).toContain("the request failed");
    expect(t).not.toContain("secret-host");
    expect(t).toContain("24 → 96 racks");
  });
  it("a malformed scenario file: the demonstration data cannot be shown, and the feeds are not even read", async () => {
    loadScenarioFile.mockImplementation(() => {
      throw new Error("scenarios.json: schema drift");
    });
    const { default: Page } = await import("@/app/observatory/page");
    const t = text(renderToStaticMarkup(await Page()));
    expect(t).toContain("The demonstration data cannot be shown");
    expect(t).not.toContain("schema drift");
    expect(getLiveContext).not.toHaveBeenCalled();
  });
});
