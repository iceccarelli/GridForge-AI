// The single model every renderer draws (3D view, 2D fallback, text alternative, presenter). PURE: no clock, no randomness, no
// locale-dependent formatting, so the same scenario and outcome always give the same model, byte for byte.
//
// Binding stages are only ever read from the data: the stage that binds as found is the node flagged `binds` (or, if the data
// flags none, the node of the constraint flagged binding); the stage that binds after the plan is the node whose constraintKey
// equals the chosen outcome's `bindingAfterPlan`. If the data does not say, the answer is null, never a guess.

import type {
  EvidenceClass,
  ObservatoryScenario,
  PathNode,
  Quantity,
  RackRow,
  ScenarioOutcome,
  SceneModel,
} from "@/lib/observatory/types";

// ---------------------------------------------------------------------------------------------------------------------
// Formatting helpers (deterministic; shared with journey.ts)
// ---------------------------------------------------------------------------------------------------------------------

/** 12 -> "12", 12.5 -> "12.5", 1234567.891 -> "1,234,567.89". Never locale dependent. */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "n/a";
  const rounded = Math.round(n * 100) / 100;
  const [int, frac] = String(Math.abs(rounded)).split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return (rounded < 0 ? "-" : "") + grouped + (frac ? "." + frac : "");
}

/** "12 MW", or the reason it is missing. A missing value is never rendered as 0. */
export function formatQuantity(q: Quantity | null): string {
  if (q === null) return "no figure supplied";
  if (q.value === null) return q.missingReason ? `not supported by the inputs (${q.missingReason})` : "not supported by the inputs";
  const range =
    q.low !== null && q.high !== null && (q.low !== q.value || q.high !== q.value)
      ? `, range ${formatNumber(q.low)} to ${formatNumber(q.high)} ${q.unit}`
      : "";
  return `${formatNumber(q.value)} ${q.unit} (evidence ${q.evidence}${range})`;
}

const EVIDENCE_ORDER: EvidenceClass[] = ["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"];

/** The outcome shown: the requested one, else the scenario's headline, else the first; null only when there are none. */
export function resolveOutcome(scenario: ObservatoryScenario, outcomeId?: string): ScenarioOutcome | null {
  const byId = (id: string | undefined) => (id === undefined ? undefined : scenario.outcomes.find((o) => o.id === id));
  return byId(outcomeId) ?? byId(scenario.headlineOutcome) ?? scenario.outcomes[0] ?? null;
}

/** Every evidence class that appears anywhere in the scenario, in order E0..E7. */
export function evidenceClassesIn(scenario: ObservatoryScenario): EvidenceClass[] {
  const seen = new Set<EvidenceClass>();
  const add = (e: EvidenceClass | undefined | null) => {
    if (e && EVIDENCE_ORDER.includes(e)) seen.add(e);
  };
  for (const n of scenario.powerPath) {
    add(n.capacity.evidence);
    add(n.loadAsFound?.evidence);
    add(n.loadAfterPlan?.evidence);
  }
  for (const c of scenario.constraints) add(c.evidence);
  for (const o of scenario.outcomes) {
    add(o.evidence);
    add(o.itLoadKwAfterPlan.evidence);
    add(o.weeksToCapacity.evidence);
    add(o.capexEur.evidence);
  }
  return EVIDENCE_ORDER.filter((e) => seen.has(e));
}

