// Server-only: the usage ledger on the website's side — ingest from the engine, and read net usage back.
//
// The engine's append-only ledger is the record of what was metered. This module copies it into `usage_events` (0028) and
// answers "how much did this account use this month, net of refunds". The rules that carry the weight:
//
//   * The cursor moves only with a durable insert. `gf_usage_ingest` inserts the page (ON CONFLICT DO NOTHING on the engine's
//     event id) and advances `payg_cursor` in ONE transaction, so a failed write leaves the cursor where it was and a repeat
//     of the same page inserts nothing new. A page that is not a gapless continuation of the cursor is REFUSED whole: skipping
//     one event would silently under-bill, forever.
//   * An event this site cannot read (a field out of range, a shape it does not know) is QUARANTINED, not fatal: it is stored with
//     the reason in usage_quarantine in the same transaction that moves the cursor past it, the operator is told, and no month it
//     could belong to is settled until the operator acknowledges it. One bad event must neither stall everyone's ingest nor be
//     silently dropped from a bill.
//   * "Caught up" means the cursor reached the engine's HEAD (`head_seq`), never the last seq of the page just read (the engine's
//     `last_seq` is the last event IN THE PAGE, so treating it as the head would settle a month after the first page of many).
//     A head BEHIND the cursor (a restored or lost ledger volume) or a ledger that is not durable is an alarm, not "complete".
//   * Everything is net of refunds, and a refund belongs to the month (and scope) of the charge it reverses (see 0028 G).

import { MONTH, monthBounds } from "@/lib/payg";
import { enc, pg, rpc } from "@/lib/payg-store";

export interface LedgerEvent {
  seq: number;
  id: string;
  ts: string;
  kind: "charge" | "refund";
  account: string;
  key_id: string;
  scope: string;
  endpoint: string;
  units: number;
  project: string;
  idem: string;
  ref: string;
}

export type LedgerPage =
  | { ok: true; events: unknown[]; last_seq: number; head_seq: number; durable: boolean }
  | { ok: false; error: string };

/** Fetches one page of the engine's ledger after `afterSeq`. Injectable: tests pass a function, production passes the engine. */
export type LedgerFetcher = (afterSeq: number, limit: number) => Promise<LedgerPage>;

const PAGE = 500;
const MAX_PAGES = 40;

/**
 * The production fetcher: the operator-only GET /v1/admin/ledger on the engine, with the operator key (the same credential the
 * key-revocation route uses; never the platform key). Null when the engine is not configured.
 */
export function engineLedgerFetcher(env: NodeJS.ProcessEnv = process.env): LedgerFetcher | null {
  const base = (env.GRIDFORGE_API_URL ?? "").replace(/\/$/, "");
  const admin = env.GRIDFORGE_ADMIN_KEY ?? "";
  if (!base || !admin) return null;
  return async (afterSeq, limit) => {
    try {
      const res = await fetch(`${base}/v1/admin/ledger?after_seq=${afterSeq}&limit=${limit}`, {
        headers: { "X-API-Key": admin },
        signal: AbortSignal.timeout(20_000),
        cache: "no-store",
      });
      if (!res.ok) return { ok: false, error: `engine answered ${res.status}` };
      const j = (await res.json()) as { events?: unknown; last_seq?: unknown; head_seq?: unknown; durable?: unknown };
      if (!Array.isArray(j.events) || typeof j.last_seq !== "number") return { ok: false, error: "engine ledger answer not understood" };
      // head_seq is how far the ledger has got; without it "caught up" cannot be told from "one page read".
      if (typeof j.head_seq !== "number" || !Number.isInteger(j.head_seq) || j.head_seq < 0) return { ok: false, error: "engine ledger answer has no head_seq" };
      return { ok: true, events: j.events, last_seq: j.last_seq, head_seq: j.head_seq, durable: j.durable === true };
    } catch {
      return { ok: false, error: "engine unreachable" };
    }
  };
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : null);

export type Classified =
  | { ok: true; event: LedgerEvent }
  | { ok: false; reason: string; seq: number | null; month: string | null; account: string | null };

