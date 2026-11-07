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
  constraints?: { id: string; domain: string }[];
  after_ladder: { racks: number; it_load_kW?: Figure };
  economics?: { decision_grade?: boolean; cost_basis_mix?: Record<string, { label?: string }> };
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

export interface WorkedResult {
  hallLabel: string;
  platform: string;
  asFoundRacks: number;
  firstLimit: string;
  /** "electrical" or "thermal", from the constraint record the file carries for the first limit. */
  firstLimitDomain: string;
  /** The rated amps of the installed tap-offs, when the first limit's basis states them ("installed tap-offs rated 63 A"). */
  tapoffAmps: number | null;
  afterLadderRacks: number;
  afterLadderArchitecture: string;
  onSiteSupplyRacks: number;
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
    firstLimitDomain: need(grid.constraints?.find((c) => c.id === grid.as_found.binding)?.domain, `the domain of the first limit "${grid.as_found.binding}"`),
    tapoffAmps: (() => {
      const m = /tap-offs? rated (\d+) A/.exec(grid.as_found.basis ?? "");
      return m ? Number(m[1]) : null;
    })(),
    afterLadderRacks: grid.after_ladder.racks,
    afterLadderArchitecture: ARCHITECTURE_WORDS[grid.architecture] ?? grid.name,
    onSiteSupplyRacks: btm.after_ladder.racks,
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

/** The panel's sentences, in reading order. The component renders exactly these, and the test compares them with the JSON. */
export function workedResultLines(w: WorkedResult): { label: string; text: string }[] {
  return [
    { label: "As found", text: `${racks(w.asFoundRacks)} of ${w.platform}. First limit: ${w.firstLimit}.` },
    { label: "After the relief ladder", text: `${racks(w.afterLadderRacks)} (${w.afterLadderArchitecture}).` },
    { label: "With on-site supply", text: `${racks(w.onSiteSupplyRacks)}.` },
  ];
}

export function workedResultEvidenceLine(w: WorkedResult): string {
  return `Evidence class ${w.evidenceCode} (${w.evidenceVerb}): the weakest input sets the class. ${w.decisionGrade ? "Decision-grade." : "Planning-grade, not decision-grade."} Rung costs here: ${w.costBasis}.`;
}

/**
 * The true statement that replaces "most halls fail on ...": it is about OUR synthetic reference hall only, says nothing about other
 * halls, and says "not cooling" only when the file's own record puts the first limit outside the thermal domain.
 */
export function referenceLimitSentence(w: WorkedResult): string {
  const amps = w.tapoffAmps !== null ? ` (${w.tapoffAmps} A tap-offs)` : "";
  const notCooling = w.firstLimitDomain !== "thermal" ? `, ${w.firstLimitDomain === "electrical" ? "an electrical limit" : "a " + w.firstLimitDomain + " limit"}, not cooling` : "";
  return `In our synthetic reference hall the first limit is the ${w.firstLimit.toLowerCase()}${amps}${notCooling}.`;
}
