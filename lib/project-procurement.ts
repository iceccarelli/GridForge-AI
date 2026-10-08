// Server-only: the BTM procurement loop under a project.
//
//   attached BTM case -> selected architecture -> RFQ package -> supplier responses
//   -> comparison -> human selection
//
// Nothing here computes anything the engine already computes. The tender package is
// `/v1/power/deploy/spec` (gridforge/reporting/btm_spec*.py); a response is validated
// and a comparison produced by `/v1/power/deploy/bids`, which calls the SAME
// `procurement.rank_bids` the hall Procurement Specification uses. This file stores
// what came back and wires it to a project and its history.
//
// Not monetised: there is no BTM price, SKU or checkout here, and none is implied.

import crypto from "node:crypto";
import { callEngine, deploymentCaseRevision, latestDeploymentCase } from "@/lib/power-deploy";
import {
  creds,
  ev,
  linksFor,
  rest,
  rpc,
  STORE_UNCONFIGURED,
  type ProjectRow,
  type Result,
} from "@/lib/projects";

const q = encodeURIComponent;
const now = () => new Date().toISOString();

export interface PackageRow {
  id: string;
  package_token: string;
  project_id: string;
  case_token: string;
  case_revision: number;
  architecture: string;
  spec_summary: { architecture: string; units: string[]; requirements: number; mandatory: number };
  response_template: Record<string, unknown>;
  document_md: string;
  document_html: string;
  created_at: string;
  selected_supplier: string | null;
  selected_response_id: string | null;
  selected_comparison_id: string | null;
  selected_at: string | null;
  selected_by: string | null;
}

export interface ResponseRow {
  id: string;
  package_id: string;
  project_id: string;
  supplier: string;
  response: Record<string, unknown>;
  received_at: string;
}

export interface ComparisonRow {
  id: string;
  package_id: string;
  project_id: string;
  case_token: string;
  case_revision: number;
  architecture: string;
  response_ids: string[];
  result: {
    ranked?: { rank: number; supplier: string; disqualified?: boolean; compliant?: boolean }[];
    leading?: string | null;
    [k: string]: unknown;
  };
  created_at: string;
}

async function loadPackage(project: ProjectRow, token: string): Promise<Result<{ pkg: PackageRow }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const r = await rest<PackageRow[]>("GET", `procurement_packages?package_token=eq.${q(token)}&select=*&limit=1`);
  if (!r.ok) return { ok: false, status: 502, error: "The package could not be read." };
  const pkg = r.data?.[0];
  // A package belonging to another project is indistinguishable from a missing one.
  if (!pkg || pkg.project_id !== project.id) return { ok: false, status: 404, error: "Not found." };
  return { ok: true, pkg };
}

export async function packageResponses(pkg: PackageRow): Promise<Result<{ responses: ResponseRow[] }>> {
  const r = await rest<ResponseRow[]>(
    "GET",
    `procurement_responses?package_id=eq.${q(pkg.id)}&select=*&order=received_at.asc`
  );
  if (!r.ok) return { ok: false, status: 502, error: "Supplier responses could not be read." };
  return { ok: true, responses: r.data ?? [] };
}

export async function latestComparison(pkg: PackageRow): Promise<Result<{ comparison: ComparisonRow | null }>> {
  const r = await rest<ComparisonRow[]>(
    "GET",
    `procurement_comparisons?package_id=eq.${q(pkg.id)}&select=*&order=created_at.desc&limit=1`
  );
  if (!r.ok) return { ok: false, status: 502, error: "The comparison could not be read." };
  return { ok: true, comparison: r.data?.[0] ?? null };
}

/** The exact deployment request a package was built from: an immutable case revision. */
async function packageRequest(pkg: PackageRow): Promise<Result<{ request: Record<string, unknown> }>> {
  const row = await deploymentCaseRevision(pkg.case_token, pkg.case_revision);
  if (!row) return { ok: false, status: 502, error: "The case revision this package was built from could not be read." };
  return { ok: true, request: row.request };
}

export async function getPackage(project: ProjectRow, token: string) {
  return loadPackage(project, token);
}

