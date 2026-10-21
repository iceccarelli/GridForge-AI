/**
 * Shared test doubles for pay-as-you-go billing. Everything here is a STAND-IN, and says so:
 *
 *   MockStripe        a fake Stripe client with the shapes of the SDK calls lib/payg-stripe.ts declares (checked against
 *                     node_modules/stripe v22). No live Stripe call is ever made by these tests. It models what the billing code
 *                     relies on: idempotency keys that EXPIRE (forgetIdempotency() = "24 hours later"), invoices that stay draft
 *                     until finalised, items attached to a named invoice, list-by-customer, injectable failures.
 *   installPaygRpcs   TypeScript mirrors of the SQL functions in migration 0028 (ingest, net usage, unsettled months, free account).
 *                     SUPPLEMENTAL: that the SQL itself behaves like this is proven against real PostgreSQL in
 *                     tests/test_payg_migration.py. A mirror that drifted from the SQL would be caught there, not here.
 *   mockEngine        the engine's /v1/revoke as a fetch interceptor (records ids, can refuse).
 */
import { PgError, PostgrestFake, type Row } from "./postgrest-fake";
import type { InvoiceLite, PaygStripe } from "@/lib/payg-stripe";

export const PAYG_TABLES = [
  "api_accounts", "usage_events", "usage_settlements", "payg_cursor", "usage_alerts", "funnel_events",
  "customer_notifications", "subscriptions", "scenarios", "watches", "watch_notes", "deliverables", "leads",
];

export function newPaygDb(): PostgrestFake {
  const db = new PostgrestFake(PAYG_TABLES);
  db.uniqueKeys.set("api_accounts", [["token"], ["account"], ["free_email_norm"]]);
  db.uniqueKeys.set("usage_events", [["event_id"], ["seq"]]);
  db.uniqueKeys.set("usage_settlements", [["account", "month"]]);
  db.uniqueKeys.set("usage_alerts", [["account", "month", "percent"]]);
  db.uniqueKeys.set("funnel_events", [["dedupe_key"]]);
  db.uniqueKeys.set("customer_notifications", [["dedupe_key"]]);
  db.rowDefaults.set("customer_notifications", () => ({
    status: "pending", attempts: 0, max_attempts: 6, next_attempt_at: new Date(0).toISOString(), claimed_until: null, last_error: null,
    last_http_status: null, provider_message_id: null, accepted_at: null, origin: "webhook", reopened_count: 0,
  }));
  db.rowDefaults.set("api_accounts", () => ({
    revoked_key_ids: [], revoked_confirmed_ids: [], key_id: null, key_issued_at: null, key_expires_at: null, key_scope: null,
    cap_units: null, stripe_payment_method_id: null, payg_enabled_at: null, free_email_norm: null, status: "active",
    stripe_customer_id: null, stripe_subscription_id: null, last_billing_event_ts: null, monthly_units: 0,
  }));
  db.rowDefaults.set("usage_settlements", () => ({
    carried_units: 0, carried_months: [], rolled_into: null, stripe_invoice_id: null, stripe_invoice_item_id: null, hosted_invoice_url: null,
    attempts: 0, last_error: null, status: "pending",
  }));
  // 0028's gf_api_accounts_guard trigger: revoked ids and confirmations only accumulate; revocation_pending is derived.
  db.rowHooks.set("api_accounts", (row, old) => {
    const union = (x: unknown, y: unknown) => [...new Set([...((x as string[]) ?? []), ...((y as string[]) ?? [])])];
    if (old) {
      row.revoked_key_ids = union(old.revoked_key_ids, row.revoked_key_ids);
      row.revoked_confirmed_ids = union(old.revoked_confirmed_ids, row.revoked_confirmed_ids);
    }
    const confirmed = new Set((row.revoked_confirmed_ids as string[]) ?? []);
    row.revocation_pending = ((row.revoked_key_ids as string[]) ?? []).some((id) => !confirmed.has(id));
  });
  db.rows("payg_cursor").push({ id: 1, last_seq: 0, updated_at: new Date().toISOString() });
  installPaygRpcs(db);
  return db;
}

// --------------------------------------------------------------------------------------------- SQL mirrors (0028)

const monthOf = (iso: string) => new Date(iso).toISOString().slice(0, 7);

