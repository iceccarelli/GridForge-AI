// The deterministic presenter journey: a pure function of the scenario file, and frameAt a pure function of time over the steps.
// No clock, no randomness, no locale: the same file always gives the same steps, the same t always gives the same frame.
//
// The tour (about three and a half to four minutes for three halls):
//   overview of the halls -> hall 1 power path -> hall 1 binding stage -> hall 1 constraints ranking -> hall 1 plan and outcomes
//   -> the context panel (its provenance spoken) -> hall 2 -> hall 3 -> close with the free qualifier as the next step.
// Every caption is the single source for the on-screen text and the WebVTT track (captions.ts). Captions state the basis where
// numbers appear, say "not dated" wherever the file says an outcome is not dated, and never sell anything.

import { formatNumber, bindingNodeAfterPlan, bindingNodeAsFound, resolveOutcome } from "@/lib/observatory/scene-model";
import type {
  ConstraintResult,
  JourneyFrame,
  JourneyStep,
  ObservatoryScenario,
  ScenarioFile,
  ScenarioOutcome,
} from "@/lib/observatory/types";

/** At most this many halls are toured. */
export const MAX_HALLS = 3;

/** Reading pace used to make sure a caption stays up long enough to read: words per second, plus a fixed settle time. */
const WORDS_PER_SECOND = 2.5;
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

function rankedConstraints(sc: ObservatoryScenario): ConstraintResult[] {
  return [...sc.constraints].sort((a, b) => {
    const av = a.racksAllowed;
    const bv = b.racksAllowed;
    if (av === null && bv === null) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    return av - bv || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  });
}

function constraintName(sc: ObservatoryScenario, key: string | null): string | null {
  if (key === null) return null;
  return sc.constraints.find((c) => c.key === key)?.name ?? null;
}

function timeSentence(o: ScenarioOutcome): string {
  return o.dated && o.weeksToCapacity.value !== null
    ? `Programme time is ${formatNumber(o.weeksToCapacity.value)} weeks, from supplied lead times.`
    : "Not dated: the lead times are assumed or missing, so no date is given.";
}

function afterPlanSentence(sc: ObservatoryScenario, o: ScenarioOutcome): string {
  const name = constraintName(sc, o.bindingAfterPlan);
  if (name) return `${name} binds after the plan.`;
  // A key this scenario has no constraint for is reported as the engine gave it; nothing is invented to explain it.
  if (o.bindingAfterPlan !== null) return `The engine names "${o.bindingAfterPlan}" as binding after the plan, which this view does not model.`;
  return "The engine output does not say what binds after the plan.";
}

function outcomeCaption(sc: ObservatoryScenario, o: ScenarioOutcome, lead: string): string {
  return (
    `${lead} ${o.name} takes ${sc.hall.name} from ${formatNumber(o.racksAsFound)} racks to ${formatNumber(o.racksAfterPlan)}; ${afterPlanSentence(sc, o)} ` +
    `${timeSentence(o)} Engine-modelled, evidence ${o.evidence}.`
  ).replace(/\s+/g, " ");
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
      `${NUMBER_WORDS[halls.length]} synthetic demonstration hall${halls.length === 1 ? "" : "s"}, modelled by the GridForge engine from invented inputs: ${listOf(halls.map((h) => h.title))}. ` +
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
    caption:
      `Hall 1, ${first.hall.name}: power reaches the racks through ${first.powerPath.length} stage${first.powerPath.length === 1 ? "" : "s"}, from the utility connection to the rack, ` +
      `with ${formatNumber(first.hall.contractedMW)} MW contracted and ${formatNumber(first.hall.currentItLoadMW)} MW of IT load today. Invented inputs, engine-modelled.`,
  });
  push({
    id: "hall-1-binding",
    plannedSec: 18,
    scenarioId: first.id,
    outcomeId: outcomeIdOf(first),
    focus: bind1 ? bind1.id : null,
    panel: "path",
    caption: bind1
      ? `${bind1.label} is the stage that binds as found. ${sentence(constraintBindingDetail(first, bind1.constraintKey))} Engine-modelled, not measured.`
      : "The engine output does not identify which stage binds as found, so none is highlighted. Nothing is guessed.",
  });

  const ranked = rankedConstraints(first);
  const top = ranked.slice(0, 3);
  const bindingConstraint = first.constraints.find((c) => c.binds) ?? null;
  push({
    id: "hall-1-constraints",
    plannedSec: 20,
    scenarioId: first.id,
    outcomeId: outcomeIdOf(first),
    focus: bindingConstraint ? bindingConstraint.key : null,
    panel: "constraints",
    caption: top.length
      ? `Constraints ranked by the racks each allows as found: ${listOf(top.map((c) => `${c.name} ${c.racksAllowed === null ? "not supported by the inputs" : formatNumber(c.racksAllowed)}`))}. ` +
        `${bindingConstraint ? `${bindingConstraint.name} sets the limit.` : "The engine output names no single limit."} Evidence classes as labelled.`
      : "The engine output lists no constraints for this hall, so there is no ranking to show.",
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

  // 6. Context panel: provenance spoken. The caption describes what KIND of values these are; it carries no figure that could age.
  push({
    id: "context",
    plannedSec: 22,
    scenarioId: first.id,
    outcomeId: outcomeIdOf(first),
    focus: null,
    panel: "context",
    caption:
      "Beside the halls: the day-ahead price for this hour in Germany, a published auction result, not a live reading. " +
      "The grid mix carries its own timestamp, queue figures are current only as of their report dates, and none of it is where these halls are.",
  });

  // 7-8. Halls 2 and 3
  halls.slice(1).forEach((sc, i) => {
    const n = i + 2;
    const bind = bindingNodeAsFound(sc);
    const o = resolveOutcome(sc);
    const bindingConstraint2 = sc.constraints.find((c) => c.binds) ?? null;
    push({
      id: `hall-${n}-path`,
      plannedSec: 16,
      scenarioId: sc.id,
      outcomeId: outcomeIdOf(sc),
      focus: bind ? bind.id : null,
      panel: "path",
      caption: bind
        ? `Hall ${n}, ${sc.hall.name}: ${bind.label} binds as found${bindingConstraint2 && bindingConstraint2.racksAllowed !== null ? `, allowing ${formatNumber(bindingConstraint2.racksAllowed)} racks` : ""}. Invented inputs, engine-modelled.`
        : `Hall ${n}, ${sc.hall.name}: the engine output does not identify which stage binds as found, so none is highlighted. Invented inputs, engine-modelled.`,
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

function constraintBindingDetail(sc: ObservatoryScenario, key: string | null): string {
  const c = key === null ? sc.constraints.find((x) => x.binds) : sc.constraints.find((x) => x.key === key);
  if (c && c.racksAllowed !== null) return `On its own it allows ${formatNumber(c.racksAllowed)} racks (evidence ${c.evidence})`;
  return "The engine output gives no rack count for it";
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
