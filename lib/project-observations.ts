// Server-only: observed reality against a stored prediction — the first typed step from a
// project toward the calibration ledger.
//
//   exact prediction (case, revision, architecture) -> submitted observation -> human review
//
// What this deliberately does NOT do: it never writes the calibration ledger, never assigns an
// evidence class on its own, and never accepts a predicted value from a caller. The expected value
// is READ from the stored engine result at an immutable case revision; the caller supplies only
// what was measured, when, how, and from which attached artifact. A submission carries no evidence
// class at all — only a separate, immutable, human review does. A verified observation of class E5
// or above is what the existing `gridforge calibrate add` would accept; that final step stays a
// person's, so the ledger's observation count is untouched by anything in this file.

import { deploymentCaseRevision, latestDeploymentCase } from "@/lib/power-deploy";
import {
  creds,
  ev,
  linksFor,
  predictionRef,
  rest,
  rpc,
  STORE_UNCONFIGURED,
  type ProjectRow,
  type Result,
} from "@/lib/projects";


/** What may be reconciled. One metric, because only the engine's own result is a model prediction. */
export const OBSERVATION_METRICS = {
  "btm.firm_MW": {
    unit: "MW",
    label: "Firm MW the delivered architecture actually holds under its contingency case",
    // Where the prediction lives in the stored result, as the record states it.
    read: (arch: Record<string, unknown>): number | null =>
      typeof arch.available_MW === "number" && Number.isFinite(arch.available_MW) ? arch.available_MW : null,
    source: (label: string) => `result.architectures["${label}"].available_MW`,
  },
} as const;

export type ObservationKey = keyof typeof OBSERVATION_METRICS;

export const EVIDENCE_CLASSES = ["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"] as const;
/** The lowest class `gridforge calibrate add` accepts: site data, never another run of the model. */
export const LEDGER_MINIMUM_CLASS = "E5";

export interface ObservationRow {
  id: string;
  project_id: string;
  prediction_ref: string;
  case_token: string;
  case_revision: number;
  architecture: string;
  calibration_key: ObservationKey;
  unit: string;
  predicted_value: number;
  predicted_source: string;
  observed_value: number;
  observed_on: string;
  method: string;
  evidence_id: string;
  installed_attested: boolean;
  installed_basis: string;
  note: string | null;
  submitted_by: string;
  submitted_at: string;
  delta_value: number;
  delta_pct: number;
}

export interface ReviewRow {
  id: string;
  observation_id: string;
  project_id: string;
  decision: "verified" | "rejected";
  evidence_class: string | null;
  reviewer: string;
  reason: string | null;
  reviewed_at: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Submit what was measured against an exact stored prediction. */
export async function submitObservation(
  project: ProjectRow,
  input: Record<string, unknown>
): Promise<Result<{ observation: ObservationRow }>> {
  if (!creds()) return STORE_UNCONFIGURED;

  const key = typeof input.calibration_key === "string" ? input.calibration_key : "";
  if (!(key in OBSERVATION_METRICS)) {
    return { ok: false, status: 422, error: `calibration_key must be one of ${Object.keys(OBSERVATION_METRICS).join(", ")}.` };
  }
  const metric = OBSERVATION_METRICS[key as ObservationKey];
  const case_token = typeof input.case_token === "string" ? input.case_token : "";
  const architecture = typeof input.architecture === "string" ? input.architecture : "";
  if (!case_token || !architecture) {
    return { ok: false, status: 422, error: "case_token and architecture identify the prediction." };
  }
  const observed = input.observed_value;
  if (typeof observed !== "number" || !Number.isFinite(observed) || observed < 0) {
    return { ok: false, status: 422, error: "observed_value must be a non-negative number you measured." };
  }
  const observed_on = typeof input.observed_on === "string" ? input.observed_on : "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(observed_on) || Number.isNaN(Date.parse(observed_on))) {
    return { ok: false, status: 422, error: "observed_on must be the ISO date the measurement covers." };
  }
  if (observed_on > new Date().toISOString().slice(0, 10)) {
    return { ok: false, status: 422, error: "observed_on cannot be in the future." };
  }
  const method = typeof input.method === "string" ? input.method.trim() : "";
  if (!method || method.length > 500) {
    return { ok: false, status: 422, error: "method is required: how it was measured (at most 500 characters)." };
  }
  const submitted_by = typeof input.submitted_by === "string" ? input.submitted_by.trim() : "";
  if (!submitted_by || submitted_by.length > 120) {
    return { ok: false, status: 422, error: "submitted_by is required: who is reporting this measurement." };
  }
  // The source artifact is required: observations are immutable, so one accepted without a source could
  // never be verified and could not be resubmitted. Attach the evidence first.
  const evidence_id = typeof input.evidence_id === "string" ? input.evidence_id : "";
  if (!UUID.test(evidence_id)) {
    return { ok: false, status: 422, error: "evidence_id is required: attach the measurement's source artifact to this project first." };
  }
  // An affirmative statement that this is the architecture actually installed. A generated RFQ, a selected
  // supplier or a passing assessment is not evidence of installation, and nothing here infers it.
  if (input.attests_installed_architecture !== true) {
    return { ok: false, status: 422, error: "attests_installed_architecture must be true: confirm this measurement is of the architecture actually installed." };
  }
  const installed_basis = typeof input.installed_basis === "string" ? input.installed_basis.trim() : "";
  if (!installed_basis || installed_basis.length > 500) {
    return { ok: false, status: 422, error: "installed_basis is required: how you know it is installed (commissioning record, site visit, handover) — at most 500 characters." };
  }
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 500) || null : null;

  // The prediction must belong to a case this project holds.
  const links = await linksFor("power_deployment_case", case_token);
  if (!links.ok) return links;
  if (!links.links.some((l) => l.project_id === project.id)) {
    return { ok: false, status: 403, error: "That case is not attached to this project." };
  }
  // Which revision was predicted: the one named, else the latest — and it must exist.
  let revision = typeof input.case_revision === "number" ? input.case_revision : null;
  if (revision === null) {
    const latest = await latestDeploymentCase(case_token);
    if (!latest) return { ok: false, status: 404, error: "That case was not found." };
    revision = latest.revision;
  }
  if (!Number.isInteger(revision) || revision < 1) {
    return { ok: false, status: 422, error: "case_revision must be a revision number." };
  }
  const row = await deploymentCaseRevision(case_token, revision);
  if (!row) return { ok: false, status: 404, error: "That case revision was not found." };

  // The expected value comes from the engine's stored result — never from the caller.
  const archs = ((row.result as { architectures?: Record<string, unknown>[] }).architectures ?? []);
  const arch = archs.find((a) => a.label === architecture);
  if (!arch) return { ok: false, status: 422, error: "That architecture is not part of this case revision." };
  const predicted = metric.read(arch);
  if (predicted === null || predicted <= 0) {
    return {
      ok: false,
      status: 422,
      error: "The stored result holds no positive prediction for that architecture, so there is nothing to reconcile against.",
    };
  }

  const added = await rpc<ObservationRow>("gf_submit_observation", {
    p: {
      project_id: project.id,
      prediction_ref: predictionRef(case_token, revision, architecture),
      case_token,
      case_revision: revision,
      architecture,
      calibration_key: key,
      unit: metric.unit,
      predicted_value: predicted,
      predicted_source: metric.source(architecture),
      observed_value: observed,
      observed_on,
      method,
      evidence_id,
      installed_attested: true,
      installed_basis,
      note,
      submitted_by,
    },
    p_event: ev("observation_submitted", submitted_by, {}),
  });
  if (!added.ok || !added.data) {
    if (added.ok === false && added.code === "23505") {
      return { ok: false, status: 409, error: "An observation of this prediction for that date is already recorded." };
    }
    if (added.ok === false && (added.code === "23502" || added.code === "23514")) {
      return { ok: false, status: 422, error: "The observation was refused: it needs its evidence artifact and the installed-architecture attestation." };
    }
    if (added.ok === false && added.code === "23503") {
      return { ok: false, status: 403, error: "That evidence does not belong to this project." };
    }
    return { ok: false, status: 502, error: "The observation could not be saved. Nothing was recorded." };
  }
  return { ok: true, observation: added.data };
}