function effective(db: PostgrestFake) {
  const events = db.rows("usage_events");
  const byId = new Map(events.map((e) => [e.event_id as string, e]));
  return events.map((e) => {
    const c = e.kind === "refund" ? byId.get(e.ref as string) : undefined;
    const charge = c && c.kind === "charge" ? c : undefined;
    return {
      account: e.account as string,
      kind: e.kind as string,
      units: e.units as number,
      scope: (charge?.scope ?? e.scope) as string,
      effective_at: (charge?.occurred_at ?? e.occurred_at) as string,
    };
  });
}
const signed = (e: { kind: string; units: number }) => (e.kind === "charge" ? e.units : -e.units);

export function installPaygRpcs(db: PostgrestFake): void {
  db.rpcs.set("gf_usage_ingest", ({ p_events, p_cursor }: { p_events: Row[]; p_cursor: number }) => {
    if (!Array.isArray(p_events)) throw new PgError("22023", "p_events must be a JSON array", 400);
    const store = db.rows("usage_events");
    let inserted = 0;
    for (const e of p_events) {
      if (store.some((r) => r.event_id === e.event_id)) continue; // ON CONFLICT (event_id) DO NOTHING
      if (store.some((r) => r.seq === e.seq)) throw new PgError("23505", "duplicate key value violates unique constraint usage_events_seq_key", 409);
      if (!((e.units as number) > 0) || !["charge", "refund"].includes(e.kind as string)) throw new PgError("23514", "usage_events check", 400);
      store.push({ ...e, key_id: e.key_id ?? "", scope: e.scope ?? "", endpoint: e.endpoint ?? "", project: e.project ?? "", idem: e.idem ?? "", ref: e.ref ?? "", ingested_at: new Date().toISOString() });
      inserted++;
    }
    const cur = db.rows("payg_cursor")[0];
    cur.last_seq = Math.max(cur.last_seq as number, p_cursor);
    cur.updated_at = new Date().toISOString();
    return { inserted, cursor: cur.last_seq };
  });

  db.rpcs.set("gf_usage_net", ({ p_account, p_from, p_to }: { p_account: string; p_from: string; p_to: string }) => {
    const rows = effective(db).filter((e) => e.account === p_account && e.effective_at >= p_from && e.effective_at < p_to);
    const sum = (xs: typeof rows) => xs.reduce((n, e) => n + signed(e), 0);
    return {
      charged: rows.filter((e) => e.kind === "charge").reduce((n, e) => n + e.units, 0),
      refunded: rows.filter((e) => e.kind === "refund").reduce((n, e) => n + e.units, 0),
      net: Math.max(0, sum(rows)),
      billable_net: Math.max(0, sum(rows.filter((e) => e.scope === "payg"))),
    };
  });

  db.rpcs.set("gf_usage_month_totals", ({ p_from, p_to }: { p_from: string; p_to: string }) => {
    const rows = effective(db).filter((e) => e.effective_at >= p_from && e.effective_at < p_to);
    const out = new Map<string, { account: string; net_units: number; billable_units: number }>();
    for (const e of rows) {
      const o = out.get(e.account) ?? { account: e.account, net_units: 0, billable_units: 0 };
      o.net_units += signed(e);
      if (e.scope === "payg") o.billable_units += signed(e);
      out.set(e.account, o);
    }
    return [...out.values()].map((o) => ({ ...o, net_units: Math.max(0, o.net_units), billable_units: Math.max(0, o.billable_units) }));
  });

  db.rpcs.set("gf_payg_unsettled", ({ p_before }: { p_before: string }) => {
    const accounts = new Set(db.rows("api_accounts").map((a) => a.account as string));
    const settled = new Set(db.rows("usage_settlements").map((s) => `${s.account}|${s.month}`));
    const groups = new Map<string, { account: string; month: string; net_units: number }>();
    for (const e of effective(db)) {
      if (e.scope !== "payg" || !accounts.has(e.account)) continue;
      const month = monthOf(e.effective_at);
      if (!(month < p_before) || settled.has(`${e.account}|${month}`)) continue;
      const key = `${e.account}|${month}`;
      const g = groups.get(key) ?? { account: e.account, month, net_units: 0 };
      g.net_units += signed(e);
      groups.set(key, g);
    }
    return [...groups.values()]
      .map((g) => ({ ...g, net_units: Math.max(0, g.net_units) }))
      .sort((a, b) => (a.account + a.month < b.account + b.month ? -1 : 1));
  });

  db.rpcs.set("gf_free_account_create", (a: Record<string, any>) => {
    if (!a.p_email_norm || a.p_max < 0 || a.p_units < 1) throw new PgError("22023", "free account arguments out of range", 400);
    const accts = db.rows("api_accounts");
    const found = accts.find((r) => r.free_email_norm === a.p_email_norm);
    if (found) return { created: false, id: found.id };
    const start = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)).toISOString();
    const count = accts.filter((r) => r.free_email_norm && (r.created_at as string) >= start).length;
    if (count >= a.p_max) return { created: false, reason: "capacity" };
    const row = db.insertRow("api_accounts", {
      token: a.p_token, account: a.p_account, email: a.p_email, company: a.p_company, plan: "api_free", monthly_units: a.p_units, status: "active", free_email_norm: a.p_email_norm,
    });
    return { created: true, id: row.id };
  });
}

