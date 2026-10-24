// Server-only: a notice to the operator that is sent ONCE for a given key, however often the thing that raises it runs.
//
// Stripe redelivers events and the daily cron runs every day, and some conditions (a subscription whose price no longer matches the
// catalogue, a settlement that cannot be invoiced) persist across all of those. Mailing on every pass is noise the operator learns
// to ignore; mailing never is a defect nobody sees. The once-only ledger is `operator_notices` (migration 0039): a UNIQUE digest, and
// the INSERT is the claim. The digest is keyed (lib/payg.ts funnelKey) so Stripe ids built into a key never sit in the table in the clear.
//
// Fails OPEN: if the ledger cannot be used (the migration is not applied yet, the store is down) the notice is sent anyway, so the worst
// case is a repeated mail, never a missing one. A claim whose mail did not go out is released, so the next pass tries again.

import { notifyOperator } from "@/lib/mail";
import { funnelKey } from "@/lib/payg";
import { enc, pg } from "@/lib/payg-store";

/**
 * Is operator mail expected to work on this deployment? When it is NOT configured at all the "OPERATOR ACTION NEEDED" log line is the only
 * channel there is, and a caller that makes the mail its record must not fail (and be redelivered for ever) over a mail nobody can send.
 */
export function operatorMailExpected(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.LEAD_TO_EMAIL && env.RESEND_API_KEY);
}

export async function notifyOperatorOnce(key: string, subject: string, text: string): Promise<"sent" | "duplicate" | "unsent"> {
  const dedupe_key = funnelKey(key);
  const claim = await pg<{ dedupe_key: string }[]>("POST", "operator_notices?on_conflict=dedupe_key", { dedupe_key }, "resolution=ignore-duplicates,return=representation");
  const claimed = claim.ok && (claim.data?.length ?? 0) > 0;
  if (claim.ok && !claimed) return "duplicate";
  const sent = await notifyOperator(subject, text);
  if (sent.sent) return "sent";
  // Not delivered: give the claim back so the next delivery or run tries again (only if we hold it).
  if (claimed) await pg("DELETE", `operator_notices?dedupe_key=eq.${enc(dedupe_key)}`, undefined, "return=minimal");
  return "unsent";
}
