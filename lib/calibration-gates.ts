// What an observation must clear to reach the shared calibration ledger: ONE typed source for the public page (/evidence), the
// pointer on /reference and the administrator's checklist (/admin/reviews).
//
// The authority is the FINAL definition of the database view `calibration_ledger_rows` (supabase/migrations/0056, which holds 0052's definition
// plus three publication conditions). It applies the conditions listed in VIEW_CONDITIONS, one per line of the view, and each is filed under the
// gate it belongs to (or under the record's shape, or under the publication conditions 0056 adds). That list is
// asserted against two things by tests/site/calibration-gates.test.ts, so it cannot drift quietly:
//   * the keys of VIEW_GATES in tests/test_calibration_final_gate.py (the Python test that reads the view out of a database built by
//     the whole migration chain), and
//   * the SQL text of the migration that holds the final view (`sql` below is a fragment that must appear in it).
// Nothing here is imported from a server-only module: a client component and a public page both read it.

/** The six gates, in the order a reader meets them. */
export type GateId =
  | "independent_review"
  | "frozen_forecast"
  | "production_origin"
  | "owner_permission"
  | "file_decision"
  | "never_test_site";

/** The fixed shape of the record itself: not a decision anyone takes, so not counted among the gates. */
export type ConditionGroup = GateId | "record_shape";

/**
 * The three conditions migration 0056 adds to the view (the organisation's standing consent, the project's attested completion milestone, no
 * withdrawal). They are decisions people take, and they are NOT among the six gates above: the administrator's checklist
 * (lib/project-observations.ts ledgerGateChecklist) reads the six gates and the record's shape and does not read these three yet, so the view
 * alone enforces them. Kept apart from `ConditionGroup` so that nothing that walks the six gates can mistake them for one.
 */
export type PublicationGroup = "publication";

export interface ViewCondition {
  /** Exactly the key of VIEW_GATES in tests/test_calibration_final_gate.py. */
  label: string;
  group: ConditionGroup | PublicationGroup;
  /** A fragment (lower-case, whitespace collapsed) that appears in the migration holding the final view. */
  sql: string;
  /** How many top-level AND terms of the view's WHERE clause this condition covers (1 unless stated). */
  terms?: number;
}

