// Server-only helpers for the founder admin dashboard: a lightweight password
// gate (single founder, internal use) and the Supabase read/update data layer.
//
// Auth model: an HMAC-signed, expiring session token (12h) in an httpOnly cookie,
// compared in constant time. This
// is a deliberate, honest "simple gate" for one operator — swap for Supabase
// Auth / Clerk when real *clients* get portal logins. Never import this file
// from a client component.

import { storeFault } from "@/lib/safe-log";
import { reviewHash } from "@/lib/deliverables";
import { RATE_POLICIES, callerIdentity, resetMemoryLimiter, countHit, countCoarseHit, isProduction, subjectOf } from "@/lib/rate-limit";
import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { SITE_URL } from "@/lib/site";

export const ADMIN_COOKIE = "gf_admin";

export function adminConfigured(): boolean {
  return !!process.env.ADMIN_PASSWORD;
}

/** Session lifetime. The cookie's maxAge in the login route matches it. */
export const ADMIN_SESSION_SECONDS = 60 * 60 * 12;

/**
 * Secret the session tokens are signed with.
 *
 * PRODUCTION (NODE_ENV=production, which Vercel also sets on previews) FAILS CLOSED: a session is minted or accepted only
 * under ADMIN_SESSION_SECRET when it is at least 32 characters and is not the admin password (nor contains it). Anything
 * else (unset, short, or equal to the password) means no session can be created and every cookie is refused, with one
 * clear error per process in the log, and the login route answers 503 naming the variable. A key derived from the
 * password would make an offline-guessable password also the cookie-forging key, and nothing would say so but a log line.
 *
 * Development and tests only: with no ADMIN_SESSION_SECRET the key is derived from ADMIN_PASSWORD by a domain-separated
 * HMAC (one warning per process), so `npm run dev` works with just a password. That convenience never applies to a
 * production build. Rotate ADMIN_SESSION_SECRET to invalidate every outstanding session at once.
 */
export const ADMIN_SECRET_MIN_LENGTH = 32;

let warnedDerivedSecret = false;
let reportedWeakSecret = false;

/** Why production would refuse to sign sessions, or null when the configured secret is acceptable. */
export function adminSessionSecretProblem(env: NodeJS.ProcessEnv = process.env): string | null {
  const secret = env.ADMIN_SESSION_SECRET;
  const pw = env.ADMIN_PASSWORD;
  if (!secret) return "ADMIN_SESSION_SECRET is not set";
  if (secret.length < ADMIN_SECRET_MIN_LENGTH) return `ADMIN_SESSION_SECRET is shorter than ${ADMIN_SECRET_MIN_LENGTH} characters`;
  if (pw && (secret === pw || secret.includes(pw))) return "ADMIN_SESSION_SECRET is (or contains) ADMIN_PASSWORD";
  return null;
}

/** True when sessions can be minted and checked: always in development, only with a distinct strong secret in production. */
export function adminSessionReady(): boolean {
  return adminConfigured() && sessionSecret() !== null;
}

function sessionSecret(): string | null {
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return null;
  if (isProduction()) {
    const problem = adminSessionSecretProblem();
    if (problem) {
      if (!reportedWeakSecret) {
        reportedWeakSecret = true;
        console.error(`[GridForge] admin: REFUSING admin sessions on a production build: ${problem}. Set ADMIN_SESSION_SECRET to a separate random value of 32+ characters (openssl rand -hex 32).`);
      }
      return null;
    }
    return process.env.ADMIN_SESSION_SECRET as string;
  }
  const dedicated = process.env.ADMIN_SESSION_SECRET;
  if (dedicated) return dedicated;
  if (!warnedDerivedSecret) {
    warnedDerivedSecret = true;
    console.warn("[GridForge] admin: ADMIN_SESSION_SECRET is not set; the session key is derived from ADMIN_PASSWORD (development only: a production build refuses). Set ADMIN_SESSION_SECRET to a separate random value (32+ characters).");
  }
  return crypto.createHmac("sha256", pw).update("gf-admin-session-key-v1").digest("hex");
}