/** A ledger event as the contract defines it, or why not (and whatever could still be read of it, for the quarantine). */
export function classifyLedgerEvent(raw: unknown): Classified {
  const bad = (reason: string, e?: Record<string, unknown>): Classified => {
    const seq = e && Number.isInteger(e.seq) && (e.seq as number) >= 1 ? (e.seq as number) : null;
    const t = e && typeof e.ts === "string" ? Date.parse(e.ts) : NaN;
    return {
      ok: false,
      reason,
      seq,
      month: Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 7),
      account: e && typeof e.account === "string" ? e.account.slice(0, 120) : null,
    };
  };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return bad("not an object");
  const e = raw as Record<string, unknown>;
  const kind = e.kind === "charge" || e.kind === "refund" ? e.kind : null;
  const id = str(e.id, 80);
  const account = str(e.account, 120);
  const ts = typeof e.ts === "string" && !Number.isNaN(Date.parse(e.ts)) ? e.ts : null;
  const units = e.units;
  if (!kind) return bad("unknown kind", e);
  if (!id) return bad("bad id", e);
  if (!account) return bad("bad account", e);
  if (!ts) return bad("bad timestamp", e);
  if (!Number.isInteger(e.seq) || (e.seq as number) < 1) return bad("bad seq", e);
  if (typeof units !== "number" || !Number.isInteger(units) || units < 1 || units > 1_000_000) return bad("units out of range", e);
  const ref = str(e.ref ?? "", 80);
  if (ref === null || (kind === "charge" && ref !== "")) return bad("bad ref", e);
  const key_id = str(e.key_id ?? "", 80);
  const scope = str(e.scope ?? "", 40);
  const endpoint = str(e.endpoint ?? "", 200);
  const project = str(e.project ?? "", 64);
  // The idempotency key is the caller's own string; the engine caps and hashes it, but a long one must never be able to stall the ledger.
  const idem = str(e.idem ?? "", 1024);
  if (key_id === null) return bad("bad key_id", e);
  if (scope === null) return bad("bad scope", e);
  if (endpoint === null) return bad("bad endpoint", e);
  if (project === null) return bad("bad project", e);
  if (idem === null) return bad("bad idem", e);
  return { ok: true, event: { seq: e.seq as number, id, ts, kind, account, key_id, scope, endpoint, units, project, idem, ref } };
}

/** Compatibility wrapper: the event, or null. */
export function parseLedgerEvent(raw: unknown): LedgerEvent | null {
  const c = classifyLedgerEvent(raw);
  return c.ok ? c.event : null;
}

export async function readCursor(): Promise<number | null> {
  const r = await pg<{ last_seq: number | string }[]>("GET", "payg_cursor?id=eq.1&select=last_seq,updated_at&limit=1");
  if (!r.ok) return null;
  const row = r.data?.[0];
  return row ? Number(row.last_seq) : 0;
}

export interface IngestResult {
  ok: boolean;
  /** The cursor reached the engine's HEAD with no error and no alarm: only then is a settlement allowed to trust the data. */
  complete: boolean;
  inserted: number;
  /** Events set aside this run because they could not be read (see usage_quarantine). */
  quarantined: number;
  cursor: number;
  headSeq: number | null;
  durable: boolean | null;
  /** ledger_behind: the engine's head is behind our cursor (restored or lost ledger volume). not_durable: the engine cannot persist. */
  alarm?: "ledger_behind" | "not_durable";
  error?: string;
}

/** Pull ledger pages after the cursor until the engine's head, inserting each durably before moving on. */
export async function ingestLedger(fetcher: LedgerFetcher, opts: { pageSize?: number; maxPages?: number } = {}): Promise<IngestResult> {
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? PAGE, 1000));
  let cursor = await readCursor();
  const out: IngestResult = { ok: false, complete: false, inserted: 0, quarantined: 0, cursor: cursor ?? 0, headSeq: null, durable: null };
  if (cursor === null) return { ...out, error: "cursor unreadable" };

  for (let page = 0; page < (opts.maxPages ?? MAX_PAGES); page++) {
    const got = await fetcher(cursor, pageSize);
    if (!got.ok) return { ...out, cursor, error: got.error };
    out.headSeq = got.head_seq;
    out.durable = got.durable;
    // An alarm before any trust: a ledger that went BACKWARDS cannot be reconciled by reading on, and one that cannot persist may lose
    // what it just reported. Neither is "complete", and nothing is settled on it.
    if (got.head_seq < cursor) return { ...out, cursor, alarm: "ledger_behind", error: "the engine's ledger head is behind the ingest cursor" };
    if (!got.durable) return { ...out, cursor, alarm: "not_durable", error: "the engine's ledger is not durable" };

    if (got.events.length === 0) {
      out.cursor = cursor;
      if (cursor >= got.head_seq) {
        out.ok = true;
        out.complete = true;
        return out;
      }
      return { ...out, error: "the engine reports a later head than it returned events for" };
    }

    const good: LedgerEvent[] = [];
    const quarantine: { seq: number; reason: string; raw: string; month: string | null; account: string | null }[] = [];
    let prev: number = cursor;
    for (const raw of got.events) {
      const c = classifyLedgerEvent(raw);
      const seq: number | null = c.ok ? c.event.seq : c.seq;
      // An event with no readable seq cannot be placed in the sequence at all: the page is refused whole (skipping blind could skip a charge).
      if (seq === null) return { ...out, cursor, error: "ledger page held an event with no readable seq; refused whole" };
      // Gapless and strictly continuing: the engine contract. A gap means events we would never bill.
      if (seq !== prev + 1) return { ...out, cursor, error: `ledger seq gap at ${prev + 1}; refused` };
      prev = seq;
      if (c.ok) good.push(c.event);
      else quarantine.push({ seq, reason: c.reason, raw: JSON.stringify(raw).slice(0, 2000), month: c.month, account: c.account });
    }
    const last: number = prev;
    const r = await rpc<{ inserted: number; quarantined: number; cursor: number }>("gf_usage_ingest", {
      p_events: good.map((e) => ({
        event_id: e.id, seq: e.seq, account: e.account, key_id: e.key_id, scope: e.scope, endpoint: e.endpoint, units: e.units,
        kind: e.kind, project: e.project, idem: e.idem, ref: e.ref, occurred_at: new Date(e.ts).toISOString(),
      })),
      p_cursor: last,
      p_quarantine: quarantine,
    });
    if (!r.ok) return { ...out, cursor, error: `ingest write failed (${r.status})` };
    out.inserted += Number(r.data?.inserted ?? 0);
    out.quarantined += Number(r.data?.quarantined ?? 0);
    cursor = Number(r.data?.cursor ?? last);
    out.cursor = cursor;
    if (cursor >= got.head_seq) {
      out.ok = true;
      out.complete = true;
      return out;
    }
  }
  // Page budget used up: progress was made and is durable; the next run continues. Not complete.
  out.ok = true;
  out.complete = false;
  return out;
}

