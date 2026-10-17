// What a saved Time-to-Power comparison rests on, read from the engine's own account of it.
//
// Nothing here computes a price. The engine says which accepted quotation lines it applied and which ladder steps each one
// repriced (lib/ttp-compare.ts: CompareCostEvidence); this file only (a) decides which lines count as BACKING the
// comparison, and (b) projects them to the fields a buyer may see. A line backs a comparison only if the engine applied it
// AND it repriced at least one step of at least one scenario: a line the overlay merely held (an item this hall never buys)
// is not evidence for any number on the page.

import type { CompareResult, CompareScenario } from "@/lib/ttp-compare";

export interface BackingLine {
  evidence_id: string;
  key: string;
  /** Scenarios whose price it moved, and how many ladder steps in each. */
  priced: { scenario: string; steps: number }[];
  /** The constraints (ladder steps) it priced, by the constraint's id. */
  constraints: string[];
}

/** The applied lines that repriced something, ordered by evidence id. */
export function backingLines(result: CompareResult): BackingLine[] {
  const ev = result.cost_evidence;
  if (!ev || !ev.effect) return [];
  // The engine reports the effect on every scenario the intake defines; only those actually compared count here.
  const compared = new Set(result.scenarios.map((s) => s.id));
  const out: BackingLine[] = [];
  for (const u of ev.used) {
    if (!u.evidence_id) continue;
    const priced: BackingLine["priced"] = [];
    const constraints = new Set<string>();
    for (const sc of ev.effect.scenarios) {
      if (!compared.has(sc.scenario)) continue;
      const hit = sc.steps_changed.filter((c) => c.cost_keys.includes(u.key));
      if (hit.length) priced.push({ scenario: sc.scenario, steps: hit.length });
      for (const c of hit) constraints.add(c.constraint);
    }
    if (priced.length) out.push({ evidence_id: u.evidence_id, key: u.key, priced, constraints: [...constraints].sort() });
  }
  return out.sort((a, b) => (a.evidence_id < b.evidence_id ? -1 : a.evidence_id > b.evidence_id ? 1 : 0));
}

export const BASIS_TEXT: Record<string, string> = {
  budgetary_quote: "budgetary quote (an indicative price, not an offer)",
  firm_quote: "firm quote",
  contracted: "contracted price",
};

export type Standing = "current" | "replaced" | "withdrawn" | "expired" | "unknown";

export interface BuyerQuotation {
  label: string;
  /** What it prices, in the words of the ladder steps it repriced. */
  item: string;
  basis: string;
  comparability: "exact" | "limited";
  quoted_on: string | null;
  valid_until: string | null;
  accepted_on: string | null;
  priced: { scenario: string; steps: number }[];
  standing: Standing;
}

export interface BuyerQuotations {
  lines: BuyerQuotation[];
  /** The engine's reasons for accepted lines it was offered but did not apply. Fixed engine wording; no supplier text. */
  not_applied: string[];
  /** Whether the comparison still rests on the project's current accepted quotations, and if not, why. */
  current: boolean;
  reasons: string[];
}

export interface LineState {
  id: string;
  state: string;
  valid_until: string | null;
}

function standingOf(s: LineState | undefined, today: string): Standing {
  if (!s) return "unknown";
  if (s.state === "superseded") return "replaced";
  if (s.state === "withdrawn") return "withdrawn";
  if (s.state !== "accepted") return "unknown";
  if (s.valid_until && s.valid_until < today) return "expired";
  return "current";
}

/**
 * The buyer's account of the quotations behind a comparison. `backed` is the set of line ids the DATABASE recorded for the
 * row (project_comparisons.evidence_ids); a line the result mentions but the row does not record is never described as
 * backing. `states` is where those lines stand today and `newer` counts accepted, unexpired lines the project has gained
 * that the comparison was not offered, so a comparison that is no longer the project's current picture says so.
 */
export function buyerQuotations(
  result: CompareResult,
  backed: string[],
  states: LineState[],
  newer: number,
  today: string
): BuyerQuotations | null {
  const ids = new Set(backed);
  const lines = backingLines(result).filter((l) => ids.has(l.evidence_id));
  if (lines.length === 0) return null;
  const used = new Map((result.cost_evidence?.used ?? []).map((u) => [u.evidence_id, u]));
  const scenario = new Map<string, CompareScenario>(result.scenarios.map((s) => [s.id, s]));
  const constraintName = new Map<string, string>();
  for (const s of result.scenarios) for (const lt of s.time_to_power.lead_times) constraintName.set(lt.constraint, lt.name);
  const byId = new Map(states.map((s) => [s.id, s]));

  const out: BuyerQuotation[] = lines.map((l, i) => {
    const u = used.get(l.evidence_id)!;
    return {
      label: `Quotation ${i + 1}`,
      item: l.constraints.map((c) => constraintName.get(c) ?? c).join(", "),
      basis: BASIS_TEXT[u.basis] ?? u.basis.replace(/_/g, " "),
      comparability: u.comparability,
      quoted_on: u.quoted_on,
      valid_until: u.valid_until,
      accepted_on: u.reviewed_on,
      priced: l.priced.map((p) => ({ scenario: scenario.get(p.scenario)?.name ?? p.scenario, steps: p.steps })),
      standing: standingOf(byId.get(l.evidence_id), today),
    };
  });

  const reasons: string[] = [];
  const count = (s: Standing) => out.filter((q) => q.standing === s).length;
  if (count("replaced")) reasons.push(`${count("replaced")} quotation${count("replaced") === 1 ? " has" : "s have"} since been replaced by a newer accepted quotation`);
  if (count("withdrawn")) reasons.push(`${count("withdrawn")} quotation${count("withdrawn") === 1 ? " has" : "s have"} since been withdrawn`);
  if (count("expired")) reasons.push(`${count("expired")} quotation${count("expired") === 1 ? " has" : "s have"} passed ${count("expired") === 1 ? "its" : "their"} validity date`);
  if (count("unknown")) reasons.push("the current standing of some quotations could not be confirmed");
  if (newer > 0) reasons.push(`${newer} further accepted quotation${newer === 1 ? " was" : "s were"} recorded after this comparison`);

  const ignored = result.cost_evidence?.ignored ?? [];
  return {
    lines: out,
    not_applied: [...new Set(ignored.map((i) => i.reason))].sort(),
    current: reasons.length === 0,
    reasons,
  };
}

/** Cost bases that rest on a supplier's own price. A step priced on one of these does not show its price to a buyer. */
const QUOTED_BASES = new Set(["budgetary_quote", "firm_quote", "contracted"]);

/**
 * The saved answer as a buyer may hold it. The engine's per-line account of the quotations it was handed (supplier,
 * price, reviewer, reference) is dropped, and so is the per-step price of any ladder step that rests on a quotation: the
 * buyer sees what each scenario costs in total and how many of its lines are quoted, not what a supplier charged for one.
 */
export function publicResult(result: CompareResult): CompareResult {
  const { cost_evidence: _account, ...rest } = result;
  return {
    ...rest,
    scenarios: rest.scenarios.map((s) => ({
      ...s,
      time_to_power: {
        ...s.time_to_power,
        lead_times: s.time_to_power.lead_times.map((l) => {
          const basis = (l as { cost_basis?: string | null }).cost_basis;
          return basis && QUOTED_BASES.has(basis) ? { ...l, capex_eur: null } : l;
        }),
      },
    })),
  };
}
