// Server-only: tell an API customer that their key is about to expire, whatever plan they are on.
//
// A signed key carries a fixed 35-day expiry and nothing can extend it. Subscription customers are reminded when a renewal invoice
// is paid (the webhook) but ONLY if the key has <= 7 days left at that moment: a key minted mid-cycle can still expire days before the
// next renewal, and a renewal event that is never delivered leaves no reminder at all. Free and pay-as-you-go accounts have no renewal
// event whatsoever. So this daily sweep is the backstop for EVERY plan: free, pay-as-you-go and the subscriptions (status active, or
// past_due, whose customer most needs to hear that the key will lapse before the payment is put right).
//
// The reminder is the existing durable `key_rotation` obligation, keyed by the key's expiry date, so it is sent ONCE PER KEY however
// many days the key stays inside the window, however many times the sweep runs, and whether the webhook or this sweep got there first
// (both use the same key). It is cancelled unsent if the key has been replaced meanwhile.

import { ROTATION_WINDOW_DAYS, type ApiAccount } from "@/lib/api-access";
import { notifyCustomer } from "@/lib/notifications";
import { enc, pg } from "@/lib/payg-store";
import { API_PRODUCTS } from "@/lib/products";

export interface ReminderReport {
  considered: number;
  queued: number;
  errors: number;
}

type Candidate = Pick<ApiAccount, "id" | "key_id" | "key_expires_at" | "status" | "plan">;

export async function remindExpiringKeys(now: Date = new Date()): Promise<ReminderReport> {
  const report: ReminderReport = { considered: 0, queued: 0, errors: 0 };
  const horizon = new Date(now.getTime() + ROTATION_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  // Not keys that died long ago: an abandoned account is not mailed about a key it dropped months back.
  const floor = new Date(now.getTime() - ROTATION_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const span = `key_id=not.is.null&key_expires_at=lte.${enc(horizon)}&key_expires_at=gte.${enc(floor)}&select=id,key_id,key_expires_at,status,plan&limit=200`;
  const subscriptionPlans = API_PRODUCTS.map((p) => p.id);
  const queries = [
    // A free allowance or pay-as-you-go account: only while it is active (past_due cannot mint, and these have no renewal to wait for).
    `api_accounts?plan=in.(api_free,api_payg)&status=eq.active&${span}`,
    // A subscription: active, or past_due (cancelled is over; the cancellation revoked its key).
    `api_accounts?plan=in.(${subscriptionPlans.join(",")})&status=in.(active,past_due)&${span}`,
  ];
  const seen = new Set<string>();
  for (const q of queries) {
    const r = await pg<Candidate[]>("GET", q);
    if (!r.ok) {
      report.errors++;
      continue;
    }
    for (const a of r.data ?? []) {
      if (!a.key_expires_at || seen.has(a.id)) continue;
      seen.add(a.id);
      report.considered++;
      // Discriminator = the expiry date: one obligation per key, however many days the key stays inside the window.
      if ((await notifyCustomer("key_rotation", a.id, a.key_expires_at)) === "ok") report.queued++;
      else report.errors++;
    }
  }
  return report;
}
