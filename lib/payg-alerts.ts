// Server-only: the 80% / 100% usage alerts, once per account / month / percent.
//
// "Once" is enforced twice: the notification outbox's unique dedupe key (usage_alert:{account id}:{YYYY-MM}:{percent}, see
// lib/notifications.ts) and the usage_alerts primary key (account, month, percent). The outbox row is written FIRST: if the alert
// row were written first and the outbox write failed, the alert would be recorded as sent and never go out.

import { PAYG, accountRef, utcMonth } from "@/lib/payg";
import { recordFunnelEvent } from "@/lib/funnel";
import { notifyCustomer } from "@/lib/notifications";
import { enc, pg } from "@/lib/payg-store";
import { capUsedUnits, monthTotals } from "@/lib/payg-usage";
import type { ApiAccount } from "@/lib/api-access";

export interface AlertReport {
  considered: number;
  sent: number;
  skipped: number;
  errors: number;
}

/** The units this account may use in a month: the free allowance, or the customer's own cap. Null: nothing to alert about. */
export function alertCapUnits(acct: Pick<ApiAccount, "plan" | "cap_units">): number | null {
  if (acct.plan === "api_free") return PAYG.freeAllowanceUnits;
  if (acct.plan === "api_payg") return acct.cap_units && acct.cap_units > 0 ? acct.cap_units : null;
  return null;
}

export async function sendUsageAlerts(now: Date = new Date()): Promise<AlertReport> {
  const report: AlertReport = { considered: 0, sent: 0, skipped: 0, errors: 0 };
  const month = utcMonth(now);
  const totals = await monthTotals(month);
  if (!totals) {
    report.errors++;
    return report;
  }
  const percents = [...PAYG.alertPercents].sort((a, b) => a - b);
  for (const t of totals) {
    if (t.net_units <= 0) continue;
    const got = await pg<ApiAccount[]>("GET", `api_accounts?account=eq.${enc(t.account)}&limit=1`);
    if (!got.ok) {
      report.errors++;
      continue;
    }
    const acct = got.data?.[0];
    const cap = acct ? alertCapUnits(acct) : null;
    if (!acct || !cap || acct.status !== "active") continue;
    report.considered++;
    // Per-scope: free-allowance units never count against a pay-as-you-go cap (the engine counts caps per account, month and scope).
    const used = capUsedUnits(acct.plan, { net: t.net_units, billable_net: t.billable_units });
    const pct = (used / cap) * 100;
    // Adoption funnel: the allowance (or the customer's own cap) is fully used. The engine records no refusals, so this is derived at
    // ingest from used >= cap; once per account and month.
    if (used >= cap) {
      const ref = accountRef(acct.account);
      await recordFunnelEvent("allowance_exhausted", { plan: acct.plan, month, account_ref: ref }, { dedupeKey: `allowance_exhausted:${ref}:${month}` });
    }
    for (const p of percents) {
      if (pct < p) continue;
      const have = await pg<unknown[]>("GET", `usage_alerts?account=eq.${enc(acct.account)}&month=eq.${month}&percent=eq.${p}&select=percent&limit=1`);
      if (!have.ok) {
        report.errors++;
        continue;
      }
      if ((have.data?.length ?? 0) > 0) {
        report.skipped++;
        continue;
      }
      if ((await notifyCustomer("usage_alert", acct.id, `${month}:${p}`)) !== "ok") {
        report.errors++;
        continue;
      }
      const rec = await pg<unknown[]>("POST", "usage_alerts?on_conflict=account,month,percent", { account: acct.account, month, percent: p }, "resolution=ignore-duplicates,return=representation");
      if (!rec.ok) {
        report.errors++;
        continue;
      }
      if ((rec.data?.length ?? 0) > 0) {
        report.sent++;
        await recordFunnelEvent("alert_sent", { percent: p, month, plan: acct.plan, account_ref: accountRef(acct.account) }, { dedupeKey: `alert_sent:${accountRef(acct.account)}:${month}:${p}` });
      }
    }
  }
  return report;
}
