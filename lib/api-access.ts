import crypto from "node:crypto";
import { storeFault } from "@/lib/safe-log";
import { PAYG } from "@/lib/products";
import { pauseDue } from "@/lib/billing-pause-due";

/**
 * Self-serve API accounts.
 *
 * A stranger's subscription has to become a working API key in seconds, without a
 * human and without the engine needing a database. The engine verifies keys
 * offline by their signature (see gridforge/api/keys.py), so this file's job is
 * the mirror image of that one: mint the same format, with the same secret.
 *
 * The two implementations must agree byte for byte on what gets signed. They are
 * tested against each other — a key minted here must verify there and vice versa —
 * because a divergence would not fail loudly, it would issue keys that quietly do
 * not work, to customers who have just paid.
 *
 * We keep a row per account so a customer can see what they bought and rotate a
 * leaked key. We store the key's ID, never the key: a database that can hand
 * somebody a working credential is a database worth stealing, and there is no
 * reason for this one to be.
 */

const PREFIX = "gfk1";

export type ApiScope = "machine" | "client" | "trial" | "payg";

export interface ApiKeyPayload {
  a: string; // account
  k: string; // key id
  q: number; // monthly unit quota, 0 = unlimited
  s: ApiScope;
  i: string; // issued, ISO date
  e: string; // expires, ISO date
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function secret(): string {
  return process.env.GRIDFORGE_KEY_SECRET || "";
}

export function signingConfigured(): boolean {
  return secret().length > 0;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * How close a subscription's key is to going silent.
 *
 * Signed keys are stateless, which is what lets the engine verify them with no
 * database and no network call. The price of that is a fixed expiry baked into
 * the token: 35 days, against a subscription that renews every ~30. Nothing can
 * extend a key in place — a new expiry means a new signature means a new key.
 *
 * So the renewal has to be a thing the customer DOES, which means we have to tell
 * them, in time, in the one place they can act on it. A paying customer whose
 * agents stop at 3am because a credential quietly aged out is the most expensive
 * failure this product has: it looks like our engine broke, and they churn.
 */
export const ROTATION_WINDOW_DAYS = 7;

export interface KeyLife {
  has_key: boolean;
  expires: string | null;
  /** Negative once the key is dead. Null when there is no key at all. */
  days_left: number | null;
  expired: boolean;
  /** Expired, or inside the window where the customer should mint a fresh one. */
  needs_rotation: boolean;
}

export function keyLife(row: Pick<ApiAccount, "key_id" | "key_expires_at">): KeyLife {
  if (!row.key_id || !row.key_expires_at) {
    return { has_key: false, expires: null, days_left: null, expired: false, needs_rotation: true };
  }
  const expires = new Date(`${row.key_expires_at}T00:00:00Z`);
  if (Number.isNaN(expires.getTime())) {
    // An unreadable date is not a healthy key. Treat it as needing replacement
    // rather than silently reporting it as live.
    return { has_key: true, expires: row.key_expires_at, days_left: null, expired: true, needs_rotation: true };
  }
  const today = new Date(`${isoDate(new Date())}T00:00:00Z`);
  const days_left = Math.round((expires.getTime() - today.getTime()) / 86_400_000);
  const expired = days_left < 0;
  return {
    has_key: true,
    expires: row.key_expires_at,
    days_left,
    expired,
    needs_rotation: expired || days_left <= ROTATION_WINDOW_DAYS,
  };
}

/**
 * Mint a signed key. 35 days, not 30: a subscription renewing on the 1st must not
 * leave a customer's agents dark for the hours between the renewal and the webhook.
 * The overlap is the difference between a renewal nobody notices and a support ticket.
 */
export function issueKey(opts: {
  account: string;
  quota: number;
  scope?: ApiScope;
  days?: number;
  keyId?: string;
  issuedOn?: Date;
}): { token: string; payload: ApiKeyPayload } {
  if (!signingConfigured()) {
    throw new Error("GRIDFORGE_KEY_SECRET is not set; refusing to mint an unsigned key");
  }
  const account = opts.account.trim();
  if (!account) throw new Error("a key must name the account it bills to");
  // A free-allowance or pay-as-you-go key carries its bound in the signature: the engine enforces `q` and treats 0 as
  // "unlimited" for a subscription key only. Minting a bounded scope with no bound would be an uncapped, unbilled key.
  if ((opts.scope === "trial" || opts.scope === "payg") && !(Math.trunc(opts.quota) > 0)) {
    throw new Error(`a ${opts.scope} key must carry a quota above zero`);
  }

  const start = opts.issuedOn ?? new Date();
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + (opts.days ?? 35));

  const payload: ApiKeyPayload = {
    a: account,
    k: opts.keyId ?? crypto.randomBytes(4).toString("hex"),
    q: Math.max(0, Math.trunc(opts.quota)),
    s: opts.scope ?? "machine",
    i: isoDate(start),
    e: isoDate(end),
  };

  // Keys are sorted and separators are tight, matching json.dumps(..., sort_keys=True,
  // separators=(",", ":")) on the Python side. This is the byte-for-byte agreement
  // the cross-language test exists to protect.
  const canonical = JSON.stringify(payload, Object.keys(payload).sort() as (keyof ApiKeyPayload)[]);
  const body = `${PREFIX}.${b64url(Buffer.from(canonical))}`;
  const sig = b64url(crypto.createHmac("sha256", secret()).update(body).digest());
  return { token: `${body}.${sig}`, payload };
}

export function inspectKey(token: string): (ApiKeyPayload & { valid: boolean }) | null {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return null;
  let payload: ApiKeyPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as ApiKeyPayload;
  } catch {
    return null;
  }
  const expected = b64url(
    crypto.createHmac("sha256", secret()).update(`${parts[0]}.${parts[1]}`).digest()
  );
  const valid =
    secret().length > 0 &&
    expected.length === parts[2].length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts[2]));
  return { ...payload, valid };
}

