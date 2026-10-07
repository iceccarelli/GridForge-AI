// Server-only: the read model behind ProjectPanel — one project, as stored.
//
// Every engineering figure here is READ from the authoritative case row
// (power_deployment_cases.result, written by the engine); nothing is recomputed,
// defaulted or estimated. Where the store has no value the field is `null` and the
// panel renders it as unknown — never as 0, "" or a sample.

import { latestDeploymentCase } from "@/lib/power-deploy";
import { PRODUCT_BY_KIND } from "@/lib/products";
import {
  creds,
  getProjectByToken,
  listEvents,
  projectLinks,
  rest,
  STORE_UNCONFIGURED,
  type EvidenceRow,
  type ProjectEventRow,
  type ProjectRow,
  type Result,
} from "@/lib/projects";
import {
  latestComparison,
  packageResponses,
  type ComparisonRow,
  type PackageRow,
} from "@/lib/project-procurement";

export interface CaseState {
  case_token: string;
  latest_revision: number;
  target_MW: number | null;
  grid_firm_MW: number | null;
  gap_MW: number | null;
  redundancy: string | null;
  objective: string | null;
  next_action: { action: string; why: string } | null;
  architectures: {
    label: string;
    status: string;
    available_MW: number | null;
    margin_MW: number | null;
    blocking: string[];
    rfq_ready: boolean;
    execution_ready: boolean;
    external_clearances_required: { gate: string; review_requirement: string; reason: string }[];
    blocking_gates: { gate: string; status: string; reason: string; missing: string[] }[];
  }[];
}

export interface PackageState {
  package_token: string;
  case_token: string;
  case_revision: number;
  /** The case has moved on since this package was written. */
  stale: boolean;
  architecture: string;
  created_at: string;
  response_count: number;
  comparison: {
    id: string;
    created_at: string;
    leading: string | null;
    ranked: NonNullable<ComparisonRow["result"]["ranked"]>;
  } | null;
  selection: { supplier: string; selected_at: string | null; selected_by: string | null } | null;
}

export interface ProjectState {
  project: Pick<ProjectRow, "project_token" | "company" | "project_name" | "site_label" | "location" | "status" | "created_at">;
  cases: CaseState[];
  /** Paid products commissioned for this project, from the Stripe webhook's own record. */
  engagements: {
    kind: string;
    /** Catalogue name; null if the kind is no longer in the catalogue. */
    name: string | null;
    amount_cents: number | null;
    object_type: "deliverable" | "watch" | null;
    /** The fulfilment object's current status, read live; null for a deposit that opens none. */
    status: string | null;
    attached_at: string;
  }[];
  /** Linked objects other than cases, packages and paid products. */
  other_links: { object_type: string; object_id: string }[];
  evidence: {
    total: number;
    unverified: number;
    verified: number;
    rejected: number;
    items: Pick<EvidenceRow, "id" | "filename" | "media_type" | "sha256" | "byte_size" | "review_status" | "evidence_class" | "source_category" | "uploaded_at">[];
  };
  procurement: { packages: PackageState[] };
  events: Pick<ProjectEventRow, "id" | "event_type" | "occurred_at" | "actor" | "payload">[];
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

function caseState(row: NonNullable<Awaited<ReturnType<typeof latestDeploymentCase>>>): CaseState {
  const r = row.result as Record<string, any>;
  const cap = (r.capacity ?? {}) as Record<string, unknown>;
  const na = r.next_action as { action?: unknown; why?: unknown } | undefined;
  return {
    case_token: row.case_token,
    latest_revision: row.revision,
    target_MW: num(cap.target_MW),
    grid_firm_MW: num(cap.grid_firm_MW),
    gap_MW: num(cap.gap_MW),
    redundancy: str(cap.redundancy),
    objective: str(cap.objective),
    next_action: na && str(na.action) ? { action: String(na.action), why: str(na.why) ?? "" } : null,
    architectures: (Array.isArray(r.architectures) ? r.architectures : []).map((a: Record<string, any>) => ({
      label: String(a.label),
      status: String(a.status),
      available_MW: num(a.available_MW),
      margin_MW: num(a.margin_MW),
      blocking: Array.isArray(a.blocking) ? a.blocking.map(String) : [],
      rfq_ready: a.rfq_ready === true,
      execution_ready: a.execution_ready === true,
      external_clearances_required: Array.isArray(a.external_clearances_required)
        ? a.external_clearances_required
        : [],
      blocking_gates: (Array.isArray(a.readiness_gates) ? a.readiness_gates : []).filter(
        (g: Record<string, unknown>) =>
          g.blocking === true || g.status === "missing_data" || g.status === "unknown" || g.status === "fail"
      ),
    })),
  };
}

export async function getProjectState(token: string): Promise<Result<{ state: ProjectState }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const found = await getProjectByToken(token);
  if (!found.ok) return found;
  const project = found.project;