// ---------------------------------------------------------------- RFQ

interface ArchitectureResult {
  label: string;
  rfq_ready: boolean;
  blocking?: string[];
  capex_uncosted_units?: string[];
  lead_time_undated_units?: string[];
  readiness_gates?: { gate: string; status: string; reason: string; missing: string[] }[];
}

/**
 * Generate the RFQ package for one architecture of an attached case.
 *
 * Refused — with the engine's own blocking information, and without calling the
 * spec engine for a document — unless that architecture is `rfq_ready` in the case's
 * stored result. The engine is then asked to re-check (`require_rfq_ready`), so a
 * stale or hand-edited stored result cannot produce a package the engine would not.
 */
export async function generateRfqPackage(
  project: ProjectRow,
  input: { case_token: string; architecture: string }
): Promise<Result<{ package: Omit<PackageRow, "document_md" | "document_html"> }> & { details?: unknown }> {
  if (!creds()) return STORE_UNCONFIGURED;

  const links = await linksFor("power_deployment_case", input.case_token);
  if (!links.ok) return links;
  if (!links.links.some((l) => l.project_id === project.id)) {
    return { ok: false, status: 403, error: "That case is not attached to this project." };
  }
  const row = await latestDeploymentCase(input.case_token);
  if (!row) return { ok: false, status: 404, error: "That case was not found." };

  const archs = ((row.result as { architectures?: ArchitectureResult[] }).architectures ?? []);
  const arch = archs.find((a) => a.label === input.architecture);
  if (!arch) return { ok: false, status: 422, error: "That architecture is not part of this case." };
  if (!arch.rfq_ready) {
    return {
      ok: false,
      status: 409,
      error: `'${arch.label}' is not RFQ-ready, so no RFQ package was generated.`,
      details: {
        blocking: arch.blocking ?? [],
        capex_uncosted_units: arch.capex_uncosted_units ?? [],
        lead_time_undated_units: arch.lead_time_undated_units ?? [],
        readiness_gates: (arch.readiness_gates ?? []).filter(
          (g) => g.status === "missing_data" || g.status === "unknown"
        ),
      },
    };
  }

  const spec = await callEngine("/v1/power/deploy/spec", {
    ...row.request,
    architecture: arch.label,
    project: project.project_name,
    format: "html",
    require_rfq_ready: true,
  });
  if (!spec.ok) {
    const refused = spec.status === 409 || spec.status === 422;
    return {
      ok: false,
      status: refused ? spec.status : 502,
      error: refused
        ? `The engine refused to prepare this RFQ: ${spec.error}`
        : `The specification engine is unavailable: ${spec.error}. No RFQ package was generated.`,
      details: refused ? spec.body : undefined,
    };
  }
  const b = spec.body as {
    document_full?: unknown;
    document_md?: unknown;
    response_template?: unknown;
    specification?: PackageRow["spec_summary"];
  };
  if (
    typeof b.document_full !== "string" ||
    typeof b.document_md !== "string" ||
    !b.response_template ||
    !b.specification
  ) {
    return { ok: false, status: 502, error: "The specification engine returned an incomplete package. Nothing was saved." };
  }

  const package_token = crypto.randomBytes(18).toString("base64url");
  // Package, project link and `rfq_generated` are written by one database function:
  // all three exist or none do.
  const made = await rpc<Omit<PackageRow, "document_md" | "document_html">>("gf_create_package", {
    p: {
      package_token,
      project_id: project.id,
      case_token: row.case_token,
      case_revision: row.revision,
      architecture: arch.label,
      spec_summary: b.specification,
      response_template: b.response_template,
      document_md: b.document_md,
      document_html: b.document_full,
      created_at: now(),
    },
    p_event: ev("rfq_generated", "project_token_holder", {
      package_token,
      case_token: row.case_token,
      case_revision: row.revision,
      architecture: arch.label,
      units: b.specification.units,
    }),
  });
  if (!made.ok || !made.data) return { ok: false, status: 502, error: "The RFQ package could not be saved. Nothing was recorded." };
  return { ok: true, package: made.data };
}

