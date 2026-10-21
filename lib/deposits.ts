// Server-only: the hand-off for the two products that open no object — the Envelope Study and
// Portfolio Screen deposits. The webhook writes the payment here before it answers 200 (a failed
// write makes Stripe redeliver); after that a named person moves it forward, one step at a time,
// each step carrying the thing that proves it (migration 0019).
//
//   paid -> contacted (owner) -> scoped (scope note, agreed fee, delivery date, credits) -> delivered (delivery reference)
//
// No date is promised at payment: how quickly someone answers is the operator's to say, and the quoted turnaround counts
// from a complete intake and the scoping call, not from payment (lib/engagement-state.ts depositTerms). The one date that
// IS stated is the delivery date a named person commits to when the scope is agreed; it is recorded at that step, set once
// (migration 0030), and an operator list flags the deposit when it passes (lib/attention.ts).
//
// Credits are a ledger, not text: a paid Density Screen is credited against a Study deposit once, at scoping, in the same
// transaction as the scoping step (gf_scope_deposit).

import { creds, rest, rpc, STORE_UNCONFIGURED, type Result } from "@/lib/projects";
import { creditsToward } from "@/lib/deliverables";
import { storeFault } from "@/lib/safe-log";
import { PRODUCT_BY_KIND } from "@/lib/products";
import { balanceDueCents } from "@/lib/engagement-state";

export const DEPOSIT_STEPS = ["paid", "contacted", "scoped", "delivered"] as const;
export type DepositStatus = (typeof DEPOSIT_STEPS)[number];

export interface DepositRow {
  id: string;
  stripe_session_id: string;
  kind: string;
  amount_cents: number;
  currency: string;
  email: string | null;
  company: string | null;
  project_id: string | null;
  paid_at: string;
  status: DepositStatus;
  owner: string | null;
  contacted_at: string | null;
  scope_note: string | null;
  scoped_at: string | null;
  delivery_ref: string | null;
  delivered_at: string | null;
  /** Set once at scoping (migration 0030); null on a deposit scoped before it existed. */
  agreed_fee_cents?: number | null;
  credit_applied_cents?: number | null;
  delivery_due_on?: string | null;
}

const q = encodeURIComponent;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Record one paid deposit, once per Stripe session. Returns ok for a first write AND for a redelivery
 * (the unique session id makes it a no-op); returns not-ok for anything that did not durably land, so
 * the caller can ask Stripe to retry rather than lose a four-to-five-figure payment.
 */
export async function recordDeposit(p: {
  sessionId: string;
  kind: string;
  amountCents: number;
  currency: string | null;
  email: string;
  company: string;
  projectId: string;
}): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  const c = creds();
  if (!c) return { ok: false, error: STORE_UNCONFIGURED.error };
  if (!(p.amountCents > 0)) return { ok: false, error: "A deposit with no amount cannot be recorded." };
  try {
    const res = await fetch(`${c.url}/rest/v1/engagement_deposits?on_conflict=stripe_session_id`, {
      method: "POST",
      headers: { ...c.headers, Prefer: "resolution=ignore-duplicates,return=representation" },
      body: JSON.stringify({
        stripe_session_id: p.sessionId,
        status: "paid",
        kind: p.kind,
        amount_cents: p.amountCents,
        currency: (p.currency || "eur").toLowerCase(),
        email: p.email || null,
        company: p.company || null,
        project_id: p.projectId || null,
      }),
      cache: "no-store",
    });
    if (!res.ok) {
      console.error("[GridForge] deposit NOT recorded:", await storeFault(res));
      return { ok: false, error: `store ${res.status}` };
    }
    const rows = (await res.json().catch(() => [])) as unknown[];
    return { ok: true, created: Array.isArray(rows) && rows.length > 0 };
  } catch (err) {
    console.error("[GridForge] deposit store unreachable:", err);
    return { ok: false, error: "store unreachable" };
  }
}

