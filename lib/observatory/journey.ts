// The deterministic presenter journey: a pure function of the scenario file, and frameAt a pure function of time over the steps.
// No clock, no randomness, no locale: the same file always gives the same steps, the same t always gives the same frame.
//
// The tour (about three and a half to four minutes for three halls):
//   overview of the halls -> hall 1 power path -> hall 1 binding stage -> hall 1 constraints ranking -> hall 1 plan and outcomes
//   -> the context panel (its provenance spoken) -> hall 2 -> hall 3 -> close with the free qualifier as the next step.
// Every caption is the single source for the on-screen text and the WebVTT track (captions.ts). Captions state the basis where
// numbers appear, say "not dated" wherever the file says an outcome is not dated (or that nothing deploys, so there is nothing to
// date), never name a city for a hall, never call a constraint the engine reports no finite limit for "unlimited", and never
// sell anything.

import { formatNumber, bindingNodeAfterPlan, bindingNodeAsFound, resolveOutcome } from "@/lib/observatory/scene-model";
import type {
  ConstraintResult,
  JourneyFrame,
  JourneyStep,
  ObservatoryScenario,
  PathNode,
  ScenarioFile,
  ScenarioOutcome,
} from "@/lib/observatory/types";

/** At most this many halls are toured. */
export const MAX_HALLS = 3;

/** Reading pace used to make sure a caption stays up long enough to read: words per second, plus a fixed settle time. */
const WORDS_PER_SECOND = 3; // 180 words a minute, the usual ceiling for on-screen captions
const SETTLE_SECONDS = 3;

const wordCount = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Whole seconds: the longer of the planned beat and the time needed to read the caption. */
export function durationFor(plannedSec: number, caption: string): number {
  return Math.max(plannedSec, Math.ceil(wordCount(caption) / WORDS_PER_SECOND) + SETTLE_SECONDS);
}

const NUMBER_WORDS = ["No", "One", "Two", "Three"];

function listOf(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return items.slice(0, -1).join(", ") + " and " + items[items.length - 1];
}

/** Ends a sentence once, whatever punctuation the source text already ends with. */
function sentence(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : t + ".";
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the data without guessing. The contract v2 fields (passes, capexComplete, capexPricing) are read defensively so a
// run over an older file degrades to the v1 meaning instead of inventing one.
// ---------------------------------------------------------------------------------------------------------------------

type OutcomeV2 = ScenarioOutcome & { capexComplete?: boolean; capexPricing?: "placeholder" | "partly_supplied" | "supplied" | "none" };

/** True when the engine reports NO finite limit for this constraint: it does not limit the hall. */
export function constraintPasses(c: ConstraintResult): boolean {
  const p = (c as ConstraintResult & { passes?: unknown }).passes;
  return typeof p === "boolean" ? p : c.racksAllowed === null;
}

/** A hall or scenario name without any "— City" suffix: a caption never names a place for an invented hall. */
export function placeFreeName(name: string): string {
  return name.replace(/\s+[—–]\s+.*$/, "").trim();
}

/** A stage label without its trailing explanatory parenthesis ("Rack feed / tap-off (current per rack)" -> "Rack feed / tap-off"). */
function plainLabel(label: string): string {
  return label.replace(/\s*\([^)]*\)\s*$/, "").trim() || label;
}

/**
 * The supply constraint is named by the engine "Firm supply (grid import + behind-the-meter)" even in grid-only options. Name it
 * as the option states it: behind-the-meter is only spoken when the option itself says so.
 */
export function shownConstraintName(name: string, outcome?: ScenarioOutcome | null): string {
  if (!/behind-the-meter/i.test(name)) return name;
  if (outcome && /behind-the-meter|\bbtm\b/i.test(outcome.name)) return name;
  return name.replace(/\s*\+\s*behind-the-meter/i, "");
}