// ---------------------------------------------------------------- responses

const MAX_RESPONSE_BYTES = 100_000;

/**
 * Store one supplier's completed response schedule against a package.
 *
 * The response is first run through the engine's own comparison with only that
 * response in it, which is the existing `SupplierResponse.from_dict` validation —
 * a response the engine cannot read is refused here, with the engine's reason,
 * rather than stored and found unusable at comparison time. Nothing about the
 * supplier, the price or the programme is ever filled in on their behalf.
 */
export async function submitSupplierResponse(
  project: ProjectRow,
  package_token: string,
  raw: unknown
): Promise<Result<{ response: ResponseRow }>> {
  const loaded = await loadPackage(project, package_token);
  if (!loaded.ok) return loaded;
  const pkg = loaded.pkg;
  if (pkg.selected_supplier) {
    return { ok: false, status: 409, error: "A supplier has already been selected for this package." };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, status: 422, error: "Send the completed response schedule as a JSON object." };
  }
  const body = raw as Record<string, unknown>;
  const supplier = typeof body.supplier === "string" ? body.supplier.trim() : "";
  if (!supplier || supplier.length > 120) {
    return { ok: false, status: 422, error: "The response must name the supplier." };
  }
  if (JSON.stringify(body).length > MAX_RESPONSE_BYTES) {
    return { ok: false, status: 422, error: "That response is too large." };
  }

  const existing = await packageResponses(pkg);
  if (!existing.ok) return existing;
  if (existing.responses.some((r) => r.supplier.trim().toLowerCase() === supplier.toLowerCase())) {
    return { ok: false, status: 409, error: `A response from ${supplier} is already recorded for this package.` };
  }

  const req = await packageRequest(pkg);
  if (!req.ok) return req;
  const check = await callEngine("/v1/power/deploy/bids", {
    ...req.request,
    architecture: pkg.architecture,
    project: project.project_name,
    responses: [{ ...body, supplier }],
  });
  if (!check.ok) {
    return check.status === 422
      ? { ok: false, status: 422, error: check.error }
      : { ok: false, status: 502, error: `The response could not be validated by the engine: ${check.error}. Nothing was saved.` };
  }

  const received_at = now();
  const added = await rpc<ResponseRow>("gf_add_response", {
    p: { package_id: pkg.id, project_id: project.id, supplier, response: { ...body, supplier }, received_at },
    p_event: ev("supplier_response_received", "project_token_holder", {
      package_token,
      case_token: pkg.case_token,
      architecture: pkg.architecture,
      supplier,
    }),
  });
  if (!added.ok && (added.code === "23505" || added.status === 409)) {
    return { ok: false, status: 409, error: `A response from ${supplier} is already recorded for this package.` };
  }
  if (!added.ok || !added.data) return { ok: false, status: 502, error: "The response could not be saved. Nothing was recorded." };
  return { ok: true, response: added.data };
}

// ---------------------------------------------------------------- comparison

/** Run the existing comparison over every stored response and persist the result as a
 * new immutable row. Earlier comparisons are kept, never overwritten. */
export async function runPackageComparison(
  project: ProjectRow,
  package_token: string
): Promise<Result<{ comparison: ComparisonRow }>> {
  const loaded = await loadPackage(project, package_token);
  if (!loaded.ok) return loaded;
  const pkg = loaded.pkg;
  const rs = await packageResponses(pkg);
  if (!rs.ok) return rs;
  if (rs.responses.length === 0) {
    return { ok: false, status: 422, error: "There are no supplier responses to compare yet." };
  }
  const req = await packageRequest(pkg);
  if (!req.ok) return req;

  const engine = await callEngine("/v1/power/deploy/bids", {
    ...req.request,
    architecture: pkg.architecture,
    project: project.project_name,
    responses: rs.responses.map((r) => r.response),
  });
  if (!engine.ok) {
    return {
      ok: false,
      status: engine.status === 422 ? 422 : 502,
      error: `The comparison could not be produced: ${engine.error}. Nothing was saved.`,
    };
  }

  const added = await rpc<ComparisonRow>("gf_add_comparison", {
    p: {
      package_id: pkg.id,
      project_id: project.id,
      case_token: pkg.case_token,
      case_revision: pkg.case_revision,
      architecture: pkg.architecture,
      response_ids: rs.responses.map((r) => r.id),
      result: engine.body,
      created_at: now(),
    },
    p_event: ev("comparison_completed", "project_token_holder", {
      package_token,
      case_token: pkg.case_token,
      architecture: pkg.architecture,
      supplier_count: rs.responses.length,
      leading: (engine.body as { leading?: string | null }).leading ?? null,
    }),
  });
  if (!added.ok || !added.data) {
    return { ok: false, status: 502, error: "The comparison was produced but could not be saved. It was not persisted." };
  }
  return { ok: true, comparison: added.data };
}