// --- storage ---------------------------------------------------------------

export interface ApiAccount {
  id: string;
  created_at: string;
  token: string; // the account's own portal token, not the API key
  account: string;
  email: string | null;
  company: string | null;
  plan: string;
  monthly_units: number;
  status: "active" | "past_due" | "cancelled";
  key_id: string | null;
  key_issued_at: string | null;
  key_expires_at: string | null;
  revoked_key_ids: string[] | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  /** Pay-as-you-go: the customer's hard cap in units (cap in EUR / unit price, rounded down). */
  cap_units?: number | null;
  stripe_payment_method_id?: string | null;
  payg_enabled_at?: string | null;
  free_email_norm?: string | null;
  /** Scope of the key recorded as live: trial | payg | machine | client. */
  key_scope?: string | null;
  /** Revoked ids the engine has confirmed. Anything in revoked_key_ids and not here is retried by the cron. */
  revoked_confirmed_ids?: string[] | null;
  revocation_pending?: boolean;
  /** Stripe event.created of the newest invoice event applied to this (subscription) account. */
  last_billing_event_ts?: number | null;
  /** {key id: last valid day} for keys DELIBERATELY left live next to a newer one: the revocation sweep leaves them alone until that day has passed. */
  overlap_key_ids?: Record<string, string> | null;
  /** When the daily revocation sweep last examined this account (migration 0039): the sweep takes the least recently examined first. */
  last_revocation_attempt_at?: string | null;
  /** Set when the emailed link is first used to mint a key; the monthly free-allowance ceiling counts these. */
  free_verified_at?: string | null;
  /** When the current past_due episode began (migration 0041): API_PAST_DUE_GRACE_DAYS counts from here. */
  past_due_since?: string | null;
  /** A suspension that is not a cancellation (migration 0041): see lib/billing-holds.ts. */
  billing_hold?: "refunded" | "disputed" | "paused" | null;
  billing_hold_ref?: string | null;
  billing_hold_invoice?: string | null;
  billing_hold_at?: string | null;
  billing_hold_prev_status?: string | null;
  /** A pause scheduled for the end of the paid period (migration 0043): see lib/billing-pause.ts. */
  billing_pause_from?: string | null;
  billing_pause_resumes_at?: string | null;
  billing_pause_event_ts?: number | null;
}

/**
 * How long a subscription API account may stay past_due with its already-minted key still working: the key is a signed token the
 * engine verifies offline, so until it is revoked it works for up to 35 days whatever the account says. A card that fails on Tuesday
 * and clears on Thursday should not cost the customer their integration, and a customer who never pays should not keep a month of
 * access. Seven days from the FIRST failed payment of the episode (Stripe retries over about that long); after it the daily cron (and
 * any later failure event) revokes the live key. A payment that clears afterwards reopens minting; the revoked key stays revoked.
 * Pay-as-you-go accounts have no grace: their key is revoked at the first failed settlement (lib/payg-billing.ts).
 */
export const API_PAST_DUE_GRACE_DAYS = 7;

function rest(pathAndQuery: string): { url: string; headers: Record<string, string> } | null {
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key) return null;
  return {
    url: `${base}/rest/v1/${pathAndQuery}`,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  };
}

export function newToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * A readable billing identity, unique PER SUBSCRIPTION. Usage aggregates under this, not the key.
 *
 * It used to be derived from email + company alone, and `api_accounts.account` is UNIQUE. So the
 * second purchase by the same buyer — a re-subscription after a cancellation ("a new sale"), or a
 * second plan — collided, the insert failed, the webhook answered 500 and Stripe retried for days:
 * a customer who had paid and never received an account. The subscription id is part of the salt, so
 * each subscription is its own account with its own quota; the same subscription always maps to the
 * same account, so a redelivery cannot mint a second one. Existing accounts keep the ids they have.
 */
export function accountIdFor(email: string, company: string, subscriptionId?: string | null): string {
  const stem = (company || email.split("@")[0] || "account")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  const salt = crypto
    .createHash("sha256")
    .update(subscriptionId ? `${email.toLowerCase()}|${subscriptionId}` : email.toLowerCase())
    .digest("hex")
    .slice(0, subscriptionId ? 8 : 6);
  return `${stem || "account"}-${salt}`;
}

export async function createApiAccount(input: {
  email: string | null;
  company: string | null;
  plan: string;
  monthly_units: number;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
}): Promise<{ row: ApiAccount; token: string } | null> {
  const r = rest("api_accounts");
  if (!r) return null;
  const account = accountIdFor(input.email || "", input.company || "", input.stripe_subscription_id);
  const token = newToken();
  const res = await fetch(r.url, {
    method: "POST",
    headers: { ...r.headers, Prefer: "return=representation" },
    body: JSON.stringify({
      token,
      account,
      email: input.email,
      company: input.company,
      plan: input.plan,
      monthly_units: input.monthly_units,
      status: "active",
      stripe_customer_id: input.stripe_customer_id,
      stripe_subscription_id: input.stripe_subscription_id,
    }),
  });
  if (!res.ok) {
    console.error("[GridForge] could not create api account:", await storeFault(res));
    return null;
  }
  const rows = (await res.json()) as ApiAccount[];
  return rows[0] ? { row: rows[0], token } : null;
}

