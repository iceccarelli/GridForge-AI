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

import { PORTFOLIO_ENGINE_MAX_HALLS } from "@/lib/portfolio-scope";

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
  /**
   * What kind of entry it is: the commitment itself, an additive change (a new key or a new behaviour), a correction (a value the engine returned or
   * published in a form that misled, now what it should have been: the entry says which values and what they were) or, when there is one, a deprecation.
   */
  kind: "policy" | "additive" | "correction" | "deprecation";
  text: string;
  /**
   * The request or response keys the entry says were added or corrected, by the name the engine uses. Not printed: tests/site/api-policy.test.ts proves
   * that each one is named in the entry's text and is really in the engine's source or its published files, so an entry cannot claim a key that is not there.
   */
  keys?: string[];
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
    keys: ["assumed_fields", "inputs_declared_assumed", "assumed_count", "assumed_count_note", "qualify_assumed_fields"],
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      "specification_available: a new boolean on every constraint in the published constraint reference (/reference/constraints.json and the one file per constraint under /reference/constraints/), " +
      "saying whether a Procurement Specification can be written for that constraint's relief. It is a field of the published reference file, not of a /v1 response.",
    keys: ["specification_available"],
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      "currency: a new key in the response_template returned by POST /v1/spec and, for the html and md formats, by POST /v1/power/deploy/spec: " +
      "the currency a supplier's prices are quoted in, left empty for the supplier to fill.",
    keys: ["currency"],
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      "figures_not_supplied: a new top-level key of the POST /v1/qualify answer, one row per figure of the seven that the request left out or sent as null (field, path, sent, assumed). " +
      'sent is "null" or "absent", and assumed says what the engine used in its place. The rule is stated once: send at least three of the seven figures, any three, and each one omitted is an assumption named in the answer. ' +
      "Fewer than three is a 422 whose body lists all seven figures and adds minimum_figures and figures_sent. A figure above the most the engine models for one hall is refused by the name you sent it under (field, limit).",
    keys: ["figures_not_supplied", "minimum_figures", "figures_sent", "limit"],
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      "sets_the_date_reason: a new key of after_relief in the POST /v1/qualify answer, null when there is a date and, when there is none, the reason in words. " +
      'date_label, which had one wording for both causes, now has two: "no date: nothing is deployable in this scenario" and "no date: a lead time on the path is missing".',
    keys: ["sets_the_date_reason", "date_label"],
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      "racks_evidence: a new key beside each rack count that had no class of its own: as_found.racks and after_relief.racks of POST /v1/qualify, and as_found.racks and after_ladder.racks of every scenario of POST /v1/compare. " +
      "It is the evidence class of the count as a short code such as E0, the weakest class among the constraints that cap it.",
    keys: ["racks_evidence", "after_ladder"],
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      "allowed: the body of a 422 (over /mcp, data.allowed of a -32602) for a format the route cannot render. POST /v1/screen, /v1/study, /v1/portfolio, /v1/diff, /v1/proposal, /v1/spec and /v1/deck, " +
      "and the MCP tools of those that are tools, refuse an unsupported format before anything is metered; it used to be answered as the route's default format and charged. " +
      "An unknown scenario on /v1/spec and /v1/bids and an unknown redundancy on the /v1/power/deploy routes are refused the same way, with field and allowed; the scenario used to fall back silently to the recommended one.",
    keys: ["allowed", "field", "scenario", "redundancy"],
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      `max_halls_per_request: a new key on the /v1/portfolio row of rate_card (GET /v1/tools and /reference/tools.json), ${PORTFOLIO_ENGINE_MAX_HALLS}, and maxItems ${PORTFOLIO_ENGINE_MAX_HALLS} on intakes in the published input schema of gridforge_portfolio. ` +
      `POST /v1/portfolio over ${PORTFOLIO_ENGINE_MAX_HALLS} halls is refused with 422 (max_halls) before it is metered, and GET and POST /v1/estimate for more than ${PORTFOLIO_ENGINE_MAX_HALLS} halls is a 422 with requests_needed, max_halls and units_per_hall, ` +
      "not a price for a request the engine would refuse.",
    keys: ["max_halls_per_request", "maxItems", "max_halls", "requests_needed", "units_per_hall"],
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      "target_reachable and gap_racks_after_ladder: new keys of capacity in the POST /v1/power/assess answer: whether the full headroom ladder reaches the target, and how many racks are still missing once every relief on it is taken. " +
      "When it does not, next_action.action leads with that fact and next_action carries target_reachable, gap_racks_after_ladder and ladder_action, the action the ladder alone would have given.",
    keys: ["target_reachable", "gap_racks_after_ladder", "ladder_action"],
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      "changed_inputs_known, drivers_note and evidence_changed_inputs: new top-level keys of the POST /v1/diff answer. Against a recorded previous_state the earlier inputs are not stored, so changed_inputs and drivers are empty because no driver can be named, not because nothing moved: " +
      "changed_inputs_known is false and drivers_note says so (send before to get the drivers). evidence_changed_inputs names the inputs whose declared evidence class moved.",
    keys: ["changed_inputs_known", "drivers_note", "evidence_changed_inputs"],
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      "figure_checks and score_basis: new keys on every ranked row of POST /v1/bids and /v1/power/deploy/bids. A bid is held to the numbers of the shall clauses it answers: one whose own figure (duty_at_site_conditions, validity_days) contradicts a clause it declared C on is not compliant on that clause, " +
      "and figure_checks lists the clause, the figure asked and the figure offered. Scores are relative to the bids in the same comparison, and score_basis says so. A refusal names the field by its path (responses[i]...).",
    keys: ["figure_checks", "score_basis", "duty_at_site_conditions", "validity_days"],
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      "directional and directional_reason: new keys of next_action in the POST /v1/power/deploy/assess answer (and directional and peak_plausible in load_profile). A load profile with fewer than 24 readings or less than 24 hours is directional, and next_action says so in its action. " +
      "A peak more than 100 times below, or above, both the target and the grid capacity is named as a likely unit slip, no architecture passes on it and next_action says to check the units (profile_problem). " +
      "A load-profile CSV with a byte-order mark, or separated by semicolons or tabs, is read.",
    keys: ["directional", "directional_reason", "peak_plausible", "profile_problem"],
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      'jsonrpc: a message to /mcp must declare "jsonrpc": "2.0"; one that does not is refused with -32600, where it used to be read as 2.0. tools/call without a params object, or with a name that is not a string, is -32602 naming name (data.available lists the tools). ' +
      'A message with "id": null is a request and is answered with id null; only a message with no id member is a notification (it was taken for one, and got 202 and no answer).',
    keys: ["jsonrpc", "name", "available"],
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      "allow: HEAD answers every GET route as GET does, without the body. A route reached by a method it does not take is a 405 with an Allow header and an allow list in the body (a GET on a POST route was a 404, and PUT, DELETE and PATCH got the HTTP library's HTML page); " +
      "OPTIONS sends Allow; an error the HTTP library raises on its own (a malformed request line, TRACE) is JSON with schema_version, error and status. The operator-only route is in no listing: not in endpoints of GET /v1/version, nor in the body of a 404.",
    keys: ["allow", "endpoints"],
  },
  {
    date: API_POLICY_DATE,
    kind: "additive",
    text:
      "warnings: a figure in an answer that is not finite (NaN or an infinity, which are not JSON) is no longer written as one: it is null where it would have been, and a top-level warnings entry reads \"non-finite figure withheld at <path>\" " +
      "(inside the result of a JSON-RPC response).",
    keys: ["warnings"],
  },
  {
    date: API_POLICY_DATE,
    kind: "correction",
    text:
      "Four values the engine returned or published in a form that misled, now what they should have been. schema_version stays gridforge/api/1, and a client that read any of them in the old form must change. " +
      "(1) rank on a /v1/portfolio hall row is null for a hall that is not ranked (no deployable rack, a required input missing or an equipment bank not declared); it carried an ordinal that read as a place in the ranking that hall did not hold. " +
      "position, new, is the row's 1-based place in the table, which rank used to double as; the ranks that exist run 1 to k with no gap. " +
      "(2) The published input schema of POST /v1/qualify has no required list. It named contracted_MW, current_site_peak_MW, busway_ampacity_A and tapoff_max_A, which the engine never required: it answers on any three of the seven. " +
      "required_at_least in the 422 listed the first three figures, which read as if those were required; it lists all seven. " +
      "(3) after_relief.sets_the_date of POST /v1/qualify is null when there is no date; it named the longest known lead time, which is a lower bound and not the item that decides. " +
      "(4) On /v1/bids and /v1/power/deploy/bids a response that was set aside (disqualified) has rank null and is not compliant; it carried a rank, compliant true and an effect on the date computed from the figure that set it aside.",
    keys: ["rank", "position", "required", "required_at_least", "sets_the_date", "compliant"],
  },
];
