// Lightweight global trigger so any button anywhere can open the audit modal.
// Avoids prop-drilling and makes every CTA on the site work consistently.
//
// The event now carries an optional structured `prefill` payload so interactive
// tools (configurator, EMS simulator, scenario, comparator…) can hand their
// current state straight into the multi-step form — turning a high-intent tool
// session into a pre-scoped audit request with zero re-typing.

export const AUDIT_EVENT = "gridforge:open-audit";

/** Structured scenario state a tool can pass into the audit form. All optional
 *  so every existing `openAudit("label")` call keeps working unchanged. */
export interface AuditPrefill {
  /** Target / configured capacity in MW. */
  capacityMW?: number;
  /** Firm (always-on) power share, 0–100. */
  firmPct?: number;
  /** Renewable share in the modeled mix, 0–100. */
  renewablePct?: number;
  /** Primary firming fuel choice, when the tool models one. */
  fuel?: "gas" | "fuelcell" | "balanced";
  /** Workload / dispatch scenario id (e.g. "pretrain", "inference"). */
  scenario?: string;
  /** Site location, if the tool knows it. */
  location?: string;
  /** Human-readable one-line scenario summary, prefilled into the message. */
  summary?: string;
  /** Which service the tool maps to, to preselect in the form. */
  service?: string;
}

export interface AuditOpenDetail {
  /** Source label for attribution (which tool / CTA opened the form). */
  context?: string;
  /** Structured tool state to prefill the form. */
  prefill?: AuditPrefill;
}

/**
 * Open the audit modal.
 * @param context  Source label for lead attribution (e.g. "configurator").
 * @param prefill  Optional structured tool state to pre-populate the form.
 */
export function openAudit(context?: string, prefill?: AuditPrefill) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AuditOpenDetail>(AUDIT_EVENT, {
      detail: { context, prefill },
    })
  );
}