/** Every condition the final view applies. 21 today: the 18 of 0052, then the three publication conditions 0056 adds after them. */
export const VIEW_CONDITIONS: readonly ViewCondition[] = [
  { label: "observation verified by a review", group: "independent_review", sql: "r.decision = 'verified'" },
  { label: "reviewed as E5 only", group: "independent_review", sql: "r.evidence_class = 'E5'" },
  { label: "reviewer is not the submitter", group: "independent_review", sql: "lower(btrim(r.reviewer)) <> lower(btrim(o.submitted_by))" },

  { label: "the forecast has a creation time", group: "frozen_forecast", sql: "c.created_at is not null" },
  { label: "the forecast predates the outcome", group: "frozen_forecast", sql: "c.created_at < (o.observed_on::timestamp at time zone 'utc')" },
  { label: "the forecast carries a digest", group: "frozen_forecast", sql: "c.case_digest is not null" },
  { label: "the forecast still matches its digest", group: "frozen_forecast", sql: "c.case_digest = encode(sha256(" },
  {
    label: "the prediction is the forecast's own number",
    group: "frozen_forecast",
    sql: "o.predicted_value = public.gf_forecast_predicted_mw(c.result, o.architecture)",
  },

  { label: "production origin", group: "production_origin", sql: "o.data_origin = 'production'" },

  {
    label: "the project's LATEST permission is a grant",
    group: "owner_permission",
    sql:
      "and exists ( select 1 from public.calibration_permissions cp where cp.scope_type = 'project' and cp.scope_id = o.project_id and cp.kind = 'granted' " +
      "and cp.seq = (select max(c2.seq) from public.calibration_permissions c2 where c2.scope_type = 'project' and c2.scope_id = o.project_id))",
  },

  { label: "the review recorded the evidence digest", group: "file_decision", sql: "r.evidence_sha256 is not null" },
  {
    label: "file status verified now and unchanged since the review",
    group: "file_decision",
    sql: "e.review_status = 'verified' and e.sha256 = r.evidence_sha256",
    terms: 2,
  },
  {
    label: "a verified decision row whose confirmed digest equals the stored one",
    group: "file_decision",
    sql:
      "and exists (select 1 from public.project_evidence_reviews er where er.evidence_id = e.id and er.decision = 'verified' and er.sha256_confirmed = e.sha256)",
  },

  {
    label: "the project was never filed under a non-production site",
    group: "never_test_site",
    sql:
      "and not exists ( select 1 from public.hall_project_attachments hpa join public.sites st on st.id = hpa.site_id " +
      "where hpa.project_id = o.project_id and st.data_origin <> 'production')",
  },

  { label: "a measurement kind", group: "record_shape", sql: "o.measurement_kind in ('metered', 'bms_trend', 'commissioning_record')" },
  { label: "the one reconcilable key in MW", group: "record_shape", sql: "o.calibration_key = 'btm.firm_mw' and o.unit = 'mw'", terms: 2 },
  { label: "a site reference", group: "record_shape", sql: "o.site_ref is not null" },
  { label: "the engine digest of the prediction", group: "record_shape", sql: "o.engine_provenance_digest is not null" },

  // 0056. Each is one top-level term of the view, after 0052's last one. None can be met by an observation recorded before 0056 (it has no organisation).
  {
    label: "the organisation's LATEST consent is a grant, and no withdrawal followed the consent the row was recorded under",
    group: "publication",
    sql:
      "and exists ( select 1 from public.calibration_consents cc where cc.organisation_id = o.organisation_id and cc.kind = 'granted' " +
      "and cc.seq = (select max(c3.seq) from public.calibration_consents c3 where c3.organisation_id = o.organisation_id)) " +
      "and exists ( select 1 from public.calibration_consents rc where rc.id = o.consent_id and rc.organisation_id = o.organisation_id and rc.kind = 'granted' " +
      "and not exists (select 1 from public.calibration_consents w where w.organisation_id = rc.organisation_id and w.kind = 'withdrawn' and w.seq > rc.seq))",
    terms: 2,
  },
  {
    label: "the project attested its completion milestone and no supplier record shows delivery in flight",
    group: "publication",
    sql:
      "and exists ( select 1 from public.project_completion_milestones pm where pm.project_id = o.project_id and pm.milestone = 'energised' " +
      "and pm.organisation_id = o.organisation_id and pm.reached_on <= o.observed_on " +
      "and not exists (select 1 from public.project_completion_milestones x where x.supersedes_id = pm.id) " +
      "and not public.gf_project_delivery_in_flight(o.project_id, o.observed_on))",
  },
  {
    label: "the observation was not withdrawn (no tombstone)",
    group: "publication",
    sql: "and not exists ( select 1 from public.calibration_tombstones tb where tb.observation_hash = public.gf_calibration_observation_hash(o.id))",
  },
];

export interface LedgerGate {
  id: GateId;
  /** What the gate asks, as a heading. */
  title: string;
  /** What the view requires, in plain words and no looser than the view. */
  rule: string;
  /** What passing it does NOT establish. */
  limit: string;
}

export const LEDGER_GATES: readonly LedgerGate[] = [
  {
    id: "independent_review",
    title: "An independent reviewer verified it as E5",
    rule:
      "A reviewer whose name differs from the submitter's (compared ignoring case and surrounding spaces) recorded a decision of verified, with class E5 and no other class, on the observation.",
    limit:
      "Both names are typed text: the admin console has one shared password, so neither is an authenticated identity. The database also refuses a review sent with the same project token as the submission, which stops one person reviewing their own submission by accident, not a determined one.",
  },
  {
    id: "frozen_forecast",
    title: "A frozen forecast, stored before the declared outcome date",
    rule:
      "The stored case revision the prediction came from was created before 00:00 UTC on the date the outcome is declared to cover, carries a digest that still equals the digest of its stored request and result, and the predicted value is still the number that stored result holds for that architecture.",
    limit:
      "The outcome date is the submitter's declaration. Nothing checks it against a meter, so a forecast that predates a mis-stated date passes. Freezing shows the forecast was not rewritten; it does not show the forecast was good.",
  },
  {
    id: "production_origin",
    title: "Production data origin",
    rule:
      "The server stamped the observation as production, which it does only on a production deployment. An observation recorded before origin was tracked is unclassified and is not exported.",
    limit:
      "Origin describes the deployment that recorded the observation, not the data. A rehearsal typed into a production deployment is stamped production unless the operator declared otherwise, which is why the last gate below exists.",
  },
  {
    id: "owner_permission",
    title: "A standing administrator-recorded permission",
    rule:
      "The newest permission record for the project is a grant. A revocation is a new record that replaces the grant; nothing is edited or deleted.",
    limit:
      "An assertion, not authentication. An administrator typed the e-mail address of the person who agreed and the digest of a signed document; the system never holds, opens or verifies that document, and the administrator is not identified. Revoking stops future exports only: rows already imported are not recalled.",
  },
  {
    id: "file_decision",
    title: "A verified file decision whose hash matches",
    rule:
      "The evidence file has a recorded decision of verified whose confirmed SHA-256 equals the digest stored for the file, the file's status is verified, and that digest is the one the observation's reviewer recorded.",
    limit:
      "The file was unchanged when the reviewer's decision was recorded: the hash is taken once, at review time, by the review route, and the database cannot confirm the route really hashed the stored object. Nothing reads or interprets the contents: the reviewer vouches that the file is what it claims to be. A verdict is final and cannot be withdrawn.",
  },
  {
    id: "never_test_site",
    title: "Never filed under a test or synthetic site",
    rule:
      "The project has never been attached to a site its organisation declared test or synthetic. Detaching it later does not undo that.",
    limit:
      "The site's origin is its organisation's own declaration and is never verified. This guards against a rehearsal being mistaken for a measurement, not against a determined insider; anyone holding a project's link token can file it under a test site and so keep its observations out.",
  },
];