// --------------------------------------------------------------------------------------------------- MockStripe

interface StoredInvoice extends InvoiceLite { customer: string; amount_due_items: number; params: Record<string, any> }

export class MockStripe implements PaygStripe {
  calls: string[] = [];
  invoicesById = new Map<string, StoredInvoice>();
  items: { id: string; invoice: string; amount: number; metadata: Record<string, string> }[] = [];
  customerUpdates: { id: string; params: any }[] = [];
  sessions: any[] = [];
  setupIntentStore = new Map<string, { id: string; status: string; payment_method: string; customer: string; metadata: Record<string, string> }>();
  /** Fail the next call to each named method with a Stripe-shaped error, once. */
  failOnce = new Set<string>();
  private idem = new Map<string, unknown>();
  private n = 0;

  /** Stripe forgets idempotency keys after 24 hours: simulate the next day's run. */
  forgetIdempotency() { this.idem.clear(); }

  private maybeFail(name: string) {
    this.calls.push(name);
    if (this.failOnce.delete(name)) throw Object.assign(new Error("simulated Stripe outage for customer@example.test"), { type: "StripeConnectionError", statusCode: 503 });
  }
  private once<T>(key: string | undefined, make: () => T): T {
    if (!key) return make();
    if (this.idem.has(key)) return this.idem.get(key) as T;
    const v = make();
    this.idem.set(key, v);
    return v;
  }

  checkout = {
    sessions: {
      create: async (params: any) => {
        this.maybeFail("checkout.sessions.create");
        this.sessions.push(params);
        return { id: `cs_mock_${++this.n}`, url: `https://checkout.stripe.test/c/cs_mock_${this.n}` };
      },
    },
  };
  setupIntents = {
    retrieve: async (id: string) => {
      this.maybeFail("setupIntents.retrieve");
      const si = this.setupIntentStore.get(id);
      if (!si) throw Object.assign(new Error("No such setupintent"), { type: "StripeInvalidRequestError", code: "resource_missing", statusCode: 404 });
      return si;
    },
  } as unknown as PaygStripe["setupIntents"];
  customers = {
    update: async (id: string, params: any) => {
      this.maybeFail("customers.update");
      this.customerUpdates.push({ id, params });
      return { id };
    },
  };
  invoices: PaygStripe["invoices"] = {
    create: async (params: any, options?: { idempotencyKey?: string }) => {
      this.maybeFail("invoices.create");
      return this.once(options?.idempotencyKey, () => {
        const id = `in_mock_${++this.n}`;
        const inv: StoredInvoice = { id, status: "draft", hosted_invoice_url: null, metadata: params.metadata ?? {}, customer: params.customer, amount_due_items: 0, params };
        this.invoicesById.set(id, inv);
        return inv;
      });
    },
    finalizeInvoice: async (id: string, params?: any, options?: { idempotencyKey?: string }) => {
      this.maybeFail("invoices.finalizeInvoice");
      return this.once(options?.idempotencyKey, () => {
        const inv = this.invoicesById.get(id)!;
        inv.status = "open";
        inv.hosted_invoice_url = `https://invoice.stripe.test/i/${id}`;
        (inv.params as any).finalize = params;
        return inv;
      });
    },
    retrieve: async (id: string) => {
      this.maybeFail("invoices.retrieve");
      const inv = this.invoicesById.get(id);
      if (!inv) throw Object.assign(new Error("No such invoice"), { type: "StripeInvalidRequestError", code: "resource_missing", statusCode: 404 });
      return inv;
    },
    list: async (params: any) => {
      this.maybeFail("invoices.list");
      return { data: [...this.invoicesById.values()].filter((i) => i.customer === params.customer) };
    },
  };
  invoiceItems: PaygStripe["invoiceItems"] = {
    create: async (params: any, options?: { idempotencyKey?: string }) => {
      this.maybeFail("invoiceItems.create");
      return this.once(options?.idempotencyKey, () => {
        const inv = this.invoicesById.get(params.invoice);
        if (!inv) throw Object.assign(new Error("No such invoice"), { type: "StripeInvalidRequestError", statusCode: 404 });
        if (inv.status !== "draft") throw Object.assign(new Error("invoice is not a draft"), { type: "StripeInvalidRequestError", statusCode: 400 });
        const item = { id: `ii_mock_${++this.n}`, invoice: params.invoice, amount: params.amount, metadata: params.metadata ?? {} };
        this.items.push(item);
        inv.amount_due_items += params.amount;
        return item;
      });
    },
    list: async (params: any) => {
      this.maybeFail("invoiceItems.list");
      return { data: this.items.filter((i) => i.invoice === params.invoice) };
    },
  };