/** Test seam: forget that the one-time warning was logged. Never called in a request path. */
export function resetAdminSecretWarning(): void {
  warnedDerivedSecret = false;
  reportedWeakSecret = false;
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

/**
 * The cookie value we set on login: `<expiryMs>.<nonce>.<hmac>`.
 *
 * It used to be an unsalted sha256(ADMIN_PASSWORD) that never expired and could
 * not be invalidated without changing the password. Now it is HMAC-signed over an
 * expiry, so it ages out on its own and is useless without the server secret.
 */
export function adminToken(now = Date.now()): string | null {
  const secret = sessionSecret();
  if (!secret) return null;
  const payload = `${now + ADMIN_SESSION_SECONDS * 1000}.${crypto.randomBytes(8).toString("hex")}`;
  return `${payload}.${sign(payload, secret)}`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Login check: does the submitted password match ADMIN_PASSWORD? */
export function checkPassword(input: string): boolean {
  const pw = process.env.ADMIN_PASSWORD;
  return !!pw && safeEqual(input, pw);
}

/**
 * A throttle on password attempts.
 *
 * ADMIN_PASSWORD is the only thing between a stranger and the lead pipeline —
 * every prospect, their site, their contracted megawatts and their score — plus
 * the button that releases a deliverable. There was nothing at all slowing an
 * attacker down, so the password's strength was the entire defence and a guess
 * cost nothing to try.
 *
 * The counter is the shared Postgres one (lib/rate-limit.ts, migration 0024, bucket `admin_login`), so every serverless
 * instance sees the same count and a cold start resets nothing. It FAILS CLOSED: if that counter cannot be read the login
 * answers 503 and compares nothing. Without a configured store the in-memory counter is used in development and tests only.
 * A long random ADMIN_PASSWORD is still the real defence; this makes a guess cost something everywhere at once.
 */
const WINDOW_MS = RATE_POLICIES.admin_login.windowSeconds * 1000;

/**
 * Who is asking, as the rate limiter's pseudonymous identity (lib/rate-limit.ts `callerIdentity`): the address comes only
 * from a header the deployment declares its own proxy writes (the LAST entry of x-forwarded-for, never the first, which a
 * client can set to anything), IPv6 is bucketed by /64, and no address is kept. When no trusted source can be established
 * every such caller shares ONE key: a guessing attacker can never pick a fresh identity by lying, at the price that they
 * can lock the single operator out for the window, which is the safe side of that trade for this gate.
 */
export function requestKey(req: Request): string {
  const who = callerIdentity(req);
  return who.ok ? who.subject : (subjectOf("admin-login:unattributed") ?? "admin-login:unattributed");
}

/** The caller's IPv6 /48 as the rate limiter's pseudonym, or null (IPv4, no trusted address). Pass it to `throttleLogin` beside `requestKey`. */
export function requestCoarseKey(req: Request): string | null {
  const who = callerIdentity(req);
  return who.ok && who.coarse ? who.coarse : null;
}

/**
 * Record an attempt. Resolves to how long to wait, in seconds, or 0 to proceed, or "unavailable" when the shared counter
 * cannot be read (the caller must refuse, not proceed).
 *
 * Counts the attempt whatever the outcome: a throttle that only counts failures lets an attacker reset it by interleaving
 * a request it will answer. `now` only moves the development/test in-memory window. With `coarseKey` (the caller's IPv6 /48,
 * `requestCoarseKey`) the attempt is also counted against that /48's ceiling, so rotating through its /64s buys no fresh guesses.
 */
export async function throttleLogin(key: string, now?: number, coarseKey?: string | null): Promise<number | "unavailable"> {
  const h = await countHit("admin_login", key, now);
  if (!h) return "unavailable";
  if (!h.allowed) return Math.max(1, Math.min(h.retryAfter, Math.ceil(WINDOW_MS / 1000)));
  if (coarseKey) {
    const wide = await countCoarseHit("admin_login", coarseKey, now);
    if (!wide) return "unavailable";
    if (!wide.allowed) return Math.max(1, Math.min(wide.retryAfter, Math.ceil(WINDOW_MS / 1000)));
  }
  return 0;
}

/** Test seam. Never called in a request path. */
export function resetLoginThrottle(): void {
  resetMemoryLimiter();
}

/**
 * Defence in depth against a cross-site write riding the admin cookie. The cookie is SameSite=Lax (a cross-site POST does
 * not carry it in current browsers), and this refuses the cases that rule does not cover: a browser that reports the request
 * as cross-site (Sec-Fetch-Site) or whose Origin is neither this deployment's host nor the configured site. A request with
 * no Origin and no Sec-Fetch-Site is not a browser form/fetch (curl, the tests, server-to-server) and cannot be CSRF'd.
 * Returns the 403 to send, or null to proceed. Call it first in every admin route that changes state.
 */
export function refuseCrossSiteWrite(req: Request): Response | null {
  const fetchSite = req.headers.get("sec-fetch-site");
  let bad = fetchSite === "cross-site";
  const origin = req.headers.get("origin");
  if (!bad && origin && origin !== "null") {
    let oh = "";
    try {
      oh = new URL(origin).host;
    } catch {
      bad = true;
    }
    if (oh) {
      const hosts = new Set<string>();
      for (const h of [req.headers.get("x-forwarded-host"), req.headers.get("host")]) {
        const last = h?.split(",").pop()?.trim();
        if (last) hosts.add(last.toLowerCase());
      }
      try {
        hosts.add(new URL(SITE_URL).host.toLowerCase());
      } catch {
        /* an unparseable SITE_URL adds nothing */
      }
      bad = !hosts.has(oh.toLowerCase());
    }
  } else if (!bad && origin === "null") {
    bad = true;
  }
  return bad ? NextResponse.json({ ok: false, error: "Cross-site request refused." }, { status: 403 }) : null;
}

/** Request check: is this cookie a validly signed, unexpired admin session? */
export function verifyAdminCookie(value: string | undefined, now = Date.now()): boolean {
  const secret = sessionSecret();
  if (!secret || !value) return false;
  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [expiry, nonce, mac] = parts;
  if (!/^\d{1,15}$/.test(expiry) || !nonce) return false;
  if (!safeEqual(mac, sign(`${expiry}.${nonce}`, secret))) return false;
  return Number(expiry) > now;
}

// --- Supabase data layer (service-role; server-only) -------------------------
export type LeadStatus =
  | "new"
  | "reviewed"
  | "call_booked"
  | "proposal"
  | "won"
  | "lost";

export interface AdminLead {
  id: string;
  created_at: string;
  name: string;
  company: string;
  email: string;
  location: string;
  capacity_mw: number | null;
  urgency: string;
  grid_status: string;
  services: string[];
  message: string;
  context: string;
  source: string;
  score: number;
  tier: "hot" | "warm" | "exploratory";
  reasons: string[];
  status: LeadStatus;
}

export const LEAD_STATUSES: LeadStatus[] = [
  "new",
  "reviewed",
  "call_booked",
  "proposal",
  "won",
  "lost",
];

function sb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  // New secret keys (sb_secret_…) are NOT JWTs and must be sent ONLY on the
  // apikey header — sending them as a Bearer token returns 401. Legacy
  // service_role JWTs need the Bearer header to elevate the Postgres role.
  const headers: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  return { url, headers };
}

export function supabaseConfigured(): boolean {
  return sb() !== null;
}

export async function fetchLeads(): Promise<AdminLead[]> {
  const c = sb();
  if (!c) return [];
  try {
    const res = await fetch(
      `${c.url}/rest/v1/leads?select=*&order=created_at.desc`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) {
      console.error("[GridForge] fetchLeads failed:", await storeFault(res));
      return [];
    }
    return (await res.json()) as AdminLead[];
  } catch (err) {
    console.error("[GridForge] fetchLeads error:", err);
    return [];
  }
}

export async function updateLeadStatus(
  id: string,
  status: LeadStatus
): Promise<boolean> {
  const c = sb();
  if (!c) return false;
  try {
    const res = await fetch(`${c.url}/rest/v1/leads?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { ...c.headers, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ status }),
    });
    return res.ok;
  } catch (err) {
    console.error("[GridForge] updateLeadStatus error:", err);
    return false;
  }
}

// --- Qualifications and purchased deliverables -------------------------------
//
// The qualifications table is the asset the physics is not. Anyone competent can
// rebuild a constraint model; nobody else is accumulating what actually binds in
// real European halls, hall by hall, with the numbers behind it.

export interface AdminQualification {
  id: string;
  created_at: string;
  site_name: string | null;
  hall_id: string | null;
  metro: string | null;
  country: string | null;
  platform: string | null;
  inputs: Record<string, number | string | null>;
  racks_as_found: number | null;
  racks_after_relief: number | null;
  binding_constraint: string | null;
  intake_completeness: number | null;
  name: string | null;
  company: string | null;
  email: string | null;
  source: string;
  status: string;
}

export interface AdminDeliverable {
  id: string;
  created_at: string;
  token: string;
  kind: string;
  status: string;
  email: string | null;
  company: string | null;
  amount_cents: number | null;
  title: string | null;
  released_at: string | null;
  has_document: boolean;
  /** sha256 of the draft's document_html: what the operator must echo back to release it. */
  document_hash: string | null;
  has_deck: boolean;
  has_working_files: boolean;
  /** A refunded or disputed purchase (migration 0045, lib/one-time-holds.ts): access is withheld until it is lifted. Absent where 0045 is not applied. */
  billing_hold?: "refunded" | "disputed" | null;
}

export async function fetchQualifications(limit = 500): Promise<AdminQualification[]> {
  const c = sb();
  if (!c) return [];
  try {
    const res = await fetch(
      `${c.url}/rest/v1/qualifications?select=*&order=created_at.desc&limit=${limit}`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) {
      console.error("[GridForge] fetchQualifications failed:", await storeFault(res));
      return [];
    }
    return (await res.json()) as AdminQualification[];
  } catch (err) {
    console.error("[GridForge] fetchQualifications error:", err);
    return [];
  }
}

export async function fetchDeliverables(limit = 200): Promise<AdminDeliverable[]> {
  const c = sb();
  if (!c) return [];
  try {
    // Deliberately does not select the document bodies: the pipeline view lists
    // engagements, it does not need to ship two megabytes of HTML to render a row.
    const cols =
      "id,created_at,token,kind,status,email,company,amount_cents,title,released_at," +
      "document_html,document_md,deck_html,working_files,intake";
    const get = (select: string) => fetch(`${c.url}/rest/v1/deliverables?select=${select}&order=created_at.desc&limit=${limit}`, { headers: c.headers, cache: "no-store" });
    // billing_hold exists from migration 0045 (applied). A failed read is an error, not a list without the holds.
    const res = await get(cols + ",billing_hold");
    if (!res.ok) {
      console.error("[GridForge] fetchDeliverables failed:", await storeFault(res));
      return [];
    }
    const rows = (await res.json()) as (AdminDeliverable & {
      document_html: string | null;
      document_md: string | null;
      deck_html: string | null;
      working_files: Record<string, string> | null;
      intake: Record<string, unknown> | null;
    })[];
    // The reviewer approves the hash shown here (what the buyer will be given: every delivered file), so it is the same
    // function the release route re-checks (reviewHash), not a second definition.
    return rows.map(({ document_html, document_md, deck_html, working_files, intake, ...r }) => ({
      ...r,
      has_document: Boolean(document_html),
      document_hash: document_html ? reviewHash({ document_html, document_md, deck_html, working_files, intake }) : null,
      has_deck: Boolean(deck_html),
      has_working_files: Boolean(working_files),
    }));
  } catch (err) {
    console.error("[GridForge] fetchDeliverables error:", err);
    return [];
  }
}

export interface ConstraintStat {
  constraint: string;
  halls: number;
  share: number;
}

export interface QualificationInsights {
  halls: number;
  withResult: number;
  constraints: ConstraintStat[];
  medianHeadroomPct: number | null;
  medianTapoffA: number | null;
  medianBuswayA: number | null;
  medianPlantSupplyC: number | null;
  blockedAsFound: number;
  metros: { metro: string; halls: number }[];
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

/** What actually binds, across every hall anyone has typed numbers into.
 *  This is the only figure in the business that gets better simply by existing. */
export function summariseQualifications(rows: AdminQualification[]): QualificationInsights {
  const scored = rows.filter((r) => r.binding_constraint);
  const counts = new Map<string, number>();
  for (const r of scored) {
    const k = r.binding_constraint as string;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const constraints: ConstraintStat[] = [...counts.entries()]
    .map(([constraint, halls]) => ({
      constraint,
      halls,
      share: scored.length ? halls / scored.length : 0,
    }))
    .sort((a, b) => b.halls - a.halls);

  const headroom: number[] = [];
  const tapoff: number[] = [];
  const busway: number[] = [];
  const plant: number[] = [];
  for (const r of rows) {
    const contracted = num(r.inputs?.contractedMW);
    const peak = num(r.inputs?.currentPeakMW);
    if (contracted && peak !== null && contracted > 0) {
      headroom.push(((contracted - peak) / contracted) * 100);
    }
    const t = num(r.inputs?.tapoffMaxA);
    if (t) tapoff.push(t);
    const b = num(r.inputs?.buswayAmpacityA);
    if (b) busway.push(b);
    const p = num(r.inputs?.plantSupplyC);
    if (p !== null) plant.push(p);
  }

  const metroCounts = new Map<string, number>();
  for (const r of rows) {
    const m = (r.metro || "").trim();
    if (m) metroCounts.set(m, (metroCounts.get(m) ?? 0) + 1);
  }

  return {
    halls: rows.length,
    withResult: scored.length,
    constraints,
    medianHeadroomPct: median(headroom),
    medianTapoffA: median(tapoff),
    medianBuswayA: median(busway),
    medianPlantSupplyC: median(plant),
    blockedAsFound: scored.filter((r) => (r.racks_as_found ?? 0) === 0).length,
    metros: [...metroCounts.entries()]
      .map(([metro, halls]) => ({ metro, halls }))
      .sort((a, b) => b.halls - a.halls)
      .slice(0, 8),
  };
}

export interface AdminWatch {
  id: string;
  created_at: string;
  token: string;
  status: string;
  cadence: string;
  email: string | null;
  company: string | null;
  site_name: string | null;
  hall_id: string | null;
  last_run_at: string | null;
  next_run_at: string | null;
  has_intake: boolean;
}

export async function fetchWatches(limit = 200): Promise<AdminWatch[]> {
  const c = sb();
  if (!c) return [];
  try {
    const cols =
      "id,created_at,token,status,cadence,email,company,site_name,hall_id," +
      "last_run_at,next_run_at,intake";
    const res = await fetch(
      `${c.url}/rest/v1/watches?select=${cols}&order=created_at.desc&limit=${limit}`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) {
      console.error("[GridForge] fetchWatches failed:", await storeFault(res));
      return [];
    }
    const rows = (await res.json()) as (AdminWatch & { intake: unknown })[];
    return rows.map(({ intake, ...r }) => ({ ...r, has_intake: Boolean(intake) }));
  } catch (err) {
    console.error("[GridForge] fetchWatches error:", err);
    return [];
  }
}


export interface AdminApiAccount {
  id: string;
  created_at: string;
  account: string;
  email: string | null;
  company: string | null;
  plan: string;
  monthly_units: number;
  status: string;
  key_id: string | null;
  key_expires_at: string | null;
  revoked_key_ids: string[] | null;
}

/**
 * Metered API accounts, for the pipeline view.
 *
 * Deliberately selects no key material, because there is none to select: the table
 * stores the id of the live key and the ids we have revoked, never a key. An admin
 * screen that could display a working credential is one screenshot away from
 * leaking it.
 */
export async function fetchApiAccounts(limit = 200): Promise<AdminApiAccount[]> {
  const c = sb();
  if (!c) return [];
  try {
    const cols =
      "id,created_at,account,email,company,plan,monthly_units,status,key_id," +
      "key_expires_at,revoked_key_ids";
    const res = await fetch(
      `${c.url}/rest/v1/api_accounts?select=${cols}&order=created_at.desc&limit=${limit}`,
      { headers: c.headers, cache: "no-store" }
    );
    if (!res.ok) {
      // The table may simply not exist yet — migration 0007. Not worth an error page.
      console.error("[GridForge] fetchApiAccounts failed:", await storeFault(res));
      return [];
    }
    return (await res.json()) as AdminApiAccount[];
  } catch (err) {
    console.error("[GridForge] fetchApiAccounts error:", err);
    return [];
  }
}

/** Keys that should be in GRIDFORGE_REVOKED_KEYS on the engine. */
export function revocationList(rows: AdminApiAccount[]): string[] {
  const out = new Set<string>();
  for (const r of rows) {
    for (const id of r.revoked_key_ids ?? []) out.add(id);
    if (r.status === "cancelled" && r.key_id) out.add(r.key_id);
  }
  return [...out].sort();
}
