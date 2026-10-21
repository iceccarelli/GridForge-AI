// Server-only: the daily pay-as-you-go job, in the order that keeps it honest.
//
//   1. retry unconfirmed key revocations          (so a revoked key actually stops working; independent of the rest)
//   2. ingest the engine's ledger into usage_events, cursor moving only with durable inserts
//   3. usage alerts (80% / 100% of the cap), once per account / month / percent
//   4. settle closed months                        ONLY if step 2 reached the engine's head with no error. A settlement closes
//                                                  a month for good, so settling on a partial copy would under-bill it forever.
//
// Every step reports; none throws. The route answers with the report so an operator (or a monitor) can read what happened.

import { retryRevocations } from "@/lib/api-access";
import { sendUsageAlerts, type AlertReport } from "@/lib/payg-alerts";
import { settleClosedMonths, type SettleReport } from "@/lib/payg-settle";
import type { PaygStripe } from "@/lib/payg-stripe";
import { ingestLedger, type IngestResult, type LedgerFetcher } from "@/lib/payg-usage";

export interface CronDeps {
  fetcher: LedgerFetcher | null;
  stripe: PaygStripe | null;
  now?: Date;
}

export interface CronReport {
  revocations: { accounts: number; confirmed: number; stillPending: number };
  ingest: IngestResult | { skipped: string };
  alerts: AlertReport | { skipped: string };
  settle: SettleReport | { skipped: string };
}

export async function runPaygCron(deps: CronDeps): Promise<CronReport> {
  const now = deps.now ?? new Date();
  const revocations = await retryRevocations();

  if (!deps.fetcher) {
    return { revocations, ingest: { skipped: "engine not configured" }, alerts: { skipped: "no usage data" }, settle: { skipped: "no usage data" } };
  }
  const ingest = await ingestLedger(deps.fetcher);
  // Alerts read whatever is durable; they do not need the copy to be complete (a late alert is better than none).
  const alerts = await sendUsageAlerts(now);

  let settle: CronReport["settle"];
  if (!ingest.ok || !ingest.complete) settle = { skipped: ingest.error ?? "ledger not fully ingested" };
  else if (!deps.stripe) settle = { skipped: "stripe not configured" };
  else settle = await settleClosedMonths(deps.stripe, now);
  return { revocations, ingest, alerts, settle };
}
