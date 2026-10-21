// Server-only: the daily pay-as-you-go job, in the order that keeps it honest.
//
//   1. retry unconfirmed key revocations          (so a revoked key actually stops working; independent of the rest)
//   2. remind free / pay-as-you-go customers whose key is about to expire (a signed key cannot be extended; nothing else tells them)
//   3. ingest the engine's ledger into usage_events, cursor moving only with durable inserts; an unreadable event is quarantined
//   4. usage alerts (80% / 100% of the cap), once per account / month / percent
//   5. settle closed months                        ONLY if step 3 reached the engine's head with no error and no alarm, and never a
//                                                  month an un-acknowledged quarantined event could belong to. A settlement closes a
//                                                  month for good, so settling on a partial copy would under-bill it forever.
//
// Every step reports; none throws. The route answers with the report so an operator (or a monitor) can read what happened. Anything an
// operator must look at (a ledger alarm, a quarantined event) is also mailed to them.

import { retryRevocations } from "@/lib/api-access";
import { notifyOperator } from "@/lib/mail";
import { sendUsageAlerts, type AlertReport } from "@/lib/payg-alerts";
import { remindExpiringKeys, type ReminderReport } from "@/lib/payg-reminders";
import { settleClosedMonths, type SettleReport } from "@/lib/payg-settle";
import type { PaygStripe } from "@/lib/payg-stripe";
import { ingestLedger, openQuarantine, type IngestResult, type LedgerFetcher } from "@/lib/payg-usage";

export interface CronDeps {
  fetcher: LedgerFetcher | null;
  stripe: PaygStripe | null;
  now?: Date;
}

export interface CronReport {
  revocations: { accounts: number; confirmed: number; stillPending: number };
  reminders: ReminderReport;
  ingest: IngestResult | { skipped: string };
  alerts: AlertReport | { skipped: string };
  settle: SettleReport | { skipped: string };
}

export async function runPaygCron(deps: CronDeps): Promise<CronReport> {
  const now = deps.now ?? new Date();
  const revocations = await retryRevocations(50, now);
  const reminders = await remindExpiringKeys(now);

  if (!deps.fetcher) {
    return { revocations, reminders, ingest: { skipped: "engine not configured" }, alerts: { skipped: "no usage data" }, settle: { skipped: "no usage data" } };
  }
  const ingest = await ingestLedger(deps.fetcher);

  if (ingest.alarm) {
    await notifyOperator(
      ingest.alarm === "ledger_behind" ? "Pay-as-you-go ledger alarm: the engine's ledger is BEHIND our cursor" : "Pay-as-you-go ledger alarm: the engine's ledger is not durable",
      ingest.alarm === "ledger_behind"
        ? `The engine reports a ledger head (${ingest.headSeq}) behind the ingest cursor (${ingest.cursor}). That is what a restored or lost ledger volume looks like. ` +
            "Nothing is settled while this holds, and no usage was ingested this run. Check the engine's /data volume and GRIDFORGE_LEDGER_FILE before anything else; " +
            "do not move the cursor until you know which events exist."
        : "The engine says its usage ledger cannot be persisted. Nothing is settled while this holds. Fix the ledger volume on the engine."
    );
  }
  if (ingest.quarantined > 0) {
    await notifyOperator(
      "Pay-as-you-go: ledger event(s) quarantined",
      `${ingest.quarantined} ledger event(s) could not be read by the website and were set aside in usage_quarantine (the cursor moved past them so ingest is not stalled). ` +
        "No month they could belong to will be settled until you acknowledge them (ackQuarantinedEvent / update usage_quarantine set acked_at)."
    );
  }

  // Alerts read whatever is durable; they do not need the copy to be complete (a late alert is better than none).
  const alerts = await sendUsageAlerts(now);

  let settle: CronReport["settle"];
  if (!ingest.ok || !ingest.complete || ingest.alarm) settle = { skipped: ingest.error ?? "ledger not fully ingested" };
  else if (!deps.stripe) settle = { skipped: "stripe not configured" };
  else {
    settle = await settleClosedMonths(deps.stripe, now);
    // A held month is a daily reminder, not a silent state.
    if (settle.heldByQuarantine > 0) {
      const open = (await openQuarantine()) ?? [];
      await notifyOperator("Pay-as-you-go: settlement held by quarantined ledger events", `${open.length} un-acknowledged quarantined event(s): ${open.slice(0, 20).map((q) => `seq ${q.seq} (${q.reason})`).join("; ")}`);
    }
  }
  return { revocations, reminders, ingest, alerts, settle };
}
