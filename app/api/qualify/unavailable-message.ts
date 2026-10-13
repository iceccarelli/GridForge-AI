/**
 * What to tell the visitor when the engine produced no result.
 *
 * The message may only claim the figures were saved when the row actually
 * landed, and may only promise a follow-up when there is somebody to follow up
 * with — the qualifier form collects no contact details unless an email was
 * supplied through the API.
 */
export function engineUnavailableMessage(saved: boolean, hasEmail: boolean): string {
  const base = "The capacity engine could not be reached, so no result was produced.";
  if (!saved) {
    return `${base} Your figures were NOT saved. Please try again in a few minutes.`;
  }
  if (hasEmail) {
    return `${base} Your figures were saved and we will come back to you at the email address you gave.`;
  }
  return `${base} Your figures were saved, but we have no contact details to reply to, so please try again in a few minutes.`;
}
