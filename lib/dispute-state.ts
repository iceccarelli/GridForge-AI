// A Stripe dispute's status, as a decision about money and access (pure; no I/O).
//
//   open      needs_response, under_review     real money has been debited: access is suspended while it stands
//   lost      lost                             the payment was taken back for good: the suspension stands
//   won       won                              the money came back: a suspension this dispute caused is lifted
//   resolved  charge_refunded, prevented       closed without a loss to us (the charge was refunded, or the dispute was prevented)
//   inquiry   warning_needs_response, warning_under_review
//                                              an early-warning inquiry: no money has moved, nothing is suspended
//   inquiry_closed  warning_closed             the inquiry ended without becoming a dispute
//   unknown   anything else                    a status this site has no rule for: nothing changes and the operator is told
//
// Every dispute event is decided by the dispute's CURRENT status read from Stripe (lib/billing-disputes.ts), never by the event type or by
// the status inside a possibly stale payload.

export type DisputeState = "open" | "lost" | "won" | "resolved" | "inquiry" | "inquiry_closed" | "unknown";

export function classifyDispute(status: unknown): DisputeState {
  switch (status) {
    case "needs_response":
    case "under_review":
      return "open";
    case "lost":
      return "lost";
    case "won":
      return "won";
    case "charge_refunded":
    case "prevented":
      return "resolved";
    case "warning_needs_response":
    case "warning_under_review":
      return "inquiry";
    case "warning_closed":
      return "inquiry_closed";
    default:
      return "unknown";
  }
}

/** The states in which a hold this dispute caused is lifted. */
export const LIFTS_DISPUTE_HOLD: readonly DisputeState[] = ["won", "resolved", "inquiry_closed"];
/** The states in which the dispute holds access. */
export const HOLDS_ACCESS: readonly DisputeState[] = ["open", "lost"];
