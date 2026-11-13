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
import { logPublicationRefusal, publicationRefusal } from "@/lib/calibration-gate-errors";
import { siteRefFromEnv } from "@/lib/site-ref";
import { GATE_BY_ID, LEDGER_GATES, RECORD_SHAPE, type ConditionGroup, type GateResult } from "@/lib/calibration-gates";
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

/** Where an observation's data came from (migration 0047). Only 'production' can reach the calibration ledger. */
export const DATA_ORIGINS = ["production", "test", "synthetic", "unclassified"] as const;
export type DataOrigin = (typeof DATA_ORIGINS)[number];

/**
 * The origin the SERVER stamps on a new observation; a request body is never read for it. 'production' only on a production
 * deployment (Vercel sets VERCEL_ENV), 'test' everywhere else: a preview, a developer machine and the test suite share a database
 * with no claim to be real. GRIDFORGE_DATA_ORIGIN may state 'test' or 'synthetic' explicitly (a demo or generator run against a
 * production deployment); it can never promote a non-production deployment to production, and anything else in it is ignored.
 */
export function dataOrigin(env: Record<string, string | undefined> = process.env): DataOrigin {
  const declared = env.GRIDFORGE_DATA_ORIGIN;
  if (declared === "test" || declared === "synthetic") return declared;
  return env.VERCEL_ENV === "production" ? "production" : "test";
}

/**
 * The forecast must predate the outcome: the stored case revision was created before the START (00:00 UTC) of the date the
 * measurement covers. A forecast made on the day of the measurement does not predate it. Mirrors migration 0046, which refuses the
 * insert and which the ledger view applies again. Null when it does; otherwise why not.
 */
