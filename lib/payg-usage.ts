// Server-only: the usage ledger on the website's side — ingest from the engine, and read net usage back.
//
// The engine's append-only ledger is the record of what was metered. This module copies it into `usage_events` (0028) and
// answers "how much did this account use this month, net of refunds". Two rules carry the weight:
//
//   * The cursor moves only with a durable insert. `gf_usage_ingest` inserts the page (ON CONFLICT DO NOTHING on the engine's
//     event id) and advances `payg_cursor` in ONE transaction, so a failed write leaves the cursor where it was and a repeat
//     of the same page inserts nothing new. A page that is not a gapless continuation of the cursor, or holds an event that
//     does not look like a ledger event, is REFUSED whole: skipping one event would silently under-bill, forever.
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
  | { ok: true; events: unknown[]; last_seq: number; durable: boolean }
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
      const j = (await res.json()) as { events?: unknown; last_seq?: unknown; durable?: unknown };
      if (!Array.isArray(j.events) || typeof j.last_seq !== "number") return { ok: false, error: "engine ledger answer not understood" };
      return { ok: true, events: j.events, last_seq: j.last_seq, durable: j.durable === true };
    } catch {
      return { ok: false, error: "engine unreachable" };
    }
  };
}

const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : null);

/** A ledger event as the contract defines it, or null. Strict on purpose: see the module comment. */
export function parseLedgerEvent(raw: unknown): LedgerEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  const kind = e.kind === "charge" || e.kind === "refund" ? e.kind : null;
  const id = str(e.id, 80);
  const account = str(e.account, 120);
  const ts = typeof e.ts === "string" && !Number.isNaN(Date.parse(e.ts)) ? e.ts : null;
  const units = e.units;
  if (!kind || !id || !account || !ts) return null;
  if (!Number.isInteger(e.seq) || (e.seq as number) < 1) return null;
  if (typeof units !== "number" || !Number.isInteger(units) || units < 1 || units > 1_000_000) return null;
  const ref = str(e.ref ?? "", 80);
  if (ref === null || (kind === "charge" && ref !== "")) return null;
  const key_id = str(e.key_id ?? "", 80);
  const scope = str(e.scope ?? "", 40);
  const endpoint = str(e.endpoint ?? "", 200);
  const project = str(e.project ?? "", 64);
  const idem = str(e.idem ?? "", 200);
  if (key_id === null || scope === null || endpoint === null || project === null || idem === null) return null;
  return { seq: e.seq as number, id, ts, kind, account, key_id, scope, endpoint, units, project, idem, ref };
}

export async function readCursor(): Promise<number | null> {
  const r = await pg<{ last_seq: number | string }[]>("GET", "payg_cursor?id=eq.1&select=last_seq,updated_at&limit=1");
  if (!r.ok) return null;
  const row = r.data?.[0];
  return row ? Number(row.last_seq) : 0;
}

export interface IngestResult {
  ok: boolean;
  /** The cursor reached the engine's head with no error: only then is a settlement allowed to trust the data. */
  complete: boolean;
  inserted: number;
  cursor: number;
  engineLast: number | null;
  durable: boolean | null;
  error?: string;
}

/** Pull ledger pages after the cursor until the engine's head, inserting each durably before moving on. */
export async function ingestLedger(fetcher: LedgerFetcher, opts: { pageSize?: number; maxPages?: number } = {}): Promise<IngestResult> {
  const pageSize = Math.max(1, Math.min(opts.pageSize ?? PAGE, 1000));
  let cursor = await readCursor();
  const out: IngestResult = { ok: false, complete: false, inserted: 0, cursor: cursor ?? 0, engineLast: null, durable: null };
  if (cursor === null) return { ...out, error: "cursor unreadable" };

  for (let page = 0; page < (opts.maxPages ?? MAX_PAGES); page++) {
    const got = await fetcher(cursor, pageSize);
    if (!got.ok) return { ...out, cursor, error: got.error };
    out.engineLast = got.last_seq;
    out.durable = got.durable;
    if (got.events.length === 0) {
      out.ok = true;
      out.complete = cursor >= got.last_seq;
      if (!out.complete) out.error = "engine reports a later seq than it returned";
      out.cursor = cursor;
      return out;
    }
    const events: LedgerEvent[] = [];
    for (const raw of got.events) {
      const e = parseLedgerEvent(raw);
      if (!e) return { ...out, cursor, error: "ledger page held an event that is not a ledger event; refused whole" };
      events.push(e);
    }
    // Gapless and strictly continuing: the engine contract. A gap means events we would never bill.
    for (let i = 0; i < events.length; i++) {
      const expect = (i === 0 ? cursor : events[i - 1].seq) + 1;
      if (events[i].seq !== expect) return { ...out, cursor, error: `ledger seq gap at ${expect}; refused` };
    }
    const last = events[events.length - 1].seq;
    const r = await rpc<{ inserted: number; cursor: number }>("gf_usage_ingest", {
      p_events: events.map((e) => ({
        event_id: e.id, seq: e.seq, account: e.account, key_id: e.key_id, scope: e.scope, endpoint: e.endpoint, units: e.units,
        kind: e.kind, project: e.project, idem: e.idem, ref: e.ref, occurred_at: new Date(e.ts).toISOString(),
      })),
      p_cursor: last,
    });
    if (!r.ok) return { ...out, cursor, error: `ingest write failed (${r.status})` };
    out.inserted += Number(r.data?.inserted ?? 0);
    cursor = Number(r.data?.cursor ?? last);
    out.cursor = cursor;
    if (cursor >= got.last_seq) {
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

export interface MonthNet {
  charged: number;
  refunded: number;
  net: number;
  /** Net units whose scope is `payg`: the only units that are ever invoiced. */
  billable_net: number;
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