/** Quarantined events no operator has acknowledged. Settlement of the months they could belong to is held. */
export async function openQuarantine(): Promise<{ seq: number; month: string | null; reason: string }[] | null> {
  const r = await pg<{ seq: number; month: string | null; reason: string }[]>("GET", "usage_quarantine?acked_at=is.null&select=seq,month,reason&order=seq.asc&limit=1000");
  return r.ok ? (r.data ?? []) : null;
}

/** The operator's acknowledgement of one quarantined event (after deciding what, if anything, it should have billed). */
export async function ackQuarantinedEvent(seq: number, note: string): Promise<boolean> {
  const r = await pg("PATCH", `usage_quarantine?seq=eq.${Math.trunc(seq)}&acked_at=is.null`, { acked_at: new Date().toISOString(), acked_note: note.slice(0, 500) }, "return=minimal");
  return r.ok;
}

export interface MonthNet {
  charged: number;
  refunded: number;
  net: number;
  /** Net units whose scope is `payg`: the only units that are ever invoiced. */
  billable_net: number;
}

/**
 * The units that count against this plan's own cap. The engine counts caps per (account, month, scope): a pay-as-you-go cap is spent only
 * by `payg` units, the free allowance only by the other (trial) units, and a subscription by everything it ran.
 */
export function capUsedUnits(plan: string, n: { net: number; billable_net: number }): number {
  if (plan === "api_payg") return n.billable_net;
  if (plan === "api_free") return Math.max(0, n.net - n.billable_net);
  return n.net;
}

export async function usageNet(account: string, month: string): Promise<MonthNet | null> {
  if (!MONTH.test(month)) return null;
  const { from, to } = monthBounds(month);
  const r = await rpc<MonthNet>("gf_usage_net", { p_account: account, p_from: from, p_to: to });
  if (!r.ok || !r.data) return null;
  return { charged: Number(r.data.charged), refunded: Number(r.data.refunded), net: Number(r.data.net), billable_net: Number(r.data.billable_net) };
}

export async function monthTotals(month: string): Promise<{ account: string; net_units: number; billable_units: number }[] | null> {
  const { from, to } = monthBounds(month);
  const r = await rpc<{ account: string; net_units: number | string; billable_units: number | string }[]>("gf_usage_month_totals", { p_from: from, p_to: to });
  if (!r.ok) return null;
  return (r.data ?? []).map((x) => ({ account: x.account, net_units: Number(x.net_units), billable_units: Number(x.billable_units) }));
}

export interface UsageEventRow {
  id: string;
  ts: string;
  endpoint: string;
  units: number;
  kind: "charge" | "refund";
  project: string;
  key_id: string;
  ref: string;
}

/** The account's most recent events (charges AND the refunds that reverse them), newest first. Only this account's rows. */
export async function recentEvents(account: string, limit = 50): Promise<UsageEventRow[] | null> {
  const r = await pg<{ event_id: string; occurred_at: string; seq: number; endpoint: string; units: number; kind: "charge" | "refund"; project: string; key_id: string; ref: string }[]>(
    "GET",
    `usage_events?account=eq.${enc(account)}&select=event_id,occurred_at,seq,endpoint,units,kind,project,key_id,ref&order=seq.desc&limit=${Math.max(1, Math.min(limit, 200))}`
  );
  if (!r.ok) return null;
  return (r.data ?? []).map((e) => ({ id: e.event_id, ts: e.occurred_at, endpoint: e.endpoint, units: e.units, kind: e.kind, project: e.project, key_id: e.key_id, ref: e.ref }));
}
