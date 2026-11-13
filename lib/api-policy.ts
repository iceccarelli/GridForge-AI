// The API versioning and deprecation commitment, written once. /developers (a section and a changelog), the OpenAPI document's info.description and
// /llms.txt all print API_VERSIONING_POLICY from here, so the three cannot say different things. Pure data: no React, no I/O, and no price.
//
// It is a commitment about what we will do, so every clause has to be one the operator can keep and one the code does not contradict:
//   - Nothing here promises an HTTP Deprecation or Sunset header or any automated notice. The engine sends neither (grep gridforge/ finds none) and
//     has one path version, /v1. The notice is an email we write and an entry on /developers; the last sentence of the policy says so.
//   - "schema_version" is the engine's own field (gridforge/api/server.py API_SCHEMA, sent in the body and in the X-GridForge-Schema header). Its
//     value is "gridforge/api/1" today. The commitment that it is incremented on any change to a response shape counts from 2026-11-13; the changelog
//     says that the additive keys of that day did not change it, so the entry is true to the code as it stands.
// tests/site/api-policy.test.ts pins the three surfaces to this constant and the changelog to the engine's own published keys.

/** The date the commitment was made and the baseline from which its schema_version rule counts. */
export const API_POLICY_DATE = "2026-11-13";

/** Days the previous path version keeps running after written notice. */
export const API_DEPRECATION_NOTICE_DAYS = 90;

export const API_VERSIONING_POLICY =
  "Within /v1 we make only additive changes: new endpoints, new optional request fields and new response keys. " +
  "A change to the meaning of a response key, to a unit, or to the meaning of a status code, and the removal of anything, is a breaking change: " +
  "it ships under a new path version and never inside /v1. " +
  `The previous version keeps running for at least ${API_DEPRECATION_NOTICE_DAYS} days after we have given written notice to the account email of every active API-key holder and posted a notice on /developers. ` +
  "The schema_version field in every response is incremented on any change to a response shape, additive or breaking. " +
  "A deprecation is announced with a dated entry in the changelog on /developers. " +
  "The API itself announces nothing: it sends no Deprecation or Sunset header, and the notice is our email and our entry on /developers.";

export interface ApiChangelogEntry {
  /** ISO date the entry was made. */
  date: string;
  /** What kind of entry it is: the commitment itself, an additive change, or (when there is one) a deprecation. */
  kind: "policy" | "additive" | "deprecation";
  text: string;
}

/**
 * The dated changelog printed on /developers. Entries of one day are in the order they were made. A deprecation would be added here with its date,
 * the path version it affects and the date the previous version stops being served, which is at least API_DEPRECATION_NOTICE_DAYS after the notice.
 * None has been made: /v1 is the only path version.
 */
export const API_CHANGELOG: ApiChangelogEntry[] = [
  {
    date: API_POLICY_DATE,
    kind: "policy",
    text:
      "This versioning and deprecation commitment is published. /v1 is the only path version and nothing is deprecated. " +
      "The additive keys listed below were added the same day and did not change schema_version, which stays gridforge/api/1: " +
      "the rule that it is incremented on any change to a response shape counts from this date.",
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      "assumed_fields: a new optional request field on POST /v1/qualify, a list naming which of the seven figures you send are assumptions rather than this hall's own data. " +
      "A named figure is classed E0, never E5. When it is sent the answer adds inputs_declared_assumed, and the intake block adds assumed_count and assumed_count_note; " +
      "a request without it is answered exactly as before. An engine that accepts it lists qualify_assumed_fields among the capabilities in GET /v1/version.",
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      "specification_available: a new boolean on every constraint in the published constraint reference (/reference/constraints.json and the one file per constraint under /reference/constraints/), " +
      "saying whether a Procurement Specification can be written for that constraint's relief. It is a field of the published reference file, not of a /v1 response.",
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      "currency: a new key in the response_template returned by POST /v1/spec and, for the html and md formats, by POST /v1/power/deploy/spec: " +
      "the currency a supplier's prices are quoted in, left empty for the supplier to fill.",
  },
];
