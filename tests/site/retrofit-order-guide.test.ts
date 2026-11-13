/**
 * The guide "The order of limits in a 100-150 kW retrofit" (app/guides/retrofit-order-of-limits).
 *
 * What this holds, and how each part would notice a defect:
 *  - DRIFT: every figure the page prints is read from a file the engine publishes. Proved three ways: the page prints what each file says;
 *    a number audit finds no 2-digit-or-longer figure on the page that is in none of those files (or in the catalogue, or derived below);
 *    and marker values injected into a COPY of each file must all come out on the page (a figure typed into the page cannot do that).
 *  - THE ARGUMENT: the claims the page makes in words (two per-position limits are at zero as found, liquid cooling does not clear the
 *    air-side one, the long-lead relief is not the first limit to bind) are pinned to the pack, so a regenerated pack that no longer shows
 *    them fails here instead of leaving a guide the data contradicts.
 *  - STRUCTURE: metadata length, one h1, heading order, table captions, keyboard-reachable scroll regions, a figure with a text alternative,
 *    every internal link resolving, JSON-LD that parses and claims no rating or review, FAQ markup only for visible questions.
 *  - COPY: no typed euro amount, no case study, testimonial, guarantee or retrofit claim.
 *  - llms.txt: lists the guide and no longer says the deposit products have no intake form.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import sitemap from "@/app/sitemap";
import { PAGE_CARDS } from "@/lib/page-cards";
import { PRODUCT_PAGES } from "@/lib/product-pages";
import { PRODUCTS, eurFromCents } from "@/lib/products";
import { pageablePlatforms } from "@/lib/platform-pages";
import {
  COMPARISON_ID,
  RESIDUAL_AIR_ID,
  SCENARIO_ID,
  TAPOFF_ID,
  bindingOrder,
  capabilityRange,
  classesIn,
  d1,
  displayBasis,
  f1,
  faqItems,
  firstSentences,
  fmt,
  fmtLead,
  fmtQty,
  lc,
  limitState,
  loadGuideModel,
  parseRetrofitPack,
  startOrder,
  weakestClass,
  words,
} from "@/lib/retrofit-order-data";
import { routeSources } from "../../scripts/page-lastmod.mjs";
import { FULL_ENGINE, stubEngine } from "./engine-stub";

vi.mock("next/font/local", () => ({ default: () => ({ variable: "", className: "" }) }));

const PATH = "/guides/retrofit-order-of-limits";
const PAGE = "app/guides/retrofit-order-of-limits/page.tsx";
const SOURCES = [PAGE, "lib/retrofit-order-data.ts", "components/diagrams/LadderBars.tsx"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const rawText = (f: string) => fs.readFileSync(`public/reference/${f}`, "utf8");
const raw = (f: string): Json => JSON.parse(rawText(f));

const unesc = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const visible = (html: string) =>
  unesc(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

async function guideModule() {
  return (await import("@/app/guides/retrofit-order-of-limits/page")) as { default: () => Promise<React.ReactElement>; metadata: Json };
}
async function render(): Promise<string> {
  const { default: Guide } = await guideModule();
  return renderToStaticMarkup(await Guide());
}
const jsonLd = (html: string): Json[] => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1].replace(/\\u003c/g, "<")));

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("@/lib/page-lastmod.json");
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("the guide prints what the engine's published files say", () => {
  it("the headline figures, the hall, the platform table, the ladder, the curve and the calibration record are the files' own", async () => {
    const m = (await loadGuideModel())!;
    expect(m).not.toBeNull();
    const html = unesc(await render());
    const pack = raw("model_pack.json");
    const h = pack.intake.document;

    expect(html).toContain(pack.notice);
    expect(html).toContain(pack.schema);
    expect(html).toContain(pack.generated);
    const hy = pack.scenarios.find((s: Json) => s.id === SCENARIO_ID);
    expect(html).toContain(hy.after_ladder.it_load_kW.digest);
    expect(html).toContain(hy.after_ladder.it_load_kW.model);
    expect(html).toContain(hy.time_to_power.date_record.calculation_version);

    // the hall, as the intake states it
    for (const s of [
      `${d1(h.grid.contracted_MW)} MW contracted, ${d1(h.grid.firm_capacity_MVA)} MVA firm; site peak ${d1(h.grid.current_site_peak_MW.value)} MW; existing IT load ${d1(h.grid.current_it_load_MW)} MW`,
      `${fmt(h.hall.rack_positions)} rack positions, ${fmt(h.hall.positions_available)} available; designed for ${fmt(h.hall.design_density_kW_per_rack)} kW per rack`,
      `${fmt(h.lv.tapoff_max_A)} A tap-off units on ${fmt(h.lv.busway_ampacity_A.value)} A busway, ${fmt(h.lv.busway_runs)} runs`,
      `${d1(h.thermal.residual_air_capacity_kW_per_rack.value)} kW per rack position (${h.thermal.residual_air_capacity_kW_per_rack.evidence}). ${h.thermal.residual_air_capacity_kW_per_rack.note}`,
      `${fmt(h.transformers[0].units)} × ${d1(h.transformers[0].unit_rating_MVA)} MVA, ${h.transformers[0].redundancy}`,
      `${fmt(h.ups[0].units)} × ${fmt(h.ups[0].unit_rating_kW)} kW, ${h.ups[0].redundancy}`,
      `${fmt(h.thermal.plant.chilled_water_capacity_kW)} kW, ${fmt(h.thermal.plant.design_supply_C.value)} °C supply, ${fmt(h.thermal.plant.pump_flow_capacity_l_per_min)} l/min pump flow`,
      h.grid.queue_note,
      h.hall.floor_loading_kPa.note,
    ]) {
      expect(html, s).toContain(s);
    }

    // the platform library: every sourced platform's own figures and its sources, [V] marks included
    for (const p of pageablePlatforms(raw("platforms.json").platforms)) {
      expect(html).toContain(p.name);
      expect(html).toContain(p.sources.join("; "));
      expect(html).toContain(`${d1(p.rack_kW)} (${d1(p.peak_rack_kW)})`);
      expect(html).toContain(`${Math.round(p.liquid_fraction * 100)}%`);
    }
    expect(html).toMatch(/\[V\]/);

    // the ladder of the scenario followed: step, racks before -> after, what relieves it, its lead time and class
    for (const st of hy.ladder) {
      expect(html).toContain(st.relief);
      expect(html).toContain(`${fmt(st.racks_before)} → ${fmt(st.racks_after)}`);
      if (st.lead_time_weeks) expect(html).toContain(`${fmt(st.lead_time_weeks.value)} [${fmt(st.lead_time_weeks.low)}–${fmt(st.lead_time_weeks.high)}] (${st.lead_time_weeks.evidence.slice(0, 2)})`);
      if (st.risk) expect(html).toContain(st.risk);
      if (!st.taken) expect(html).toContain(st.not_taken_reason);
    }
    expect(html).toContain(`${hy.as_found.racks} racks`);
    expect(html).toContain(hy.time_to_power.date_label);
    for (const c of hy.time_to_power.curve) {
      expect(html).toContain(c.unlocked_by);
    }
    expect(html).toContain(firstSentences(hy.time_to_power.date_record.limitation, 2));

    // all thirteen limits: the reference page's own name, what it limits and what relieves it, and the pack's basis as printed
    const ref = raw("constraints.json");
    expect(m.order).toHaveLength(ref.constraints.length);
    for (const o of m.order) {
      const d = ref.constraints.find((c: Json) => c.id === o.id);
      expect(html, o.id).toContain(d.name);
      expect(html, o.id).toContain(d.limits);
      expect(html, o.id).toContain(d.relief);
      expect(html, o.id).toContain(`href="/constraints/${d.slug}"`);
      expect(html, o.id).toContain(displayBasis(hy.constraints.find((c: Json) => c.id === o.id).basis));
    }

    // every scenario's architecture-capability and residual-air sentence
    for (const s of pack.scenarios) {
      expect(html, s.id).toContain(s.name);
      expect(html, s.id).toContain(displayBasis(s.constraints.find((c: Json) => c.id === "architecture_capability").basis));
      expect(html, s.id).toContain(displayBasis(s.constraints.find((c: Json) => c.id === RESIDUAL_AIR_ID).basis));
    }

    // the calibration record
    const cal = raw("calibration.json");
    expect(html).toContain(`“${cal.state}”`);
    expect(html).toContain(`${fmt(cal.observations)} reconciled observations across ${fmt(cal.sites)} sites, covering ${fmt(cal.keys_with_site_observations)} of ${fmt(cal.keys_asserted)} model outputs`);

    // the answers of the questions section are the model's
    for (const q of faqItems(m)) {
      expect(html).toContain(q.q);
      expect(html).toContain(q.a);
    }
  });

  it("the arithmetic across the band is recomputed here from the published inputs and agrees with the page", async () => {
    const m = (await loadGuideModel())!;
    const plat = raw("platforms.json").platforms;
    const gb300 = plat.find((p: Json) => p.id === m.pack.hall.platformId);
    const hall = raw("model_pack.json").intake.document;
    const html = visible(await render());
    expect(m.band).not.toBeNull();
    // the four points the lead's brief names are the lower end and the stated value of the two liquid architectures' practical ranges
    expect(m.band!.rows).toHaveLength(4);
    expect(Math.min(...m.band!.rows.map((r) => r.kw))).toBe(100); // the title's band: if the library's ranges move, the title is stale
    expect(Math.max(...m.band!.rows.map((r) => r.kw))).toBe(150);
    const feed = (kw: number) => Math.round((gb300.rack_feed_current_A * kw) / gb300.rack_kW);
    const air = (kw: number, share: number) => f1(kw * (1 - share));
    for (const r of m.band!.rows) {
      expect(r.feedA).toBeCloseTo((gb300.rack_feed_current_A * r.kw) / gb300.rack_kW, 9);
      expect(html).toContain(`${r.kw} `);
      expect(Math.round(r.feedA)).toBe(feed(r.kw));
      for (const p of pageablePlatforms(plat)) {
        const a = r.air.find((x) => x.platformId === p.id)!;
        expect(f1(a.kw)).toBe(air(r.kw, p.liquid_fraction));
        expect(a.overBy).toBeCloseTo(r.kw * (1 - p.liquid_fraction) - hall.thermal.residual_air_capacity_kW_per_rack.value, 9);
      }
    }
    expect(m.band!.maxRackOnTapoffKw).toBeCloseTo((hall.lv.tapoff_max_A * gb300.rack_kW) / gb300.rack_feed_current_A, 9);
    for (const p of pageablePlatforms(plat)) {
      const t = m.band!.maxRackOnAir.find((x) => x.platformId === p.id)!;
      expect(t.kw).toBeCloseTo(hall.thermal.residual_air_capacity_kW_per_rack.value / (1 - p.liquid_fraction), 9);
      expect(html).toContain(`${f1(t.kw)} kW at ${Math.round(p.liquid_fraction * 100)}% liquid`);
    }
    // the arithmetic reproduces the engine's own published values at the library's own rack power (the check the page prints)
    expect(m.band!.check.feedMatches).toBe(true);
    expect(m.band!.check.airMatches).toBe(true);
    expect(m.band!.check.feedA).toBeCloseTo(gb300.rack_feed_current_A, 9);
    expect(m.band!.check.airKw).toBeCloseTo(gb300.residual_air_kW, 6);
    // and the page says, in words, that it is arithmetic and not a solve
    expect(html).toContain("Arithmetic, not an engine solve.");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("drift: no figure on the page is typed", () => {
  const NUM = /(?<![\w.,])\d[\d,]*(?:\.\d+)?/g;
  const norm = (t: string) => String(Number(t.replace(/,/g, "")));
  const tokens = (s: string) => (s.match(NUM) ?? []).map((t) => t.replace(/,$/, "")).map(norm);

  it("every figure of two digits or more, or with a decimal point, is in a published file, the catalogue or the derived set", async () => {
    const m = (await loadGuideModel())!;
    const allowed = new Set<string>();
    for (const f of ["model_pack.json", "platforms.json", "constraints.json", "calibration.json"]) for (const t of tokens(JSON.stringify(raw(f)))) allowed.add(t); // parsed first, so an escaped en dash does not glue two figures together
    // the catalogue's own amounts and turnarounds, shown through lib/products.ts
    for (const id of ["density_screen", "envelope_study_deposit", "procurement_spec"] as const) {
      const p = PRODUCTS[id];
      for (const c of [p.amountCents, ...(p.opensBandCents ?? [])]) allowed.add(norm(String(c / 100)));
      allowed.add(norm(String(p.turnaroundDays)));
    }
    // derived, and recomputed here independently of the module under test
    const gb300 = raw("platforms.json").platforms.find((p: Json) => p.id === m.pack.hall.platformId);
    const lib = pageablePlatforms(raw("platforms.json").platforms);
    for (const kw of m.band!.rows.map((r) => r.kw)) {
      allowed.add(norm(String(Math.round((gb300.rack_feed_current_A * kw) / gb300.rack_kW))));
      for (const p of lib) allowed.add(norm(f1(kw * (1 - p.liquid_fraction))));
    }
    allowed.add(norm(f1((m.pack.hall.tapoffA * gb300.rack_kW) / gb300.rack_feed_current_A)));
    for (const p of lib) allowed.add(norm(f1(m.pack.hall.residualAirKw.value / (1 - p.liquid_fraction))));
    allowed.add(norm(String(gb300.rack_kW / gb300.residual_air_kW))); // "about 10 times lower"
    for (const p of lib) allowed.add(String(Math.round(p.liquid_fraction * 100))); // the liquid share as a percentage
    for (let i = 1; i <= m.order.length; i++) allowed.add(String(i)); // the position of each limit, and the count of limits
    allowed.add(String(m.withE0));
    for (const c of ["E0", "E3", "E5"]) allowed.add(String(m.order.filter((o) => o.classes.includes(c)).length));
    allowed.add(String(m.pack.scenarios.length));
    // typed on purpose: the title's band, and the publication date
    for (const t of ["100", "150", "12", "2026"]) allowed.add(t);

    const text = visible(await render());
    const found = new Set(tokens(text).filter((t) => t.includes(".") || t.replace(/\D/g, "").length >= 2));
    const stray = [...found].filter((t) => !allowed.has(t));
    expect(stray).toEqual([]);
    expect(found.size).toBeGreaterThan(60); // the audit read a page full of figures, not an empty one
  });

  it("marker values injected into a copy of each published file all come out on the page (a typed figure cannot)", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retrofit-guide-"));
    fs.mkdirSync(path.join(tmp, "public", "reference"), { recursive: true });
    const pack = raw("model_pack.json");
    const platforms = raw("platforms.json");
    const constraints = raw("constraints.json");
    const calibration = raw("calibration.json");
    const original = (await loadGuideModel())!;

    pack.generated = "2031-02-03";
    pack.notice = "SENTINEL-NOTICE 7770";
    pack.intake.document.grid.contracted_MW = 7771.5;
    pack.intake.document.lv.tapoff_max_A = 7772;
    pack.intake.document.thermal.residual_air_capacity_kW_per_rack.value = 7773;
    const hy = pack.scenarios.find((s: Json) => s.id === SCENARIO_ID);
    const txStep = hy.ladder.find((l: Json) => l.constraint === "transformer_capacity" && l.taken);
    const bwStep = hy.ladder.find((l: Json) => l.constraint === "busway_ampacity" && l.taken);
    txStep.lead_time_weeks.value = 7774;
    bwStep.racks_after = 7775;
    hy.time_to_power.curve[0].unlocked_by = "SENTINEL-UNLOCK";
    hy.constraints.find((c: Json) => c.id === TAPOFF_ID).basis = "SENTINEL-BASIS 7776 A (E0)";
    hy.after_ladder.it_load_kW.digest = "5ent1ne10001";
    const gb300 = platforms.platforms.find((p: Json) => p.id === "gb300_nvl72");
    gb300.rack_kW = 7778;
    gb300.residual_air_kW = 7777;
    constraints.constraints.find((c: Json) => c.id === RESIDUAL_AIR_ID).limits = "SENTINEL LIMITS TEXT 7780.";
    constraints.constraints.find((c: Json) => c.id === "transformer_capacity").relief = "SENTINEL RELIEF TEXT 7781.";
    calibration.observations = 7779;
    for (const [f, v] of [["model_pack.json", pack], ["platforms.json", platforms], ["constraints.json", constraints], ["calibration.json", calibration]] as const) {
      fs.writeFileSync(path.join(tmp, "public", "reference", f), JSON.stringify(v));
    }

    const { default: Guide } = await guideModule();
    const spy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    let html: string;
    try {
      html = unesc(renderToStaticMarkup(await Guide()));
    } finally {
      spy.mockRestore();
    }
    for (const s of [
      "2031-02-03", "SENTINEL-NOTICE 7770", "7,771.5 MW contracted", "7,772 A tap-off units", "7,773 kW per rack position", "7,774 [", `${fmt(bwStep.racks_before)} → 7,775`,
      "SENTINEL-UNLOCK", "SENTINEL-BASIS 7776 A (E0)", "5ent1ne10001", "7,778", "7,777", "SENTINEL LIMITS TEXT 7780.", "SENTINEL RELIEF TEXT 7781.", "7,779 reconciled observations",
    ]) {
      expect(html, s).toContain(s);
    }
    // and what they replaced is gone, wherever it was printed
    expect(html).not.toContain(original.pack.generated);
    expect(html).not.toContain(original.pack.notice);
    expect(html).not.toContain(original.pack.hall.queueNote === "" ? "\u0000" : "0 reconciled observations across 0 sites");
  });

  it("a limit the engine says it did not assess (a CDU limit with no CDU schedule declared) is described as not assessed, with no figure invented for it", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retrofit-guide-cdu-"));
    fs.mkdirSync(path.join(tmp, "public", "reference"), { recursive: true });
    const pack = raw("model_pack.json");
    const basis = "no CDU schedule declared: CDU capacity was not assessed, so this does not limit the hall here and has not been shown adequate";
    for (const s of pack.scenarios) {
      const c = s.constraints.find((x: Json) => x.id === "cdu_capacity");
      if (c && c.racks_permitted !== null) Object.assign(c, { racks_permitted: null, basis });
      s.ladder = s.ladder.filter((l: Json) => l.constraint !== "cdu_capacity");
    }
    for (const f of ["platforms.json", "constraints.json", "calibration.json"]) fs.copyFileSync(`public/reference/${f}`, path.join(tmp, "public", "reference", f));
    fs.writeFileSync(path.join(tmp, "public", "reference", "model_pack.json"), JSON.stringify(pack));
    const { default: Guide } = await guideModule();
    const spy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    let html: string;
    try {
      html = unesc(renderToStaticMarkup(await Guide()));
    } finally {
      spy.mockRestore();
    }
    const text = visible(html);
    expect(text).toContain(basis);
    expect(text).toContain("Not assessed in this example");
    expect(text).toContain("That is not the same as passing");
    expect(text).not.toMatch(/CDU capacity[^.]{0,80}Not used by this architecture/);
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("a pack that is not the synthetic model pack, or lacks what the guide reads, is refused and the page prints no figures", async () => {
    const good = raw("model_pack.json");
    expect(parseRetrofitPack(good)).not.toBeNull();
    for (const mutate of [
      (p: Json) => { p.synthetic = false; },
      (p: Json) => { delete p.notice; },
      (p: Json) => { p.schema = "something/else/1"; },
      (p: Json) => { p.scenarios = p.scenarios.filter((s: Json) => s.id !== SCENARIO_ID); },
      (p: Json) => { delete p.intake.document.thermal.residual_air_capacity_kW_per_rack; },
      (p: Json) => { p.scenarios[2].ladder[0].racks_before = "many"; },
    ]) {
      const p = JSON.parse(JSON.stringify(good));
      mutate(p);
      expect(parseRetrofitPack(p)).toBeNull();
    }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retrofit-guide-empty-"));
    fs.mkdirSync(path.join(tmp, "public", "reference"), { recursive: true });
    const { default: Guide } = await guideModule();
    const spy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
    let html: string;
    try {
      html = renderToStaticMarkup(await Guide());
    } finally {
      spy.mockRestore();
    }
    expect(visible(html)).toContain("no worked figures are shown rather than quoting any from memory");
    expect(html).not.toContain("<table");
    expect(html.match(/<h1/g)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("the argument the page makes in words is still what the pack shows", () => {
  it("two limits that apply to a single rack position are at zero as found, ahead of every capacity limit", async () => {
    const m = (await loadGuideModel())!;
    expect(m.zero.map((z) => z.id).sort()).toEqual([RESIDUAL_AIR_ID, TAPOFF_ID].sort());
    expect(m.scenario.asFound.racks).toBe(0);
    expect(m.order.slice(0, 2).map((o) => o.id).sort()).toEqual([RESIDUAL_AIR_ID, TAPOFF_ID].sort());
    for (const z of m.zero) expect(m.docs.get(z.id)!.limits).toMatch(/single rack position/);
    for (const c of m.order.slice(2).filter((o) => o.rungs.length)) expect(c.racks).toBeGreaterThan(0);
    // the engine names one of them; the other is still at zero and the ladder shows it at the next step
    expect(m.scenario.ladder[0].constraint).toBe(m.scenario.asFound.binding);
    expect(m.scenario.ladder[0].racksBefore).toBe(0);
    expect(m.scenario.ladder[0].racksAfter).toBe(0);
    expect(m.scenario.ladder[1].constraint).toBe(m.zero.find((z) => z.id !== m.scenario.asFound.binding)!.id);
    expect(m.scenario.ladder[1].racksAfter).toBeGreaterThan(0);
  });

  it("liquid cooling lowers the air-side load and does not clear the limit, in every scenario the engine solved", async () => {
    const m = (await loadGuideModel())!;
    const hallAir = m.pack.hall.residualAirKw.value;
    expect(m.platform.residual_air_kW).toBeLessThan(m.platform.rack_kW);
    expect(m.platform.residual_air_kW).toBeGreaterThan(hallAir);
    expect(m.platform.rack_kW * (1 - m.platform.liquid_fraction)).toBeCloseTo(m.platform.residual_air_kW, 6);
    for (const s of m.pack.scenarios) {
      const c = s.constraints.find((x) => x.id === RESIDUAL_AIR_ID)!;
      expect(c.gate, s.id).toBe(true);
      expect(c.racks, s.id).toBe(0);
    }
    const full = m.pack.scenarios.find((s) => s.id === COMPARISON_ID)!;
    expect(full.ladder.some((l) => l.constraint === RESIDUAL_AIR_ID && l.taken)).toBe(true);
    expect(full.ladder.find((l) => l.constraint === RESIDUAL_AIR_ID)!.racksAfter).toBe(0);
    // across the whole band, at both library shares, no point fits the position, and the installed tap-off feeds none
    for (const r of m.band!.rows) {
      expect(r.feedA).toBeGreaterThan(m.pack.hall.tapoffA);
      for (const a of r.air) expect(a.kw).toBeGreaterThan(hallAir);
    }
    for (const t of m.band!.maxRackOnAir) expect(t.kw).toBeLessThan(m.band!.rows[0].kw);
    expect(m.band!.maxRackOnTapoffKw).toBeLessThan(m.band!.rows[0].kw);
  });

  it("the relief to start first is not the limit that binds first, and the date is an assumed lead time", async () => {
    const m = (await loadGuideModel())!;
    expect(m.starts[0].id).toBe(m.scenario.time.setsTheDate ? m.order.find((o) => o.name === m.scenario.time.setsTheDate)!.id : "");
    expect(m.starts[0].id).not.toBe(m.order[0].id);
    expect(m.order.find((o) => o.id === m.starts[0].id)!.position).toBeGreaterThan(2);
    for (let i = 1; i < m.starts.length; i++) expect(m.starts[i - 1].lead.value).toBeGreaterThanOrEqual(m.starts[i].lead.value);
    expect(m.scenario.time.dateLabel).toMatch(/assumed lead time, not a date/);
    expect(m.scenario.time.dateClass).toBe("E0");
    expect(m.scenario.time.limitation).toMatch(/run in parallel/);
    expect(m.scenario.time.limitation).toMatch(/No dependency between reliefs is modelled/);
    for (const s of m.scenario.ladder.filter((l) => l.taken)) expect(s.leadTime!.evidence).toBe("E0_ASSUMPTION");
  });

  it("the comparison scenario needs the facility-water gate as well, and a limit can bind twice in the ladder", async () => {
    const m = (await loadGuideModel())!;
    const full = m.comparison!;
    const first = full.ladder.findIndex((s) => s.racksAfter > 0);
    expect(first).toBeGreaterThanOrEqual(2);
    expect(full.ladder.slice(0, first + 1).some((s) => s.constraint === "tcs_supply_achievable")).toBe(true);
    const taken = m.scenario.ladder.filter((s) => s.taken).map((s) => s.constraint);
    expect(taken.some((id, i) => taken.indexOf(id) !== i)).toBe(true);
    expect(m.scenario.ladder.some((s) => !s.taken && s.notTakenReason)).toBe(true);
  });

  it("the architecture ranges place the 100-150 kW band: air architectures cannot hold the rack, the liquid ones' ranges start and stand inside it", async () => {
    const m = (await loadGuideModel())!;
    const by = (id: string) => m.pack.scenarios.find((s) => s.id === id)!;
    expect(capabilityRange(by("retained_air"))!.high).toBeLessThan(m.platform.rack_kW);
    expect(capabilityRange(by("rdhx"))!.high).toBeLessThan(m.platform.rack_kW);
    expect(by("retained_air").constraints.find((c) => c.id === "architecture_capability")!.racks).toBe(0);
    // read from the file at test time with a second, independent pattern
    for (const id of ["hybrid_dlc", "full_dlc"]) {
      const basis: string = raw("model_pack.json").scenarios.find((s: Json) => s.id === id).constraints.find((c: Json) => c.id === "architecture_capability").basis;
      const [, nominal, low, high] = /capable of ([\d.]+) \[([\d.]+)–([\d.]+)\] kW/.exec(basis)!;
      expect(capabilityRange(by(id))).toEqual({ nominal: Number(nominal), low: Number(low), high: Number(high) });
    }
    expect(m.platform.peak_rack_kW).toBeGreaterThan(m.platform.rack_kW);
  });
});

describe("the order and its helpers", () => {
  it("lists all thirteen limits once, ladder first, then ceilings by count, then gates that pass, then any not used", async () => {
    const m = (await loadGuideModel())!;
    expect(m.order.map((o) => o.position)).toEqual(Array.from({ length: m.order.length }, (_, i) => i + 1));
    expect(new Set(m.order.map((o) => o.id)).size).toBe(m.order.length);
    expect(m.order).toHaveLength(13);
    const ladderIds = [...new Set(m.scenario.ladder.map((s) => s.constraint))];
    expect(m.order.slice(0, ladderIds.length).map((o) => o.id)).toEqual(ladderIds);
    const rest = m.order.slice(ladderIds.length);
    const rank = (o: (typeof rest)[number]) => ({ ceiling: 0, fails: 0, not_assessed: 1, passes: 2, not_applicable: 3 })[o.state];
    for (let i = 1; i < rest.length; i++) {
      expect(rank(rest[i - 1])).toBeLessThanOrEqual(rank(rest[i]));
      if (rank(rest[i - 1]) === 0 && rank(rest[i]) === 0) expect(rest[i - 1].racks!).toBeLessThanOrEqual(rest[i].racks!);
    }
    // a different scenario orders by its own ladder
    const full = bindingOrder(m.comparison!);
    expect(full.map((o) => o.id).slice(0, 3)).toEqual(m.comparison!.ladder.slice(0, 3).map((s) => s.constraint));
  });

  it("reads a gate that passes as no count, one that fails as zero, and says so", () => {
    const base = { id: "x", name: "X", domain: "thermal", basis: "b" };
    expect(limitState({ ...base, gate: true, racks: null })).toBe("passes");
    expect(limitState({ ...base, gate: true, racks: 0 })).toBe("fails");
    expect(limitState({ ...base, gate: false, racks: null })).toBe("not_applicable");
    // an unassessed limit is not a passing one, and not an inapplicable one
    expect(limitState({ ...base, basis: "no CDU schedule declared: CDU capacity was not assessed", gate: false, racks: null })).toBe("not_assessed");
    expect(limitState({ ...base, gate: false, racks: 12 })).toBe("ceiling");
    expect(limitState({ ...base, gate: false, racks: 0 })).toBe("ceiling");
  });

  it("evidence classes are read in order, once each, and the weakest is the lowest", () => {
    expect(classesIn("2,700 [2,070–2,970] kW (E0) usable against 122 (E0) at 24 (E0)")).toEqual(["E0"]);
    expect(classesIn("platform needs 205 (E0); tap-offs rated 63 A (E5)")).toEqual(["E0", "E5"]);
    expect(classesIn("1,900 kW (E3) against 135 (E0)")).toEqual(["E3", "E0"]);
    expect(weakestClass(["E3", "E0"])).toBe("E0");
    expect(weakestClass(["E5", "E3"])).toBe("E3");
    expect(weakestClass([])).toBeNull();
    expect(classesIn("E10 or xE1 or E8")).toEqual([]);
  });

  it("the printed basis is the pack's sentence cut at its modelling notes, never altered", async () => {
    const pack = raw("model_pack.json");
    const seen = new Set<string>();
    for (const s of pack.scenarios) {
      for (const c of s.constraints) {
        const shown = displayBasis(c.basis);
        expect(c.basis.startsWith(shown)).toBe(true);
        expect(shown).not.toMatch(/Modelling limit:|Flow basis:/);
        seen.add(shown);
      }
    }
    expect(seen.size).toBeGreaterThan(10);
    expect(displayBasis("a. Modelling limit: b")).toBe("a.");
    expect(displayBasis("a. Flow basis: b. Modelling limit: c")).toBe("a.");
    expect(displayBasis("plain")).toBe("plain");
  });

  it("small helpers say what they say", () => {
    expect(firstSentences("One. Two (x). Three.", 2)).toBe("One. Two (x).");
    expect(firstSentences("Only one.", 3)).toBe("Only one.");
    expect(f1(9.999999999999998)).toBe("10.0");
    expect(d1(13.5)).toBe("13.5");
    expect(d1(9)).toBe("9");
    expect(fmt(9000)).toBe("9,000");
    expect(words(2)).toBe("two");
    expect(words(40)).toBe("40");
    expect(lc("Transformer capacity")).toBe("transformer capacity");
    expect(lc("UPS capacity (protected load)")).toBe("UPS capacity (protected load)");
    expect(lc("CDU capacity")).toBe("CDU capacity");
    const q = { value: 160, low: 104, high: 216, unit: "weeks", evidence: "E0_ASSUMPTION" };
    expect(fmtQty(q)).toBe("160 [104–216]");
    expect(fmtLead(q)).toBe("160 weeks (band 104–216, E0)");
    expect(fmtLead({ ...q, low: null, high: null })).toBe("160 weeks (E0)");
  });

  it("start order is by lead time, longest first, one entry per relief with every step that uses it", async () => {
    const m = (await loadGuideModel())!;
    const ups = startOrder(m.scenario).find((s) => s.id === "ups_capacity")!;
    expect(ups.steps).toEqual(m.scenario.ladder.filter((s) => s.constraint === "ups_capacity" && s.taken).map((s) => s.step));
    expect(startOrder(m.scenario).map((s) => s.id)).not.toContain("grid_firm_capacity"); // not taken, so not started
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("structure, metadata and accessibility", () => {
  it("title fits a result once the site name is added, the description fits, and the page names itself canonical with a 1200x630 card", async () => {
    const { metadata } = await guideModule();
    const layout = (await import("@/app/layout")) as unknown as { metadata: { title: { template: string } } };
    const shown = layout.metadata.title.template.replace("%s", metadata.title);
    expect(metadata.title.length).toBeLessThanOrEqual(44);
    expect(shown.length).toBeLessThanOrEqual(60);
    expect(metadata.description.length).toBeGreaterThanOrEqual(63);
    expect(metadata.description.length).toBeLessThanOrEqual(160);
    expect(metadata.alternates.canonical).toBe(PATH);
    expect(metadata.openGraph.url).toBe(PATH);
    expect(metadata.openGraph.title).toBe(metadata.title);
    expect(metadata.openGraph.description).toBe(metadata.description);
    for (const img of [...metadata.openGraph.images, ...metadata.twitter.images]) {
      expect(img.url).toBe("/cards/guide-retrofit-order.png");
      expect([img.width, img.height]).toEqual([1200, 630]);
      expect(img.alt.length).toBeGreaterThan(10);
    }
    expect(PAGE_CARDS["guide-retrofit-order"].title).toBe(metadata.title);
    expect(JSON.stringify(PAGE_CARDS["guide-retrofit-order"]).toLowerCase()).not.toMatch(/guarantee|customers|market leader|award|trusted by/);
  });

  it("has exactly one h1, headings never skip a level, and the answer comes before the method", async () => {
    const html = await render();
    expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
    const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((x) => Number(x[1]));
    expect(levels[0]).toBe(1);
    for (let i = 1; i < levels.length; i++) expect(levels[i], `heading ${i}`).toBeLessThanOrEqual(levels[i - 1] + 1);
    expect(html.indexOf("THE SHORT ANSWER")).toBeGreaterThan(0);
    expect(html.indexOf("THE SHORT ANSWER")).toBeLessThan(html.indexOf("The case this guide shows"));
    expect(html.indexOf("<strong class=\"text-ghost\">For:</strong>")).toBeLessThan(html.indexOf("THE SHORT ANSWER"));
    expect(html).toContain("data-definition");
    expect(html).toContain("Synthetic.");
  });

  it("every table has a caption and column headers and sits in a region the keyboard can reach; the figure has a text alternative", async () => {
    const html = await render();
    const parts = html.split("<table");
    expect(parts.length - 1).toBeGreaterThanOrEqual(9);
    parts.slice(1).forEach((rest, i) => {
      const table = rest.slice(0, rest.indexOf("</table>"));
      expect(table, `table ${i}`).toMatch(/<caption/);
      expect(table, `table ${i}`).toMatch(/<th scope="col"/);
      expect(parts[i], `table ${i}`).toMatch(/role="region"[^>]*aria-label="[^"]+"[^>]*tabindex="0"[^>]*>$/);
    });
    const svg = html.match(/<svg[\s\S]*?<\/svg>/)![0];
    expect(svg).toMatch(/role="img"/);
    expect(svg).toMatch(/aria-labelledby="ladder-t ladder-d"/);
    expect(svg).toMatch(/<title id="ladder-t">[^<]{10,}/);
    expect(svg).toMatch(/<desc id="ladder-d">[^<]{50,}/);
    expect(html).toMatch(/<figure[\s\S]*<figcaption/);
    // every value plotted is in the ladder table that follows it
    const m = (await loadGuideModel())!;
    for (const s of m.scenario.ladder) expect(svg).toContain(`${s.racksBefore} racks before, ${s.racksAfter} after`);
  });

  it("is in the sitemap, the footer and the llms.txt route, linked from the nameplate guide, and dated by the sitemap's own mechanism", async () => {
    expect((await sitemap()).some((u) => u.url.endsWith(PATH))).toBe(true);
    expect(fs.readFileSync("lib/nav.ts", "utf8")).toContain(PATH);
    const nameplate = renderToStaticMarkup(await (await import("@/app/guides/nameplate-vs-useful-compute/page")).default());
    expect(nameplate).toContain(`href="${PATH}"`);
    const sources = (routeSources() as Record<string, string[]>)[PATH];
    expect(sources).toEqual(expect.arrayContaining(SOURCES));
    for (const f of sources) expect(fs.existsSync(f), f).toBe(true);
  });

  it("every internal link goes to a page, route or file that exists, with a valid slug where the route is dynamic", async () => {
    const html = unesc(await render());
    const hrefs = [...new Set([...html.matchAll(/href="([^"]+)"/g)].map((x) => x[1]))];
    expect(hrefs.length).toBeGreaterThan(20);
    expect(hrefs.filter((h) => /^(https?:)?\/\//.test(h))).toEqual([]);
    const exists = (dir: string, segs: string[]): boolean => {
      if (!segs.length) return fs.existsSync(path.join(dir, "page.tsx"));
      return fs.readdirSync(dir, { withFileTypes: true }).some((e) => e.isDirectory() && (e.name === segs[0] || /^\[\w+\]$/.test(e.name)) && exists(path.join(dir, e.name), segs.slice(1)));
    };
    const slugs = new Set(raw("constraints.json").constraints.map((c: Json) => c.slug));
    const platformIds = new Set(pageablePlatforms(raw("platforms.json").platforms).map((p: Json) => p.id));
    const productSlugs = new Set(PRODUCT_PAGES.map((p) => p.slug));
    const bad: string[] = [];
    for (const h of hrefs) {
      if (!h.startsWith("/")) {
        bad.push(`${h}: not site-relative`);
        continue;
      }
      const p = h.split("#")[0].split("?")[0].replace(/\/$/, "") || "/";
      const segs = p.split("/").filter(Boolean);
      if (fs.existsSync(path.join("public", ...segs)) && segs.length) continue; // a published file
      if (!exists("app", segs)) bad.push(`${h}: no such page`);
      if (segs[0] === "constraints" && segs[1] && !slugs.has(segs[1])) bad.push(`${h}: no such constraint`);
      if (segs[0] === "platforms" && segs[1] && !platformIds.has(segs[1])) bad.push(`${h}: no such platform page`);
      if (segs[0] === "products" && segs[1] && !productSlugs.has(segs[1])) bad.push(`${h}: no such product page`);
    }
    expect(bad).toEqual([]);
    // a section per limit, each linking its reference page: all thirteen
    for (const slug of slugs) expect(hrefs, String(slug)).toContain(`/constraints/${slug}`);
    expect(slugs.size).toBe(13);
    // the next steps go to the catalogue products
    for (const p of ["/qualify", "/products/density-screen", "/products/envelope-study", "/products/procurement-specification"]) expect(hrefs).toContain(p);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("structured data", () => {
  const FORBIDDEN_TYPES = /^(Review|AggregateRating|Rating|Product|Event|Article|NewsArticle|BlogPosting|HowTo|ClaimReview|Claim|LocalBusiness|Brand)$/;
  const FORBIDDEN_KEYS = ["aggregateRating", "review", "reviewRating", "ratingValue", "ratingCount", "reviewCount", "bestRating", "license", "licence", "award"];
  const walk = (v: unknown, f: (k: string, x: unknown) => void) => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, f));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) (f(k, x), walk(x, f));
  };

  it("parses, is a TechArticle that matches the page, and names the one organisation and the founder by id", async () => {
    const html = await render();
    const blocks = jsonLd(html);
    const { metadata } = await guideModule();
    const article = blocks.find((b) => b["@type"] === "TechArticle")!;
    expect(article.headline).toBe(metadata.title);
    expect(article.description).toBe(metadata.description);
    expect(article.url).toMatch(new RegExp(`${PATH}$`));
    expect(article.datePublished).toBe("2026-11-12");
    expect(html).toMatch(/<time dateTime="2026-11-12">12 November 2026<\/time>|<time datetime="2026-11-12">12 November 2026<\/time>/);
    expect(article.publisher["@id"]).toMatch(/#organization$/);
    expect(article.publisher["@type"]).toBe("Organization");
    expect(article.author["@id"]).toMatch(/#founder$/);
    expect(article.isBasedOn.map((u: string) => new URL(u).pathname)).toEqual(["/reference/model_pack.json", "/reference/platforms.json"]);
    const crumb = blocks.find((b) => b["@type"] === "BreadcrumbList")!;
    expect(crumb.itemListElement.map((i: Json) => new URL(i.item).pathname)).toEqual(["/", PATH]);
    expect(blocks.find((b) => b["@type"] === "WebPage")!.url).toMatch(new RegExp(`${PATH}$`));
  });

  it("claims no review, rating, licence or award, in any block", async () => {
    const blocks = jsonLd(await render());
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    const types: string[] = [];
    const keys = new Set<string>();
    for (const b of blocks) walk(b, (k, x) => { keys.add(k); if (k === "@type") types.push(...([] as string[]).concat(x as string)); });
    expect(types.filter((t) => FORBIDDEN_TYPES.test(t))).toEqual([]);
    expect(FORBIDDEN_KEYS.filter((k) => keys.has(k))).toEqual([]);
    expect(types).toContain("TechArticle");
  });

  it("FAQPage appears only with its questions and answers visible on the page", async () => {
    const html = await render();
    const text = visible(html);
    const faq = jsonLd(html).find((b) => b["@type"] === "FAQPage")!;
    expect(faq.mainEntity.length).toBeGreaterThanOrEqual(4);
    for (const q of faq.mainEntity) {
      expect(text).toContain(q.name.replace(/\s+/g, " ").trim());
      expect(text).toContain(q.acceptedAnswer.text.replace(/\s+/g, " ").trim());
    }
    expect(html).not.toMatch(/aria-hidden="true"[^>]*>\s*<dl/);
  });

  it("dateModified is the sitemap record's own date: absent while there is none, present and equal once there is, ignored if malformed, never typed", async () => {
    const manifest = JSON.parse(fs.readFileSync("lib/page-lastmod.json", "utf8"));
    const recorded: string | undefined = manifest.pages?.[PATH]?.lastmod;
    const real = jsonLd(await render()).find((b) => b["@type"] === "TechArticle")!;
    if (recorded) expect(real.dateModified).toBe(recorded);
    else expect(real).not.toHaveProperty("dateModified");

    for (const [lastmod, expected] of [["2031-05-06", "2031-05-06"], ["not a date", undefined], [20310506, undefined]] as const) {
      vi.resetModules();
      vi.doMock("@/lib/page-lastmod.json", () => ({ default: { pages: { [PATH]: { lastmod } } } }));
      const html = await render();
      const article = jsonLd(html).find((b) => b["@type"] === "TechArticle")!;
      if (expected) {
        expect(article.dateModified).toBe(expected);
        expect(visible(html)).toContain("updated 6 May 2031");
      } else {
        expect(article).not.toHaveProperty("dateModified");
        expect(visible(html)).not.toContain("updated");
      }
      vi.doUnmock("@/lib/page-lastmod.json");
    }
    vi.resetModules();
    vi.doMock("@/lib/page-lastmod.json", () => ({ default: {} }));
    expect(jsonLd(await render()).find((b) => b["@type"] === "TechArticle")).not.toHaveProperty("dateModified");
    // and the source types no date but the publication date
    expect((fs.readFileSync(PAGE, "utf8").match(/\b20\d\d-\d\d-\d\d\b/g) ?? [])).toEqual(["2026-11-12"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("copy: no typed price, no case study, no testimonial, no guarantee, no claim of work done", () => {
  it("the sources contain no euro amount (prices come from the catalogue)", () => {
    for (const f of SOURCES) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/€|\bEUR\b|\beuros?\b|\bUSD\b|\$\s?\d/i);
    }
  });

  it("every euro amount the page shows is a catalogue amount", async () => {
    const shown = [...visible(await render()).matchAll(/€\s?[\d,]+(?:\.\d+)?/g)].map((x) => x[0].replace(/\s/g, ""));
    const catalogue = new Set<string>();
    for (const p of Object.values(PRODUCTS)) for (const c of [p.amountCents, ...(p.opensBandCents ?? [])]) catalogue.add(eurFromCents(c).replace(/\s/g, ""));
    expect(shown.length).toBeGreaterThan(3);
    expect(shown.filter((s) => !catalogue.has(s))).toEqual([]);
  });

  it("says none of the things the honesty rules forbid, in the rendered page or in its sources", async () => {
    const BANNED = /case stud(y|ies)|testimonial|guaranteed?\b|we have (retrofitted|completed|delivered|done)|our (clients|customers)\b|customer (result|case|story)|\btrusted by\b|\bsavings?\b|\bROI\b|world[- ]class|best[- ]in[- ]class|market leader|industry[- ]leading|unrivalled/i;
    const text = visible(await render());
    expect(text.match(BANNED)).toBeNull();
    for (const f of SOURCES) expect(fs.readFileSync(f, "utf8").match(BANNED), f).toBeNull();
    // and it says what it is: modelled, synthetic, not a design or an approval
    expect(text).toContain("Time to Power sells no equipment");
    expect(text).toMatch(/not a design, an approval or a statement that a hall can be loaded/);
    // no claim of what halls or operators generally do: checked on the page's own authored copy (the reference and engine sentences it prints are theirs)
    for (const f of SOURCES) expect(fs.readFileSync(f, "utf8").match(/\b(usually|rarely|typically|most halls|most operators|most owners)\b/i), f).toBeNull();
  });

  it("does not present a vendor figure as validated, or use the figures its reference marks as not for paid work", async () => {
    const text = visible(await render());
    expect(text).toMatch(/A vendor claim stays a vendor claim/);
    expect(text).toMatch(/does not present any of them as validated performance/);
    // docs/02 section 9: unpublished rack powers, the GB200 "120 kW" marketing figure, the Rubin and Helios targets
    expect(text).not.toMatch(/\b(VR200|Vera Rubin|Rubin Ultra|Helios|MI450|NVL144|NVL576)\b/);
    expect(text).not.toMatch(/GB200[^.]{0,40}\b120 kW/);
    expect(text).not.toMatch(/(?<![\d,.])(190|230|600)(?:[–-]230)? ?kW\b/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("llms.txt", () => {
  async function llms(): Promise<string> {
    const stop = stubEngine(FULL_ENGINE);
    try {
      vi.resetModules();
      return await (await (await import("@/app/llms.txt/route")).GET()).text();
    } finally {
      stop();
    }
  }

  it("lists the guide, in the style of the other guide, with a description that matches the page", async () => {
    const body = await llms();
    const line = body.split("\n").find((l) => l.includes(`${PATH}`))!;
    expect(line).toMatch(/^- https:\/\/\S+\/guides\/retrofit-order-of-limits — /);
    expect(line).toMatch(/synthetic reference hall/);
    expect(body).toContain("/guides/nameplate-vs-useful-compute — ");
    expect(body.split("\n").filter((l) => l.includes(PATH))).toHaveLength(1);
  });

  it("no longer says the deposit products have no intake form: scoping comes first, then a private intake link is emailed", async () => {
    const body = await llms();
    const flat = body.replace(/\s+/g, " ");
    expect(flat).not.toMatch(/no intake form/i);
    expect(flat).toMatch(/Envelope Study and Portfolio Screen deposits open a scoping conversation with a person first/);
    expect(flat).toMatch(/nothing is produced until the scope and fee are agreed/);
    expect(flat).toMatch(/the buyer's private intake link is emailed and the hall's numbers are submitted there/);
    // the sentence tests/site/copy-honesty.test.ts pins is still there, unchanged
    expect(body).toMatch(/no response time is\s+promised/);
    expect(body).not.toMatch(/business days?/i);
    // what the page of the same flow says agrees with it
    expect(fs.readFileSync("lib/product-pages.ts", "utf8")).toMatch(/Once the scope and fee are agreed, your private intake link is emailed to you/);
  });

  it("keeps the other flow statements the code proves: the checkout parameter, the dashboard sign-in and the delivery states", async () => {
    const flat = (await llms()).replace(/\s+/g, " ");
    expect(flat).toContain("awaiting_intake");
    expect(flat).toContain("No document is released unread.");
    expect(flat).toContain("project_share_token");
    expect(flat).toMatch(/passwordless email sign-in/);
  });
});