/** A human decision on one submission. Called only from an admin-authenticated route. */
export async function reviewObservation(input: {
  observation_id: unknown;
  decision: unknown;
  evidence_class: unknown;
  reviewer: unknown;
  reason: unknown;
}): Promise<Result<{ review: ReviewRow }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const id = typeof input.observation_id === "string" ? input.observation_id : "";
  if (!UUID.test(id)) return { ok: false, status: 404, error: "Not found." };
  const decision = input.decision;
  if (decision !== "verified" && decision !== "rejected") {
    return { ok: false, status: 422, error: "decision must be 'verified' or 'rejected'." };
  }
  const reviewer = typeof input.reviewer === "string" ? input.reviewer.trim() : "";
  if (!reviewer || reviewer.length > 120) {
    return { ok: false, status: 422, error: "reviewer is required: the person taking this decision." };
  }
  let evidence_class: string | null = null;
  if (decision === "verified") {
    // Never inferred and never defaulted: the reviewer states the class.
    if (typeof input.evidence_class !== "string" || !(EVIDENCE_CLASSES as readonly string[]).includes(input.evidence_class)) {
      return { ok: false, status: 422, error: `A verified observation needs an evidence_class (${EVIDENCE_CLASSES.join(", ")}).` };
    }
    evidence_class = input.evidence_class;
  } else if (input.evidence_class != null && input.evidence_class !== "") {
    return { ok: false, status: 422, error: "A rejected observation carries no evidence class." };
  }
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) || null : null;

  const done = await rpc<ReviewRow>("gf_review_observation", {
    p: { observation_id: id, decision, evidence_class, reviewer, reason },
    p_event: ev("observation_reviewed", reviewer, {}),
  });
  if (!done.ok || !done.data) {
    if (done.ok === false && done.code === "23503") return { ok: false, status: 404, error: "Not found." };
    if (done.ok === false && done.code === "23505") {
      return { ok: false, status: 409, error: "This observation has already been reviewed." };
    }
    return { ok: false, status: 502, error: "The review could not be saved. Nothing was recorded." };
  }
  return { ok: true, review: done.data };
}

/** Every observation with its review, newest submission first — for the admin queue. */
export async function observationQueue(
  state: "pending" | "all"
): Promise<Result<{ items: { observation: ObservationRow; review: ReviewRow | null }[] }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const [o, r] = await Promise.all([
    rest<ObservationRow[]>("GET", "project_observations?select=*&order=submitted_at.desc"),
    rest<ReviewRow[]>("GET", "project_observation_reviews?select=*"),
  ]);
  if (!o.ok || !r.ok) return { ok: false, status: 502, error: "The observation queue could not be read." };
  const byObs = new Map((r.data ?? []).map((x) => [x.observation_id, x]));
  const items = (o.data ?? []).map((observation) => ({ observation, review: byObs.get(observation.id) ?? null }));
  return { ok: true, items: state === "pending" ? items.filter((i) => !i.review) : items };
}

