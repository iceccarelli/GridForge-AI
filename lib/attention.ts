// Server-only: the operator's "needs a person" list for paid work.
//
// Everything a customer has paid for that is not moving by itself shows up here, with how long it has been waiting and
// who (if anyone) owns it. The list exists because the failure it prevents has no other symptom: a paid engagement stuck
// in `generating`, a deposit nobody has contacted, a draft nobody has reviewed and a Hall Watch with no numbers all look
// like ordinary rows until a customer writes in.
//
// Thresholds are INTERNAL review thresholds (lib/engagement-state.ts). A deposit's delivery date is the one date that
// is ever stated, and it is the one a named person recorded when the scope was agreed.
//
// A read that fails is reported as a failed read. An empty list from a store that could not be read would tell the
// operator that nothing is wrong, which is the exact failure this list is for.

import { PRODUCT_BY_KIND } from "@/lib/products";
import { creds, rest, STORE_UNCONFIGURED } from "@/lib/pgrest";
import { REVIEW_AFTER_DAYS, days, generatingSince, isStaleGenerating } from "@/lib/engagement-state";

export type AttentionKind =
  | "stuck_generating"
  | "engine_held"
  | "draft_unreviewed"
  | "intake_not_submitted"
  | "deposit_uncontacted"
  | "deposit_unscoped"
  | "deposit_overdue"
  | "deposit_no_date"
  | "watch_no_numbers"
  | "watch_paused"
  | "watch_notice_abandoned";

export interface AttentionItem {
  kind: AttentionKind;
  /** The row's id (never a token: a document token is a credential). */
  ref: string;
  table: "deliverables" | "engagement_deposits" | "watches" | "watch_note_notices";
  what: string;
  buyer: string | null;
  since: string | null;
  age_days: number | null;
  owner: string | null;
  /** The delivery date a person recorded, for a scoped deposit. */
  due: string | null;
  action: string;
}

type Row = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const ageDays = (iso: string | null, now: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? Math.floor((now - t) / days(1)) : null;
};
const older = (iso: string | null, thresholdDays: number, now: number) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) && now - t > days(thresholdDays);
};
const nameOf = (kind: string) => PRODUCT_BY_KIND[kind]?.name ?? kind;

