// Client-safe, pure: the engine's account of what a project's accepted supplier quotations did to a comparison, arranged for a reader.
//
// Nothing here prices anything or decides anything. Every number is a field of the engine's own answer (POST /v1/compare with `cost_evidence`:
// gridforge/scenario/evidence.py evidence_effect); this file picks the fields, names the ladder steps with the words the comparison itself uses,
// and words each cost basis exactly as the engine does (gridforge/costs.py BASIS_LABEL). The only comparison it makes is whether two weeks
// figures the engine gave are equal.

import type { CompareResult, CompareScenario } from "@/lib/ttp-compare";
import { basisLabel } from "@/lib/cost-evidence-claims";

/** The effect as the engine sends it. The site's CompareCostEvidence type names the fields the buyer page needs; this names all of them. */
export interface EngineStepChange {
  step: number;
  constraint: string;
  basis_before: string;
  basis_after: string;
  capex_before_eur?: number | null;
  capex_after_eur?: number | null;
  price_kind_after?: string | null;
  cost_keys: string[];
}
export interface EngineScenarioEffect {
  scenario: string;
  racks_before?: number;
  racks_after?: number;
  capex_before_eur: number;
  capex_after_eur: number;
  capex_delta_eur?: number;
  capex_complete_before?: boolean;
  capex_complete_after: boolean;
  decision_grade_before?: boolean;
  decision_grade_after?: boolean;
  unpriced_before?: number;
  unpriced_after?: number;
  placeholder_lines_before?: number;
  placeholder_lines_after?: number;
  limited_lines_after?: number;
  steps_changed: EngineStepChange[];
}

export interface StepView {
  step: number;
  /** The name the comparison table uses for this ladder step (what the relief is). */
  name: string;
  from: string;
  to: string;
  capex_before_eur: number | null;
  capex_after_eur: number | null;
  /** How the engine priced it after: "quoted_job_lump", "quoted_scaled", "per_unit", "quoted_lump_unstated_quantity". Shown as the engine's own token. */
  price_kind: string | null;
  cost_keys: string[];
}

export interface ScenarioEffectView {
  id: string;
  name: string;
  capex_before_eur: number;
  capex_after_eur: number;
  capex_delta_eur: number;
  complete_before: boolean | null;
  complete_after: boolean;
  /** The engine's own flag, before and after; null where this engine build does not report it. */
  decision_grade_before: boolean | null;
  decision_grade_after: boolean | null;
  placeholder_lines_before: number | null;
  placeholder_lines_after: number | null;
  steps: StepView[];
  /** The scenario as the engine answered it WITH the quotations (its date, and what the date rests on). */
  priced: CompareScenario | null;
  /** The weeks the same scenario gave WITHOUT them, from the comparison the visitor already ran. */
  weeks_without: number | null;
  weeks_with: number | null;
  /** True when the engine gave the same weeks with and without the quotations (both undated counts: there is no date either way) and the same date basis: the quotation did not move the date. */
  date_unchanged: boolean;
}

export interface UsedLineView {
  evidence_id: string | null;
  key: string;
  supplier: string | null;
  basis: string;
  basis_label: string;
  comparability: "exact" | "limited";
  quoted_on: string | null;
  valid_until: string | null;
  reviewer: string | null;
  reviewed_on: string | null;
}

export interface IgnoredLineView {
  key: string;
  evidence_id: string | null;
  /** The engine's exact reason string. */
  reason: string;
}

export interface EffectView {
  scenarios: ScenarioEffectView[];
  used: UsedLineView[];
  ignored: IgnoredLineView[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * The effect of the accepted quotations on the scenarios that were compared. `without` is the comparison the visitor already ran (library
 * prices); `with` is the engine's answer with the quotations applied. Returns null when the engine reported no cost-evidence account at all.
 */
export function effectView(without: CompareResult, withQuotes: CompareResult): EffectView | null {
  const block = withQuotes.cost_evidence;
  if (!block) return null;
  const compared = new Map(withQuotes.scenarios.map((s) => [s.id, s]));
  const before = new Map(without.scenarios.map((s) => [s.id, s]));
  const effect = (block.effect?.scenarios ?? []) as unknown as EngineScenarioEffect[];

  const scenarios: ScenarioEffectView[] = [];
  for (const e of effect) {
    const s = compared.get(e.scenario);
    if (!s) continue; // the engine reports every scenario the intake defines; only those compared are shown
    const names = new Map(s.time_to_power.lead_times.map((l) => [l.constraint, l.name]));
    const b = before.get(e.scenario);
    const wWith = num(s.time_to_power.weeks);
    const wWithout = num(b?.time_to_power.weeks);
    scenarios.push({
      id: e.scenario,
      name: s.name,
      capex_before_eur: e.capex_before_eur,
      capex_after_eur: e.capex_after_eur,
      capex_delta_eur: typeof e.capex_delta_eur === "number" ? e.capex_delta_eur : e.capex_after_eur - e.capex_before_eur,
      complete_before: typeof e.capex_complete_before === "boolean" ? e.capex_complete_before : null,
      complete_after: e.capex_complete_after === true,
      decision_grade_before: typeof e.decision_grade_before === "boolean" ? e.decision_grade_before : null,
      decision_grade_after: typeof e.decision_grade_after === "boolean" ? e.decision_grade_after : null,
      placeholder_lines_before: num(e.placeholder_lines_before),
      placeholder_lines_after: num(e.placeholder_lines_after),
      steps: e.steps_changed.map((c) => ({
        step: c.step,
        name: names.get(c.constraint) ?? c.constraint,
        from: basisLabel(c.basis_before),
        to: basisLabel(c.basis_after),
        capex_before_eur: num(c.capex_before_eur),
        capex_after_eur: num(c.capex_after_eur),
        price_kind: c.price_kind_after ?? null,
        cost_keys: c.cost_keys,
      })),
      priced: s,
      weeks_without: wWithout,
      weeks_with: wWith,
      date_unchanged: !!b && wWith === wWithout && b.time_to_power.date_basis === s.time_to_power.date_basis,
    });
  }

  return {
    scenarios,
    used: block.used.map((u) => ({
      evidence_id: u.evidence_id,
      key: u.key,
      supplier: u.supplier,
      basis: u.basis,
      basis_label: basisLabel(u.basis),
      comparability: u.comparability,
      quoted_on: u.quoted_on,
      valid_until: u.valid_until,
      reviewer: u.reviewer,
      reviewed_on: u.reviewed_on,
    })),
    ignored: block.ignored.map((i) => ({ key: i.key, evidence_id: i.evidence_id, reason: i.reason })),
  };
}