// ---------------------------------------------------------------- selection

/**
 * A human picks a supplier. This writes the selection onto the package and appends
 * `supplier_selected`; the comparison row is not touched, so the ranking the
 * decision was taken against stays reproducible. Selecting rank 3 does not make it
 * rank 1 — the event records where the chosen supplier actually ranked.
 */
export async function selectSupplier(
  project: ProjectRow,
  package_token: string,
  input: { supplier: unknown; actor: unknown }
): Promise<Result<{ package: PackageRow; rank_at_selection: number | null }>> {
  const loaded = await loadPackage(project, package_token);
  if (!loaded.ok) return loaded;
  const pkg = loaded.pkg;
  if (pkg.selected_supplier) {
    return { ok: false, status: 409, error: "A supplier has already been selected for this package." };
  }
  const supplier = typeof input.supplier === "string" ? input.supplier.trim() : "";
  const actor = typeof input.actor === "string" ? input.actor.trim() : "";
  if (!supplier) return { ok: false, status: 422, error: "Name the supplier to select." };
  if (!actor || actor.length > 120) {
    return { ok: false, status: 422, error: "Selection is a decision by a person: say who is selecting (actor)." };
  }

  const cmp = await latestComparison(pkg);
  if (!cmp.ok) return cmp;
  if (!cmp.comparison) {
    return { ok: false, status: 409, error: "Run the comparison before selecting a supplier." };
  }
  const ranked = cmp.comparison.result.ranked ?? [];
  const row = ranked.find((r) => r.supplier.toLowerCase() === supplier.toLowerCase());
  if (!row) {
    return { ok: false, status: 409, error: "That supplier is not in the latest comparison." };
  }
  if (row.disqualified) {
    return { ok: false, status: 409, error: `${row.supplier}'s response was disqualified as incomplete and cannot be selected.` };
  }
  const responses = await packageResponses(pkg);
  if (!responses.ok) return responses;
  const resp = responses.responses.find((r) => r.supplier.toLowerCase() === row.supplier.toLowerCase());

  const selected_at = now();
  const upd = await rpc<PackageRow | null>("gf_select_supplier", {
    p_package: pkg.id,
    p: {
      selected_supplier: row.supplier,
      selected_response_id: resp?.id ?? null,
      selected_comparison_id: cmp.comparison.id,
      selected_at,
      selected_by: actor,
    },
    p_event: ev("supplier_selected", actor, {
      supplier: row.supplier,
      package_token,
      case_token: pkg.case_token,
      case_revision: pkg.case_revision,
      architecture: pkg.architecture,
      comparison_id: cmp.comparison.id,
      response_id: resp?.id ?? null,
      selected_at,
      rank_at_selection: row.rank,
      was_leading: cmp.comparison.result.leading === row.supplier,
      compliant: row.compliant ?? null,
    }),
  });
  if (!upd.ok) return { ok: false, status: 502, error: "The selection could not be saved. Nothing was recorded." };
  // null: another selection landed first; the function wrote nothing.
  if (!upd.data) return { ok: false, status: 409, error: "A supplier has already been selected for this package." };
  return { ok: true, package: upd.data, rank_at_selection: row.rank };
}