export async function depositBySession(sessionId: string): Promise<DepositRow | null> {
  if (!creds() || !sessionId) return null;
  const r = await rest<DepositRow[]>("GET", `engagement_deposits?stripe_session_id=eq.${q(sessionId)}&select=*&limit=1`);
  return r.ok ? (r.data?.[0] ?? null) : null;
}

/** Every deposit not yet delivered, oldest payment first — the operator's work list. */
export async function openDeposits(all = false): Promise<Result<{ items: DepositRow[] }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  const r = await rest<DepositRow[]>(
    "GET",
    `engagement_deposits?select=*${all ? "" : "&status=neq.delivered"}&order=paid_at.asc`
  );
  if (!r.ok) return { ok: false, status: 502, error: "The deposit list could not be read." };
  return { ok: true, items: r.data ?? [] };
}

/** One earlier payment that MAY be credited. The identity is the address typed at that checkout (unverified), so an operator confirms it. */
export interface CreditCandidate {
  source_deliverable_id: string;
  kind: string;
  amount_cents: number;
  /** The address as typed at that checkout, the company and the date: what the operator compares with the deposit's buyer. */
  email: string;
  company: string | null;
  paid_on: string | null;
}

/** The paid Density Screens of this buyer that credit against this deposit's engagement and have not been credited yet. */
export async function availableCredits(
  dep: Pick<DepositRow, "email" | "kind">
): Promise<Result<{ credits: CreditCandidate[] }>> {
  const engagement = dep.kind.replace(/_deposit$/, "");
  const found = await creditsToward(dep.email ?? "", engagement);
  if (!found.ok) return { ok: false, status: 502, error: "The buyer's earlier payments could not be read, so no credit was applied. Nothing was recorded." };
  if (found.from.length === 0) return { ok: true, credits: [] };
  const ids = found.from.map((f) => f.id).filter(Boolean);
  const ledger = await rest<{ source_deliverable_id: string }[]>(
    "GET",
    `engagement_credits?source_deliverable_id=in.(${ids.map(q).join(",")})&select=source_deliverable_id`
  );
  if (!ledger.ok) {
    // Never guess a credit, and never apply one without being able to see whether it was already given.
    return { ok: false, status: 503, error: "The credit ledger could not be read (is migration 0030 applied?). Nothing was recorded." };
  }
  const applied = new Set((ledger.data ?? []).map((r) => r.source_deliverable_id));
  return {
    ok: true,
    credits: found.from.filter((f) => f.id && !applied.has(f.id)).map((f) => ({ source_deliverable_id: f.id, kind: f.kind, amount_cents: f.amount_cents, email: f.email, company: f.company, paid_on: f.created_at ? f.created_at.slice(0, 10) : null })),
  };
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Move one deposit forward by exactly one step. Called only from an admin-authenticated route. */
export async function advanceDeposit(
  id: unknown,
  input: {
    owner?: unknown;
    scope_note?: unknown;
    agreed_fee_cents?: unknown;
    delivery_due_on?: unknown;
    delivery_ref?: unknown;
    applied_by?: unknown;
    confirm_credit_ids?: unknown;
  },
  today: string = new Date().toISOString().slice(0, 10)
): Promise<Result<{ deposit: DepositRow; balance_due_cents: number | null; credits: { source_deliverable_id: string; amount_cents: number }[]; credits_unapplied?: { source_deliverable_id: string; amount_cents: number }[] }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  if (typeof id !== "string" || !UUID.test(id)) return { ok: false, status: 404, error: "Not found." };
  const cur = await rest<DepositRow[]>("GET", `engagement_deposits?id=eq.${q(id)}&select=*&limit=1`);
  if (!cur.ok) return { ok: false, status: 502, error: "The deposit could not be read." };
  const row = cur.data?.[0];
  if (!row) return { ok: false, status: 404, error: "Not found." };
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null);
  const now = new Date().toISOString();
  let patch: Record<string, unknown>;
  if (row.status === "scoped" || row.status === "delivered") {
    if (row.status === "delivered") return { ok: false, status: 409, error: "This deposit is already delivered." };
    const ref = text(input.delivery_ref, 500);
    if (!ref) return { ok: false, status: 422, error: "delivery_ref is required: where the delivered work can be found." };
    patch = { status: "delivered", delivery_ref: ref, delivered_at: now };
  } else if (row.status === "paid") {
    const owner = text(input.owner, 120);
    if (!owner) return { ok: false, status: 422, error: "owner is required: the person who has contacted the buyer." };
    patch = { status: "contacted", owner, contacted_at: now };
  } else {
    return scope(row, input, today);
  }
  // Conditional on the step we read, so two operators cannot both advance the same step.
  const c = creds()!;
  const res = await fetch(`${c.url}/rest/v1/engagement_deposits?id=eq.${q(id)}&status=eq.${row.status}`, {
    method: "PATCH",
    headers: { ...c.headers, Prefer: "return=representation" },
    body: JSON.stringify(patch),
    cache: "no-store",
  }).catch(() => null);
  if (!res || !res.ok) return { ok: false, status: 502, error: "The step could not be saved. Nothing was recorded." };
  const out = (await res.json().catch(() => [])) as DepositRow[];
  if (!out[0]) return { ok: false, status: 409, error: "Someone else already moved this deposit; reload it." };
  return { ok: true, deposit: out[0], balance_due_cents: balanceOf(out[0]), credits: [] };
}

