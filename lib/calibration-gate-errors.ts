// Server-only: what a refusal by one of migration 0056's publication gates means to the person who receives it.
//
// The database refuses with a stable SQLSTATE of its own (the migration's header and tests/test_calibration_publication_gates.py are the authority):
//
//   GF015  consent        a production observation needs a project attached to a hall of an organisation, and that organisation's standing
//                         consent (a grant, not a withdrawal). Also raised, with other meanings, by the consent writers themselves
//                         (a non-owner recording consent; a withdrawal with nothing to withdraw): the site calls neither yet.
//   GF016  milestone      the project has not attested its completion milestone (energised), or the observation is dated before it, or a
//                         supplier record of the project shows delivery still in flight at the observed date, or the milestone was attested
//                         under another organisation than the project belongs to now. Also raised by the milestone writer.
//   GF017  withdrawal     the observation (by the hash of its id) was withdrawn with its organisation's consent and cannot be recorded again;
//                         also raised by the release registry for a snapshot that contains one.
//   GF018  release        the snapshot registry refused a release: too few observations or organisations, one organisation too large a share,
//                         too soon after the previous release, no safe difference from an earlier one, or a malformed snapshot.
//
// The words below are for the PERSON, so they name what is missing and who can supply it, in plain language; they carry no SQL text, no table or
// function name, no SQLSTATE and no value from the request. PostgREST's own message (which does hold SQL text) never reaches here: lib/pgrest.ts keeps
// the status and the code and drops the body. The cause goes to the server log through `logPublicationRefusal`, which says which gate refused and for
// which project, and runs the line through the log scrubber (lib/mail.ts `redact`).
//
// Honesty about what exists: the organisation's owner records consent, and an editor or owner attests the milestone, through two functions of
// migration 0056 that NOTHING in this site calls yet. There is no page for either. The messages say so rather than point at one.

import { redact } from "@/lib/mail";

export type PublicationGateCode = "GF015" | "GF016" | "GF017" | "GF018";
export type PublicationGate = "organisation_consent" | "completion_milestone" | "withdrawal" | "release_policy";

export interface PublicationRefusal {
  code: PublicationGateCode;
  gate: PublicationGate;
  /** The HTTP status a route answers with. 409: the request is well formed, the record's state does not allow it yet. */
  status: number;
  /** What the person is told. */
  error: string;
}

/**
 * The release policy migration 0056 enforces in `gf_calibration_release_policy()` and gridforge/calibration/release.py holds in Python. Typed here
 * only so GF018's sentence can state the numbers; tests/site/calibration-publication-gate-errors.test.ts compares them with both.
 */
export const RELEASE_POLICY = {
  minCellObservations: 10,
  minCellOrganisations: 3,
  maxOrganisationSharePermille: 400,
  releaseStepObservations: 10,
  releaseStepOrganisations: 3,
  minReleaseIntervalDays: 30,
} as const;

const NO_PAGE = "There is no page for this yet: write to us from /contact.";

const REFUSALS: Readonly<Record<PublicationGateCode, PublicationRefusal>> = {
  GF015: {
    code: "GF015",
    gate: "organisation_consent",
    status: 409,
    error:
      "This measurement was not recorded: no organisation consent covers it. The project has to be attached to a hall of an organisation, and that " +
      "organisation's owner has to record its consent to publication, and at what aggregation, before a production measurement can be kept. " +
      NO_PAGE,
  },
  GF016: {
    code: "GF016",
    gate: "completion_milestone",
    status: 409,
    error:
      "This measurement was not recorded: the project has not attested that it reached completion (energised), or the measurement is dated before that, " +
      "or a supplier record of the project still shows delivery in flight on that date, or completion was attested under another organisation (it does " +
      "not move with the project). An editor or an owner of the project's organisation attests completion against a commissioning file that a reviewer " +
      "has verified. " +
      NO_PAGE,
  },
  GF017: {
    code: "GF017",
    gate: "withdrawal",
    status: 409,
    error:
      "This observation was withdrawn together with its organisation's consent, so it cannot be recorded again, and granting consent later does not " +
      "bring it back.",
  },
  GF018: {
    code: "GF018",
    gate: "release_policy",
    status: 409,
    error:
      `The release was refused. A release has to rest on at least ${RELEASE_POLICY.minCellObservations} observations from at least ` +
      `${RELEASE_POLICY.minCellOrganisations} organisations, none supplying more than ${RELEASE_POLICY.maxOrganisationSharePermille / 10}%, come at ` +
      `least ${RELEASE_POLICY.minReleaseIntervalDays} days after the previous release, differ from every earlier release by a group that large ` +
      `(${RELEASE_POLICY.releaseStepObservations} observations from ${RELEASE_POLICY.releaseStepOrganisations} organisations), and contain no ` +
      "withdrawn observation. An administrator can add observations, or wait, and propose it again.",
  },
};

/** The refusal for a database error code, or null when the code is not one of the four (it is then someone else's to map). */
export function publicationRefusal(code: unknown): PublicationRefusal | null {
  return typeof code === "string" && Object.prototype.hasOwnProperty.call(REFUSALS, code) ? REFUSALS[code as PublicationGateCode] : null;
}

/**
 * Log WHY a request was refused, for the operator: which gate and which record, never the database's own message, a token or a value from the request.
 * `subject` is an internal id (a project's uuid), not its link token.
 */
export function logPublicationRefusal(refusal: PublicationRefusal, where: string, subject?: string): void {
  console.error(
    redact(`[GridForge] ${where} refused by the ${refusal.gate} gate (${refusal.code})${subject ? ` for ${subject}` : ""}: nothing was recorded.`)
  );
}
