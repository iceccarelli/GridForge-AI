// The worked result on the home page's first screen, read from the committed ENGINE OUTPUT and never typed.
//
// public/reference/model_pack.json is what the engine produced for the synthetic reference hall (REF-EU-01/DH-02, an invented hall; the file
// says so in its own `notice`). Every figure and label the panel shows comes from that file:
//   - as found and first limit: the "full_dlc" scenario's as_found (racks and the binding constraint's name);
//   - after the relief ladder: the same scenario's after_ladder racks, described by the scenario's own architecture;
//   - with on-site supply: the "full_dlc_btm" scenario's after_ladder racks;
//   - the evidence class: the WEAKEST class on the headline figure (deployable IT load) across the scenarios shown, worded by
//     lib/evidence-classes.ts (which tests/site/evidence-pages.test.ts holds to the engine);
//   - "planning-grade, not decision-grade": the file's own economics.decision_grade flag;
//   - what the ladder's costs are: the file's own cost_basis_mix label.
// If the file is missing or does not have what the panel needs, this THROWS, so the build fails instead of a first screen that silently
// shows a different hall or nothing. tests/site/worked-result.test.ts re-reads the JSON independently and fails if the rendered text
// disagrees with it.

import fs from "node:fs";
import path from "node:path";
import { EVIDENCE_CLASSES } from "@/lib/evidence-classes";

interface Figure { evidence?: string }
interface PackScenario {
  id: string;
  name: string;
  architecture: string;
  as_found: { racks: number; binding: string; binding_name: string; basis?: string };
  ladder?: { taken?: boolean }[];
  after_ladder: { racks: number; it_load_kW?: Figure };
  economics?: { decision_grade?: boolean; cost_basis_mix?: Record<string, { label?: string }>; capex_total_eur?: { low?: number | null; high?: number | null } | null };
  time_to_power?: { date_record?: { date_interval_weeks?: { low?: number; high?: number }; evidence_class?: string | null } };
}
export interface ModelPack {
  synthetic?: boolean;
  notice?: string;
  intake?: { document?: { compute?: { platform?: string } } };
  scenarios: PackScenario[];
}

/** How an architecture id reads in a sentence. The id comes from the file; this only words it. */
const ARCHITECTURE_WORDS: Record<string, string> = {
  full_dlc: "full direct liquid cooling",
  hybrid_dlc: "hybrid direct liquid cooling",
  rdhx: "rear-door heat exchangers",
  retained_air: "retained air cooling",
};

/** What it takes to reach a scenario's rack count, from the same scenario record: steps taken, total capex interval, time interval. */
export interface ScenarioDetail {
  steps: number;
  capexLowEur: number;
  capexHighEur: number;
  weeksLow: number;
  weeksHigh: number;
}

function detailOf(s: PackScenario): ScenarioDetail {
  const capex = need(s.economics?.capex_total_eur, `economics.capex_total_eur on scenario "${s.id}"`);
  const iv = need(s.time_to_power?.date_record?.date_interval_weeks, `time_to_power.date_record.date_interval_weeks on scenario "${s.id}"`);
  return {
    steps: need(s.ladder, `ladder on scenario "${s.id}"`).filter((l) => l.taken).length,
    capexLowEur: need(capex.low, `capex low on scenario "${s.id}"`),
    capexHighEur: need(capex.high, `capex high on scenario "${s.id}"`),
    weeksLow: need(iv.low, `date interval low on scenario "${s.id}"`),
    weeksHigh: need(iv.high, `date interval high on scenario "${s.id}"`),
  };
}

export interface WorkedResult {
  hallLabel: string;
  platform: string;
  asFoundRacks: number;
  firstLimit: string;
  /** The evidence class the file gives the per-rack current the platform needs, when the first limit is the rack feed ("platform needs 205 A (E0) per rack"). */
  firstLimitInputClass: string | null;
  afterLadderRacks: number;
  afterLadderArchitecture: string;
  afterLadderDetail: ScenarioDetail;
  onSiteSupplyRacks: number;
  onSiteSupplyDetail: ScenarioDetail;
  evidenceCode: string;
  evidenceVerb: string;
  decisionGrade: boolean;
  costBasis: string;
}

function need<T>(v: T | undefined | null, what: string): T {
  if (v === undefined || v === null) throw new Error(`public/reference/model_pack.json has no ${what}; the home page's worked result cannot be built`);
  return v;
}

