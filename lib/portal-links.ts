// Links out of the customer portal, built only from tokens that exist.
//
// For a session whose email has not been confirmed, /api/engagements returns the watch, document and intake tokens as
// null and says `verified: false` (and /api/subscription-status answers {active:false, verified:false}). A page that
// interpolated those into a template string would link to /watch/null. These helpers return null for a missing token,
// so the caller renders a "confirm your email to open this" state instead of a dead link.

export interface EngagementTokens {
  documentToken?: string | null;
  intakeToken?: string | null;
}

function usable(token: unknown): token is string {
  return typeof token === "string" && token.length > 0 && token !== "null" && token !== "undefined";
}

export function documentHref(e: EngagementTokens): string | null {
  return usable(e.documentToken) ? `/deliverable/${encodeURIComponent(e.documentToken)}` : null;
}

export function intakeHref(e: EngagementTokens): string | null {
  return usable(e.intakeToken) ? `/intake/${encodeURIComponent(e.intakeToken)}` : null;
}

export function watchHref(w: { token?: string | null }): string | null {
  return usable(w.token) ? `/watch/${encodeURIComponent(w.token)}` : null;
}

/** Only an explicit `false` means unconfirmed; an older route that sends no flag is treated as verified. */
export function isUnverified(body: { verified?: unknown } | null | undefined): boolean {
  return body?.verified === false;
}

export const CONFIRM_EMAIL_TEXT =
  "Confirm your email to open this. Your sign-in has not been confirmed yet, so we do not show links to private documents, intakes or watches. Open the confirmation email we sent, then reload this page.";