/**
 * The three publication conditions of migration 0056, in the view's own terms, for the public page. Worded as conditional on the migration: this
 * code cannot tell whether it has been applied to the database that serves the page, and it must not claim an enforcement that is not there.
 */
export const PUBLICATION_CONDITIONS = {
  title: "Publication conditions (migration 0056)",
  rule:
    "Once migration 0056 is applied the view also requires three things: the organisation the observation was recorded under still has a standing consent (its newest consent record is a grant, and no withdrawal followed the consent the observation was recorded under; a withdrawal is a new record); the project attested its completion milestone (energised) under that same organisation, on a date no later than the observation's (a milestone does not move with a project, and an owner corrects a wrong date by a later record), and none of its own supplier records shows delivery still in flight at the observed date; and the observation was not withdrawn with its organisation's consent (a withdrawal leaves a permanent tombstone that a later grant does not lift).",
  limit:
    "The consent text and the signed document are digests the organisation's owner typed: nothing here opens either. The milestone date is the attester's declaration, backed by a file a reviewer verified. A withdrawal stops future aggregates; it cannot recall one that was already published. An observation recorded before the migration has no organisation and no consent, so it is not in the view, and it is not back-filled. The administrator's checklist does not read these three conditions yet: the view alone applies them.",
} as const;

export const RECORD_SHAPE = {
  title: "The record itself",
  rule:
    "One metric only (firm MW of the delivered architecture, btm.firm_MW, in MW), a measurement kind of metered, bms_trend or commissioning_record, a site reference, and the engine build digest of the prediction.",
} as const;

/** How many gates the final view enforces (not counting the record's shape). */
export const GATE_COUNT: number = LEDGER_GATES.length;
export const VIEW_CONDITION_COUNT: number = VIEW_CONDITIONS.length;
/**
 * The top-level AND terms of the final view's WHERE clause that the conditions above account for. tests/site/calibration-gates.test.ts and
 * tests/test_calibration_final_gate.py count the terms the view really has and fail if it has more (or fewer) than this.
 */
export const VIEW_WHERE_TERMS: number = VIEW_CONDITIONS.reduce((n, c) => n + (c.terms ?? 1), 0);
const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
/** The gate count in words, for copy ("six"); the number itself is never typed into prose. */
export const GATE_COUNT_WORD: string = NUMBER_WORDS[GATE_COUNT] ?? String(GATE_COUNT);

export const GATE_BY_ID: ReadonlyMap<GateId, LedgerGate> = new Map(LEDGER_GATES.map((g) => [g.id, g]));

/** The conditions the final view applies for one group. */
export const conditionsOf = (group: ConditionGroup | PublicationGroup): ViewCondition[] => VIEW_CONDITIONS.filter((c) => c.group === group);

/** What holds whatever the gates say, stated once for every surface. */
export const LEDGER_LIMITS: readonly string[] = [
  "A verdict is final. An observation review and a file decision are each recorded once; there is no way to withdraw a mistaken one.",
  "The outcome date is the submitter's declaration, and the permission is an administrator's assertion. Neither is checked against anything outside this system.",
  "Revoking a permission stops future exports only. Rows already imported into the ledger are not recalled.",
  "Observations recorded before origin was tracked are unclassified, are not exported, and are not back-filled.",
  "Clearing the gates makes an observation exportable, not accurate. A person still runs the import, and a record counts toward a published residual only after that step.",
];

// --- the checklist an administrator reads ---------------------------------------------------------------------------------------

/** "unreadable": the record that decides the gate could not be read (a failed read, or a table that is not there), so it is not "met". */
export type GateStatus = "met" | "not_met" | "unreadable";