export function buildWorkedResult(pack: ModelPack, platformName?: string): WorkedResult {
  if (pack.synthetic !== true) throw new Error("model_pack.json is not marked synthetic; the home page only shows a synthetic reference hall");
  const find = (id: string) => need(pack.scenarios.find((s) => s.id === id), `scenario "${id}"`);
  const grid = find("full_dlc");
  const btm = find("full_dlc_btm");
  const classes = [grid, btm].map((s) => {
    const m = /^E(\d)/.exec(need(s.after_ladder.it_load_kW?.evidence, `deployable-load evidence on scenario "${s.id}"`));
    return Number(need(m, `a parsable evidence class on scenario "${s.id}"`)[1]);
  });
  const code = `E${Math.min(...classes)}`;
  const doc = EVIDENCE_CLASSES.find((c) => c.code === code);
  const mix = Object.values(need(grid.economics?.cost_basis_mix, `cost_basis_mix on scenario "${grid.id}"`));
  const labels = [...new Set(mix.map((m) => m.label).filter((l): l is string => Boolean(l)))];
  return {
    hallLabel: "Synthetic reference hall — not a customer site",
    platform: platformName ?? need(pack.intake?.document?.compute?.platform, "compute platform"),
    asFoundRacks: grid.as_found.racks,
    firstLimit: need(grid.as_found.binding_name, "binding constraint name"),
    firstLimitInputClass: (() => {
      // The file states the platform's per-rack current and its class in the first limit's basis ("platform needs 205 [174–236] A (E0) per rack").
      // For the rack feed that is the figure the limit rests on, so the build THROWS if it is not there rather than dropping the caveat.
      if (grid.as_found.binding !== "rack_feed_tapoff") return null;
      const m = /platform needs [^()]*?\bA \((E\d)\) per rack/.exec(grid.as_found.basis ?? "");
      return need(m?.[1], `the per-rack current and its evidence class in the basis of the rack-feed limit on scenario "${grid.id}"`);
    })(),
    afterLadderRacks: grid.after_ladder.racks,
    afterLadderArchitecture: ARCHITECTURE_WORDS[grid.architecture] ?? grid.name,
    afterLadderDetail: detailOf(grid),
    onSiteSupplyRacks: btm.after_ladder.racks,
    onSiteSupplyDetail: detailOf(btm),
    evidenceCode: code,
    evidenceVerb: need(doc, `a known evidence class ${code}`).verb,
    decisionGrade: need(grid.economics?.decision_grade, `economics.decision_grade on scenario "${grid.id}"`),
    costBasis: labels.length ? labels.join("; ") : "not stated in the file",
  };
}

/** Reads the committed files. Synchronous on purpose: the home page is a static page and this runs once, at build. */
export function loadWorkedResult(root: string = process.cwd()): WorkedResult {
  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  const pack = read("public/reference/model_pack.json") as ModelPack;
  let platformName: string | undefined;
  try {
    const id = pack.intake?.document?.compute?.platform;
    platformName = (read("public/reference/platforms.json") as { platforms: { id: string; name: string }[] }).platforms.find((p) => p.id === id)?.name;
  } catch {
    platformName = undefined;
  }
  return buildWorkedResult(pack, platformName);
}

const racks = (n: number) => `${n} ${n === 1 ? "rack" : "racks"}`;
const eurM = (n: number) => `€${(n / 1_000_000).toFixed(1)}M`;

/** "<n> relief steps · capex <low>–<high> · <weeks> weeks to full capacity · assumed (E0)": the cost and time behind a rack count, all from the file. */
export function scenarioDetailLine(d: ScenarioDetail, evidenceCode: string): string {
  return `${d.steps} relief ${d.steps === 1 ? "step" : "steps"} · capex ${eurM(d.capexLowEur)}–${eurM(d.capexHighEur)} · ${d.weeksLow}–${d.weeksHigh} weeks to full capacity · assumed (${evidenceCode})`;
}

/** The panel's sentences, in reading order. The component renders exactly these, and the test compares them with the JSON. */
export function workedResultLines(w: WorkedResult): { label: string; text: string; detail?: string }[] {
  return [
    { label: "As found", text: `${racks(w.asFoundRacks)} of ${w.platform}. First limit: ${w.firstLimit}.` },
    { label: "After the relief ladder", text: `${racks(w.afterLadderRacks)} (${w.afterLadderArchitecture}).`, detail: scenarioDetailLine(w.afterLadderDetail, w.evidenceCode) },
    { label: "With on-site supply", text: `${racks(w.onSiteSupplyRacks)}.`, detail: scenarioDetailLine(w.onSiteSupplyDetail, w.evidenceCode) },
  ];
}

export function workedResultEvidenceLine(w: WorkedResult): string {
  return `Class ${w.evidenceCode} (${w.evidenceVerb}): the weakest input sets it; counts are point values. ${w.decisionGrade ? "Decision-grade." : "Planning-grade, not decision-grade."} Costs: ${w.costBasis}.`;
}

/**
 * The statement that replaces "most halls fail on ...": it is about OUR synthetic reference hall only and generalises to no other. When the
 * first limit is the rack feed it says what the limit rests on, from the file: a per-rack current the platform library assumes.
 */
export function referenceLimitSentence(w: WorkedResult): string {
  const doc = w.firstLimitInputClass ? EVIDENCE_CLASSES.find((c) => c.code === w.firstLimitInputClass) : undefined;
  const verb = doc?.verb ?? "unclassified";
  const basis = w.firstLimitInputClass ? `, on ${/^[aeiou]/i.test(verb) ? "an" : "a"} ${verb} per-rack current (${w.firstLimitInputClass})` : "";
  return `In our synthetic reference hall the first limit is the ${w.firstLimit.toLowerCase()}${basis}.`;
}

/** The trust line for the first screen, from the committed calibration record: how many reconciled observations back the engine's accuracy. */
export function loadCalibration(root: string = process.cwd()): { observations: number; sites: number } {
  const c = JSON.parse(fs.readFileSync(path.join(root, "public/reference/calibration.json"), "utf8")) as { observations?: number; sites?: number };
  return { observations: need(c.observations, "calibration observations"), sites: need(c.sites, "calibration sites") };
}

export function calibrationLine(c: { observations: number; sites: number }): string {
  return c.observations === 0
    ? "Pilot-stage and founder-led. The calibration ledger is empty: 0 reconciled observations, so no accuracy is claimed."
    : `Pilot-stage and founder-led. The calibration ledger holds ${c.observations} reconciled observations across ${c.sites} sites.`;
}
