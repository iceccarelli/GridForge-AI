/**
 * Findings of the adversarial review of /guides/retrofit-order-of-limits (R2, R3, R6 to R9), each pinned so that reverting its fix fails here.
 * Every expectation is computed from the published files at test time; nothing is hard-coded from today's pack.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import K from "@/lib/engineering-constants.json";
import { EVIDENCE_CLASSES } from "@/lib/evidence-classes";
import { fmt, loadGuideModel } from "@/lib/retrofit-order-data";

vi.mock("next/font/local", () => ({ default: () => ({ variable: "", className: "" }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const REF = "public/reference";
const raw = (f: string): Json => JSON.parse(fs.readFileSync(`${REF}/${f}`, "utf8"));
const unesc = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&");
const visible = (html: string) =>
  unesc(html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
const jsonLd = (html: string): Json[] => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1].replace(/\\u003c/g, "<")));

async function page() {
  return (await import("@/app/guides/retrofit-order-of-limits/page")) as { default: () => Promise<React.ReactElement> };
}
async function renderReal(): Promise<string> {
  return renderToStaticMarkup(await (await page()).default());
}
/** Render against a copy of the published files that `mutate` has changed. The strings are the file texts for the .md file. */
async function renderWith(mutate: (f: { pack: Json; platforms: Json; constraints: Json; calibration: Json; study: { text: string | null } }) => void): Promise<string> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "retrofit-review-"));
  fs.mkdirSync(path.join(tmp, "public", "reference"), { recursive: true });
  const f = { pack: raw("model_pack.json"), platforms: raw("platforms.json"), constraints: raw("constraints.json"), calibration: raw("calibration.json"), study: { text: fs.readFileSync(`${REF}/envelope_study.md`, "utf8") as string | null } };
  mutate(f);
  for (const [name, v] of [["model_pack.json", f.pack], ["platforms.json", f.platforms], ["constraints.json", f.constraints], ["calibration.json", f.calibration]] as const) {
    fs.writeFileSync(path.join(tmp, "public", "reference", name), JSON.stringify(v));
  }
  if (f.study.text !== null) fs.writeFileSync(path.join(tmp, "public", "reference", "envelope_study.md"), f.study.text);
  const { default: Guide } = await page();
  const spy = vi.spyOn(process, "cwd").mockReturnValue(tmp);
  try {
    return renderToStaticMarkup(await Guide());
  } finally {
    spy.mockRestore();
  }
}
const hybrid = (pack: Json) => pack.scenarios.find((s: Json) => s.id === "hybrid_dlc");
const between = (text: string, a: string, b: string) => text.slice(text.indexOf(a), text.indexOf(b, text.indexOf(a)));