function balanceOf(d: DepositRow): number | null {
  return typeof d.agreed_fee_cents === "number" ? balanceDueCents(d.agreed_fee_cents, d.amount_cents, d.credit_applied_cents ?? 0) : null;
}

/**
 * contacted -> scoped: record the scope, the fee agreed for it, the delivery date committed to it and the credits applied,
 * in one transaction. The fee must lie inside the band the public price list says this deposit opens, because a fee outside
 * it contradicts what the buyer was shown when they paid; if the band is wrong the catalogue is the thing to change.
 */
async function scope(
  row: DepositRow,
  input: { scope_note?: unknown; agreed_fee_cents?: unknown; delivery_due_on?: unknown; applied_by?: unknown; owner?: unknown; confirm_credit_ids?: unknown },
  today: string
): Promise<Result<{ deposit: DepositRow; balance_due_cents: number | null; credits: { source_deliverable_id: string; amount_cents: number }[]; credits_unapplied?: { source_deliverable_id: string; amount_cents: number }[] }>> {
  const note = typeof input.scope_note === "string" ? input.scope_note.trim() : "";
  if (!note || note.length > 2000) return { ok: false, status: 422, error: "scope_note is required: what was agreed with the buyer." };
  const fee = input.agreed_fee_cents;
  if (typeof fee !== "number" || !Number.isInteger(fee) || fee <= 0) {
    return { ok: false, status: 422, error: "agreed_fee_cents is required: the fixed fee agreed with the buyer for this scope, in EUR cents." };
  }
  const band = PRODUCT_BY_KIND[row.kind]?.opensBandCents;
  if (band && (fee < band[0] || fee > band[1])) {
    return {
      ok: false,
      status: 422,
      error: `agreed_fee_cents is outside the ${band[0]}-${band[1]} cent band this deposit was sold against. Agree a scope that fits the band, or change the published band first.`,
    };
  }
  const due = input.delivery_due_on;
  if (typeof due !== "string" || !ISO_DAY.test(due) || Number.isNaN(Date.parse(`${due}T00:00:00Z`))) {
    return { ok: false, status: 422, error: "delivery_due_on is required (YYYY-MM-DD): the delivery date committed to when the scope was agreed." };
  }
  if (due < today) return { ok: false, status: 422, error: "delivery_due_on is in the past." };

  if (row.amount_cents > fee) {
    return { ok: false, status: 422, error: "The agreed fee is lower than the deposit already paid; a credit reduces what is owed, it never creates a refund. Nothing was recorded." };
  }
  const available = await availableCredits(row);
  if (!available.ok) return available;
  // A credit is money not collected, and its identity is only the address typed (unverified) at an earlier checkout. So the
  // operator confirms WHICH of the buyer's earlier payments to credit: a call that leaves credits unconfirmed is refused with
  // the candidates listed (nothing recorded), and is repeated with confirm_credit_ids (an empty list applies none).
  const confirmed = input.confirm_credit_ids;
  if (available.credits.length > 0 && confirmed === undefined) {
    return {
      ok: false,
      status: 409,
      error:
        "This buyer has earlier payments that may be credited against this fee. Check each one is the same buyer (the address was typed at checkout and is not verified), " +
        "then repeat the request with confirm_credit_ids listing the ones to apply ([] applies none). Nothing was recorded.",
      details: { credits_available: available.credits, needs: "confirm_credit_ids" },
    } as Result<never>;
  }
  if (confirmed !== undefined && (!Array.isArray(confirmed) || !confirmed.every((x) => typeof x === "string"))) {
    return { ok: false, status: 422, error: "confirm_credit_ids must be a list of credit source ids." };
  }
  const chosen = new Set<string>((confirmed as string[] | undefined) ?? []);
  const known = new Set(available.credits.map((c) => c.source_deliverable_id));
  const stray = [...chosen].filter((id) => !known.has(id));
  if (stray.length) {
    return { ok: false, status: 422, error: "A credit you confirmed is not available for this buyer (already credited, or not theirs). Nothing was recorded.", details: { not_available: stray } } as Result<never>;
  }
  // Apply the confirmed credits whole while the deposit plus the credits still fit inside the fee. A credit that would take
  // the total past the fee is NOT applied (and is not consumed: it stays available), because a credit reduces what is owed and
  // never creates a refund. Largest first, ties by id, so the choice is the same every time.
  const credits: CreditCandidate[] = [];
  let creditTotal = 0;
  for (const c of available.credits.filter((x) => chosen.has(x.source_deliverable_id)).sort((a, b) => b.amount_cents - a.amount_cents || (a.source_deliverable_id < b.source_deliverable_id ? -1 : 1))) {
    if (row.amount_cents + creditTotal + c.amount_cents <= fee) {
      credits.push(c);
      creditTotal += c.amount_cents;
    }
  }
  const unapplied = available.credits.filter((c) => !credits.includes(c));
  const by = typeof input.applied_by === "string" && input.applied_by.trim() ? input.applied_by.trim().slice(0, 120) : row.owner;
  if (!by) return { ok: false, status: 422, error: "applied_by is required." };
  const r = await rpc<DepositRow>("gf_scope_deposit", {
    p: { id: row.id, scope_note: note, agreed_fee_cents: fee, delivery_due_on: due, applied_by: by, credits: credits.map((c) => ({ source_deliverable_id: c.source_deliverable_id, amount_cents: c.amount_cents })) },
  });
  if (!r.ok) {
    if (r.code === "23505") return { ok: false, status: 409, error: "A credit this deposit was about to use was applied elsewhere a moment ago; reload and try again. Nothing was recorded." };
    if (r.code === "55000") return { ok: false, status: 409, error: "Someone else already moved this deposit, or a credit failed its checks; reload it. Nothing was recorded." };
    if (r.status === 404) return { ok: false, status: 503, error: "Scoping needs migration 0030 (gf_scope_deposit), which this database does not have yet. Nothing was recorded." };
    return { ok: false, status: 502, error: "The step could not be saved. Nothing was recorded." };
  }
  const dep = r.data;
  return {
    ok: true,
    deposit: dep,
    balance_due_cents: balanceOf(dep),
    credits: credits.map((c) => ({ source_deliverable_id: c.source_deliverable_id, amount_cents: c.amount_cents })),
    credits_unapplied: unapplied.map((c) => ({ source_deliverable_id: c.source_deliverable_id, amount_cents: c.amount_cents })),
  };
}