export function forecastPredatesOutcome(createdAt: unknown, observedOn: string): string | null {
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) {
    return "That case revision has no recorded creation time, so it cannot be shown to predate the outcome.";
  }
  if (Date.parse(createdAt) >= Date.parse(`${observedOn}T00:00:00Z`)) {
    return "The forecast must predate the outcome: that case revision was created at or after the start of the date you measured, so it cannot be reconciled against it. Reconcile a forecast that was made before the measurement.";
  }
  return null;
}

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
  /** Absent on rows read from a store that predates migration 0047; such a row is never ledger-eligible. */
  data_origin?: DataOrigin;
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
  // Calibration is only worth anything if the prediction was fixed before reality answered it (the database enforces this too).
  const late = forecastPredatesOutcome(row.created_at, observed_on);
  if (late) return { ok: false, status: 422, error: late };
  // A revision written before the freeze (0046) has no digest: nothing shows its forecast was not rewritten, so it is not reported on.
  if (typeof row.case_digest !== "string" || !/^[0-9a-f]{64}$/.test(row.case_digest)) {
    return { ok: false, status: 422, error: "That case revision was written before forecasts were frozen (it has no case_digest), so nothing shows it was not rewritten and it cannot be reconciled. Re-run the case to make a new revision." };
  }

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

  // The site reference is computed HERE under a server secret (lib/site-ref.ts), never by the database from the bare label and never from the request.
  // A production deployment with no secret refuses, before anything is written.
  const siteRef = siteRefFromEnv(project.site_label);
  if (!siteRef.ok) return { ok: false, status: 503, error: siteRef.error };

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
      // party can be refused; the prediction's engine digest is read by the database, not sent.
      submitted_by_ref: createHash("sha256").update(project.project_token).digest("hex"),
      // Stamped by the server, never read from the request: production only on a production deployment (see dataOrigin).
      data_origin: dataOrigin(),
      // The salted site reference (migration 0053 stores it; before 0053 the database ignores this key and derives the unsalted one). Absent
      // when the project has no site label: the database then stores none, and the observation can never be exported.
      ...(siteRef.ref ? { site_ref: siteRef.ref } : {}),
    },
    p_event: ev("observation_submitted", submitted_by, {}),
  });
  if (!added.ok || !added.data) {
    // 0056's gates (GF015 consent, GF016 completion milestone, GF017 withdrawn): said in words that name what is missing and who supplies it, never
    // the database's own text; the cause goes to the log.
    const gate = added.ok === false ? publicationRefusal(added.code) : null;
    if (gate) {
      logPublicationRefusal(gate, "observation", project.id);
      return { ok: false, status: gate.status, error: gate.error };
    }
    if (added.ok === false && added.code === "23505") {
      return { ok: false, status: 409, error: "An observation of this prediction for that date is already recorded." };
    }
    if (added.ok === false && added.code === "GF004") {
      return { ok: false, status: 422, error: "The forecast was refused as the basis for this outcome: it must predate the outcome, be frozen, hold the predicted value, and the outcome cannot be dated in the future." };
    }
    if (added.ok === false && (added.code === "23502" || added.code === "23514")) {
      return { ok: false, status: 422, error: "The observation was refused: it needs its evidence artifact, the installed-architecture attestation and a measurement kind, and its values must be physical." };
    }
    if (added.ok === false && added.code === "23503") {
      return { ok: false, status: 403, error: "That evidence does not belong to this project." };
    }
    return { ok: false, status: 502, error: "The observation could not be saved. Nothing was recorded." };
  }
  // Feature detection, honestly reported: a database that has not had 0053 applied ignores the key and stores the UNSALTED hash. The observation is
  // still valid; the log says its reference is the old, guessable kind so the operator can see that 0053 is still to be applied.
  if (siteRef.ref && added.data.site_ref !== siteRef.ref) {
    console.warn("[GridForge] gf_submit_observation did not keep the salted site_ref (migration 0053 is not applied): this observation's site reference is the UNSALTED legacy hash.");
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
 * reviewer who is not the submitter; and (0047) a production data origin and a standing permission from the project's owner.
 * The forecast-before-outcome rule (0046) is enforced when an observation is stored and again by the view; it is not restated here.
 * The VIEW is the authority, this only explains it: `standing` must be read from calibration_permissions, and an absent one is
 * treated as "no permission on record", the safe direction.
 */
export type PermissionStanding = "granted" | "revoked" | "none" | "unknown";

export function ledgerBlockers(
  o: Pick<ObservationRow, "measurement_kind" | "site_ref" | "engine_provenance_digest" | "submitted_by" | "data_origin">,
  r: Pick<ReviewRow, "decision" | "evidence_class" | "reviewer" | "evidence_sha256"> | null | undefined,
  evidence: { review_status: string; sha256: string } | null | undefined,
  standing?: PermissionStanding
): string[] {
  return blockerDetails(o, r, evidence, standing, false).map((b) => b.reason);
}

interface Blocker {
  gate: ConditionGroup;
  reason: string;
}

/**
 * The blockers `ledgerBlockers` names, each filed under the gate it belongs to. `full` keeps going when the observation has no verified
 * review, so the other gates can still be read: without it the first answer is "not reviewed yet" or "rejected", as before.
 */
function blockerDetails(
  o: Pick<ObservationRow, "measurement_kind" | "site_ref" | "engine_provenance_digest" | "submitted_by" | "data_origin">,
  r: Pick<ReviewRow, "decision" | "evidence_class" | "reviewer" | "evidence_sha256"> | null | undefined,
  evidence: { review_status: string; sha256: string } | null | undefined,
  standing: PermissionStanding | undefined,
  full: boolean
): Blocker[] {
  const why: Blocker[] = [];
  const add = (gate: ConditionGroup, reason: string) => why.push({ gate, reason });
  const reviewed = Boolean(r) && r?.decision === "verified";
  if (!r) {
    add("independent_review", "not reviewed yet");
    if (!full) return why;
  } else if (r.decision !== "verified") {
    add("independent_review", "rejected by the reviewer");
    if (!full) return why;
  }
  if (r && reviewed) {
    if (r.evidence_class !== REVIEW_CLASS) add("independent_review", `evidence class is not ${REVIEW_CLASS}`);
  }
  if (o.measurement_kind === null || !(MEASUREMENT_KINDS as readonly string[]).includes(o.measurement_kind)) {
    add("record_shape", "no measurement kind was recorded");
  }
  if (!o.site_ref) add("record_shape", "the project has no site label, so there is no site reference");
  if (!o.engine_provenance_digest) add("record_shape", "the prediction's engine build was not recorded");
  if (r && reviewed && !r.evidence_sha256) add("file_decision", "the review did not record the evidence digest");
  if (!evidence || evidence.review_status !== "verified") add("file_decision", "the evidence artifact is not verified");
  else if (r && reviewed && r.evidence_sha256 && evidence.sha256 !== r.evidence_sha256) add("file_decision", "the evidence artifact changed after review");
  if (r && reviewed && r.reviewer.trim().toLowerCase() === o.submitted_by.trim().toLowerCase()) add("independent_review", "reviewer is the submitter");
  if (o.data_origin !== "production") add("production_origin", `the data origin is not production (${o.data_origin ?? "not recorded"})`);
  if (standing === "revoked") add("owner_permission", "the project's permission to share its measurements was revoked");
  else if (standing === "unknown") add("owner_permission", "the project's permission record could not be read");
  else if (standing !== "granted") add("owner_permission", "no permission from the project's owner to share its measurements is on record");
  return why;
}

export function ledgerEligible(
  o: Parameters<typeof ledgerBlockers>[0],
  r: Parameters<typeof ledgerBlockers>[1],
  evidence: Parameters<typeof ledgerBlockers>[2],
  standing?: PermissionStanding
): boolean {
  return ledgerBlockers(o, r, evidence, standing).length === 0;
}

// --- the whole checklist ------------------------------------------------------------------------------------------------------
//
// `ledgerBlockers` is what the project panel shows to the holder of a project link. It cannot see two things the export view also requires:
// a recorded file decision (project_evidence_reviews) and the project's site history (hall_project_attachments joined to sites). An
// administrator can, with the service role. `ledgerGateChecklist` is `ledgerBlockers` plus those two, plus a read of the stored forecast,
// reported gate by gate as met / not met / cannot be read. A record that could not be read is never "met".
//
// Neither reads the three PUBLICATION conditions migration 0056 adds to the view (the organisation's standing consent, the project's attested
// completion milestone, no withdrawal; lib/calibration-gates.ts PUBLICATION_CONDITIONS). The database refuses to RECORD a production observation
// without the first two, so a row that exists had them when it was stored; a later withdrawal takes it out of the view while the checks here still
// pass, which is why the panel says only that the export view makes the final decision. Reading them here is open work (docs/CALIBRATION_GATES_RUNBOOK.md).

/** What project_evidence_reviews holds for the observation's evidence file. */
export type FileDecisionRead = "unreadable" | "none" | { decision: "verified" | "rejected"; sha256_confirmed: string | null };
/** What hall_project_attachments joined to sites says about the project: how many attachments there are, and how many are to a non-production site. */
export type SiteOriginRead = "unreadable" | { attachments: number; nonProduction: number };
/** The stored case revision the prediction came from (its request and result are not read here). */
export type ForecastRead = "unreadable" | "missing" | { created_at: string | null; case_digest: string | null };

export interface GateInputs {
  standing: PermissionStanding;
  fileDecision: FileDecisionRead;
  siteOrigin: SiteOriginRead;
  forecast: ForecastRead;
}

type ChecklistObservation = Pick<ObservationRow, "measurement_kind" | "site_ref" | "engine_provenance_digest" | "submitted_by" | "data_origin" | "observed_on">;
type ChecklistReview = Pick<ReviewRow, "decision" | "evidence_class" | "reviewer" | "evidence_sha256">;

const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Every gate the final export view enforces (lib/calibration-gates.ts), each as met / not met / cannot be read with the reason, in the
 * order the public page lists them, then the shape of the record. The view is still the authority and a person still imports; this is
 * what an administrator reads to see what blocks a row. One thing is checked only in part: the view recomputes the forecast's digest and
 * its predicted value from the stored request and result, which this does not, so a forecast that passes here is marked `partial`.
 */
export function ledgerGateChecklist(
  o: ChecklistObservation,
  r: ChecklistReview | null | undefined,
  evidence: { review_status: string; sha256: string } | null | undefined,
  inputs: GateInputs
): GateResult[] {
  const details = blockerDetails(o, r, evidence, inputs.standing, true);
  const of = (g: ConditionGroup) => details.filter((b) => b.gate === g).map((b) => b.reason);
  const result = (id: ConditionGroup, title: string, reasons: string[], met: string, partial?: boolean): GateResult =>
    reasons.length
      ? { id, title, status: "not_met", reason: reasons.join("; ") }
      : { id, title, status: "met", reason: met, ...(partial ? { partial: true } : {}) };
  const unreadable = (id: ConditionGroup, title: string, reason: string): GateResult => ({ id, title, status: "unreadable", reason });
  const title = (id: ConditionGroup) => (id === "record_shape" ? RECORD_SHAPE.title : GATE_BY_ID.get(id)!.title);
  const out: GateResult[] = [];

  for (const gate of LEDGER_GATES) {
    const id = gate.id;
    const t = title(id);
    switch (id) {
      case "independent_review":
        out.push(result(id, t, of(id), "Verified as E5 by a reviewer whose typed name differs from the submitter's."));
        break;
      case "frozen_forecast": {
        const f = inputs.forecast;
        if (f === "unreadable") out.push(unreadable(id, t, "The stored case revision could not be read."));
        else if (f === "missing") out.push({ id, title: t, status: "not_met", reason: "The case revision the prediction cites was not found." });
        else {
          const reasons: string[] = [];
          const late = forecastPredatesOutcome(f.created_at, o.observed_on);
          if (late) reasons.push(late);
          if (typeof f.case_digest !== "string" || !SHA256.test(f.case_digest)) reasons.push("The case revision carries no digest, so nothing shows it was not rewritten.");
          out.push(
            result(id, t, reasons, `Stored ${f.created_at} (before ${o.observed_on}, the date the submitter declared) and a digest is on record. Not checked here: that the digest still matches the stored forecast and that the predicted value is still its number. The export view checks both.`, true)
          );
        }
        break;
      }
      case "production_origin":
        out.push(result(id, t, of(id), "Recorded on a production deployment."));
        break;
      case "owner_permission":
        out.push(
          inputs.standing === "unknown"
            ? unreadable(id, t, "The permission record could not be read.")
            : result(id, t, of(id), "The newest permission record is a grant (an assertion an administrator recorded; not authenticated).")
        );
        break;
      case "file_decision": {
        const d = inputs.fileDecision;
        if (d === "unreadable") {
          out.push(unreadable(id, t, "The file decision record could not be read."));
          break;
        }
        const reasons = of(id);
        if (d === "none") reasons.push("no file decision is on record");
        else if (d.decision !== "verified") reasons.push("the file was rejected");
        else if (evidence && d.sha256_confirmed !== evidence.sha256) reasons.push("the digest confirmed by the file decision differs from the file's stored digest");
        if (!r) reasons.push("the observation has not been reviewed, so the digest its reviewer saw is not recorded yet");
        out.push(result(id, t, reasons, "A verified file decision is on record, its confirmed digest equals the stored one, and the reviewer recorded that digest."));
        break;
      }
      case "never_test_site": {
        const s = inputs.siteOrigin;
        if (s === "unreadable") out.push(unreadable(id, t, "The project's site history could not be read."));
        else if (s.nonProduction > 0) {
          out.push({ id, title: t, status: "not_met", reason: `The project has been filed under a test or synthetic site (${s.nonProduction} attachment${s.nonProduction === 1 ? "" : "s"}); detaching does not undo it.` });
        } else {
          out.push({ id, title: t, status: "met", reason: s.attachments === 0 ? "The project has never been filed under any site." : `All ${s.attachments} site attachment${s.attachments === 1 ? "" : "s"} are to production sites.` });
        }
        break;
      }
    }
  }
  out.push(result("record_shape", title("record_shape"), of("record_shape"), "Metric, measurement kind, site reference and engine build digest are all recorded."));
  return out;
}

/** The checklist as sentences, for what is not met or could not be read. Empty only when every gate was read and met. */
export function exportBlockers(gates: readonly GateResult[]): string[] {
  return gates.filter((g) => g.status !== "met").map((g) => `${g.title}: ${g.reason}`);
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

const HEX64 = /^[0-9a-f]{64}$/;
const TOMBSTONE_PAGE = 1000;
const TOMBSTONE_PAGES_MAX = 100;

/**
 * Every observation withdrawn with its organisation's consent (migration 0056 `calibration_tombstones`), as the sha256 of its id and NOTHING else: no
 * organisation, no time, no content. The export carries them so that an operator who imports it (`gridforge calibrate import`, a person running a command on a
 * saved file: the importer reads no network) RECORDS them in the side file beside the private ledger (gridforge/calibration/tombstones.py, ledger.py
 * import_export), after which every read of the ledger leaves the withdrawn rows out and the same observation cannot be imported again. Until that import
 * (or `gridforge calibrate withdraw <hash>`) the private ledger still counts what it already holds, and an export file saved before the withdrawal is refused
 * only once its tombstones are recorded: the importer cannot know what the database has not told it.
 *
 * Read in full or not at all: a list cut short would let a withdrawn observation come back, so a page that fills the limit is followed by the next, more
 * than TOMBSTONE_PAGES_MAX pages is refused, and any other failure is a failure of the export. The one answer taken as "none": the table is not there
 * (404, undefined relation: migration 0056 has not been applied, so no withdrawal can have been recorded).
 */
async function readTombstones(): Promise<{ ok: true; hashes: string[] } | { ok: false }> {
  const hashes: string[] = [];
  for (let page = 0; page < TOMBSTONE_PAGES_MAX; page++) {
    const r = await rest<{ observation_hash?: unknown }[]>(
      "GET",
      `calibration_tombstones?select=observation_hash&order=observation_hash.asc&limit=${TOMBSTONE_PAGE}&offset=${page * TOMBSTONE_PAGE}`
    );
    if (!r.ok) return page === 0 && r.status === 404 && (r.code === "42P01" || r.code === "PGRST205") ? { ok: true, hashes: [] } : { ok: false };
    const rows = r.data ?? [];
    for (const x of rows) {
      if (typeof x.observation_hash !== "string" || !HEX64.test(x.observation_hash)) return { ok: false };
      hashes.push(x.observation_hash);
    }
    if (rows.length < TOMBSTONE_PAGE) return { ok: true, hashes };
  }
  return { ok: false };
}

/**
 * The rows `gridforge calibrate import` may take, and only those. Read through a database view that encodes the gates
 * (see `ledgerEligible`); this adds a finiteness check and nothing else. With none verified the list is empty and the
 * ledger stays empty. Nothing here imports anything: a person runs the CLI on the saved file.
 *
 * `tombstones` (additive) lists the hash of every observation withdrawn with its organisation's consent, which the importer refuses and the ledger leaves out.
 */
export async function calibrationExport(): Promise<
  Result<{ schema: typeof EXPORT_SCHEMA; count: number; rows: CalibrationExportRow[]; tombstones: string[]; reviewer_identity: string }>
> {
  if (!creds()) return STORE_UNCONFIGURED;
  const r = await rest<Record<string, unknown>[]>("GET", "calibration_ledger_rows?select=*&order=reviewed_at.asc");
  if (!r.ok) return { ok: false, status: 502, error: "The calibration export could not be read. Nothing was exported." };
  const withdrawn = await readTombstones();
  if (!withdrawn.ok) return { ok: false, status: 502, error: "The list of withdrawn observations could not be read in full. Nothing was exported." };
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
    tombstones: withdrawn.hashes,
    reviewer_identity: "self-asserted: one shared admin password exists; reviewed_by is the name the reviewer typed",
  };
}