/** Constraints that give a finite limit, tightest first, ties by key. Constraints that pass are not in the ranking. */
function rankedConstraints(sc: ObservatoryScenario): ConstraintResult[] {
  return sc.constraints
    .filter((c) => !constraintPasses(c) && c.racksAllowed !== null)
    .sort((a, b) => (a.racksAllowed as number) - (b.racksAllowed as number) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function constraintByKey(sc: ObservatoryScenario, key: string | null): ConstraintResult | null {
  return key === null ? null : (sc.constraints.find((c) => c.key === key) ?? null);
}

function timeSentence(o: ScenarioOutcome): string {
  return o.dated && o.weeksToCapacity.value !== null
    ? `Programme time is ${formatNumber(o.weeksToCapacity.value)} weeks, from supplied lead times.`
    : "Not dated: the lead times are assumed or missing.";
}

function afterPlanSentence(sc: ObservatoryScenario, o: ScenarioOutcome): string {
  const key = o.bindingAfterPlan;
  const c = constraintByKey(sc, key);
  if (c && constraintPasses(c)) return `After the plan the engine names ${shownConstraintName(c.name, o)}, though it reports no finite limit for it.`;
  if (c) return `After the plan the limit is ${shownConstraintName(c.name, o)}.`;
  // A key this scenario has no constraint for is reported as the engine gave it; nothing is invented to explain it.
  if (key !== null) return `After the plan the engine names "${key}" as the limit, which this view does not model.`;
  return "The engine output does not say what limits the hall after the plan.";
}

/** "6.6 million euros" / "480 thousand euros". With `floor` it rounds DOWN so "at least" stays true. Null when there is nothing to say. */
function euroWords(v: number, floor: boolean): string | null {
  if (!Number.isFinite(v) || v <= 0) return null;
  const r = (x: number, k: number) => (floor ? Math.floor(x * k) / k : Math.round(x * k) / k);
  if (v >= 1_000_000) return `${r(v / 1_000_000, 10)} million euros`;
  if (v >= 1000) return `${r(v / 1000, 1)} thousand euros`;
  return "less than a thousand euros";
}

const NO_CAPEX = "No capital cost is given, because the inputs carry no prices.";

/** A partial capital cost is "at least", priced lines only, and says what kind of prices stand behind it. */
export function capexSentence(o: ScenarioOutcome): string {
  const v2 = o as OutcomeV2;
  if (v2.capexPricing === "none" || o.capexEur.value === null) return NO_CAPEX;
  const partial = o.unpricedComponents.length > 0 || v2.capexComplete === false;
  const amount = euroWords(o.capexEur.value, partial);
  if (amount === null) return NO_CAPEX;
  const basis =
    v2.capexPricing === "placeholder"
      ? "library placeholder prices"
      : v2.capexPricing === "partly_supplied"
        ? "partly supplied prices"
        : v2.capexPricing === "supplied"
          ? "supplied prices"
          : "";
  return partial
    ? `Modelled capital cost at least ${amount}, priced lines only${basis ? `, at ${basis}` : ""}.`
    : `Modelled capital cost ${amount}${basis ? `, at ${basis}` : ""}.`;
}

function outcomeCaption(sc: ObservatoryScenario, o: ScenarioOutcome, lead: string): string {
  const platform = sc.hall.platform;
  const hall = placeFreeName(sc.hall.name);
  if (o.racksAfterPlan === 0) {
    // Nothing deploys: there is nothing to date, which is a different statement from "the lead times are assumed".
    return (
      `${lead} ${o.name} adds no new ${platform} racks in ${hall} after the plan (${formatNumber(o.racksAsFound)} as found), so nothing deploys and there is nothing to date. ` +
      `${afterPlanSentence(sc, o)} Engine-modelled, evidence ${o.evidence}.`
    ).replace(/\s+/g, " ");
  }
  return (
    `${lead} ${o.name}: ${formatNumber(o.racksAfterPlan)} new ${platform} racks after the plan, ${formatNumber(o.racksAsFound)} as found; existing racks are separate. ` +
    `${afterPlanSentence(sc, o)} ${timeSentence(o)} ${capexSentence(o)} Engine-modelled, evidence ${o.evidence}.`
  ).replace(/\s+/g, " ");
}

/** The stage count is computed from the nodes and says what the path is: power and cooling stages, some perhaps not modelled. */
function pathCaption(sc: ObservatoryScenario, n: number): string {
  const nodes: PathNode[] = sc.powerPath;
  const cooling = nodes.filter((x) => x.kind === "cooling").length;
  const unmodelled = nodes.filter((x) => x.constraintKey === null).map((x) => plainLabel(x.label));
  const count =
    nodes.length === 0
      ? "no stages of the power and cooling path are given"
      : `${nodes.length} stage${nodes.length === 1 ? "" : "s"} of the power and cooling path (${nodes.length - cooling} power, ${cooling} cooling)` +
        (unmodelled.length ? `; the engine does not model ${listOf(unmodelled)}` : "");
  return (
    `Hall ${n}, ${placeFreeName(sc.hall.name)}: ${count}. ` +
    `${formatNumber(sc.hall.contractedMW)} MW contracted and ${formatNumber(sc.hall.currentItLoadMW)} MW of IT load today. Invented inputs, engine-modelled.`
  );
}

function bindingDetail(sc: ObservatoryScenario, node: PathNode): string {
  const c = constraintByKey(sc, node.constraintKey) ?? sc.constraints.find((x) => x.binds) ?? null;
  if (c && !constraintPasses(c) && c.racksAllowed !== null) return `On its own it allows ${formatNumber(c.racksAllowed)} new racks (evidence ${c.evidence})`;
  if (c) return "The engine reports no finite limit for it";
  return "The engine output gives no rack count for it";
}

function constraintsCaption(sc: ObservatoryScenario): string {
  if (sc.constraints.length === 0) return "The engine output lists no constraints for this hall, so there is no ranking to show.";
  const top = rankedConstraints(sc).slice(0, 3);
  const limit = sc.constraints.find((c) => c.binds && !constraintPasses(c)) ?? null;
  const passing = sc.constraints.filter(constraintPasses);
  const parts: string[] = [];
  if (top.length) {
    parts.push(
      `Ranked by the new racks each allows as found (evidence class in brackets): ${listOf(top.map((c) => `${shownConstraintName(c.name)} ${formatNumber(c.racksAllowed as number)} (${c.evidence})`))}.`,
    );
    parts.push(limit ? `The limit is ${shownConstraintName(limit.name)}.` : "The engine output names no single limit.");
  } else {
    parts.push("No constraint gives a finite rack limit as found.");
  }
  if (passing.length) {
    parts.push(
      passing.length <= 2
        ? `${listOf(passing.map((c) => shownConstraintName(c.name)))} ${passing.length === 1 ? "does" : "do"} not limit the hall (${passing.length === 1 ? "passes" : "pass"}).`
        : `${passing.length} other constraints do not limit the hall (they pass).`,
    );
  }
  return parts.join(" ");
}

export function buildJourney(file: ScenarioFile): JourneyStep[] {
  const halls = file.scenarios.slice(0, MAX_HALLS);
  const steps: JourneyStep[] = [];
  const push = (s: Omit<JourneyStep, "durationSec"> & { plannedSec: number }) => {
    const { plannedSec, ...rest } = s;
    steps.push({ ...rest, durationSec: durationFor(plannedSec, rest.caption) });
  };

  if (halls.length === 0) {
    push({
      id: "overview",
      plannedSec: 8,
      scenarioId: "",
      outcomeId: "",
      focus: null,
      panel: "outcomes",
      caption: "No demonstration halls are available in this build, so there is nothing to tour.",
    });
    return steps;
  }

  const first = halls[0];
  const outcomeIdOf = (sc: ObservatoryScenario) => resolveOutcome(sc)?.id ?? "";

  // 1. Overview
  push({
    id: "overview",
    plannedSec: 16,
    scenarioId: first.id,
    outcomeId: outcomeIdOf(first),
    focus: null,
    panel: "outcomes",
    caption:
      `${NUMBER_WORDS[halls.length]} synthetic demonstration hall${halls.length === 1 ? "" : "s"}, modelled by the GridForge engine from invented inputs: ${listOf(halls.map((h) => placeFreeName(h.title)))}. ` +
      "None is a customer's hall and nothing here is measured.",
  });

  // 2-5. Hall 1: path, binding stage, constraints, plan and outcomes
  const o1 = resolveOutcome(first);
  const bind1 = bindingNodeAsFound(first);
  push({
    id: "hall-1-path",
    plannedSec: 18,
    scenarioId: first.id,
    outcomeId: outcomeIdOf(first),
    focus: null,
    panel: "path",
    caption: pathCaption(first, 1),
  });
  push({
    id: "hall-1-binding",
    plannedSec: 18,
    scenarioId: first.id,
    outcomeId: outcomeIdOf(first),
    focus: bind1 ? bind1.id : null,
    panel: "path",
    caption: bind1
      ? `${plainLabel(bind1.label)} is the stage that binds as found. ${sentence(bindingDetail(first, bind1))} Engine-modelled, not measured.`
      : "The engine output does not identify which stage binds as found, so none is highlighted. Nothing is guessed.",
  });

  const bindingConstraint = first.constraints.find((c) => c.binds) ?? null;
  push({
    id: "hall-1-constraints",
    plannedSec: 20,
    scenarioId: first.id,
    outcomeId: outcomeIdOf(first),
    focus: bindingConstraint ? bindingConstraint.key : null,
    panel: "constraints",
    caption: constraintsCaption(first),
  });

  if (o1) {
    push({
      id: "hall-1-plan",
      plannedSec: 24,
      scenarioId: first.id,
      outcomeId: o1.id,
      focus: bindingNodeAfterPlan(first, o1)?.id ?? null,
      panel: "outcomes",
      caption: outcomeCaption(first, o1, "The plan:"),
    });
    const alt = first.outcomes.find((o) => o.id !== o1.id);
    if (alt) {
      push({
        id: "hall-1-alternative",
        plannedSec: 18,
        scenarioId: first.id,
        outcomeId: alt.id,
        focus: bindingNodeAfterPlan(first, alt)?.id ?? null,
        panel: "outcomes",
        caption: outcomeCaption(first, alt, "The alternative compared:"),
      });
    }
  } else {
    push({
      id: "hall-1-plan",
      plannedSec: 10,
      scenarioId: first.id,
      outcomeId: "",
      focus: null,
      panel: "outcomes",
      caption: "The engine output gives no plan or outcome for this hall, so none is shown.",
    });
  }

  // 6. Context panel: provenance spoken. The caption describes what KIND of values these are; it carries no figure that could age,
  // and it does not say "now" or "this hour": the journey is recorded and replayed, so it cannot claim a moment.
  push({
    id: "context",
    plannedSec: 22,
    scenarioId: first.id,
    outcomeId: outcomeIdOf(first),
    focus: null,
    panel: "context",
    caption:
      "Beside the halls: a day-ahead auction price for an hour in Germany's market, a published result, not a live reading. " +
      "The grid mix carries its own timestamp, queue figures are current only as of their report dates, and none of it is where these halls are.",
  });

  // 7-8. Halls 2 and 3
  halls.slice(1).forEach((sc, i) => {
    const n = i + 2;
    const bind = bindingNodeAsFound(sc);
    const o = resolveOutcome(sc);
    const c = bind ? (constraintByKey(sc, bind.constraintKey) ?? sc.constraints.find((x) => x.binds) ?? null) : null;
    const allowing =
      c && !constraintPasses(c) && c.racksAllowed !== null ? `, allowing ${formatNumber(c.racksAllowed)} new racks (evidence ${c.evidence})` : "";
    push({
      id: `hall-${n}-path`,
      plannedSec: 16,
      scenarioId: sc.id,
      outcomeId: outcomeIdOf(sc),
      focus: bind ? bind.id : null,
      panel: "path",
      caption: bind
        ? `Hall ${n}, ${placeFreeName(sc.hall.name)}: the stage that binds as found is ${plainLabel(bind.label)}${allowing}. Invented inputs, engine-modelled.`
        : `Hall ${n}, ${placeFreeName(sc.hall.name)}: the engine output does not identify which stage binds as found, so none is highlighted. Invented inputs, engine-modelled.`,
    });
    push({
      id: `hall-${n}-outcome`,
      plannedSec: 18,
      scenarioId: sc.id,
      outcomeId: o ? o.id : "",
      focus: o ? (bindingNodeAfterPlan(sc, o)?.id ?? null) : null,
      panel: "outcomes",
      caption: o ? outcomeCaption(sc, o, "The plan:") : "The engine output gives no plan or outcome for this hall, so none is shown.",
    });
  });

  // 9. Close: the free qualifier as the next step, caption only.
  const last = halls[halls.length - 1];
  push({
    id: "close",
    plannedSec: 16,
    scenarioId: last.id,
    outcomeId: outcomeIdOf(last),
    focus: null,
    panel: "outcomes",
    caption:
      "These halls are synthetic. For your own hall, the next step is the free capacity qualifier, which shows the binding constraint and the rack count for your figures.",
  });

  return steps;
}

export function totalDuration(steps: JourneyStep[]): number {
  let t = 0;
  for (const s of steps) t += Number.isFinite(s.durationSec) && s.durationSec > 0 ? s.durationSec : 0;
  return t;
}

/**
 * Pure: the same steps and t always give the same frame. t is clamped to [0, total] (NaN counts as 0). At or past the end the
 * frame is the last step at progress 1 with done = true. Requires at least one step (buildJourney never returns none).
 */
export function frameAt(steps: JourneyStep[], t: number): JourneyFrame {
  if (steps.length === 0) throw new RangeError("frameAt: a journey needs at least one step");
  const total = totalDuration(steps);
  const clamped = Number.isNaN(t) ? 0 : Math.min(Math.max(t, 0), total);
  let start = 0;
  for (let i = 0; i < steps.length; i++) {
    const d = Number.isFinite(steps[i].durationSec) && steps[i].durationSec > 0 ? steps[i].durationSec : 0;
    const end = start + d;
    if (clamped < end) return { t: clamped, stepIndex: i, step: steps[i], progress: (clamped - start) / d, done: false };
    start = end;
  }
  const lastIndex = steps.length - 1;
  return { t: clamped, stepIndex: lastIndex, step: steps[lastIndex], progress: 1, done: true };
}