export async function getApiAccount(token: string): Promise<ApiAccount | null> {
  const r = rest(`api_accounts?token=eq.${encodeURIComponent(token)}&limit=1`);
  if (!r) return null;
  try {
    const res = await fetch(r.url, { headers: r.headers, cache: "no-store" });
    if (!res.ok) return null;
    const rows = (await res.json()) as ApiAccount[];
    return rows[0] ?? null;
  } catch (err) {
    console.error("[GridForge] api account lookup unreachable:", err);
    return null;
  }
}

export async function updateApiAccount(
  token: string,
  patch: Partial<ApiAccount>
): Promise<ApiAccount | null> {
  const r = rest(`api_accounts?token=eq.${encodeURIComponent(token)}`);
  if (!r) return null;
  try {
    const res = await fetch(r.url, {
      method: "PATCH",
      headers: { ...r.headers, Prefer: "return=representation" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      console.error("[GridForge] api account update failed:", await storeFault(res));
      return null;
    }
    const rows = (await res.json()) as ApiAccount[];
    return rows[0] ?? null;
  } catch (err) {
    console.error("[GridForge] api account update unreachable:", err);
    return null;
  }
}

/**
 * The account behind a Stripe subscription, with "the store could not be read" kept apart from
 * "there is no such account". The billing webhook must tell them apart: treating a failed read as
 * "no account" acknowledges a cancellation that was never applied.
 */
export async function lookupBySubscription(
  subscriptionId: string
): Promise<{ ok: true; row: ApiAccount | null } | { ok: false }> {
  const r = rest(
    `api_accounts?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}&limit=1`
  );
  if (!r) return { ok: false };
  try {
    const res = await fetch(r.url, { headers: r.headers, cache: "no-store" });
    if (!res.ok) {
      console.error("[GridForge] api account lookup failed:", await storeFault(res));
      return { ok: false };
    }
    return { ok: true, row: ((await res.json()) as ApiAccount[])[0] ?? null };
  } catch (err) {
    console.error("[GridForge] api account lookup unreachable:", err);
    return { ok: false };
  }
}

export async function findBySubscription(subscriptionId: string): Promise<ApiAccount | null> {
  const found = await lookupBySubscription(subscriptionId);
  return found.ok ? found.row : null;
}

/**
 * Issue (or reissue) the account's key and record which id is now live.
 *
 * Reissuing revokes the previous id. That is the whole point of rotation: a leaked
 * key that keeps working until it expires is not rotated, it is duplicated. The
 * revoked ids go into GRIDFORGE_REVOKED_KEYS on the engine.
 */
/**
 * Tell the engine to stop honouring a key now, rather than at expiry.
 *
 * The account row records which ids we have revoked; the ENGINE is what has to
 * refuse them, and until it had a local revocation store the only lever was an
 * environment variable — a redeploy, done by hand, while a leaked key kept
 * working.
 *
 * A call that fails does not fail the webhook (a redelivery would re-run a cancellation that
 * already happened), and it is NOT forgotten either: every caller records the id in
 * `revoked_key_ids` BEFORE asking the engine and records the engine's confirmation in
 * `revoked_confirmed_ids` only on a 2xx. An id in the first and not the second is a
 * DURABLE obligation (`revocation_pending`): the daily sweep (retryRevocations) and the
 * next billing event for the account push it again, the operator is told once per
 * account (lib/billing-holds.ts noteUnconfirmedRevocation), and
 * checkRevocationBacklog (lib/stripe-health.ts) reports it. Nothing may say a key is
 * revoked on the strength of this function returning false.
 */
export type RevokeResult =
  | { ok: true }
  | {
      ok: false;
      /**
       * unconfigured: no engine URL / admin key here. not_deployed: the engine answered 404 for the route (an engine older than this
       * repository; scripts/check-engine-drift.py). refused: the engine answered and said no (admin key mismatch, revocation store not
       * persistable). unreachable: no answer.
       */
      reason: "unconfigured" | "not_deployed" | "refused" | "unreachable";
      status?: number;
    };

/** The one place this site calls the engine's /v1/revoke (an operator-tier route, never reachable with a customer key). */
function postRevoke(base: string, admin: string, keyId: string, timeoutMs: number): Promise<Response> {
  return fetch(`${base.replace(/\/$/, "")}/v1/revoke`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": admin },
    body: JSON.stringify({ key_id: keyId }),
    signal: AbortSignal.timeout(timeoutMs),
    cache: "no-store",
  });
}

/** What the engine said about one revocation, as a category: never "revoked" unless the engine answered 2xx. */
export async function revokeOnEngineDetailed(keyId: string | null | undefined): Promise<RevokeResult> {
  const id = (keyId ?? "").trim();
  if (!id) return { ok: false, reason: "refused" };
  const base = process.env.GRIDFORGE_API_URL;
  const admin = process.env.GRIDFORGE_ADMIN_KEY;
  if (!base || !admin) {
    console.warn(
      "[GridForge] cannot revoke key id on the engine (GRIDFORGE_API_URL / GRIDFORGE_ADMIN_KEY unset):",
      id
    );
    return { ok: false, reason: "unconfigured" };
  }
  try {
    const res = await postRevoke(base, admin, id, 10_000);
    if (!res.ok) {
      console.error("[GridForge] engine refused a revocation:", await storeFault(res), id);
      return { ok: false, reason: res.status === 404 ? "not_deployed" : "refused", status: res.status };
    }
    console.log("[GridForge] key id revoked on the engine:", id);
    return { ok: true };
  } catch (err) {
    console.error("[GridForge] could not reach the engine to revoke:", err, id);
    return { ok: false, reason: "unreachable" };
  }
}

export async function revokeOnEngine(keyId: string | null | undefined): Promise<boolean> {
  return (await revokeOnEngineDetailed(keyId)).ok;
}

/**
 * Does the engine serve the revocation route at all? A POST with an EMPTY key id revokes nothing on an engine that has the route (it
 * answers 422 "key_id is required") and 404s on one that does not (the deployed engine, today). Used only to tell the operator which
 * of the two is behind a revocation backlog; "unknown" is any other answer.
 */
export async function probeEngineRevokeRoute(): Promise<"served" | "not_deployed" | "unreachable" | "unconfigured" | "unknown"> {
  const base = process.env.GRIDFORGE_API_URL;
  const admin = process.env.GRIDFORGE_ADMIN_KEY;
  if (!base || !admin) return "unconfigured";
  try {
    const res = await postRevoke(base, admin, "", 5_000);
    if (res.status === 404) return "not_deployed";
    if (res.status === 422 || res.status === 503 || res.ok) return "served";
    return "unknown";
  } catch {
    return "unreachable";
  }
}

/**
 * Does the engine verify the keys this site signs? Asked before a rotation revokes the key it replaces: a new key the engine cannot
 * verify (a signing secret that differs, an engine that is down, an engine too old to know the key's scope) must never be the only
 * key left. The key is presented to the engine's unmetered GET /v1/version; the engine answers tier "client" only if it verified our
 * signature and knows the scope. "unknown" means the engine could not be asked; only "yes" permits revoking the old key.
 *
 * WHICH key is presented matters. With `newKey` of scope machine or payg, the customer's REAL new token is what is shown to the
 * engine: a throwaway trial probe proves only that the engine knows the signature and the TRIAL scope, and an engine built before the
 * payg scope existed passes that probe and then refuses the pay-as-you-go key the customer is about to be left with. Without `newKey`
 * (the daily sweep holds no token; a trial key is bounded and unmetered here) a throwaway one-day probe key is signed instead.
 */
export async function engineVerifiesOurKeys(newKey?: { token: string; scope: string }): Promise<"yes" | "no" | "unknown"> {
  if (!signingConfigured()) return "no";
  const base = process.env.GRIDFORGE_API_URL;
  if (!base) return "unknown";
  const real = newKey && (newKey.scope === "machine" || newKey.scope === "payg") ? newKey.token : null;
  const presented = real ?? issueKey({ account: "ttp-rotation-probe", quota: 1, scope: "trial", days: 1 }).token;
  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/v1/version`, { headers: { "X-API-Key": presented }, signal: AbortSignal.timeout(5_000), cache: "no-store" });
    if (!res.ok) return "unknown";
    const j = (await res.json()) as { tier?: unknown } | null;
    if (!j || typeof j !== "object") return "unknown";
    return j.tier === "client" ? "yes" : "no";
  } catch {
    return "unknown";
  }
}

export interface MintResult {
  token: string;
  expires: string;
  /** Every id the account now records as revoked (including ones the engine has not yet confirmed). */
  revoked: string[];
  /** The key id this mint replaced on the account row, if any. */
  previous: string | null;
  /**
   * What the ENGINE said about the previous id: true = confirmed revoked there, false = a revocation was
   * attempted and not confirmed (the id stays in revoked_key_ids so cancellation retries it), null = no
   * engine revocation was attempted (nothing replaced, or an in-window overlap mint left the old key live).
   */
  engine_revoked: boolean | null;
  /** The previous key was NOT revoked now because the engine could not be shown to verify the new key; the sweep revokes it after it can. */
  rotation_deferred?: boolean;
}

/**
 * Mint and record a new key. Whenever it overwrites key_id, the superseded id is kept in
 * revoked_key_ids so it is never forgotten (cancellation pushes every one of them to the engine).
 * With `rotate`, the superseded id is also revoked on the engine now, AFTER the new id is saved, and the
 * result says honestly whether the engine confirmed. Without it (a mint inside the renewal window) the old
 * key keeps working until it expires, on purpose, but it is tracked.
 */
export async function mintForAccount(row: ApiAccount, opts: MintOptions = {}): Promise<MintResult | null> {
  const out = await mintChecked(row, opts);
  return out.ok ? out.result : null;
}

export type MintOutcome =
  | { ok: true; result: MintResult }
  | { ok: false; reason: "conflict" | "store" | "refused"; message?: string };

export interface MintOptions {
  rotate?: boolean;
  /** Extra account columns written in the SAME compare-and-set write as the key (the cap, on a cap change). */
  extra?: Record<string, unknown>;
  /** Override what the plan would mint (a cap change mints for the NEW cap before the account row says so). */
  entitlement?: { scope: "trial" | "payg" | "machine"; quota: number };
}

/**
 * What a key for this account must carry, by plan: the free allowance (scope trial, bounded), the customer's own cap (scope
 * payg, bounded) or the subscription allowance (scope machine). A bounded scope with no bound is REFUSED here as well as in
 * issueKey: a quota of 0 means "unlimited" to the engine, and neither a free account nor a pay-as-you-go account may have that.
 */
export function keyEntitlement(
  row: Pick<ApiAccount, "plan" | "monthly_units" | "cap_units">
): { ok: true; scope: "trial" | "payg" | "machine"; quota: number } | { ok: false; error: string } {
  if (row.plan === "api_free") return { ok: true, scope: "trial", quota: PAYG.freeAllowanceUnits };
  if (row.plan === "api_payg") {
    const cap = Math.trunc(Number(row.cap_units ?? 0));
    if (!(cap > 0)) return { ok: false, error: "This account has no spending cap on record, so a pay-as-you-go key cannot be issued. Set a cap first." };
    return { ok: true, scope: "payg", quota: cap };
  }
  return { ok: true, scope: "machine", quota: row.monthly_units };
}

/**
 * Compare-and-set write of the key columns. The PATCH only matches while the account still has the key id (and the status) this
 * mint was based on, so two concurrent mints cannot both "win": the loser's PATCH matches no row and its key is never handed out.
 * Without this the last write silently replaced the first mint's id, which was then recorded nowhere and could never be
 * revoked (it lives up to 35 days).
 */
async function casUpdateKey(row: ApiAccount, patch: Record<string, unknown>): Promise<"ok" | "conflict" | "error"> {
  const r = rest(
    `api_accounts?token=eq.${encodeURIComponent(row.token)}` +
      (row.key_id ? `&key_id=eq.${encodeURIComponent(row.key_id)}` : "&key_id=is.null") +
      `&status=eq.${encodeURIComponent(row.status)}`
  );
  if (!r) return "error";
  try {
    const res = await fetch(r.url, {
      method: "PATCH",
      headers: { ...r.headers, Prefer: "return=representation" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) {
      console.error("[GridForge] api account key write failed:", await storeFault(res));
      return "error";
    }
    const rows = (await res.json()) as unknown[];
    return rows.length === 1 ? "ok" : "conflict";
  } catch {
    console.error("[GridForge] api account key write unreachable");
    return "error";
  }
}

/** Record that the engine confirmed these ids revoked (the DB unions them in; they only accumulate). */
export async function confirmRevoked(token: string, ids: string[]): Promise<boolean> {
  if (ids.length === 0) return true;
  const row = await getApiAccount(token);
  if (!row) return false;
  const confirmed = [...new Set([...(row.revoked_confirmed_ids ?? []), ...ids])];
  return Boolean(await updateApiAccount(token, { revoked_confirmed_ids: confirmed }));
}

/**
 * The compare-and-set mint (see casUpdateKey): a concurrent mint makes this one answer "conflict" and no key is handed out.
 */
export async function mintChecked(row: ApiAccount, opts: MintOptions = {}): Promise<MintOutcome> {
  // A pause scheduled for the end of the paid period (lib/billing-pause.ts) has started to hold access once that instant has passed, even
  // before the daily job writes the hold: no new key is minted for a period nobody paid for. (Up to the instant, minting is the customer's.)
  if (row.status !== "cancelled" && pauseDue(row)) {
    return { ok: false, reason: "refused", message: "Billing for this plan is paused and the period you paid for has ended, so a new key cannot be issued. Resume billing in the billing portal to continue." };
  }
  const want = opts.entitlement ? ({ ok: true, ...opts.entitlement } as const) : keyEntitlement(row);
  if (!want.ok) return { ok: false, reason: "refused", message: want.error };
  const { token, payload } = issueKey({ account: row.account, quota: want.quota, scope: want.scope });
  const revoked = [...(row.revoked_key_ids ?? [])];
  const previous = row.key_id || null;
  if (previous && !revoked.includes(previous)) revoked.push(previous);
  // A mint that does NOT rotate leaves the previous key live on purpose (the renewal window: the old key works until it expires, so a
  // deployment can switch over first). It is still recorded so cancellation can revoke it, but the daily revocation sweep must not kill
  // it early: its last valid day is kept here, and the sweep revokes it only after that day.
  //
  // An EXPLICIT rotation ends every overlap, not only the key it replaces: a customer who rotates because a key leaked must not be left
  // with an older in-window key that keeps working for up to a week. Those ids are revoked below (once the engine is shown to verify the
  // new key), and the overlap record is cleared in the same write: from then on the sweep treats them as ordinary pending revocations.
  const overlapIds = opts.rotate ? Object.keys(row.overlap_key_ids ?? {}).filter((id) => id !== previous) : [];
  for (const id of overlapIds) if (!revoked.includes(id)) revoked.push(id);
  const overlap: Record<string, string> | undefined = opts.rotate
    ? (Object.keys(row.overlap_key_ids ?? {}).length > 0 ? {} : undefined)
    : previous
      ? { ...(row.overlap_key_ids ?? {}), [previous]: row.key_expires_at ?? new Date().toISOString().slice(0, 10) }
      : undefined;
  // The key is only handed over once the account records which id is live. A key the account does
  // not know about can be neither rotated nor revoked on cancellation, so a failed write must not
  // produce a working credential the customer then holds.
  const saved = await casUpdateKey(row, {
    key_id: payload.k,
    key_issued_at: payload.i,
    key_expires_at: payload.e,
    key_scope: want.scope,
    revoked_key_ids: revoked,
    ...(overlap ? { overlap_key_ids: overlap } : {}),
    ...(opts.extra ?? {}),
  });
  if (saved === "conflict") return { ok: false, reason: "conflict" };
  if (saved === "error") return { ok: false, reason: "store" };
  let engine_revoked: boolean | null = null;
  let rotation_deferred = false;
  if (opts.rotate && (previous || overlapIds.length > 0)) {
    // The old keys are revoked only once the engine is shown to verify the NEW key this site just signed (the real token, for a machine or
    // pay-as-you-go key). A new key the engine cannot verify (a signing secret that differs, an engine that is down, an engine too old to
    // know the scope) must not be the only key left: the customer would be locked out by their own rotation. Until then the old keys
    // stay valid, are recorded as unconfirmed, and the daily sweep revokes them after the check passes.
    if ((await engineVerifiesOurKeys({ token, scope: want.scope })) === "yes") {
      const ids = [...(previous ? [previous] : []), ...overlapIds];
      const done: string[] = [];
      for (const id of ids) if (await revokeOnEngine(id)) done.push(id);
      // true only when the engine confirmed EVERY id this rotation retired.
      engine_revoked = done.length === ids.length;
      if (done.length > 0) await confirmRevoked(row.token, done);
    } else {
      rotation_deferred = true;
      console.error("[GridForge] rotation: the engine could not be shown to verify the new key; the previous key id(s) stay valid for now:", [previous, ...overlapIds].filter(Boolean));
    }
  }
  return { ok: true, result: { token, expires: payload.e, revoked, previous, engine_revoked, ...(rotation_deferred ? { rotation_deferred: true } : {}) } };
}


/** An overlap key is live ON PURPOSE only while its account is ACTIVE and its last valid day has not passed. */
export function overlapHeld(row: Pick<ApiAccount, "status" | "overlap_key_ids">, id: string, today: string): boolean {
  return row.status === "active" && (row.overlap_key_ids ?? {})[id] >= today;
}

type SweepRow = Pick<ApiAccount, "token" | "status" | "revoked_key_ids" | "revoked_confirmed_ids" | "overlap_key_ids">;

/**
 * Push every revoked key id the engine has not yet confirmed. This is what makes "revocation will be retried" true: the mint
 * and the cancellation paths each try once and record the id as unconfirmed, and this sweep (run by /api/cron/payg) keeps trying
 * until the engine says yes. Bounded per run; an id the engine refuses stays pending and is counted, never silently dropped.
 *
 * Fair: the batch is the accounts whose revocation was attempted LEAST recently (never-attempted first), and every account examined is
 * stamped, so rows that are held back (the engine cannot yet be shown to verify the key that replaced theirs, an overlap not yet due) or
 * that the engine keeps refusing cannot occupy the whole bounded batch run after run while others wait.
 *
 * An overlap key (live on purpose next to a newer one) is left alone until its last valid day only for an ACTIVE account. A cancelled or
 * past-due account is being cut off: its overlap ids are pushed now, like every other unconfirmed id.
 */
export async function retryRevocations(limit = 50, now: Date = new Date()): Promise<{ accounts: number; confirmed: number; stillPending: number }> {
  const today = now.toISOString().slice(0, 10);
  const n = Math.max(1, Math.min(limit, 200));
  const select = "token,status,revoked_key_ids,revoked_confirmed_ids,overlap_key_ids";
  const ordered = rest(`api_accounts?revocation_pending=eq.true&select=${select}&order=last_revocation_attempt_at.asc.nullsfirst,created_at.asc&limit=${n}`);
  const legacy = rest(`api_accounts?revocation_pending=eq.true&select=${select}&limit=${n}`);
  if (!ordered || !legacy) return { accounts: 0, confirmed: 0, stillPending: 0 };
  let rows: SweepRow[] = [];
  try {
    let res = await fetch(ordered.url, { headers: ordered.headers, cache: "no-store" });
    if (!res.ok) {
      // Migration 0039 not applied yet (no last_revocation_attempt_at): read unordered, as before, rather than stop revoking.
      console.error("[GridForge] revocation sweep: ordered read refused; reading unordered:", await storeFault(res));
      res = await fetch(legacy.url, { headers: legacy.headers, cache: "no-store" });
    }
    if (!res.ok) {
      console.error("[GridForge] revocation sweep could not read accounts:", await storeFault(res));
      return { accounts: 0, confirmed: 0, stillPending: 0 };
    }
    rows = (await res.json()) as SweepRow[];
  } catch {
    return { accounts: 0, confirmed: 0, stillPending: 0 };
  }
  let confirmed = 0;
  let stillPending = 0;
  // For an account that is still ACTIVE the id waiting here is a key it replaced: revoking it before the engine is shown to verify the
  // key that replaced it could leave the customer with nothing. Checked once per run, and only if such an account is in the batch.
  // Cancelled and past-due accounts are being cut off, so their ids are pushed regardless.
  const ctx: SweepContext = { verifies: null };
  for (const row of rows) {
    await stampRevocationAttempt(row.token, now);
    const r = await sweepRow(row, today, ctx);
    confirmed += r.confirmed;
    stillPending += r.stillPending;
  }
  return { accounts: rows.length, confirmed, stillPending };
}

interface SweepContext {
  verifies: "yes" | "no" | "unknown" | null;
}

async function sweepRow(row: SweepRow, today: string, ctx: SweepContext, maxIds = Infinity): Promise<{ confirmed: number; stillPending: number }> {
  const done = new Set(row.revoked_confirmed_ids ?? []);
  // An overlap key of an active account is live on purpose until its last valid day: neither pushed nor counted pending before then.
  const todo = (row.revoked_key_ids ?? []).filter((id) => !done.has(id) && !overlapHeld(row, id, today));
  if (row.status === "active") {
    ctx.verifies ??= await engineVerifiesOurKeys();
    if (ctx.verifies !== "yes") return { confirmed: 0, stillPending: todo.length };
  }
  const ok: string[] = [];
  let tried = 0;
  for (const id of todo) {
    if (tried >= maxIds) break; // the rest stays pending for the daily sweep
    tried++;
    const out = await revokeOnEngineDetailed(id);
    if (out.ok) ok.push(id);
    else if (out.reason === "unreachable") break; // a down engine will not answer the next id either: do not spend the caller's time on it
  }
  const confirmed = ok.length && (await confirmRevoked(row.token, ok)) ? ok.length : 0;
  return { confirmed, stillPending: todo.length - confirmed };
}

/** At most this many key ids are pushed inline by a billing event; the daily sweep drains the rest. */
export const INLINE_REVOCATION_IDS = 3;
/** An account whose revocation was attempted more recently than this is not retried inline (the daily sweep stamps it too). */
export const INLINE_REVOCATION_PAUSE_MS = 10 * 60_000;

/**
 * Push one account's unconfirmed revocations now (the next billing event for an account whose revocation is pending calls this, so a
 * revocation does not wait for the daily sweep). It runs INSIDE the webhook, whose time is limited, so it is bounded: at most
 * INLINE_REVOCATION_IDS ids (10 s each at worst), none if this account was tried in the last INLINE_REVOCATION_PAUSE_MS, and it stops at
 * the first id the engine does not answer. The daily sweep has no such limit and drains whatever is left.
 */
export async function retryRevocationsFor(token: string, now: Date = new Date()): Promise<{ confirmed: number; stillPending: number; skipped?: "recent" }> {
  const row = await getApiAccount(token);
  if (!row) return { confirmed: 0, stillPending: 0 };
  const last = row.last_revocation_attempt_at ? Date.parse(row.last_revocation_attempt_at) : NaN;
  if (Number.isFinite(last) && now.getTime() - last < INLINE_REVOCATION_PAUSE_MS) return { confirmed: 0, stillPending: 0, skipped: "recent" };
  await stampRevocationAttempt(row.token, now);
  return sweepRow(row, now.toISOString().slice(0, 10), { verifies: null }, INLINE_REVOCATION_IDS);
}

/** Best effort: a failed stamp only costs fairness for one run (and a missing column before 0039 is not an error worth stopping for). */
async function stampRevocationAttempt(token: string, now: Date): Promise<void> {
  const r = rest(`api_accounts?token=eq.${encodeURIComponent(token)}`);
  if (!r) return;
  try {
    await fetch(r.url, { method: "PATCH", headers: { ...r.headers, Prefer: "return=minimal" }, body: JSON.stringify({ last_revocation_attempt_at: now.toISOString() }) });
  } catch {
    /* fairness only */
  }
}

/**
 * Mark an account cancelled and revoke every key id it ever held, from a FRESH read, compare-and-set on the key id.
 *
 * The cancellation webhook used to write `revoked_key_ids` computed from the row it looked up at the START of the event. A key minted
 * between that read and the write became the live key and was recorded nowhere: cancelled, but with a working credential no revocation
 * list contained. Now the row is re-read and the write only matches while `key_id` is still the id the revoked set was built from; if a
 * mint landed meanwhile the write matches nothing and the loop starts again from the new row, so the live id is always in the set.
 * (The database also unions revoked ids, which covers the other direction, but cannot know about an id nobody wrote.)
 */
export async function cancelApiAccount(
  token: string,
  attempts = 5
): Promise<{ ok: true; row: ApiAccount; revoked: string[] } | { ok: false }> {
  for (let i = 0; i < attempts; i++) {
    const row = await getApiAccount(token);
    if (!row) return { ok: false };
    const revoked = new Set(row.revoked_key_ids ?? []);
    if (row.key_id) revoked.add(row.key_id);
    for (const id of Object.keys(row.overlap_key_ids ?? {})) revoked.add(id);
    const r = rest(
      `api_accounts?token=eq.${encodeURIComponent(token)}` + (row.key_id ? `&key_id=eq.${encodeURIComponent(row.key_id)}` : "&key_id=is.null")
    );
    if (!r) return { ok: false };
    try {
      const res = await fetch(r.url, {
        method: "PATCH",
        headers: { ...r.headers, Prefer: "return=representation" },
        body: JSON.stringify({ status: "cancelled", revoked_key_ids: [...revoked] }),
      });
      if (!res.ok) {
        console.error("[GridForge] api account cancellation write failed:", await storeFault(res));
        return { ok: false };
      }
      const rows = (await res.json()) as ApiAccount[];
      if (rows.length === 1) return { ok: true, row, revoked: [...revoked] };
      // No row matched: the key changed under us. Read again and rebuild the set from what is live NOW.
    } catch {
      console.error("[GridForge] api account cancellation write unreachable");
      return { ok: false };
    }
  }
  return { ok: false };
}

/**
 * Write to an account only while it is NOT cancelled (a conditional update, like claimWatch): a hold, a lift or a payment event that
 * races a cancellation can never turn cancelled back into active or past_due. "terminal": no row matched, the account is cancelled.
 */
export async function updateApiAccountUnlessCancelled(token: string, patch: Partial<ApiAccount>): Promise<"ok" | "terminal" | "error"> {
  const r = rest(`api_accounts?token=eq.${encodeURIComponent(token)}&status=neq.cancelled`);
  if (!r) return "error";
  try {
    const res = await fetch(r.url, { method: "PATCH", headers: { ...r.headers, Prefer: "return=representation" }, body: JSON.stringify(patch) });
    if (!res.ok) {
      console.error("[GridForge] api account conditional update failed:", await storeFault(res));
      return "error";
    }
    return ((await res.json()) as unknown[]).length > 0 ? "ok" : "terminal";
  } catch {
    console.error("[GridForge] api account conditional update unreachable");
    return "error";
  }
}

export type SuspendOutcome =
  | { ok: false; /** The account is cancelled: nothing to suspend, and not a failure to retry. */ terminal?: true }
  | {
      ok: true;
      /** The row as it stood when the key columns were cleared. */
      row: ApiAccount;
      /** Every id the account now records as live-or-overlapping and revoked by this call. */
      revoked: string[];
      /** The engine answered 2xx for these. */
      confirmed: string[];
      /** The engine did NOT confirm these: they stay in revoked_key_ids without a confirmation, a durable obligation the sweep retries. */
      unconfirmed: { id: string; reason: string }[];
    };

/**
 * Cut an account's keys off NOW and record that the account may not mint: the live key, and any key deliberately left live next to a
 * newer one, are written into revoked_key_ids and key_id/expiry/scope are cleared, in ONE write that carries `extra` (the status, the
 * hold, the clock). The write is compare-and-set on the key id from a FRESH read (as cancelApiAccount), so a key minted between the
 * caller's read and this write is the live key and is in the set. Only after the account says so is the engine told; what the engine
 * confirmed goes into revoked_confirmed_ids and nothing else does, so an engine that cannot be reached (or that does not serve
 * /v1/revoke yet) leaves a recorded, unconfirmed revocation that the daily sweep and the next billing event keep pushing. The caller
 * must not tell anybody the key is revoked unless `unconfirmed` is empty.
 *
 * Used by every path that suspends rather than cancels: the pay-as-you-go failed settlement, the end of the past_due grace, and a
 * refunded, disputed or paused subscription payment.
 */
export async function suspendApiKeys(acct: Pick<ApiAccount, "token">, extra: Partial<ApiAccount> = {}, attempts = 5): Promise<SuspendOutcome> {
  for (let i = 0; i < attempts; i++) {
    const row = await getApiAccount(acct.token);
    if (!row) return { ok: false };
    // A cancelled account is over: a suspension must never turn it into past_due (cancellation owns its revocations).
    if (row.status === "cancelled") return { ok: false, terminal: true };
    const live = row.key_id ? [row.key_id] : [];
    const overlap = Object.keys(row.overlap_key_ids ?? {});
    const toRevoke = [...new Set([...live, ...overlap])];
    const revoked = new Set([...(row.revoked_key_ids ?? []), ...toRevoke]);
    // Compare-and-set on the key id AND not cancelled: a cancellation that lands between the read and this write matches no row.
    const r = rest(
      `api_accounts?token=eq.${encodeURIComponent(row.token)}&status=neq.cancelled` + (row.key_id ? `&key_id=eq.${encodeURIComponent(row.key_id)}` : "&key_id=is.null")
    );
    if (!r) return { ok: false };
    try {
      const res = await fetch(r.url, {
        method: "PATCH",
        headers: { ...r.headers, Prefer: "return=representation" },
        body: JSON.stringify({
          ...extra,
          key_id: null,
          key_issued_at: null,
          key_expires_at: null,
          key_scope: null,
          revoked_key_ids: [...revoked],
        }),
      });
      if (!res.ok) {
        console.error("[GridForge] api account suspension write failed:", await storeFault(res));
        return { ok: false };
      }
      const rows = (await res.json()) as ApiAccount[];
      if (rows.length !== 1) continue; // a mint landed under us: read again and rebuild the set from what is live NOW
      const confirmed: string[] = [];
      const unconfirmed: { id: string; reason: string }[] = [];
      for (const id of toRevoke) {
        const out = await revokeOnEngineDetailed(id);
        if (out.ok) confirmed.push(id);
        else unconfirmed.push({ id, reason: out.reason });
      }
      if (confirmed.length) await confirmRevoked(row.token, confirmed);
      return { ok: true, row, revoked: [...revoked], confirmed, unconfirmed };
    } catch {
      console.error("[GridForge] api account suspension write unreachable");
      return { ok: false };
    }
  }
  return { ok: false };
}

/** Milliseconds a past_due subscription API account may keep its minted key. */
export const API_PAST_DUE_GRACE_MS = API_PAST_DUE_GRACE_DAYS * 86_400_000;

/**
 * Has this subscription API account's grace run out? Only a past_due row with a start time, no hold of its own (a hold already cut the
 * key off) and a subscription behind it (pay-as-you-go and free accounts have their own rules) can be over grace.
 */
export function graceElapsed(row: Pick<ApiAccount, "status" | "past_due_since" | "billing_hold" | "plan" | "stripe_subscription_id">, nowMs: number): boolean {
  if (row.status !== "past_due" || row.billing_hold) return false;
  if (row.plan === "api_payg" || row.plan === "api_free" || !row.stripe_subscription_id) return false;
  const since = row.past_due_since ? Date.parse(row.past_due_since) : NaN;
  return Number.isFinite(since) && nowMs - since >= API_PAST_DUE_GRACE_MS;
}
