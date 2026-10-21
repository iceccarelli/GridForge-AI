// Server-only: tell a free-allowance or pay-as-you-go customer that their key is about to expire.
//
// A signed key carries a fixed 35-day expiry and nothing can extend it. Subscription customers are reminded when a renewal invoice
// is paid (the webhook); free and pay-as-you-go accounts have no renewal event at all, so without this their agents simply stop
// working at day 35. The reminder is the existing durable `key_rotation` obligation, keyed by the key's expiry date, so it is sent
// ONCE PER KEY and is cancelled unsent if the key has been replaced meanwhile.

import { ROTATION_WINDOW_DAYS, type ApiAccount } from "@/lib/api-access";
import { notifyCustomer } from "@/lib/notifications";
import { enc, pg } from "@/lib/payg-store";

export interface ReminderReport {
  considered: number;
  queued: number;
  errors: number;
}

export async function remindExpiringKeys(now: Date = new Date()): Promise<ReminderReport> {
  const report: ReminderReport = { considered: 0, queued: 0, errors: 0 };
  const horizon = new Date(now.getTime() + ROTATION_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  // Not keys that died long ago: an abandoned free account is not mailed about a key it dropped months back.
  const floor = new Date(now.getTime() - ROTATION_WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10);
  const r = await pg<Pick<ApiAccount, "id" | "key_id" | "key_expires_at" | "status" | "plan">[]>(
    "GET",
    `api_accounts?plan=in.(api_free,api_payg)&status=eq.active&key_id=not.is.null&key_expires_at=lte.${enc(horizon)}&key_expires_at=gte.${enc(floor)}&select=id,key_id,key_expires_at,status,plan&limit=200`
  );
  if (!r.ok) {
    report.errors++;
    return report;
  }
  for (const a of r.data ?? []) {
    if (!a.key_expires_at) continue;
    report.considered++;
    // Discriminator = the expiry date: one obligation per key, however many days the key stays inside the window.
    if ((await notifyCustomer("key_rotation", a.id, a.key_expires_at)) === "ok") report.queued++;
    else report.errors++;
  }
  return report;
}