  /** Everything that would have moved money, for assertions. */
  get allInvoices() { return [...this.invoicesById.values()]; }
}

// ------------------------------------------------------------------------------------------------- mock engine

export interface MockEngine {
  revokeCalls: string[];
  refuseRevoke: boolean;
  restore: () => void;
}

/** Layers the engine's /v1/revoke (and a Resend sink) over whatever fetch is installed (the PostgREST fake). */
export function mockEngine(mail: { to: string; subject: string; text: string }[] = []): MockEngine {
  process.env.GRIDFORGE_API_URL = "https://engine.test";
  process.env.GRIDFORGE_ADMIN_KEY = "admin-test-key";
  const inner = globalThis.fetch;
  const eng: MockEngine = { revokeCalls: [], refuseRevoke: false, restore: () => { globalThis.fetch = inner; } };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === "https://engine.test/v1/revoke") {
      const id = JSON.parse(String(init?.body)).key_id as string;
      if (eng.refuseRevoke) return new Response("{}", { status: 503 });
      eng.revokeCalls.push(id);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.startsWith("https://api.resend.com")) {
      const b = JSON.parse(String(init?.body));
      mail.push({ to: ([] as string[]).concat(b.to)[0], subject: b.subject, text: b.text });
      return new Response(JSON.stringify({ id: `em_${mail.length}` }), { status: 200 });
    }
    return inner(input as RequestInfo, init);
  }) as typeof fetch;
  return eng;
}

// ---------------------------------------------------------------------------------------------------- builders

let seqCounter = 0;
export function resetSeq() { seqCounter = 0; }

export function ledgerEvent(over: Partial<Record<string, unknown>> = {}) {
  const seq = (over.seq as number) ?? ++seqCounter;
  if (over.seq) seqCounter = Math.max(seqCounter, over.seq as number);
  return {
    seq,
    id: `ev${String(seq).padStart(6, "0")}`,
    ts: "2026-09-10T12:00:00+00:00",
    kind: "charge",
    account: "acme-123456",
    key_id: "aabbccdd",
    scope: "payg",
    endpoint: "/v1/study",
    units: 5,
    project: "",
    idem: "",
    ref: "",
    ...over,
  };
}

export function paygAccount(db: PostgrestFake, over: Record<string, unknown> = {}): Row {
  return db.insertRow("api_accounts", {
    token: "tok-" + Math.random().toString(36).slice(2).padEnd(24, "x"),
    account: "acme-123456",
    email: "ops@acme.example",
    company: "Acme",
    plan: "api_payg",
    monthly_units: 50,
    cap_units: 50,
    status: "active",
    stripe_customer_id: "cus_acme",
    stripe_payment_method_id: "pm_acme",
    payg_enabled_at: "2026-08-01T00:00:00.000Z",
    ...over,
  });
}

/** A fetcher over a fixed event list that honours after_seq / limit like the engine's /v1/admin/ledger. */
export function ledgerFetcherOver(events: Record<string, unknown>[], opts: { durable?: boolean } = {}) {
  const calls: number[] = [];
  const fn = async (after: number, limit: number) => {
    calls.push(after);
    const page = events.filter((e) => (e.seq as number) > after).slice(0, limit);
    const last = events.length ? Math.max(...events.map((e) => e.seq as number)) : 0;
    return { ok: true as const, events: page, last_seq: last, durable: opts.durable ?? true };
  };
  return Object.assign(fn, { calls });
}
