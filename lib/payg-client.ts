// Typed browser/server helpers for the pay-as-you-go and free-allowance routes.
//
// The billing routes are built by other agents and may not exist on every deployment (or may be refusing
// because the store, the rate-limit counter or Stripe is not configured). Every helper therefore returns a
// discriminated result instead of throwing, and a route that is missing or fails closed becomes
// `kind: "unavailable"`, which the UI renders as "not available on this deployment". Nothing here ever
// fabricates a usage figure, an invoice or a price: if a route did not answer, there is no data.
//
// JSON shapes are the contract in payg-contract.md (lead-owned). Parsers are defensive about FIELDS the
// contract leaves open (settlement rows) but never invent values for them.
//
// No React and no module-level state; `fetch` is injectable so the whole file is testable in node.

import { PAYG, PRODUCTS, type ProductId } from "@/lib/products";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type FailureKind =
  | "unavailable" // route missing (404/405/501) or failing closed (503): not available on this deployment
  | "unauthorized" // 401/403
  | "rate_limited" // 429
  | "invalid" // 400/422: the request was refused, the server's reason is in `message`
  | "payment_required" // 402
  | "network" // the request never completed
  | "server"; // any other non-2xx

export interface ClientFailure {
  ok: false;
  kind: FailureKind;
  status: number;
  /** Safe to show to a person. */
  message: string;
  retryAfterSeconds?: number;
  /** The server's machine-readable next step, when it names one (for example "enable_payg"). */
  fix?: string;
}

export type ClientResult<T> = { ok: true; data: T } | ClientFailure;

export const UNAVAILABLE_MESSAGE = "This is not available on this deployment.";

// --- shared plumbing ---------------------------------------------------------------------------------

export interface Raw {
  status: number;
  /** Parsed JSON body, or null when the body was empty or not JSON (a framework 404 page, for instance). */
  json: Record<string, unknown> | null;
  retryAfter: number | undefined;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function call(f: FetchLike, url: string, init?: RequestInit): Promise<Raw | ClientFailure> {
  let res: Response;
  try {
    res = await f(url, init);
  } catch {
    return {
      ok: false,
      kind: "network",
      status: 0,
      message: "Could not reach the server. Nothing was changed. Check your connection and try again.",
    };
  }
  let json: Record<string, unknown> | null = null;
  try {
    json = asRecord(await res.json());
  } catch {
    json = null;
  }
  const ra = Number(res.headers?.get?.("retry-after"));
  return { status: res.status, json, retryAfter: Number.isFinite(ra) && ra > 0 ? ra : undefined };
}

function isFailure(x: Raw | ClientFailure): x is ClientFailure {
  return (x as ClientFailure).ok === false;
}

/** Map a non-success response to a failure. Exported for tests. */
export function failureFor(raw: Raw): ClientFailure {
  const serverMsg = str(raw.json?.error) ?? str(raw.json?.message);
  const { status } = raw;
  if (status === 404 || status === 405 || status === 501) {
    return { ok: false, kind: "unavailable", status, message: UNAVAILABLE_MESSAGE };
  }
  if (status === 503) {
    // The billing routes fail closed (store, rate-limit counter or Stripe not configured). That is an
    // honest "not available here", and the server's own reason is shown when it gave one.
    return {
      ok: false,
      kind: "unavailable",
      status,
      message: serverMsg ? `${UNAVAILABLE_MESSAGE} ${serverMsg}` : UNAVAILABLE_MESSAGE,
    };
  }
  if (status === 429) {
    return {
      ok: false,
      kind: "rate_limited",
      status,
      retryAfterSeconds: raw.retryAfter,
      message:
        serverMsg ?? "Too many requests from this address. Wait a little and try again; nothing was created.",
    };
  }
  if (status === 402) {
    return {
      ok: false,
      kind: "payment_required",
      status,
      message: serverMsg ?? "A payment has not cleared, so this cannot be done yet.",
    };
  }
  if (status === 401 || status === 403) {
    return { ok: false, kind: "unauthorized", status, message: serverMsg ?? "This link is not valid for that." };
  }
  if (status === 400 || status === 409 || status === 422) {
    const fix = str(raw.json?.fix) ?? undefined;
    return { ok: false, kind: "invalid", status, message: serverMsg ?? "The request was refused.", ...(fix ? { fix } : {}) };
  }
  return {
    ok: false,
    kind: "server",
    status,
    message: serverMsg ?? "The server could not complete that. Nothing was changed. Try again shortly.",
  };
}

async function run<T>(
  f: FetchLike,
  url: string,
  init: RequestInit | undefined,
  parse: (json: Record<string, unknown>) => T | null
): Promise<ClientResult<T>> {
  const raw = await call(f, url, init);
  if (isFailure(raw)) return raw;
  const okStatus = raw.status >= 200 && raw.status < 300;
  if (!okStatus || raw.json === null || raw.json.ok === false) {
    return failureFor(raw);
  }
  const data = parse(raw.json);
  if (data === null) {
    return {
      ok: false,
      kind: "server",
      status: raw.status,
      message: "The server answered in a shape this page does not understand, so nothing is shown.",
    };
  }
  return { ok: true, data };
}

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

function defaultFetch(): FetchLike {
  return (input, init) => fetch(input, init);
}

// --- email -------------------------------------------------------------------------------------------

/** Deliberately loose: one @, something on each side, a dot in the domain, no spaces. The server decides the rest. */
export function validateEmail(raw: string): { ok: boolean; email: string; error: string | null } {
  const email = raw.trim();
  if (!email) return { ok: false, email, error: "Enter your email address." };
  if (email.length > 254 || /\s/.test(email) || !/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
    return { ok: false, email, error: "That does not look like an email address." };
  }
  return { ok: true, email, error: null };
}

// --- free allowance ----------------------------------------------------------------------------------

/**
 * POST /api/free-account. The server answers identically for a new and an existing address (no enumeration),
 * so a success here means only "if this address can have an account, a link is on its way".
 */
export async function requestFreeAccount(
  input: { email: string; company?: string },
  f: FetchLike = defaultFetch()
): Promise<ClientResult<{ email: string }>> {
  const v = validateEmail(input.email);
  if (!v.ok) {
    return { ok: false, kind: "invalid", status: 0, message: v.error ?? "Enter your email address." };
  }
  const company = input.company?.trim();
  return run(
    f,
    "/api/free-account",
    {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ email: v.email, ...(company ? { company } : {}) }),
    },
    () => ({ email: v.email })
  );
}