/** Pure: classify already-read rows. Exported for tests. */
export function classify(
  input: { deliverables: Row[]; deposits: Row[]; watches: Row[]; notices: Row[] },
  now: number = Date.now()
): AttentionItem[] {
  const out: AttentionItem[] = [];

  for (const d of input.deliverables) {
    const status = str(d.status);
    const base = { ref: String(d.id), table: "deliverables" as const, what: nameOf(String(d.kind)), buyer: str(d.email), owner: null, due: null };
    const meta = (d.intake as { _gridforge?: { generated_at?: unknown } } | null)?._gridforge;
    if (status === "generating" && isStaleGenerating({ status, intake: d.intake }, now)) {
      const since = generatingSince({ intake: d.intake }) ? new Date(generatingSince({ intake: d.intake })!).toISOString() : str(d.created_at);
      out.push({ ...base, kind: "stuck_generating", since, age_days: ageDays(since, now),
        action: "Generation started and never finished (its request is gone). Reopen it, or Regenerate it from the stored numbers; the sweep also moves it to 'engine_unavailable'." });
    } else if (status === "engine_unavailable") {
      out.push({ ...base, kind: "engine_held", since: str(d.created_at), age_days: ageDays(str(d.created_at), now),
        action: "Held: the engine could not produce the whole pack. Regenerate it once the engine is back; it cannot be released while held." });
    } else if (status === "draft") {
      const since = str(meta?.generated_at) ?? str(d.created_at);
      if (older(since, REVIEW_AFTER_DAYS.draft_unreviewed, now)) {
        out.push({ ...base, kind: "draft_unreviewed", since, age_days: ageDays(since, now),
          action: "A draft is waiting for a named engineer to review and release it. The buyer has been told it is with an engineer." });
      }
    } else if (status === "awaiting_intake" && str(d.stripe_session_id) && older(str(d.created_at), REVIEW_AFTER_DAYS.intake_not_submitted, now)) {
      out.push({ ...base, kind: "intake_not_submitted", since: str(d.created_at), age_days: ageDays(str(d.created_at), now),
        action: "Paid, and the hall's numbers have not been submitted. Contact the buyer; the intake link is on /commissioned and in their email." });
    }
  }

  const today = new Date(now).toISOString().slice(0, 10);
  for (const p of input.deposits) {
    const status = str(p.status);
    if (status === "delivered") continue;
    const base = { ref: String(p.id), table: "engagement_deposits" as const, what: nameOf(String(p.kind)), buyer: str(p.email), owner: str(p.owner), due: str(p.delivery_due_on) };
    if (status === "paid" && older(str(p.paid_at), REVIEW_AFTER_DAYS.deposit_uncontacted, now)) {
      out.push({ ...base, kind: "deposit_uncontacted", since: str(p.paid_at), age_days: ageDays(str(p.paid_at), now),
        action: "Paid and nobody has recorded contacting the buyer. Record who has (owner)." });
    } else if (status === "contacted" && older(str(p.contacted_at), REVIEW_AFTER_DAYS.deposit_unscoped, now)) {
      out.push({ ...base, kind: "deposit_unscoped", since: str(p.contacted_at), age_days: ageDays(str(p.contacted_at), now),
        action: "Contacted, and no scope, fee or delivery date has been recorded. Record what was agreed." });
    } else if (status === "scoped") {
      if (!str(p.delivery_due_on)) {
        out.push({ ...base, kind: "deposit_no_date", since: str(p.scoped_at), age_days: ageDays(str(p.scoped_at), now),
          action: "Scoped before delivery dates were recorded: no date is on file for this deposit. Agree one with the buyer and note it." });
      } else if (String(p.delivery_due_on) < today) {
        out.push({ ...base, kind: "deposit_overdue", since: str(p.delivery_due_on), age_days: ageDays(`${p.delivery_due_on}T00:00:00Z`, now),
          action: "Past the delivery date recorded when the scope was agreed. Deliver, or tell the buyer and record why." });
      }
    }
  }

  for (const w of input.watches) {
    const status = str(w.status);
    const base = { ref: String(w.id), table: "watches" as const, what: nameOf("hall_watch"), buyer: str(w.email), owner: null, due: null };
    if (status === "active" && !w.intake && older(str(w.created_at), REVIEW_AFTER_DAYS.watch_no_numbers, now)) {
      out.push({ ...base, kind: "watch_no_numbers", since: str(w.created_at), age_days: ageDays(str(w.created_at), now),
        action: "Paid, and the buyer has not given the hall's numbers, so no run can happen. Contact them." });
    } else if (status === "paused") {
      out.push({ ...base, kind: "watch_paused", since: str(w.last_run_at) ?? str(w.created_at), age_days: null,
        action: "Paused by a failed payment: no runs happen until the payment clears. It resumes by itself when Stripe reports a paid invoice." });
    }
  }

  for (const n of input.notices) {
    out.push({ ref: String(n.id), table: "watch_note_notices", kind: "watch_notice_abandoned", what: "Hall Watch change note email", buyer: null,
      since: str(n.created_at), age_days: ageDays(str(n.created_at), now), owner: null, due: null,
      action: "The change note was stored but its email could not be delivered after repeated attempts. The note is on the buyer's watch page; tell them." });
  }

  return out.sort((a, b) => (b.age_days ?? -1) - (a.age_days ?? -1));
}

export type AttentionResult =
  | { ok: true; items: AttentionItem[]; checked_at: string }
  | { ok: false; status: number; error: string };

