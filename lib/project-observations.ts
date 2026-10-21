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

import { createHash } from "node:crypto";
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
    /** A physical sanity bound on what may be reported, in this unit: above it the number is a typo, not a plant. */
    max: 10_000,
    read: (arch: Record<string, unknown>): number | null =>
      typeof arch.available_MW === "number" && Number.isFinite(arch.available_MW) ? arch.available_MW : null,
    source: (label: string) => `result.architectures["${label}"].available_MW`,
  },
} as const;

export type ObservationKey = keyof typeof OBSERVATION_METRICS;

export const EVIDENCE_CLASSES = ["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"] as const;
/**
 * The ONE class a reviewer may assign to a measured observation. E6 and E7 are outputs of computation (a model
 * reconciled against the ledger, a deployed system), not of a person's review; anything weaker than E5 is a
 * rejection, not a verification. The database refuses everything else.
 */
export const REVIEW_CLASS = "E5";
/** How a measurement was made. A quote, an assumed value and a simulation have no kind: they are not measurements. */
export const MEASUREMENT_KINDS = ["metered", "bms_trend", "commissioning_record"] as const;
export type MeasurementKind = (typeof MEASUREMENT_KINDS)[number];
export const EXPORT_SCHEMA = "gridforge/calibration-export/1";

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
  /** Null on rows written before migration 0038; such a row is never ledger-eligible. */
  measurement_kind: MeasurementKind | null;
  /** Site-only reference derived by the database from the project's site label. */
  site_ref: string | null;
  /** The engine build that produced the prediction, from the case revision; null when none was stored. */
  engine_provenance_digest: string | null;
  report_date: string | null;
  submitted_by_ref: string | null;
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
  /** The evidence artifact's digest at the moment the reviewer vouched for it (null for reviews before 0038). */
  evidence_sha256: string | null;
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
  if (typeof observed !== "number" || !Number.isFinite(observed) || observed <= 0 || observed > metric.max) {
    return { ok: false, status: 422, error: `observed_value must be a positive number of ${metric.unit} you measured (at most ${metric.max}).` };
  }
  // What kind of measurement it is. A vendor quote, an assumed value or a simulation is not a measurement and
  // has no kind, so it cannot be entered here at all.
  const measurement_kind = typeof input.measurement_kind === "string" ? input.measurement_kind : "";
  if (!(MEASUREMENT_KINDS as readonly string[]).includes(measurement_kind)) {
    return {
      ok: false,
      status: 422,
      error: `measurement_kind is required: ${MEASUREMENT_KINDS.join(", ")}. A vendor quote, an assumed value or a simulation is not a measurement.`,
    };
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
      measurement_kind,
      // Who submitted, as far as the site can know it: the project token's hash. Stored so a review by the same
      // party can be refused; the site_ref and the prediction's engine digest are read by the database, not sent.
      submitted_by_ref: createHash("sha256").update(project.project_token).digest("hex"),
    },
    p_event: ev("observation_submitted", submitted_by, {}),
  });
  if (!added.ok || !added.data) {
    if (added.ok === false && added.code === "23505") {
      return { ok: false, status: 409, error: "An observation of this prediction for that date is already recorded." };
    }
    if (added.ok === false && (added.code === "23502" || added.code === "23514")) {
      return { ok: false, status: 422, error: "The observation was refused: it needs its evidence artifact, the installed-architecture attestation and a measurement kind, and its values must be physical." };
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
  // Self-asserted: the admin console has one shared password, so this is the name the reviewer typed, not an
  // authenticated identity. It is stored and shown as such.
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
    if (input.evidence_class !== REVIEW_CLASS) {
      return {
        ok: false,
        status: 422,
        error: `A reviewer may assign only ${REVIEW_CLASS} to a measured observation (E6 and E7 are computation outputs; weaker data is a rejection).`,
      };
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
    if (done.ok === false && done.code === "GF001") {
      return { ok: false, status: 403, error: "A submission cannot be reviewed by the person who submitted it." };
    }
    if (done.ok === false && done.code === "GF002") {
      return { ok: false, status: 409, error: "The supporting evidence artifact is not verified, so this observation cannot be verified. Reject it, or verify the artifact first." };
    }
    if (done.ok === false && done.code === "GF003") {
      return { ok: false, status: 422, error: `A reviewer may assign only ${REVIEW_CLASS} to a measured observation.` };
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

/**
 * Whether a reviewed observation clears every gate the ledger applies. A person still imports it.
 * Mirrors the `calibration_ledger_rows` view (migration 0038): verified, E5 only, a measurement kind, a site, the
 * engine digest of the prediction, an evidence artifact that is verified now and is the one the reviewer saw, and a
 * reviewer who is not the submitter.
 */
export function ledgerBlockers(
  o: Pick<ObservationRow, "measurement_kind" | "site_ref" | "engine_provenance_digest" | "submitted_by">,
  r: Pick<ReviewRow, "decision" | "evidence_class" | "reviewer" | "evidence_sha256"> | null | undefined,
  evidence: { review_status: string; sha256: string } | null | undefined
): string[] {
  if (!r) return ["not reviewed yet"];
  if (r.decision !== "verified") return ["rejected by the reviewer"];
  const why: string[] = [];
  if (r.evidence_class !== REVIEW_CLASS) why.push(`evidence class is not ${REVIEW_CLASS}`);
  if (o.measurement_kind === null || !(MEASUREMENT_KINDS as readonly string[]).includes(o.measurement_kind)) {
    why.push("no measurement kind was recorded");
  }
  if (!o.site_ref) why.push("the project has no site label, so there is no site reference");
  if (!o.engine_provenance_digest) why.push("the prediction's engine build was not recorded");
  if (!r.evidence_sha256) why.push("the review did not record the evidence digest");
  if (!evidence || evidence.review_status !== "verified") why.push("the evidence artifact is not verified");
  else if (r.evidence_sha256 && evidence.sha256 !== r.evidence_sha256) why.push("the evidence artifact changed after review");
  if (r.reviewer.trim().toLowerCase() === o.submitted_by.trim().toLowerCase()) why.push("reviewer is the submitter");
  return why;
}

export function ledgerEligible(
  o: Parameters<typeof ledgerBlockers>[0],
  r: Parameters<typeof ledgerBlockers>[1],
  evidence: Parameters<typeof ledgerBlockers>[2]
): boolean {
  return ledgerBlockers(o, r, evidence).length === 0;
}

export interface CalibrationExportRow {
  id: string;
  key: string;
  observed_value: number;
  predicted_value: number;
  unit: string;
  site_ref: string;
  measurement_kind: MeasurementKind;
  evidence_sha256: string;
  engine_provenance_digest: string;
  report_date: string | null;
  observed_on: string;
  method: string;
  evidence_class: string;
  reviewed_by: string;
  reviewed_at: string;
}

/**
 * The rows `gridforge calibrate import` may take, and only those. Read through a database view that encodes the gates
 * (see `ledgerEligible`); this adds a finiteness check and nothing else. With none verified the list is empty and the
 * ledger stays empty. Nothing here imports anything: a person runs the CLI on the saved file.
 */
export async function calibrationExport(): Promise<
  Result<{ schema: typeof EXPORT_SCHEMA; count: number; rows: CalibrationExportRow[]; reviewer_identity: string }>
> {
  if (!creds()) return STORE_UNCONFIGURED;
  const r = await rest<Record<string, unknown>[]>("GET", "calibration_ledger_rows?select=*&order=reviewed_at.asc");
  if (!r.ok) return { ok: false, status: 502, error: "The calibration export could not be read. Nothing was exported." };
  const rows: CalibrationExportRow[] = [];
  for (const x of r.data ?? []) {
    const observed = Number(x.observed_value);
    const predicted = Number(x.predicted_value);
    // A row that cannot be stated as finite numbers is dropped, never repaired.
    if (!Number.isFinite(observed) || !Number.isFinite(predicted)) continue;
    rows.push({
      id: String(x.id), key: String(x.key), observed_value: observed, predicted_value: predicted, unit: String(x.unit),
      site_ref: String(x.site_ref), measurement_kind: x.measurement_kind as MeasurementKind,
      evidence_sha256: String(x.evidence_sha256), engine_provenance_digest: String(x.engine_provenance_digest),
      report_date: x.report_date === null || x.report_date === undefined ? null : String(x.report_date),
      observed_on: String(x.observed_on), method: String(x.method), evidence_class: String(x.evidence_class),
      reviewed_by: String(x.reviewed_by), reviewed_at: String(x.reviewed_at),
    });
  }
  return {
    ok: true,
    schema: EXPORT_SCHEMA,
    count: rows.length,
    rows,
    reviewer_identity: "self-asserted: one shared admin password exists; reviewed_by is the name the reviewer typed",
  };
}