export interface GateResult {
  id: ConditionGroup;
  title: string;
  status: GateStatus;
  /** Why, in a sentence: what is missing, or what was checked. */
  reason: string;
  /** True when this screen checked only part of what the view checks (the view alone recomputes the forecast's digest). */
  partial?: boolean;
}

export const STATUS_LABEL: Record<GateStatus, string> = { met: "Met", not_met: "Not met", unreadable: "Cannot be read" };

/** The gates blocking export: everything that is not met, unreadable included (an unread gate is not a passed one). */
export const blockingGates = (gates: readonly GateResult[]): GateResult[] => gates.filter((g) => g.status !== "met");

// --- the residual report the engine publishes -----------------------------------------------------------------------------------

export const RESIDUALS_PATH = "/v1/calibration/residuals";
export const RESIDUALS_SCHEMA = "gridforge.calibration.residuals.public/1";

/** The variables whose residuals the public report carries, with the unit each error is stated in (gridforge/calibration/records.py VARIABLES). */
export const PUBLISHED_VARIABLES: readonly { name: string; subsystem: string; unit: string }[] = [
  { name: "it_load_kW", subsystem: "envelope", unit: "kW" },
  { name: "facility_load_kW", subsystem: "envelope", unit: "kW" },
  { name: "racks", subsystem: "envelope", unit: "racks" },
  { name: "pue", subsystem: "thermal", unit: "ratio" },
  { name: "heat_rejection_kW", subsystem: "thermal", unit: "kW" },
  { name: "coolant_flow_lps", subsystem: "thermal", unit: "L/s" },
  { name: "coolant_supply_temp_C", subsystem: "thermal", unit: "degC" },
  { name: "transformer_load_kVA", subsystem: "power", unit: "kVA" },
  { name: "ups_load_kW", subsystem: "power", unit: "kW" },
  { name: "btm_firm_MW", subsystem: "power", unit: "MW" },
  { name: "grid_firm_MW", subsystem: "grid", unit: "MW" },
];

/** The variables the public report withholds (money and dates), by the engine's own list. */
export const WITHHELD_VARIABLES: readonly string[] = ["capex_total_eur", "weeks_to_full"];

/** The fields of one residual cell, as gridforge/calibration/residuals.py `_stats` writes them. Errors are in the variable's own unit. */
export const RESIDUAL_CELL_FIELDS: readonly { field: string; meaning: string }[] = [
  { field: "n", meaning: "approved observations in the cell" },
  { field: "sites", meaning: "distinct sites behind them" },
  { field: "mean_abs_error", meaning: "mean of |predicted - measured|, in the variable's unit" },
  { field: "median_abs_error", meaning: "median of |predicted - measured|, in the variable's unit" },
  { field: "max_abs_error", meaning: "largest |predicted - measured|, in the variable's unit" },
  { field: "mean_signed_error", meaning: "mean of predicted - measured, in the variable's unit; positive means the model over-predicts" },
  { field: "median_pct_error", meaning: "median of 100 x |error| / |measured|, in percent; undefined when measured is 0" },
  { field: "pct_error_defined_n", meaning: "observations with a defined percentage error" },
  { field: "pct_error_undefined_n", meaning: "observations whose measured value is 0" },
];

/** The fields of one variable block under subsystems.<name>.variables.<variable>. */
export const RESIDUAL_VARIABLE_FIELDS: readonly string[] = [
  "unit",
  "state",
  "approved_observations",
  "counting_toward_calibration",
  "distinct_sites",
  "still_needed",
  "residuals",
  "by_capacity_bucket",
  "by_evidence_class",
  "lead_time_error",
  "interval_coverage",
];

/**
 * The fewest distinct SITES a published statistic rests on (gridforge/calibration/publication.py PUBLIC_MIN_SITES). Below it a cell shows its counts and says
 * why. Typed once, here, for every sentence that states it; tests/site/calibration-gates.test.ts compares it with the Python constant, so the copy cannot say
 * "three" while the engine says five.
 */
export const PUBLIC_MIN_SITES = 5;

/** The thresholds the engine states in `requirements` (gridforge/calibration/residuals.py). */
export const RESIDUAL_REQUIREMENTS = { min_approved_observations_per_variable: 10, min_distinct_sites_per_variable: 3 } as const;

/** The top-level fields of the public report (gridforge/calibration/residuals.py public_report). */
export const RESIDUAL_TOP_FIELDS: readonly string[] = [
  "schema",
  "state",
  "n_records",
  "n_sites",
  "headline",
  "requirements",
  "subsystem_states",
  "subsystems",
  "withheld_variables",
  "note",
];