export async function attentionList(now: number = Date.now()): Promise<AttentionResult> {
  if (!creds()) return { ok: false, status: STORE_UNCONFIGURED.status, error: STORE_UNCONFIGURED.error };
  const [d, p, w, n] = await Promise.all([
    rest<Row[]>("GET", "deliverables?status=in.(generating,engine_unavailable,draft,awaiting_intake)&select=id,kind,status,email,created_at,stripe_session_id,intake&order=created_at.asc&limit=500"),
    rest<Row[]>("GET", "engagement_deposits?status=neq.delivered&select=*&order=paid_at.asc&limit=500"),
    rest<Row[]>("GET", "watches?status=in.(active,paused)&select=id,email,status,intake,created_at,last_run_at&order=created_at.asc&limit=500"),
    // The notice table exists only once migration 0030 is applied; its absence is not an error of the list.
    rest<Row[]>("GET", "watch_note_notices?status=eq.abandoned&select=id,created_at&order=created_at.asc&limit=200"),
  ]);
  if (!d.ok || !p.ok || !w.ok) {
    return { ok: false, status: 502, error: "The attention list could not be read completely. This is not a statement that nothing needs attention." };
  }
  const items = classify({ deliverables: d.data ?? [], deposits: p.data ?? [], watches: w.data ?? [], notices: n.ok ? (n.data ?? []) : [] }, now);
  return { ok: true, items, checked_at: new Date(now).toISOString() };
}

// ------------------------------------------------------------------------------------------------ deposits table

export interface DepositView {
  id: string;
  what: string;
  buyer: string | null;
  company: string | null;
  status: string;
  /** Whole days since the payment cleared. */
  age_days: number | null;
  paid_at: string | null;
  owner: string | null;
  contacted_at: string | null;
  fee_cents: number | null;
  credit_cents: number | null;
  balance_due_cents: number | null;
  due: string | null;
  delivered_at: string | null;
  /** The attention kind this deposit is currently flagged with, if any. */
  flag: AttentionKind | null;
}

/** Pure: the operator's deposits table from rows already read (oldest payment first). Exported for tests. */
export function shapeDeposits(rows: Row[], now: number = Date.now()): DepositView[] {
  const flags = new Map<string, AttentionKind>();
  for (const i of classify({ deliverables: [], deposits: rows, watches: [], notices: [] }, now)) flags.set(i.ref, i.kind);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return [...rows]
    .sort((a, b) => String(a.paid_at ?? "").localeCompare(String(b.paid_at ?? "")))
    .map((p) => {
      const fee = num(p.agreed_fee_cents);
      const credit = fee === null ? null : (num(p.credit_applied_cents) ?? 0);
      return {
        id: String(p.id),
        what: nameOf(String(p.kind)),
        buyer: str(p.email),
        company: str(p.company),
        status: String(p.status ?? ""),
        age_days: ageDays(str(p.paid_at), now),
        paid_at: str(p.paid_at),
        owner: str(p.owner),
        contacted_at: str(p.contacted_at),
        fee_cents: fee,
        credit_cents: credit,
        balance_due_cents: fee === null ? null : Math.max(0, fee - (num(p.amount_cents) ?? 0) - (credit ?? 0)),
        due: str(p.delivery_due_on),
        delivered_at: str(p.delivered_at),
        flag: flags.get(String(p.id)) ?? null,
      };
    });
}

/** Every deposit (delivered ones too, so the record of what was committed and when stays readable), shaped for the table. */
export async function depositTable(now: number = Date.now()): Promise<{ ok: true; items: DepositView[] } | { ok: false; error: string }> {
  if (!creds()) return { ok: false, error: STORE_UNCONFIGURED.error };
  const r = await rest<Row[]>("GET", "engagement_deposits?select=*&order=paid_at.asc&limit=500");
  if (!r.ok) return { ok: false, error: "The deposit list could not be read." };
  return { ok: true, items: shapeDeposits(r.data ?? [], now) };
}