/** The standing line on every frame; the evidence range is read from the scenario so it never claims more than the data carries. */
export function basisBannerFor(scenario: ObservatoryScenario): string {
  const classes = evidenceClassesIn(scenario);
  const range =
    classes.length === 0
      ? "evidence class not stated"
      : classes.length === 1
        ? `evidence ${classes[0]} as labelled`
        : `evidence ${classes[0]}–${classes[classes.length - 1]} as labelled`;
  return `Synthetic demonstration hall. Engine-modelled values (${range}), not measurements; calibration ledger empty.`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Binding stages
// ---------------------------------------------------------------------------------------------------------------------

export function bindingNodeAsFound(scenario: ObservatoryScenario): PathNode | null {
  const flagged = scenario.powerPath.find((n) => n.binds);
  if (flagged) return flagged;
  const constraint = scenario.constraints.find((c) => c.binds);
  if (constraint) return scenario.powerPath.find((n) => n.constraintKey === constraint.key) ?? null;
  return null;
}

export function bindingNodeAfterPlan(scenario: ObservatoryScenario, outcome: ScenarioOutcome | null): PathNode | null {
  const key = outcome?.bindingAfterPlan ?? null;
  if (key === null) return null;
  return scenario.powerPath.find((n) => n.constraintKey === key) ?? null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Text alternative
// ---------------------------------------------------------------------------------------------------------------------

function stageSentence(n: PathNode, index: number, asFound: PathNode | null, afterPlan: PathNode | null): string {
  const parts = [
    n.capacity.value === null
      ? `${index + 1}. ${n.label}: capacity ${formatQuantity(n.capacity)}`
      : `${index + 1}. ${n.label}: can carry ${formatQuantity(n.capacity)}`,
    `asked to carry ${formatQuantity(n.loadAsFound)} as found and ${formatQuantity(n.loadAfterPlan)} after the plan`,
  ];
  const marks: string[] = [];
  if (asFound && asFound.id === n.id) marks.push("this stage binds as found");
  if (afterPlan && afterPlan.id === n.id) marks.push("this stage binds after the plan");
  return parts.join("; ") + (marks.length ? `; ${marks.join(" and ")}` : "") + ".";
}

function rackRowSentence(r: RackRow): string {
  const kw = (v: number | null) => (v === null ? "not supported by the inputs" : `${formatNumber(v)} kW per rack`);
  return `${r.label}: ${formatNumber(r.racks)} racks; ${kw(r.kwPerRackAsFound)} as found, ${kw(r.kwPerRackAfterPlan)} after the plan.`;
}

function outcomeSentences(o: ScenarioOutcome): string[] {
  const out = [
    `Outcome shown: ${o.name}. Racks: ${formatNumber(o.racksAsFound)} as found, ${formatNumber(o.racksAfterPlan)} after the plan; IT load after the plan ${formatQuantity(o.itLoadKwAfterPlan)}.`,
  ];
  out.push(
    o.dated && o.weeksToCapacity.value !== null
      ? `Time to full capacity: ${formatNumber(o.weeksToCapacity.value)} weeks, from supplied lead times (evidence ${o.weeksToCapacity.evidence}).`
      : `Time to full capacity: not dated${o.weeksToCapacity.missingReason ? ` (${o.weeksToCapacity.missingReason})` : ", because the lead times are assumed or missing"}; no date is given.`,
  );
  out.push(
    o.capexEur.value === null
      ? `Capital cost: not priced${o.capexEur.missingReason ? ` (${o.capexEur.missingReason})` : ""}.`
      : `Capital cost: ${formatQuantity(o.capexEur)}${o.unpricedComponents.length ? ", which is not a complete price" : ""}.`,
  );
  if (o.unpricedComponents.length) out.push(`Unpriced components the capital cost omits: ${o.unpricedComponents.join(", ")}.`);
  out.push(`Evidence class for this outcome: ${o.evidence}.`);
  return out;
}

export function textAlternativeFor(
  scenario: ObservatoryScenario,
  outcome: ScenarioOutcome | null,
  asFound: PathNode | null,
  afterPlan: PathNode | null,
): string {
  const h = scenario.hall;
  const lines: string[] = [];
  lines.push(
    `${scenario.title}. Synthetic demonstration hall "${h.name}" (${h.platform}): ${formatNumber(h.contractedMW)} MW contracted, ${formatNumber(h.currentItLoadMW)} MW IT load today, ${formatNumber(h.positionsAvailable)} rack positions available.`,
  );
  lines.push(`Power path, from the utility connection to the racks, ${scenario.powerPath.length} stage${scenario.powerPath.length === 1 ? "" : "s"}:`);
  scenario.powerPath.forEach((n, i) => lines.push(stageSentence(n, i, asFound, afterPlan)));
  lines.push(
    asFound
      ? `Binding stage as found: ${asFound.label}.`
      : "Binding stage as found: the engine output does not identify one, so none is named.",
  );
  if (outcome) {
    lines.push(
      afterPlan
        ? `Binding stage after the plan: ${afterPlan.label}.`
        : "Binding stage after the plan: the engine output does not identify one, so none is named.",
    );
  }
  if (scenario.rackRows.length) {
    lines.push("Racks:");
    for (const r of scenario.rackRows) lines.push(rackRowSentence(r));
  } else {
    lines.push("Racks: no rack rows are given.");
  }
  if (outcome) lines.push(...outcomeSentences(outcome));
  else lines.push("No outcome is given for this hall.");
  lines.push("Modelled from invented inputs, not measured. The calibration ledger is empty.");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------------------------------------------------

export function buildSceneModel(scenario: ObservatoryScenario, outcomeId?: string): SceneModel {
  const outcome = resolveOutcome(scenario, outcomeId);
  const asFound = bindingNodeAsFound(scenario);
  const afterPlan = bindingNodeAfterPlan(scenario, outcome);
  return {
    scenarioId: scenario.id,
    outcomeId: outcome ? outcome.id : "",
    nodes: scenario.powerPath.map((n) => ({ ...n })),
    rackRows: scenario.rackRows.map((r) => ({ ...r })),
    bindingAsFound: asFound ? asFound.id : null,
    bindingAfterPlan: afterPlan ? afterPlan.id : null,
    textAlternative: textAlternativeFor(scenario, outcome, asFound, afterPlan),
    basisBanner: basisBannerFor(scenario),
  };
}
