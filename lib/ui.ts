// Lightweight global triggers so any button anywhere can open the audit modal.
// Avoids prop-drilling and makes every CTA on the site work consistently.

export const AUDIT_EVENT = "gridforge:open-audit";

export function openAudit(context?: string) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(AUDIT_EVENT, { detail: { context } }));
}
