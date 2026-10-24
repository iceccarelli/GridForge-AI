import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { enforcePastDueGrace, type ReversalStripe } from "@/lib/billing-holds";
import { applyDuePauses } from "@/lib/billing-pause";
import { runSettlementReversalPass } from "@/lib/payg-refunds";
import { runPaygCron } from "@/lib/payg-cron";
import { notifyOperatorOnce } from "@/lib/payg-operator";
import { checkRevocationBacklog } from "@/lib/stripe-health";
import { paygStripe } from "@/lib/payg-stripe";
import { engineLedgerFetcher } from "@/lib/payg-usage";

export const runtime = "nodejs";
export const maxDuration = 300;

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false; // no secret configured = nothing is authorised
  const auth = req.headers.get("authorization") || "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const a = Buffer.from(given), b = Buffer.from(secret);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Daily: retry key revocations, ingest the engine ledger, send usage alerts, settle closed months, start the billing pauses whose paid
// period has ended, apply operator releases of refunded / disputed settlements and list the pay-as-you-go accounts still on such a hold.
// Header-only authorization with CRON_SECRET, failing CLOSED like /api/cron/notifications. Idempotent end to end: a second run (a
// retry, an overlap, a manual call) ingests nothing twice, alerts nothing twice and invoices no month twice (lib/payg-settle.ts).
export async function GET(req: Request) {
  if (!authorised(req)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  const report = await runPaygCron({ fetcher: engineLedgerFetcher(), stripe: paygStripe() });
  // After the sweep above: end the past_due grace of subscription API accounts (revoke the live key of any past API_PAST_DUE_GRACE_DAYS),
  // then report what the engine still has not confirmed. Neither throws; both are idempotent.
  const grace = await enforcePastDueGrace();
  // A pause is scheduled for the end of the period the customer paid for (lib/billing-pause.ts): the ones whose instant has passed become
  // the hold now (once, audited, after asking Stripe that billing is still paused). Then the pay-as-you-go settlements that were refunded or
  // disputed (lib/payg-refunds.ts): operator releases are applied, and the accounts still held are listed and mailed once a day, because a
  // person decides whether that customer's access continues.
  const pauses = await applyDuePauses({ stripe: paygStripe() as unknown as ReversalStripe | null });
  const settlementReversals = await runSettlementReversalPass();
  if (settlementReversals.heldAccounts.length > 0) {
    await notifyOperatorOnce(
      `payg_holds:${new Date().toISOString().slice(0, 10)}`,
      `Pay-as-you-go accounts on a refund or dispute hold: ${settlementReversals.heldAccounts.length}`,
      `${settlementReversals.heldAccounts.map((a) => `account reference ${a.account_ref}: ${a.hold}${a.since ? ` since ${a.since}` : ""}`).join("\n")}\n\n` +
        "Each stopped further pay-as-you-go use after a settlement invoice was refunded in full or disputed. The usage ledger and the units already consumed are unchanged and nothing was credited to a future invoice. " +
        "A won dispute or a paid later settlement lifts a hold by itself; otherwise append a release row to payg_settlement_reversals (the notice sent when the hold began says how). This summary is sent once a day while any hold stands."
    );
  }
  const backlog = await checkRevocationBacklog();
  if (backlog.checked && !backlog.ok) {
    // A credential the site has cut off and the engine has not: said once a day while it holds, not left to a log line.
    await notifyOperatorOnce(
      `revocation_backlog:${new Date().toISOString().slice(0, 10)}`,
      `Key revocations NOT confirmed by the engine — ${backlog.idsPendingOnCutOffAccounts} on cut-off accounts`,
      `${backlog.error}\n\nAccounts with an unconfirmed id: ${backlog.accountsPending}; ids: ${backlog.idsPending}; engine /v1/revoke: ${backlog.engineRevokeRoute}. ` +
        "GET /api/admin/stripe-health lists the same numbers. This notice is sent once a day while the backlog stands."
    );
  }
  return NextResponse.json({ ok: true, ...report, grace, pauses, settlement_reversals: settlementReversals, revocation_backlog: backlog });
}
