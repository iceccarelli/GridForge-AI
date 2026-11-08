/**
 * The engine's reserved engineering constants, as the site states them (lib/engineering-constants.ts).
 *
 * What this holds: every figure a page, /llms.txt or a definition states about the transformer lead-time default, the tap-off check, the
 * hydraulic-flow limit and the trim-chiller and PUE treatment is read from lib/engineering-constants.json (drift-tested against the engine by
 * tests/test_engineering_constants.py) or from the engine's published files; the typed module carries no figure of its own; each statement says
 * what the code does with the class the engine labels it with; and a labelled engine assumption is never presented as, or supported by, a
 * reported market figure.
 */
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ConstraintReference, PlatformEntry } from "@/lib/constraints";
import { ENGINEERING_ASSUMPTIONS_NOTE, engineeringAssumptionDefinition } from "@/lib/definitions";
import { LEAD_TIME_SOURCE_LABELS, assumptionsForConstraint, engineeringAssumptions, impliedDeltaTK, physicsFlowPerKW, transformerDefaultIsNotMarketEvidence } from "@/lib/engineering-constants";
import { formatLeadTime, leadTimeSourceLabel } from "@/lib/date-basis";
import { MARKET_EVIDENCE, PUBLISHABLE_FIGURES, marketFigure } from "@/lib/market-evidence";
import K from "@/lib/engineering-constants.json";

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const readJson = <T>(rel: string) => JSON.parse(read(rel)) as T;
const text = (html: string) => html.replace(/<!-- -->/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const ref = readJson<ConstraintReference>("public/reference/constraints.json");
const lib = readJson<{ platforms: PlatformEntry[] }>("public/reference/platforms.json");
const published = {
  platforms: lib.platforms,
  transformerIndicativeRange: ref.constraints.find((c) => c.id === "transformer_capacity")?.lead_time_weeks ?? null,
};
const all = engineeringAssumptions(published);
const byId = (id: string) => all.find((a) => a.id === id)!;
const BANNED = /\b(best|#1|number one|world'?s|leading|leader|unrivalled|guarantee[sd]?|trusted by|certified)\b|state[- ]of[- ]the[- ]art|\b(usually|rarely|typically)\b/i;
const n = (v: number) => v.toLocaleString("en-IE");

describe("the typed source carries no figure of its own", () => {
  it("lib/engineering-constants.ts has no numeric literal beyond the unit conversions of a heat balance and a percentage", () => {
    const code = read("lib/engineering-constants.ts")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""');
    const literals = (code.match(/(?<![\w.$])\d+(?:\.\d+)?(?![\w])/g) ?? []).map(Number);
    const allowed = new Set([0, 1, 2, 3, 10, 60, 100]);
    expect(literals.filter((v) => !allowed.has(v))).toEqual([]);
  });

  it("the JSON has exactly the groups the engine test exercises, and states that it is a description of the engine", () => {
    expect(Object.keys(K).sort()).toEqual(
      ["cost_band_factor_by_class", "cost_basis_classes", "expired_quote_class", "firm_quote_without_validity_class", "hydraulic_flow", "heat_rejection", "note", "rack_feed", "schema", "transformer_lead_time"].sort()
    );
    expect(K.note).toMatch(/description of what the engine does, not a second source of it/);
    expect(K.note).toContain("tests/test_engineering_constants.py");
    expect(fs.existsSync(path.join(ROOT, "tests/test_engineering_constants.py"))).toBe(true);
  });
});

describe("the figures agree with the data the engine already publishes", () => {
  const pack = readJson<{ scenarios: any[] }>("public/reference/model_pack.json"); // eslint-disable-line @typescript-eslint/no-explicit-any
  const steps = pack.scenarios.flatMap((s) => (s.ladder ?? []) as any[]); // eslint-disable-line @typescript-eslint/no-explicit-any

  it("the trim-chiller step in the model pack is the JSON's lump, band, lead time and class", () => {
    const trim = steps.filter((s) => s.cost_key === "trim_chiller.adiabatic");
    expect(trim.length).toBeGreaterThan(0);
    const h = K.heat_rejection;
    for (const s of trim) {
      expect(s.capex_eur.value).toBe(h.trim_chiller_eur);
      expect(s.capex_eur.evidence).toBe(`${h.trim_chiller_class}_ASSUMPTION`);
      expect([s.capex_eur.low, s.capex_eur.high]).toEqual([h.trim_chiller_eur * K.cost_band_factor_by_class.E0[0], h.trim_chiller_eur * K.cost_band_factor_by_class.E0[1]]);
      expect(s.cost_basis).toBe("library_default");
      expect(s.cost_kind).toBe(h.trim_chiller_cost_kind);
      expect(s.lead_time_weeks.value).toBe(h.trim_chiller_lead_weeks);
      expect([s.lead_time_weeks.low, s.lead_time_weeks.high]).toEqual(h.trim_chiller_lead_band_weeks);
      expect(s.lead_time_weeks.evidence).toBe("E0_ASSUMPTION");
    }
  });

  it("the PUE the model pack states for each architecture is the JSON's", () => {
    const pue = K.heat_rejection.pue_by_architecture;
    const label = (v: { value: number; band: number[] }) => `PUE ${v.value} [${v.band[0]}–${v.band[1]}]`;
    const wanted = new Map(Object.entries(pue).map(([k, v]) => [k, label(v)]));
    let seen = 0;
    for (const s of pack.scenarios) {
      const w = wanted.get(s.architecture);
      if (!w) continue;
      const basis = (s.constraints as any[]).map((c) => c.basis as string).find((b) => /at PUE/.test(b)); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(basis, s.id).toContain(`at ${w}`);
      seen += 1;
    }
    expect(seen).toBeGreaterThan(2);
  });

  it("a transformer lead time in the model pack is labelled E0 whatever its value (the reference hall types the default's own 160)", () => {
    const tx = steps.filter((s) => s.constraint === "transformer_capacity" && s.lead_time_weeks);
    expect(tx.length).toBeGreaterThan(0);
    for (const s of tx) expect(s.lead_time_weeks.evidence).toBe("E0_ASSUMPTION");
    const dated = pack.scenarios.find((s) => s.time_to_power?.weeks_to_full === K.transformer_lead_time.default_weeks);
    expect(dated.time_to_power.date_basis).toBe("assumed");
  });

  it("the constraint reference prices the tap-off relief as a library default at E0, as the JSON says", () => {
    const c = ref.constraints.find((x) => x.id === "rack_feed_tapoff")!;
    expect(c.cost_basis?.basis).toBe("library_default");
    expect(c.cost_basis?.evidence.startsWith(K.rack_feed.relief_tapoff_class)).toBe(true);
  });

  it("every library platform's feed current the page quotes is the published one", () => {
    const a = byId("rack_feed_check");
    for (const p of lib.platforms.filter((x) => typeof x.rack_feed_current_A === "number")) expect(a.value).toContain(`${p.name}: ${n(p.rack_feed_current_A as number)} A`);
  });
});

describe("each statement says what the code does, with the engine's class", () => {
  it("the transformer default is a labelled E0 library placeholder, and a supplied or quoted lead time is not described as stronger", () => {
    const a = byId("transformer_lead_time");
    const t = K.transformer_lead_time;
    expect(a.value).toBe(`${n(t.default_weeks)} weeks, band ${n(t.default_band_weeks[0])}–${n(t.default_band_weeks[1])} weeks`);
    expect(a.classCode).toBe("E0");
    expect(a.evidenceClass).toBe("E0 (assumed)");
    expect(a.overriddenBy).toContain("stays class E0");
    expect(a.overriddenBy).toContain("neither a typed lead time nor a quotation raises a lead time above E0 today");
    expect(a.overriddenBy).toContain(`±${n(Math.round(t.supplied_band_fraction * 100))}%`);
    expect(a.overriddenBy).not.toMatch(/\bE[3-5]\b.{0,40}(lead time|quotation)|(lead time|quotation).{0,40}raised to E[3-5]/i);
    expect(a.appliesWhere).toMatch(/HV\/MV transformer bank/);
    expect(a.notes.join(" ")).toContain("assumed lead time, not a date");
    // the published catalogue range is named as a separate thing, with its own figures read from the published file
    const r = published.transformerIndicativeRange!;
    expect(a.notes.join(" ")).toContain(`${r.low}–${r.high} weeks`);
  });

  it("the tap-off check is a current comparison at the stated rating: no derating, and it says so plainly", () => {
    const a = byId("rack_feed_check");
    const r = K.rack_feed;
    expect(a.value).toContain("A current comparison, not a power formula");
    expect(a.value).toContain(`compared at 100% of the rating`);
    expect(a.value).toContain(`${n(r.library_feed_voltage_V)} V three-phase`);
    const all = [a.value, ...a.notes].join(" ");
    expect(all).toContain("No continuous-load derating factor is applied to the tap-off rating");
    expect(all).toContain("without a derating for continuous load, ambient temperature or grouping");
    expect(all).toContain("known open point");
    // the √3 x V x PF form is named where the code uses it: the busway, not the tap-off
    expect(all).toMatch(/Busway capacity per run is \(√3 for three-phase, 1 for single-phase\) × voltage × installed ampacity × that utilisation limit × the site power factor/);
    expect(all).toContain("It does not enter the tap-off check");
    expect(all).not.toMatch(/tap-off rating is derated|derated tap-off|derating factor of/i);
    // absent inputs are said to be assumed, supplied ones carry the engine's class
    expect(a.overriddenBy).toContain(`${n(r.installed_tapoff_default_A)} A tap-off`);
    expect(a.overriddenBy).toContain("both class E0");
    expect(a.overriddenBy).toContain(`class ${r.installed_tapoff_supplied_class} as supplied`);
  });

  it("hydraulic flow: the rack count is E0, the step is capped at E2, and a pump curve without pipework resistance is not given a stronger class", () => {
    const a = byId("hydraulic_flow");
    const h = K.hydraulic_flow;
    expect(a.evidenceClass).toContain("E0 (assumed) for the rack count");
    expect(a.evidenceClass).toContain(`capped at ${h.step_class_cap}`);
    expect(a.overriddenBy).toContain(`${h.pump_flow_supplied_class} as supplied`);
    expect(a.overriddenBy).toContain(`so the rack count is ${h.result_class} whatever the pumped-flow evidence is`);
    expect(a.notes.join(" ")).toContain("A pump curve without the pipework resistance does not establish how much flow the loop delivers");
    expect(a.notes.join(" ")).toContain("do not agree");
    // per-platform flows are computed from the published library, not typed
    for (const p of lib.platforms) {
      expect(a.value).toContain(`${p.name}: ${n(p.flow_l_per_min_per_rack)} l/min`);
      expect(a.value).toContain((p.flow_l_per_min_per_rack / p.rack_kW).toLocaleString("en-IE", { minimumFractionDigits: 3, maximumFractionDigits: 3 }));
    }
    expect(physicsFlowPerKW()).toBeCloseTo(1.436, 3);
    expect(impliedDeltaTK(0, 100)).toBe(0);
    expect(impliedDeltaTK(10, 0)).toBe(0);
  });

  it("the trim chiller is a flat E0 library lump, PUE is fixed per architecture, and a quotation changes the cost, not the PUE", () => {
    const a = byId("heat_rejection_and_pue");
    const x = K.heat_rejection;
    expect(a.classCode).toBe("E0");
    expect(a.evidenceClass).toContain("a library default");
    expect(a.value).toContain(`${n(x.trim_chiller_eur)} EUR per hall`);
    for (const v of Object.values(x.pue_by_architecture)) expect(a.value).toContain(v.value.toLocaleString("en-IE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    const notes = a.notes.join(" ");
    expect(notes).toContain("not scaled with hall size or with the heat it must reject");
    expect(notes).toContain("not recomputed for the site's climate");
    expect(a.overriddenBy).toContain("firm_quote");
    expect(a.overriddenBy).toContain(`class ${K.cost_basis_classes.firm_quote}`);
    expect(a.overriddenBy).toContain(`held at ${K.firm_quote_without_validity_class}`);
    expect(a.overriddenBy).toContain("an expired quotation is ignored");
    expect(a.overriddenBy).toContain("no intake field overrides the PUE");
    expect(a.appliesWhere).toContain("does not change the relief's price, lead time or the PUE");
    // the cost class is the engine's E0, not a stronger one
    expect(a.evidenceClass).not.toMatch(/E1 \(modelled\)/);
  });

  it("every statement, definition and note is free of superlatives and unsupported prevalence claims", () => {
    expect(ENGINEERING_ASSUMPTIONS_NOTE).not.toMatch(BANNED);
    for (const a of all) {
      for (const s of [a.title, a.headline, a.value, a.evidenceClass, a.appliesWhere, a.overriddenBy, ...a.notes, engineeringAssumptionDefinition(a)]) {
        expect(s, a.id).not.toMatch(BANNED);
        expect(s, a.id).not.toMatch(/undefined|null|NaN|\[object/);
      }
    }
  });
});

describe("definitions", () => {
  it("each assumption has one sentence that names it, its class, and what it is not; every figure in it is one the typed source states", () => {
    for (const a of all) {
      const d = engineeringAssumptionDefinition(a);
      expect(d.startsWith(a.title), a.id).toBe(true);
      expect(d, a.id).toContain(`class ${a.classCode}`);
      expect(d, a.id).toContain("not a measurement, a quotation or a market figure");
      expect(d.endsWith("."), a.id).toBe(true);
      expect(d.slice(0, -1).match(/\.\s+[A-Z]/g) ?? [], a.id).toEqual([]);
      for (const num of d.match(/\d[\d,.]*/g) ?? []) {
        if (/^E\d/.test(num)) continue;
        expect(`${a.headline} ${a.classCode}`, `${a.id}: ${num}`).toContain(num.replace(/[.,]$/, ""));
      }
    }
  });
});

describe("pages", () => {
  it("/reference has the section, with every assumption and its class, where it applies and what overrides it", async () => {
    const page = (await import("@/app/reference/page")).default;
    const html = renderToStaticMarkup(await page());
    const t = text(html);
    expect(t).toContain("Engineering assumptions the engine uses");
    expect(html).toContain('data-testid="engineering-assumptions"');
    for (const a of all) {
      expect(html, a.id).toContain(`data-assumption="${a.id}"`);
      expect(t, a.id).toContain(a.value);
      expect(t, a.id).toContain(a.evidenceClass);
      expect(t, a.id).toContain(a.appliesWhere);
      expect(t, a.id).toContain(a.overriddenBy);
    }
    expect(t).toContain("No continuous-load derating factor is applied to the tap-off rating");
  });

  it("each constraint page carries exactly its own assumptions, and the others carry none", async () => {
    const mod = await import("@/app/constraints/[slug]/page");
    for (const c of ref.constraints) {
      const html = renderToStaticMarkup(await mod.default({ params: Promise.resolve({ slug: c.slug }) } as never));
      const want = assumptionsForConstraint(c.id, published).map((a) => a.id);
      const got = [...html.matchAll(/data-assumption="([a-z_]+)"/g)].map((m) => m[1]);
      expect(got, c.slug).toEqual(want);
    }
    expect(["rack_feed_tapoff", "transformer_capacity", "hydraulic_flow", "tcs_supply_achievable"].every((id) => assumptionsForConstraint(id, published).length > 0)).toBe(true);
    const tap = ref.constraints.find((c) => c.id === "rack_feed_tapoff")!;
    const html = renderToStaticMarkup(await mod.default({ params: Promise.resolve({ slug: tap.slug }) } as never));
    expect(text(html)).toContain("without a derating for continuous load, ambient temperature or grouping");
  });

  it("/llms.txt states each assumption, from the same source", async () => {
    const { GET } = await import("@/app/llms.txt/route");
    const body = await (await GET()).text();
    expect(body).toContain("## Engineering assumptions the engine uses");
    for (const a of all) {
      expect(body, a.id).toContain(`- ${a.title}: ${a.value}`);
      expect(body, a.id).toContain(`Evidence class: ${a.evidenceClass}.`);
      expect(body, a.id).toContain(a.overriddenBy);
    }
  });
});

describe("a labelled engine assumption is never conflated with a reported market figure", () => {
  it("the register's transformer entry is unverified, is not shown, and says the engine's default is a separate labelled assumption", () => {
    const m = marketFigure("transformer-lead-time");
    expect(m.verification).toBe("unverified");
    expect(PUBLISHABLE_FIGURES.map((f) => f.id)).not.toContain("transformer-lead-time");
    expect(m.caveat).toContain(transformerDefaultIsNotMarketEvidence());
    expect(transformerDefaultIsNotMarketEvidence()).toContain(`${n(K.transformer_lead_time.default_weeks)} weeks`);
    expect(transformerDefaultIsNotMarketEvidence()).toContain(`class ${K.transformer_lead_time.default_class}`);
    expect(transformerDefaultIsNotMarketEvidence()).toContain("is a labelled library assumption");
    expect(transformerDefaultIsNotMarketEvidence()).toContain("is not derived from this reporting and is not supported by it");
  });

  it("no engine-assumption text cites a publisher or a press source, and no shown market figure states the engine's default as a market number", () => {
    const publishers = MARKET_EVIDENCE.map((f) => f.publisher).filter((p) => p && p !== "Not found");
    for (const a of all) {
      const s = [a.value, a.evidenceClass, a.appliesWhere, a.overriddenBy, ...a.notes].join(" ");
      for (const p of publishers) expect(s, `${a.id} cites ${p}`).not.toContain(p);
      expect(s, a.id).not.toMatch(/Wood Mackenzie|Data Center Knowledge/);
    }
    for (const f of PUBLISHABLE_FIGURES) expect(f.statement, f.id).not.toMatch(/transformer/i);
  });

  it("nothing outside the register renders the transformer market entry", () => {
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
        const p = path.join(d, e.name);
        return e.isDirectory() ? (["node_modules", ".next", ".git"].includes(e.name) ? [] : walk(p)) : /\.(ts|tsx)$/.test(e.name) ? [p] : [];
      });
    const users = ["app", "components", "lib"].flatMap((d) => walk(path.join(ROOT, d))).filter((f) => /transformer-lead-time/.test(fs.readFileSync(f, "utf8")));
    expect(users.map((f) => path.relative(ROOT, f))).toEqual(["lib/market-evidence.ts"]);
  });

  it("date-basis keeps the engine's lead-time source beside the class and never guesses one", () => {
    expect(formatLeadTime(160, "E0")).toBe("160 wk lead (E0, assumed)");
    expect(formatLeadTime(160, "E0", "library_placeholder")).toBe("160 wk lead (E0, assumed), library placeholder");
    expect(formatLeadTime(100, "E0", "customer_supplied_unverified")).toBe("100 wk lead (E0, assumed), customer-supplied (unverified)");
    expect(formatLeadTime(100, "E0", "something_else")).toBe("100 wk lead (E0, assumed)");
    expect(formatLeadTime(100, "E0", undefined)).toBe("100 wk lead (E0, assumed)");
    expect(leadTimeSourceLabel(null)).toBeNull();
    expect(leadTimeSourceLabel("toString")).toBeNull();
    for (const [k, v] of Object.entries(LEAD_TIME_SOURCE_LABELS)) expect(leadTimeSourceLabel(k)).toBe(v);
  });

  it("the source labels are the engine's own", () => {
    const py = read("gridforge/envelope/time_to_power.py");
    for (const [k, v] of Object.entries(LEAD_TIME_SOURCE_LABELS)) {
      expect(py).toContain(`"${v}"`);
      expect(py).toContain(`"${k}"`);
    }
  });
});