// --- usage -------------------------------------------------------------------------------------------

export interface UsageEvent {
  ts: string;
  endpoint: string;
  units: number;
  kind: "charge" | "refund";
  project: string;
  keyId: string;
}

export type SettlementStatus = "pending" | "carried" | "invoiced" | "paid" | "failed" | "void" | "unknown";

export interface Settlement {
  month: string;
  units: number | null;
  amountCents: number | null;
  status: SettlementStatus;
  /** Units carried in from earlier months that were under the minimum invoice. */
  carriedUnits: number | null;
  /** Only ever an https Stripe-hosted invoice URL; anything else is dropped. */
  invoiceUrl: string | null;
}

export interface UsageAccount {
  plan: string;
  status: string;
  scope: string | null;
  capUnits: number | null;
  capEur: number | null;
  /** A card is on file for pay-as-you-go. Null on routes that predate the field. */
  paymentMethodSaved: boolean | null;
}

export interface UsageSnapshot {
  account: UsageAccount;
  month: string | null;
  unitsUsed: number;
  unitsCap: number | null;
  eurAccruedCents: number | null;
  remainingUnits: number | null;
  unitPriceCents: number | null;
  /** Units that will be invoiced (pay-as-you-go only); the free allowance is never part of it. */
  billableUnits: number | null;
  /** When the ledger was last copied from the engine, or null. The engine's own counter is real time. */
  asOf: string | null;
  /** Alert thresholds (percent of cap) and whether each has already been sent this month. */
  alerts: Record<string, boolean>;
  events: UsageEvent[];
  settlements: Settlement[];
}

const SETTLEMENT_STATUSES: SettlementStatus[] = ["pending", "carried", "invoiced", "paid", "failed", "void"];

