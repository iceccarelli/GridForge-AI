// Server-only: the append-only billing_audit trail (migration 0041), one function every billing path writes through.
//
// A leaf module (store + operator mail only) so that the access checks (lib/subscribers.ts, lib/api-access.ts) can audit a decision without
// importing the whole hold machinery, which imports them.

import { notifyOperatorOnce } from "@/lib/payg-operator";
import { pg } from "@/lib/payg-store";

export interface AuditEntry {
  /** Once-only key: a redelivered event records nothing twice. */
  dedupeKey: string;
  table: "api_accounts" | "watches" | "subscriptions" | "stripe_disputes" | "deliverables" | "engagement_deposits";
  subjectId: string;
  action: string;
  eventId?: string;
  objectId?: string;
  invoiceId?: string | null;
  subscriptionId?: string;
  detail?: Record<string, string | number | boolean | null>;
}

/**
 * Append one decision to billing_audit. "duplicate": already there (a redelivery). "unavailable": the table does not exist yet
 * (migration 0041), reported to the operator once and NOT a reason to refuse the event. "error": the store failed; the caller retries.
 */
export async function recordBillingAudit(e: AuditEntry): Promise<"recorded" | "duplicate" | "unavailable" | "error"> {
  const r = await pg<{ id: string }[]>(
    "POST",
    "billing_audit?on_conflict=dedupe_key",
    {
      dedupe_key: e.dedupeKey,
      subject_table: e.table,
      subject_id: e.subjectId,
      action: e.action,
      stripe_event_id: e.eventId ?? null,
      stripe_object_id: e.objectId ?? null,
      stripe_invoice_id: e.invoiceId ?? null,
      stripe_subscription_id: e.subscriptionId || null,
      detail: e.detail ?? {},
    },
    "resolution=ignore-duplicates,return=representation"
  );
  if (r.ok) return (r.data?.length ?? 0) > 0 ? "recorded" : "duplicate";
  if (r.status === 404 || r.code === "PGRST205" || r.code === "42P01") {
    await notifyOperatorOnce(
      "migration_0041_missing",
      "Migration 0041 (billing holds and audit trail) is not applied",
      "A billing decision about a customer's access could not be written to billing_audit because the table does not exist. The decision itself WAS applied " +
        "(as a status change), but it is not audited and a refund, dispute or pause cannot be reversed individually until supabase/migrations/0041_billing_holds.sql is applied. " +
        "This notice is sent once."
    );
    return "unavailable";
  }
  return "error";
}
