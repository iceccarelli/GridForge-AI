// What "credits in full" means, in ONE sentence, for every page, email and agent block that says a Density Screen is credited against the Study.
//
// The promise used to be typed in a dozen places as "credits in full against the full study", with no condition, while the code that honours it
// (lib/deliverables.ts creditsToward, lib/deposits.ts availableCredits / scope, supabase/migrations/0030 and 0045) applies several. A promise
// about money has to say what the money has to satisfy. Every clause below is a thing that code does:
//
//   - "credited once": engagement_credits holds one row per source Density Screen, UNIQUE on source_deliverable_id (migration 0030);
//     a second use fails with 23505 (lib/deposits.ts scope).
//   - "against the fee agreed for an Envelope Study": it is applied when an operator scopes a Study deposit, against that deposit's agreed fee
//     (lib/deposits.ts scope -> gf_scope_deposit). Only the Study: PRODUCTS.density_screen.creditsAgainst is envelope_study_deposit, and
//     lib/engagement-state.ts creditedEarlier names no other engagement.
//   - "for the same email address, after we confirm it is the same buyer (the address typed at checkout is not verified)": creditsToward matches
//     the NORMALISED address exactly, and scope refuses to credit until an operator lists the ones to apply in confirm_credit_ids.
//   - "applied whole ... only while the deposit and the credit together stay within the agreed fee": scope applies a confirmed credit whole, and
//     skips (without consuming) one that would take deposit + credits past the fee.
//   - "reduces what is owed and is never paid out as cash": the balance due is the agreed fee less the deposit and the credits and is never
//     negative (lib/engagement-state.ts balanceDueCents); a fee below the deposit is refused ("a credit ... never creates a refund").
//   - "a refunded or disputed purchase carries no credit": creditsToward drops any row with a billing_hold (migration 0045; lib/one-time-holds.ts).
//
// What the code does NOT apply, so the sentence does not mention it: an expiry (there is none in the code or the ledger), a minimum spend, a
// cap on the credit other than the agreed fee. The Study DEPOSIT is credited against the agreed fee by a different rule (lib/engagement-state.ts
// depositTerms) and states no further condition; no refund term for a deposit is written in the code, and the Terms say so.
export const SCREEN_CREDIT_SENTENCE =
  "The fee paid for a Density Screen is credited once against the fee agreed for an Envelope Study: for the same email address, after we confirm it is the same buyer " +
  "(the address typed at checkout is not verified), applied whole and only while the deposit and the credit together stay within the agreed fee. " +
  "It reduces what is owed and is never paid out as cash, and a refunded or disputed purchase carries no credit.";

/** The same promise at the length a price ladder row has room for: it names the conditions exist and where they are written. The full sentence is SCREEN_CREDIT_SENTENCE. */
export const SCREEN_CREDIT_SHORT = "Credited once against an Envelope Study fee, on the conditions in the Terms.";
