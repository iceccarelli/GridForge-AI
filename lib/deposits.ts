// Server-only: the hand-off for the two products that open no object — the Envelope Study and
// Portfolio Screen deposits. The webhook writes the payment here before it answers 200 (a failed
// write makes Stripe redeliver); after that a named person moves it forward, one step at a time,
// each step carrying the thing that proves it (migration 0019).
//
//   paid -> contacted (owner) -> scoped (scope note) -> delivered (delivery reference)
//
// No date is promised anywhere: how quickly someone answers is the operator's to say.

import { creds, rest, STORE_UNCONFIGURED, type Result } from "@/lib/projects";

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
      console.error("[GridForge] deposit NOT recorded:", res.status, await res.text());
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

/** Move one deposit forward by exactly one step. Called only from an admin-authenticated route. */
export async function advanceDeposit(
  id: unknown,
  input: { owner?: unknown; scope_note?: unknown; delivery_ref?: unknown }
): Promise<Result<{ deposit: DepositRow }>> {
  if (!creds()) return STORE_UNCONFIGURED;
  if (typeof id !== "string" || !UUID.test(id)) return { ok: false, status: 404, error: "Not found." };
  const cur = await rest<DepositRow[]>("GET", `engagement_deposits?id=eq.${q(id)}&select=*&limit=1`);
  if (!cur.ok) return { ok: false, status: 502, error: "The deposit could not be read." };
  const row = cur.data?.[0];
  if (!row) return { ok: false, status: 404, error: "Not found." };
  const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null);
  const now = new Date().toISOString();
  let patch: Record<string, unknown>;
  if (row.status === "paid") {
    const owner = text(input.owner, 120);
    if (!owner) return { ok: false, status: 422, error: "owner is required: the person who has contacted the buyer." };
    patch = { status: "contacted", owner, contacted_at: now };
  } else if (row.status === "contacted") {
    const scope = text(input.scope_note, 2000);
    if (!scope) return { ok: false, status: 422, error: "scope_note is required: what was agreed with the buyer." };
    patch = { status: "scoped", scope_note: scope, scoped_at: now };
  } else if (row.status === "scoped") {
    const ref = text(input.delivery_ref, 500);
    if (!ref) return { ok: false, status: 422, error: "delivery_ref is required: where the delivered work can be found." };
    patch = { status: "delivered", delivery_ref: ref, delivered_at: now };
  } else {
    return { ok: false, status: 409, error: "This deposit is already delivered." };
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
  return { ok: true, deposit: out[0] };
}