// ---------------------------------------------------------------------------------------------------------------------------------
describe("R2: where the lead times come from", () => {
  it("states the pack's lead-time source for the date-setting lead time, in the short answer, the table, the questions and the JSON-LD", async () => {
    const dr = hybrid(raw("model_pack.json")).time_to_power.date_record;
    expect(dr.lead_time_source_label).toBeTruthy();
    const html = await renderReal();
    const text = visible(html);
    const answer = between(text, "THE SHORT ANSWER", "Terms, and how");
    expect(answer).toContain(dr.lead_time_source_label);
    expect(answer).toContain("unverified");
    const faq = jsonLd(html).find((b) => b["@type"] === "FAQPage")!;
    const q = faq.mainEntity.find((x: Json) => x.name === "Which relief should be started first?");
    expect(q.acceptedAnswer.text).toContain(dr.lead_time_source_label);
    expect(text).toContain(q.acceptedAnswer.text);
    const row = [...html.matchAll(/<tr[\s\S]*?<\/tr>/g)].map((m) => visible(m[0])).find((r) => r.startsWith(dr.controlling_component) && /\d+ \[/.test(r))!;
    expect(row).toContain(dr.lead_time_source_label);
  });

  it("calls no supplied figure a library default or a library figure", async () => {
    const pack = raw("model_pack.json");
    const dr = hybrid(pack).time_to_power.date_record;
    const text = visible(await renderReal()).split(flat(dr.limitation)).join(" "); // the pack's own sentence says "a library placeholder or a figure the customer supplied": about both
    expect(text).not.toMatch(/an assumed library figure/i);
    expect(text).not.toMatch(/lead times? (are|is|in the ladder is)[^.]{0,40}library('s| default| figure| placeholder)/i);
    expect(text).not.toMatch(/(transformer|date-setting)[^.]{0,100}library (figure|default|placeholder)/i);
    expect(text).not.toMatch(/every cost and lead time in the ladder is a library default/i);
    expect(text).toMatch(/not a quotation/);
    // the class is still E0: any supplied lead time is an assumption
    expect(dr.evidence_class).toBe("E0");
    expect(text).toMatch(/classes (any|every) lead time[^.]*E0/i);
  });

  it("prints the pack's whole limitation text, including the customer-supplied and CDU-kit sentences, and the intake's supplied lead-time inputs", async () => {
    const pack = raw("model_pack.json");
    const dr = hybrid(pack).time_to_power.date_record;
    const html = await renderReal();
    const text = visible(html);
    expect(text).toContain(flat(dr.limitation));
    const caveat = dr.limitation.split(/(?<=\.)\s+(?=[A-Z])/).find((s: string) => /first-rack/.test(s))!;
    expect(caveat).toMatch(/kit/);
    const curve = between(text, "When the racks arrive", "Limit by limit");
    expect(curve).toContain(flat(caveat));
    for (const path of pack.intake.supplied.filter((s: string) => /lead_time/.test(s))) expect(text).toContain(path);
  });

  it("follows the pack: another source label changes the sentence, and a library-sourced pack is described as library-sourced", async () => {
    const supplied = await renderWith((f) => { hybrid(f.pack).time_to_power.date_record.lead_time_source_label = "SENTINEL-SOURCE-LABEL"; hybrid(f.pack).time_to_power.date_record.limitation = "Sentinel one. Sentinel two. Sentinel first-rack kit three."; });
    const t1 = visible(supplied);
    expect(between(t1, "THE SHORT ANSWER", "Terms, and how")).toContain("SENTINEL-SOURCE-LABEL");
    expect(t1).not.toContain("customer-supplied (unverified)");
    expect(t1).toContain("Sentinel one. Sentinel two. Sentinel first-rack kit three.");
    const lib = await renderWith((f) => { const d = hybrid(f.pack).time_to_power.date_record; d.lead_time_source = "library_default"; d.lead_time_source_label = "library default (assumed)"; });
    const t2 = visible(lib);
    expect(between(t2, "THE SHORT ANSWER", "Terms, and how")).toContain("library default (assumed)");
    expect(between(t2, "THE SHORT ANSWER", "Terms, and how")).not.toContain("unverified");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("R3: floor loading is arithmetic and an engineer decides", () => {
  it("shows the pitch-averaged figure and the per-footprint figure, the raised-floor note, the survey caveat, and no verdict", async () => {
    const m = (await loadGuideModel())!;
    const gb300 = raw("platforms.json").platforms.find((p: Json) => p.id === m.pack.hall.platformId);
    const html = await renderReal();
    const text = visible(html);
    const article = visible(html.split("<article").find((x) => x.includes('id="lim-floor_loading"'))!);
    expect(article).toContain(`${fmt(gb300.rack_mass_kg)} kg / ${gb300.rack_footprint_m2} m²`);
    expect(article).toContain(`${fmt(Math.round(gb300.rack_mass_kg / gb300.rack_footprint_m2))} kg/m²`);
    expect(article).toMatch(/averaged over the aisle pitch/);
    expect(article).toMatch(/structural engineer decides/);
    expect(article).toContain("Requires structural survey");
    const study = fs.readFileSync(`${REF}/envelope_study.md`, "utf8");
    const note = /Raised floor: [^\n]*/.exec(study)![0];
    expect(article).toContain(note);
    expect(article).not.toMatch(/gate, open|passes as found/i);
    expect(text).not.toMatch(/floor loading[^.]{0,60}(passes|is open|is closed)/i);
    // the page does not call the floor safe or adequate anywhere
    expect(text).not.toMatch(/floor[^.]{0,40}\b(is|are) (safe|adequate|fine|sufficient)/i);
  });

  it("derives the per-footprint figure from the pack's rack mass and footprint, and says when the pack does not carry the raised-floor note", async () => {
    const withMass = visible(await renderWith((f) => { const p = f.platforms.platforms.find((x: Json) => x.id === "gb300_nvl72"); p.rack_mass_kg = 7791; p.rack_footprint_m2 = 2; }));
    expect(withMass).toContain("7,791 kg / 2 m²");
    expect(withMass).toContain(`${fmt(Math.round(7791 / 2))} kg/m²`);
    const sentinel = visible(await renderWith((f) => { f.study.text = f.study.text!.replace(/Raised floor: [^\n]*/, "Raised floor: SENTINEL-FLOOR-NOTE."); }));
    expect(sentinel).toContain("Raised floor: SENTINEL-FLOOR-NOTE.");
    const none = visible(await renderWith((f) => { f.study.text = null; }));
    expect(none).toMatch(/does not carry the engine['’]s raised-floor note/);
    expect(none).not.toContain("load-spreading plates");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("R6: the page can be navigated", () => {
  it("has a jump list under the short answer whose anchors all resolve, and every h2 has an id", async () => {
    const html = await renderReal();
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((x) => x[1]));
    const h2s = [...html.matchAll(/<h2([^>]*)>/g)].map((x) => /\sid="([^"]+)"/.exec(x[1])?.[1]);
    expect(h2s.length).toBeGreaterThanOrEqual(10);
    expect(h2s.filter((x) => !x)).toEqual([]);
    const navAt = html.indexOf('<nav aria-label="On this page"');
    expect(navAt).toBeGreaterThan(html.indexOf("THE SHORT ANSWER"));
    expect(navAt).toBeLessThan(html.indexOf('id="case-h"'));
    const nav = html.slice(navAt, html.indexOf("</nav>", navAt));
    const targets = [...nav.matchAll(/href="#([^"]+)"/g)].map((x) => x[1]);
    expect(targets.length).toBeGreaterThanOrEqual(9);
    for (const t of targets) expect(ids.has(t), t).toBe(true);
    // every section after the short answer is in the list
    const after = [...html.matchAll(/<h2[^>]*\sid="([^"]+)"/g)].map((x) => x[1]).filter((id) => html.indexOf(`id="${id}"`) > navAt);
    expect(targets).toEqual(after);
    // all in-page anchors in the page resolve
    for (const m of html.matchAll(/href="#([^"]+)"/g)) expect(ids.has(m[1]), m[1]).toBe(true);
  });

  it("tells a reader a wide table scrolls sideways, in words, and ties the cue to each scroll region", async () => {
    const html = await renderReal();
    const tables = (html.match(/<table/g) ?? []).length;
    const regions = [...html.matchAll(/<div[^>]*role="region"[^>]*>/g)].map((x) => x[0]);
    expect(regions.length).toBe(tables);
    for (const r of regions) {
      const id = /aria-describedby="([^"]+)"/.exec(r)?.[1];
      expect(id, r).toBeTruthy();
      const cue = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html)?.[1] ?? "";
      expect(cue).toMatch(/scroll sideways/i);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("R7: the feed current is a library working value with a class and a band", () => {
  it("labels the column E0 with the band and its basis, scales the band, and states the conclusion only because the numbers hold", async () => {
    const m = (await loadGuideModel())!;
    const frac = K.rack_feed.library_feed_current_band_fraction;
    const pct = Math.round(frac * 100);
    const html = await renderReal();
    const text = visible(html);
    expect(K.rack_feed.library_feed_current_class).toBe("E0");
    expect(text).toContain(`Feed A (${K.rack_feed.library_feed_current_class}, ±${pct}%)`);
    // both tables carry it: the library's platform table and the arithmetic across the band
    for (const cap of ["Rack power, liquid share, air-side load and feed current", "For each rack power in the band"]) {
      const table = visible(html.split("<table").find((t) => t.includes(cap))!);
      expect(table, cap).toContain(`Feed A (${K.rack_feed.library_feed_current_class}, ±${pct}%)`);
    }
    expect(text).toMatch(/working value[^.]*not an OEM figure/);
    expect(text).toContain(`${fmt(K.rack_feed.library_feed_voltage_V)} V three-phase`);
    const gb300 = raw("platforms.json").platforms.find((p: Json) => p.id === m.pack.hall.platformId);
    const tap = m.pack.hall.tapoffA;
    for (const kw of m.band!.rows.map((r) => r.kw)) {
      const a = (gb300.rack_feed_current_A * kw) / gb300.rack_kW;
      expect(text).toContain(`${fmt(Math.round(a))} [${fmt(Math.round(a * (1 - frac)))}–${fmt(Math.round(a * (1 + frac)))}]`);
      expect(a * (1 - frac), `${kw} kW still needs more than the tap-off at the low end of the band`).toBeGreaterThan(tap);
    }
    const perKw = gb300.rack_feed_current_A / gb300.rack_kW;
    expect(text).toContain(`${((tap / (perKw * (1 - frac))) as number).toFixed(1)} kW`); // the most a tap-off could feed if the library's current were that much too high
    expect(text).toMatch(/closed even/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("R8: what E3 means on these rows", () => {
  it("says no engineer reviewed this synthetic hall, counts the E3 rows, and keeps the class definition as the repo's own", async () => {
    const m = (await loadGuideModel())!;
    const e3 = m.order.filter((o) => o.classes.includes("E3")).length;
    expect(e3).toBeGreaterThan(0);
    const text = visible(await renderReal());
    expect(text).toContain("No engineer reviewed this synthetic hall");
    expect(text).toContain(`${fmt(e3)} of ${fmt(m.order.length)} limits`);
    expect(text).toMatch(/E3 rows[^.]*(arithmetic|the engine's own estimate)/);
    expect(text).not.toMatch(/rows?[^.]{0,60}reviewed by a qualified engineer/);
    const def = EVIDENCE_CLASSES.find((c) => c.code === "E3")!.meaning;
    expect(text).toContain(def); // the definition is printed as the definition, not as what happened here
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("R9: no text under 12 px in the guide", () => {
  it("has no 10 or 11 px text class in the page or the figure, headers and badges are 12 px or more, and the figure's text stays 12 px once scaled to a 375 px screen", async () => {
    for (const f of ["app/guides/retrofit-order-of-limits/page.tsx", "components/diagrams/LadderBars.tsx"]) {
      expect(fs.readFileSync(f, "utf8"), f).not.toMatch(/text-\[(9|10|11)px\]/);
    }
    const html = await renderReal();
    expect(html).not.toMatch(/text-\[(9|10|11)px\]/);
    for (const th of html.matchAll(/<th scope="col"[^>]*class="([^"]*)"/g)) expect(th[1]).toMatch(/text-xs|text-sm|text-\[1[2-9]px\]/);
    for (const e of html.matchAll(/<p class="eyebrow[^"]*"/g)) expect(e[0]).toMatch(/!text-xs/);
    const svg = html.match(/<svg[\s\S]*?<\/svg>/)![0];
    const w = Number(/viewBox="0 0 (\d+)/.exec(svg)![1]);
    const sizes = [...svg.matchAll(/font-size="(\d+(?:\.\d+)?)"/g)].map((x) => Number(x[1]));
    expect(sizes.length).toBeGreaterThan(5);
    const shown = 375 - 2 * 20 - 2 * 16; // viewport, less the page gutters and the figure's padding
    for (const s of sizes) expect((s * shown) / w, `font-size ${s} in a ${w}-wide viewBox`).toBeGreaterThanOrEqual(12);
    // every label is still whole: no text in the figure is cut by the viewBox
    for (const t of svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)) expect(t[1].length * 0.6 * Math.max(...sizes)).toBeLessThanOrEqual(w);
  });
});