/** An invoice link is only followed if it is an https URL on stripe.com. A malformed or foreign one is dropped. */
export function safeInvoiceUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return null;
    if (u.hostname !== "stripe.com" && !u.hostname.endsWith(".stripe.com")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function parseEvent(v: unknown): UsageEvent | null {
  const r = asRecord(v);
  if (!r) return null;
  const ts = str(r.ts);
  const endpoint = str(r.endpoint);
  const units = num(r.units);
  if (!ts || !endpoint || units === null) return null;
  return {
    ts,
    endpoint,
    units,
    kind: r.kind === "refund" ? "refund" : "charge",
    project: str(r.project) ?? "",
    keyId: str(r.key_id) ?? "",
  };
}

function parseSettlement(v: unknown): Settlement | null {
  const r = asRecord(v);
  if (!r) return null;
  const month = str(r.month);
  if (!month) return null;
  const status = SETTLEMENT_STATUSES.find((s) => s === r.status) ?? "unknown";
  return {
    month,
    units: num(r.units),
    amountCents: num(r.amount_cents),
    status,
    carriedUnits: num(r.carried_units),
    invoiceUrl: safeInvoiceUrl(r.hosted_invoice_url ?? r.invoice_url),
  };
}

/** Exported for tests. Returns null (never a guess) when the essentials are missing. */
export function parseUsage(json: Record<string, unknown>): UsageSnapshot | null {
  const acc = asRecord(json.account);
  const plan = str(acc?.plan);
  const status = str(acc?.status);
  if (!acc || !plan || !status) return null;
  const used = num(json.units_used);
  if (used === null) return null;
  return {
    account: {
      plan,
      status,
      scope: str(acc.scope),
      capUnits: num(acc.cap_units),
      capEur: num(acc.cap_eur),
      paymentMethodSaved: typeof acc.payment_method_saved === "boolean" ? acc.payment_method_saved : null,
    },
    month: str(json.month),
    unitsUsed: used,
    unitsCap: num(json.units_cap),
    eurAccruedCents: num(json.eur_accrued_cents),
    remainingUnits: num(json.remaining_units),
    unitPriceCents: num(json.unit_price_cents),
    billableUnits: num(json.billable_units),
    asOf: str(json.as_of),
    alerts: Object.fromEntries(
      Object.entries(asRecord(json.alerts) ?? {}).filter(([, v]) => typeof v === "boolean") as [string, boolean][]
    ),
    events: (Array.isArray(json.events) ? json.events : []).map(parseEvent).filter((e): e is UsageEvent => e !== null),
    settlements: (Array.isArray(json.settlements) ? json.settlements : [])
      .map(parseSettlement)
      .filter((s): s is Settlement => s !== null),
  };
}

/** GET /api/usage?token=. The token is the account's portal token; it is sent in the query string as the route expects. */
export function getUsage(token: string, f: FetchLike = defaultFetch()): Promise<ClientResult<UsageSnapshot>> {
  return run(
    f,
    `/api/usage?token=${encodeURIComponent(token)}`,
    { method: "GET", cache: "no-store", headers: { Accept: "application/json" } },
    parseUsage
  );
}

// --- enable PAYG and change cap ----------------------------------------------------------------------

/** A Stripe Checkout URL is followed only if it is https. */
export function safeCheckoutUrl(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  try {
    return new URL(s).protocol === "https:" ? s : null;
  } catch {
    return null;
  }
}

/** POST /api/payg/enable. Returns the Stripe Checkout (setup mode) URL; no charge is made by this call. */
export function enablePayg(
  token: string,
  capEur: number,
  f: FetchLike = defaultFetch()
): Promise<ClientResult<{ url: string }>> {
  return run(
    f,
    "/api/payg/enable",
    { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, cap_eur: capEur }) },
    (j) => {
      const url = safeCheckoutUrl(j.url);
      return url ? { url } : null;
    }
  );
}

/**
 * POST /api/payg/card. Stripe Checkout in setup mode for the account's existing customer. Nothing is charged by this
 * call; the card is saved by the signed webhook, which also retries a failed unpaid invoice on it. A 409 carries
 * `fix: "enable_payg"` (no card to replace yet); a cancelled account answers 402.
 */
export function replaceCard(token: string, f: FetchLike = defaultFetch()): Promise<ClientResult<{ url: string }>> {
  return run(f, "/api/payg/card", { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token }) }, (j) => {
    const url = safeCheckoutUrl(j.url);
    return url ? { url } : null;
  });
}