  const [links, events, ev, pk] = await Promise.all([
    projectLinks(project.id),
    listEvents(project.id),
    rest<EvidenceRow[]>("GET", `project_evidence?project_id=eq.${encodeURIComponent(project.id)}&select=*&order=uploaded_at.asc`),
    rest<PackageRow[]>("GET", `procurement_packages?project_id=eq.${encodeURIComponent(project.id)}&select=*&order=created_at.asc`),
  ]);
  if (!links.ok) return links;
  if (!events.ok) return events;
  // A failed read is a failed read — never rendered as "no evidence" or "no packages".
  if (!ev.ok || !pk.ok) return { ok: false, status: 502, error: "The project record could not be read." };

  const cases: CaseState[] = [];
  const latestRevision = new Map<string, number>();
  for (const l of links.links.filter((l) => l.object_type === "power_deployment_case")) {
    const row = await latestDeploymentCase(l.object_id);
    if (!row) return { ok: false, status: 502, error: "A linked case could not be read." };
    cases.push(caseState(row));
    latestRevision.set(l.object_id, row.revision);
  }

  const packages: PackageState[] = [];
  for (const p of pk.data ?? []) {
    const rs = await packageResponses(p);
    const cmp = await latestComparison(p);
    if (!rs.ok || !cmp.ok) return { ok: false, status: 502, error: "The procurement record could not be read." };
    packages.push({
      package_token: p.package_token,
      case_token: p.case_token,
      case_revision: p.case_revision,
      stale: (latestRevision.get(p.case_token) ?? p.case_revision) > p.case_revision,
      architecture: p.architecture,
      created_at: p.created_at,
      response_count: rs.responses.length,
      comparison: cmp.comparison
        ? {
            id: cmp.comparison.id,
            created_at: cmp.comparison.created_at,
            leading: cmp.comparison.result.leading ?? null,
            ranked: cmp.comparison.result.ranked ?? [],
          }
        : null,
      selection: p.selected_supplier
        ? { supplier: p.selected_supplier, selected_at: p.selected_at, selected_by: p.selected_by }
        : null,
    });
  }

  // Paid products: what the webhook recorded, plus each object's status as it is NOW.
  const engagements: ProjectState["engagements"] = [];
  for (const e of events.events.filter((x) => x.event_type === "paid_product_attached")) {
    const pl = e.payload as Record<string, unknown>;
    const objectType = pl.object_type === "deliverable" || pl.object_type === "watch" ? pl.object_type : null;
    const objectId = typeof pl.object_id === "string" ? pl.object_id : null;
    let status: string | null = null;
    if (objectType && objectId) {
      const table = objectType === "deliverable" ? "deliverables" : "watches";
      const r = await rest<{ status: string }[]>("GET", `${table}?id=eq.${encodeURIComponent(objectId)}&select=status&limit=1`);
      if (!r.ok) return { ok: false, status: 502, error: "A purchased engagement could not be read." };
      status = r.data?.[0]?.status ?? null;
    }
    const kind = typeof pl.kind === "string" ? pl.kind : "unknown";
    engagements.push({
      kind,
      name: PRODUCT_BY_KIND[kind]?.name ?? null,
      amount_cents: typeof pl.amount_cents === "number" ? pl.amount_cents : null,
      object_type: objectType,
      status,
      attached_at: e.occurred_at,
    });
  }

  const evidence = ev.data ?? [];
  return {
    ok: true,
    state: {
      project: {
        project_token: project.project_token,
        company: project.company,
        project_name: project.project_name,
        site_label: project.site_label,
        location: project.location,
        status: project.status,
        created_at: project.created_at,
      },
      cases,
      engagements,
      other_links: links.links
        .filter((l) => !["power_deployment_case", "procurement_package", "deliverable", "watch"].includes(l.object_type))
        .map((l) => ({ object_type: l.object_type, object_id: l.object_id })),
      evidence: {
        total: evidence.length,
        unverified: evidence.filter((e) => e.review_status === "unverified").length,
        verified: evidence.filter((e) => e.review_status === "verified").length,
        rejected: evidence.filter((e) => e.review_status === "rejected").length,
        items: evidence.map((e) => ({
          id: e.id,
          filename: e.filename,
          media_type: e.media_type,
          sha256: e.sha256,
          byte_size: e.byte_size,
          review_status: e.review_status,
          evidence_class: e.evidence_class,
          source_category: e.source_category,
          uploaded_at: e.uploaded_at,
        })),
      },
      procurement: { packages },
      events: events.events.map((e) => ({
        id: e.id,
        event_type: e.event_type,
        occurred_at: e.occurred_at,
        actor: e.actor,
        payload: e.payload,
      })),
    },
  };
}
