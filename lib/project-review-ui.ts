// Client-safe: the exact bodies the review screen sends, and the rule it mirrors for the submitter.
//
// The routes (app/api/admin/observations/[id]/review, app/api/admin/supplier-actuals/[id]/review) are the authority and
// re-validate everything; the database enforces the rest. This module only builds the request those routes expect, from values
// the server page hands over (REVIEW_CLASS, VERIFIABLE_FIELDS), so the screen never carries its own copy of them.

export type Decision = "verified" | "rejected";

export interface ReviewInput {
  decision: Decision;
  reviewer: string;
  reason: string;
}

export const SELF_REVIEW_MESSAGE = "A submission cannot be reviewed by the person who submitted it.";

/** The route's comparison of the typed reviewer name with the submitter: trimmed and case-insensitive (migration 0038). */
export function isSelfReview(reviewer: string, submittedBy: string): boolean {
  const who = reviewer.trim().toLowerCase();
  return who !== "" && who === submittedBy.trim().toLowerCase();
}

/** What is missing before a decision may be sent, in the screen's words. Empty means ready. */
export function reviewProblems(input: ReviewInput, submittedBy: string, extra: { factsChosen?: number } = {}): string[] {
  const out: string[] = [];
  if (!input.reviewer.trim()) out.push("Your name is required: the person taking this decision.");
  else if (input.reviewer.trim().length > 120) out.push("Your name must be at most 120 characters.");
  if (!input.reason.trim()) out.push("A reason is required.");
  else if (input.reason.trim().length > 500) out.push("The reason is stored up to 500 characters; shorten it.");
  if (isSelfReview(input.reviewer, submittedBy)) out.push(SELF_REVIEW_MESSAGE);
  if (extra.factsChosen === 0 && input.decision === "verified") out.push("Choose the facts you vouch for.");
  return out;
}

/** POST /api/admin/observations/{id}/review. A verified observation carries the one class a reviewer may assign. */
export function observationReviewBody(input: ReviewInput, reviewClass: string): Record<string, unknown> {
  return input.decision === "verified"
    ? { decision: "verified", evidence_class: reviewClass, reviewer: input.reviewer.trim(), reason: input.reason.trim() }
    : { decision: "rejected", reviewer: input.reviewer.trim(), reason: input.reason.trim() };
}

/** POST /api/admin/supplier-actuals/{id}/review. A verified record names the facts vouched for; a rejection verifies nothing. */
export function actualReviewBody(input: ReviewInput, verifiedFields: string[]): Record<string, unknown> {
  return input.decision === "verified"
    ? { decision: "verified", verified_fields: verifiedFields, reviewer: input.reviewer.trim(), reason: input.reason.trim() }
    : { decision: "rejected", reviewer: input.reviewer.trim(), reason: input.reason.trim() };
}

export const reviewUrl = (kind: "observation" | "actual", id: string): string =>
  kind === "observation"
    ? `/api/admin/observations/${encodeURIComponent(id)}/review`
    : `/api/admin/supplier-actuals/${encodeURIComponent(id)}/review`;

/** How the routes word a decision that someone else already took (a 409). The screen drops a stale card on it; tests pin both routes to it. */
export const ALREADY_REVIEWED = /already been reviewed/i;