/**
 * A free account's first key mint is refused with 429 {reason:"capacity"} when the month's free allowances are all
 * taken. That is not "slow down": the page says the free allowance is full and points at pay-as-you-go, which needs
 * no free allowance.
 */
export function isFreeCapacityRefusal(status: number, body: unknown): boolean {
  return status === 429 && asRecord(body)?.reason === "capacity";
}

export const FREE_CAPACITY_MESSAGE =
  "Free allowances are full this month, so no free key can be issued yet. They reopen at the start of next month (UTC). " +
  "Pay as you go needs no free allowance: you can enable it below with a cap you choose.";

export interface MintedKey {
  key: string;
  expires: string | null;
  revocationPending: boolean;
  revocationNote: string | null;
}

/** POST /api/payg/cap. The cap lives in the signed key, so a change mints a new key, shown once. */
export function changeCap(
  token: string,
  capEur: number,
  f: FetchLike = defaultFetch()
): Promise<ClientResult<MintedKey>> {
  return run(
    f,
    "/api/payg/cap",
    { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token, cap_eur: capEur }) },
    (j) => {
      const key = str(j.key);
      if (!key) return null;
      return {
        key,
        expires: str(j.expires),
        revocationPending: j.revocation_pending === true,
        revocationNote: str(j.revocation_note),
      };
    }
  );
}

// --- the engine's public estimate --------------------------------------------------------------------

export interface EngineEstimate {
  endpoint: string;
  units: number;
  unitPriceCents: number;
  estimatedCents: number;
  billable: boolean;
  free: boolean;
  basis: string | null;
}

export function parseEstimate(json: Record<string, unknown>): EngineEstimate | null {
  const endpoint = str(json.endpoint);
  const units = num(json.units);
  const unitPriceCents = num(json.unit_price_cents);
  const estimatedCents = num(json.estimated_cents);
  if (!endpoint || units === null || unitPriceCents === null || estimatedCents === null) return null;
  return {
    endpoint,
    units,
    unitPriceCents,
    estimatedCents,
    billable: json.billable !== false,
    free: json.free === true,
    basis: str(json.basis),
  };
}

/**
 * GET {engine}/v1/estimate. Public, free and never metered. It is a plain GET with no custom headers, so the
 * browser sends it without a preflight; if the engine does not allow this origin, the browser blocks it and
 * the caller gets `network`, which the estimator reports as "could not check against the live engine".
 */
export function getEngineEstimate(
  engineBase: string,
  endpoint: string,
  halls: number | null,
  f: FetchLike = defaultFetch()
): Promise<ClientResult<EngineEstimate>> {
  const base = engineBase.replace(/\/+$/, "");
  const q = new URLSearchParams({ endpoint });
  if (halls !== null) q.set("hall_count", String(halls));
  return run(f, `${base}/v1/estimate?${q.toString()}`, { method: "GET", headers: { Accept: "application/json" } }, parseEstimate);
}

// --- presentation helpers ----------------------------------------------------------------------------

/** The plan as a person reads it. Subscription names come from the catalogue; the two new ones are defined here. */
export function planLabel(plan: string): string {
  if (plan === "api_free") return "Free allowance";
  if (plan === "api_payg") return "Pay as you go";
  const p = PRODUCTS[plan as ProductId];
  return p ? p.name : plan;
}

export type MeterTone = "ok" | "warn" | "full" | "unknown";

export interface MeterState {
  /** 0..100, clamped. */
  percent: number;
  tone: MeterTone;
  used: number;
  cap: number | null;
  remaining: number | null;
}

/** Usage against a cap. Warn at the registry's first alert threshold, full at the last. No cap means no meter. */
export function meterState(used: number, cap: number | null): MeterState {
  const u = Math.max(0, used);
  if (cap === null || cap <= 0) return { percent: 0, tone: "unknown", used: u, cap: null, remaining: null };
  const pct = Math.min(100, Math.round((u / cap) * 100));
  const warnAt = Math.min(...PAYG.alertPercents);
  const fullAt = Math.max(...PAYG.alertPercents);
  const tone: MeterTone = pct >= fullAt ? "full" : pct >= warnAt ? "warn" : "ok";
  return { percent: pct, tone, used: u, cap, remaining: Math.max(0, cap - u) };
}
