import crypto from "node:crypto";

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

export type ApiScope = "machine" | "client" | "trial";

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
}

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

/** A stable, readable billing identity. Usage aggregates under this, not the key. */
export function accountIdFor(email: string, company: string): string {
  const stem = (company || email.split("@")[0] || "account")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
  const salt = crypto.createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 6);
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
  const account = accountIdFor(input.email || "", input.company || "");
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
    console.error("[GridForge] could not create api account:", await res.text());
    return null;
  }
  const rows = (await res.json()) as ApiAccount[];
  return rows[0] ? { row: rows[0], token } : null;
}

export async function getApiAccount(token: string): Promise<ApiAccount | null> {
  const r = rest(`api_accounts?token=eq.${encodeURIComponent(token)}&limit=1`);
  if (!r) return null;
  const res = await fetch(r.url, { headers: r.headers, cache: "no-store" });
  if (!res.ok) return null;
  const rows = (await res.json()) as ApiAccount[];
  return rows[0] ?? null;
}

export async function updateApiAccount(
  token: string,
  patch: Partial<ApiAccount>
): Promise<ApiAccount | null> {
  const r = rest(`api_accounts?token=eq.${encodeURIComponent(token)}`);
  if (!r) return null;
  const res = await fetch(r.url, {
    method: "PATCH",
    headers: { ...r.headers, Prefer: "return=representation" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as ApiAccount[];
  return rows[0] ?? null;
}

export async function findBySubscription(subscriptionId: string): Promise<ApiAccount | null> {
  const r = rest(
    `api_accounts?stripe_subscription_id=eq.${encodeURIComponent(subscriptionId)}&limit=1`
  );
  if (!r) return null;
  const res = await fetch(r.url, { headers: r.headers, cache: "no-store" });
  if (!res.ok) return null;
  const rows = (await res.json()) as ApiAccount[];
  return rows[0] ?? null;
}

/**
 * Issue (or reissue) the account's key and record which id is now live.
 *
 * Reissuing revokes the previous id. That is the whole point of rotation: a leaked
 * key that keeps working until it expires is not rotated, it is duplicated. The
 * revoked ids go into GRIDFORGE_REVOKED_KEYS on the engine.
 */
export async function mintForAccount(
  row: ApiAccount,
  opts: { rotate?: boolean } = {}
): Promise<{ token: string; expires: string; revoked: string[] } | null> {
  const { token, payload } = issueKey({
    account: row.account,
    quota: row.monthly_units,
    scope: "machine",
  });
  const revoked = [...(row.revoked_key_ids ?? [])];
  if (opts.rotate && row.key_id) revoked.push(row.key_id);
  await updateApiAccount(row.token, {
    key_id: payload.k,
    key_issued_at: payload.i,
    key_expires_at: payload.e,
    revoked_key_ids: revoked,
  });
  return { token, expires: payload.e, revoked };
}
