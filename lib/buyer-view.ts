// Server-only: what a person opening a project's buyer link is shown.
//
// It is assembled from stored records and the product catalogue and nothing else: no engine call, no arithmetic, no
// figure that is not in a stored engine result. It is deliberately narrower than the owner's project state
// (lib/project-state.ts): no project token, no evidence file names, no supplier names or prices, no event history.

import { buyerPath, type BuyerStep } from "@/lib/buyer-path";
import { listComparisons, type ComparisonRow } from "@/lib/project-comparisons";
import { projectForShare } from "@/lib/project-share";
import { PRODUCT_BY_KIND } from "@/lib/products";
import { rest, type ProjectRow, type Result } from "@/lib/projects";

const q = encodeURIComponent;

export interface BuyerAssumption {
  label: string;
  value: string;
}

export interface BuyerView {
  project: Pick<ProjectRow, "project_name" | "company" | "site_label" | "created_at">;
  comparison: ComparisonRow | null;
  /** Saved comparisons older than the one shown. */
  earlier_comparisons: number;
  assumptions: BuyerAssumption[];
  engagements: { kind: string; name: string }[];
  /** Quotation lines recorded against this project's engagements; the comparison itself does not use them. */
  quotations: { total: number; accepted: number } | null;
  next: BuyerStep | null;
  others: BuyerStep[];
}

const asObj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/**
 * The hall inputs behind a comparison, as the owner entered them, from an allow-list of fields. Free-text fields
 * (queue notes, DSO names, the client and reference strings) are not copied: a buyer page shows the numbers the
 * decision rests on, not everything the owner typed.
 */
export function assumptionsOf(request: Record<string, unknown>): BuyerAssumption[] {
  const intake = asObj(request.intake);
  const grid = asObj(intake.grid);
  const lv = asObj(intake.lv);
  const hall = asObj(intake.hall);
  const plant = asObj(asObj(intake.thermal).plant);
  const compute = asObj(intake.compute);
  const rows: [string, unknown, string][] = [
    ["Platform", typeof compute.platform === "string" && /^[a-z0-9_]{1,40}$/.test(compute.platform) ? compute.platform : undefined, ""],
    ["Contracted grid capacity", grid.contracted_MW, " MW"],
    ["Firm connection capacity", grid.firm_capacity_MVA, " MVA"],
    ["Current site peak", grid.current_site_peak_MW, " MW"],
    ["Current IT load", grid.current_it_load_MW, " MW"],
    ["Busway ampacity", lv.busway_ampacity_A, " A"],
    ["Tap-off rating (max)", lv.tapoff_max_A, " A"],
    ["Free rack positions", hall.positions_available, ""],
    ["Floor loading", hall.floor_loading_kPa, " kPa"],
    ["Chilled-water plant capacity", plant.chilled_water_capacity_kW, " kW"],
    ["Chilled-water design supply", plant.design_supply_C, " °C"],
  ];
  // Only the platform is text, and only as a short identifier; every other input must be a finite number.
  const out: BuyerAssumption[] = rows
    .filter(([label, v]) => (label === "Platform" ? typeof v === "string" : typeof v === "number" && Number.isFinite(v)))
    .map(([label, v, unit]) => ({ label, value: `${v}${unit}` }));
  const btm = Array.isArray(intake.btm_options) ? intake.btm_options : [];
  for (const o of btm.slice(0, 10)) {
    const b = asObj(o);
    if (typeof b.kind === "string" && typeof b.capacity_MW === "number" && typeof b.lead_time_weeks === "number") {
      out.push({ label: `On-site supply option (${b.kind.replace(/_/g, " ")})`, value: `${b.capacity_MW} MW, ${b.lead_time_weeks} wk lead time as declared` });
    }
  }
  return out;
}

export async function getBuyerView(shareToken: string): Promise<Result<{ view: BuyerView }>> {
  const found = await projectForShare(shareToken);
  if (!found.ok) return found;
  const project = found.project;

  const [cmp, paid, lines] = await Promise.all([
    listComparisons(project.id),
    rest<{ payload: Record<string, unknown> }[]>(
      "GET",
      `project_events?project_id=eq.${q(project.id)}&event_type=eq.paid_product_attached&select=payload&order=occurred_at.asc`
    ),
    rest<{ state: string }[]>("GET", `cost_evidence_state?project_id=eq.${q(project.id)}&select=state`),
  ]);
  if (!cmp.ok) return cmp;
  // A failed read is a failed read, never "no purchases yet" or "no quotations".
  if (!paid.ok || !lines.ok) return { ok: false, status: 502, error: "The project record could not be read." };

  const seen = new Set<string>();
  const engagements: BuyerView["engagements"] = [];
  for (const e of paid.data ?? []) {
    const kind = typeof e.payload?.kind === "string" ? e.payload.kind : null;
    if (!kind || seen.has(kind)) continue;
    seen.add(kind);
    engagements.push({ kind, name: PRODUCT_BY_KIND[kind]?.name ?? kind });
  }
  const { next, others } = buyerPath(engagements.map((e) => e.kind));
  const latest = cmp.comparisons[0] ?? null;
  const total = (lines.data ?? []).length;

  return {
    ok: true,
    view: {
      project: {
        project_name: project.project_name,
        company: project.company,
        site_label: project.site_label,
        created_at: project.created_at,
      },
      comparison: latest,
      earlier_comparisons: Math.max(0, cmp.comparisons.length - 1),
      assumptions: latest ? assumptionsOf(latest.request) : [],
      engagements,
      quotations: total > 0 ? { total, accepted: (lines.data ?? []).filter((l) => l.state === "accepted").length } : null,
      next,
      others,
    },
  };
}
