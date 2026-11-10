// Server-only: the guard in front of every path that spends a shared provider credential.
//
// Two paid providers sit behind this site, each under ONE company-wide credential:
//   engine     the capacity engine, called with GRIDFORGE_API_KEY (metered units; the free /v1/qualify tier costs compute only)
//   anthropic  Anthropic, called with ANTHROPIC_API_KEY (the chat agent, lead extraction, the siting analyst)
// A visitor who needs no account and no payment can make the site call either on their behalf, so the question this module
// answers is not "did the route call a limiter" but "can any path spend without bound". It answers it in two layers, both
// backed by the ONE atomic counter in migration 0024 (gf_rate_limit_hit):
//
//   1. REQUEST level (`guardRequest`): how many times one caller may START each kind of request. Runs after the request has
//      been parsed and authorised and before any provider is touched.
//   2. PROVIDER level (`engineFetch` / `anthropicFetch`): every actual provider call, including each tool call and each SDK
//      retry inside one request, counts against a per-caller budget and a shared aggregate. The helpers that call providers
//      use these two functions instead of `fetch`, so a different route, a helper reached indirectly, or one request that
//      fans out into several calls cannot go around the budget. A provider call with no scope is refused in production.
//
// What each bucket counts, and what it protects, is in RATE_POLICIES and PROVIDER_BUDGETS below. 429 means "retry later"
// (Retry-After says when); a paid API plan over its quota is a different thing and answers 402 elsewhere.
//
// FAILS CLOSED. If the counter cannot be read (store unconfigured on a production build, migration 0024 not applied, store
// unreachable, an answer this file does not understand), the secret that pseudonymises callers is missing, or the caller's
// address cannot be established from a source the deployment trusts, the request is refused with 503 and no provider is
// called. The guard is therefore not "live" in an environment until 0024 is applied to the database it uses.
//
// IDENTITY AND PRIVACY. The counter's key is an HMAC-SHA256 of the caller's address (or, for a verified account, of its
// email) under a server-side secret. The address is never stored, logged or sent to the database, nor is any header, body,
// token, prompt or user agent. See `callerIdentity` for which header is trusted and why.
//
// IPv6 AND THE /48. A caller is identified by its /64 (the smallest block one subscriber gets). A caller holding a /48 (65,536 /64s)
// or more could otherwise take a fresh allowance from every /64 it chose to speak from. So an IPv6 caller is ALSO counted in a coarser
// bucket keyed on its /48, with a ceiling of IPV6_48_FACTOR_DEFAULT (8) times the route's own limit (override: GRIDFORGE_RATE_V6_48_FACTOR),
// and is refused when EITHER bucket is over. A normal caller (one /64, or an office on a few /64s) is stopped by its own /64 allowance
// long before it could reach the /48 ceiling; the factor only decides how many /64 allowances one /48 may use. LIMITS: this bounds a
// /48, not a /32 -- an operator holding many /48s still gets 8 allowances per /48; the shared aggregate budgets below bound the total.
// IPv4 and the "unattributed" caller are keyed exactly as before.
//
// KEY ROTATION AND RETENTION. Rows are (bucket, subject, window start) -> hits and nothing else; windows are at most one
// hour long and the function deletes rows older than a day on ~1% of calls. Changing RATE_LIMIT_HMAC_KEY (or, when that is
// unset, SUPABASE_SERVICE_ROLE_KEY, from which the key is derived) re-pseudonymises every caller: existing counters are
// orphaned and each caller starts a fresh allowance once. Nothing needs migrating, and the old pseudonyms stop matching
// anyone. Set RATE_LIMIT_HMAC_KEY (32+ characters) so rotating the database credential does not silently rotate this too.

import crypto from "node:crypto";
import net from "node:net";
import { NextResponse } from "next/server";
import { creds, rest, rpc } from "@/lib/pgrest";
import { currentSpendScope, runInSpendScope, type SpendClass, type SpendDenial, type SpendScope } from "@/lib/spend-scope";

export interface RatePolicy {
  /** Name of the counter. Stable: changing it resets everyone's allowance. */
  bucket: string;
  limit: number;
  windowSeconds: number;
}

const HOUR = 3600;

/**
 * REQUEST level. Each entry limits ONE caller (pseudonymised address) to `limit` starts of that kind of request per window.
 * A request is counted when it is admitted, after validation and authorisation, so malformed or unauthorised requests
 * never use anyone's allowance. Thresholds are operational limits, not claims made to visitors.
 */
export const RATE_POLICIES = {
  /** POST /api/power/compare, one engine solve each. 20 per 10 min: an engineer iterating on one hall; unchanged. */
  ttp_compare: { bucket: "ttp_compare", limit: 20, windowSeconds: 600 },
  /** POST /api/power/compare/save, one engine solve and one stored project each; unchanged. */
  ttp_compare_save: { bucket: "ttp_compare_save", limit: 6, windowSeconds: HOUR },
  /** POST /api/qualify, one free-tier engine call. 30 per 10 min leaves room for an office behind one address. */
  qualify: { bucket: "qualify", limit: 30, windowSeconds: 600 },
  /** POST /api/power/deploy/cases and /cases/[token]: one contingency-model solve (up to 60 s) per request. */
  deploy_case: { bucket: "deploy_case", limit: 20, windowSeconds: HOUR },
  /** The project procurement routes that call the engine (RFQ package, supplier response check, bid comparison). */
  project_rfq: { bucket: "project_rfq", limit: 30, windowSeconds: HOUR },
  /** POST /api/projects: an unauthenticated write that stores a row and an event. 30 an hour per caller address is a team setting up halls, not a loop. */
  project_create: { bucket: "project_create", limit: 30, windowSeconds: HOUR },
  /** POST /api/projects/[token]/evidence: an unauthenticated upload (up to EVIDENCE_MAX_BYTES) into the object store. */
  project_evidence: { bucket: "project_evidence", limit: 60, windowSeconds: HOUR },
  /** POST /api/projects/[token]/cost-evidence: records a supplier quotation claim (a row and an event) beside an uploaded file. 30 an hour per caller address is a buyer entering a few quotations, not a loop. */
  project_quotation: { bucket: "project_quotation", limit: 30, windowSeconds: HOUR },
  /** POST /api/intake/[token]/evidence: an upload (up to EVIDENCE_MAX_BYTES) into the object store, behind a purchase's intake token. */
  intake_evidence: { bucket: "intake_evidence", limit: 60, windowSeconds: HOUR },
  /** POST /api/chat. A scoping conversation is ~10-20 requests; each runs at most CHAT_MAX_ANTHROPIC_CALLS Anthropic calls. */
  chat: { bucket: "chat", limit: 40, windowSeconds: HOUR },
  /** POST /api/siting-analysis, per caller address (a verified subscriber is limited per account as well, below). */
  siting: { bucket: "siting", limit: 20, windowSeconds: HOUR },
  /** The same route, per VERIFIED account, so one subscriber cannot spend the analyst budget from many addresses. */
  siting_account: { bucket: "siting_account", limit: 10, windowSeconds: HOUR },
  /** Token-addressed customer work that calls the engine (intake generation, bid comparison, quotation runs, watch re-solve). */
  customer_generate: { bucket: "customer_generate", limit: 20, windowSeconds: HOUR },
  /** POST /api/team/invitations: each one queues an email to an address the owner typed. Per caller address... */
  team_invite: { bucket: "team_invite", limit: 30, windowSeconds: HOUR },
  /** ...and per VERIFIED owner account, so one owner cannot mail-bomb from many addresses. Team is 5 seats, so this is generous. */
  team_invite_account: { bucket: "team_invite_account", limit: 20, windowSeconds: HOUR },
  /** POST /api/team/invitation (preview, accept, decline): per caller address. A secret is 256 bits; this bounds noise, not guessing. */
  team_redeem: { bucket: "team_redeem", limit: 60, windowSeconds: HOUR },
  /** GET /api/orgs, /api/sites, /api/halls/...: reads of the site and hall registry (0049-0051) by a signed-in, VERIFIED member. Counted per VERIFIED ACCOUNT, not per
   *  address (`accountOnly`): an office behind one NAT must not lock itself out, and the caller has been identified before anything is counted. A page load is two. */
  registry_read: { bucket: "registry_read", limit: 600, windowSeconds: HOUR },
  /** POST/DELETE on the same routes: each writes an append-only row. 120 an hour per verified account is a team entering a hall's figures, not a loop. */
  registry_write: { bucket: "registry_write", limit: 120, windowSeconds: HOUR },
  /** POST /api/halls/[id]/diff: each run asks the engine's /v1/diff under the OPERATOR's key (2 metered units, EUR 4 at the published EUR 2 a unit), for a free verified account.
   *  Five limits stand between any of them and the operator's money, each its own bucket; a run is charged to ALL of them and a run that fails before the engine answers is
   *  given back to all of them (`refundHit`), so a failure never burns an allowance. Per VERIFIED ACCOUNT per hour (`accountOnly`, an office behind one NAT is not locked out): 3, at most EUR 12 an hour. */
  registry_diff: { bucket: "registry_diff", limit: 3, windowSeconds: HOUR },
  /** ...per verified account per day: 10, at most EUR 40 a day. */
  registry_diff_day: { bucket: "registry_diff_day", limit: 10, windowSeconds: 86400 },
  /** ...per ORGANISATION per day (keyed on the hall's organisation id, charged only after membership is known, so a stranger cannot spend it): 20, at most EUR 80 a day. Free accounts can open
   *  organisations, so this is the bound on how much one team can spend however many accounts it has. */
  registry_diff_org: { bucket: "registry_diff_org", limit: 20, windowSeconds: 86400 },
  /** ...per HALL per day: 10, at most EUR 40 a day. */
  registry_diff_hall: { bucket: "registry_diff_hall", limit: 10, windowSeconds: 86400 },
  /** ...and ONE ceiling for the whole site per day: 150 runs, at most EUR 600 a day, whoever asks. Over it the route fails CLOSED (503, "temporarily unavailable"); the operator is told by a
   *  console.error line at 50% and at 100% of it (lib/site-registry-engine-server.ts). */
  registry_diff_global: { bucket: "registry_diff_global", limit: 150, windowSeconds: 86400 },
  /** POST /api/audit: records an enquiry, mails the desk, pings Slack and may mail the address typed in the form. */
  audit: { bucket: "audit", limit: 10, windowSeconds: HOUR },
  /** POST /api/qualify/[token]/follow-up: each first request mails the desk and an address the caller typed. */
  qualify_followup: { bucket: "qualify_followup", limit: 10, windowSeconds: HOUR },
  /**
   * Not a request policy: how many messages ONE recipient address may be sent per day, from every route that mails an
   * address a visitor supplied (see `mailRecipientAllowed`). Whoever the caller is, a third party's inbox is not a free target.
   */
  mail_recipient: { bucket: "mail_recipient", limit: 3, windowSeconds: 86400 },
  /** POST /api/free-account: each one can queue an email to an address the visitor typed. 5 per hour per caller address: an office behind one address is not the use case. */
  free_account: { bucket: "free_account", limit: 5, windowSeconds: HOUR },
  /** POST /api/payg/enable and /api/payg/cap: token-addressed account changes (a Stripe session, or a key rotation). */
  payg_manage: { bucket: "payg_manage", limit: 30, windowSeconds: HOUR },
  /** POST /api/checkout: each valid request creates a Stripe Checkout Session and writes funnel rows. 60 an hour per caller address is a buyer (or an office behind one address) trying products, not a loop. */
  checkout: { bucket: "checkout", limit: 60, windowSeconds: HOUR },
  /** POST /api/keys: each one mints (and may rotate) a signed key and, for a free account, takes a place in the monthly ceiling. */
  key_mint: { bucket: "key_mint", limit: 30, windowSeconds: HOUR },
  /**
   * POST /api/admin/login: password attempts per caller address (lib/admin.ts `throttleLogin`). Counted on EVERY attempt,
   * right or wrong, before the password is compared. In the shared Postgres counter so every serverless instance sees
   * the same count; fails closed (503) when that counter cannot be read.
   */
  admin_login: { bucket: "admin_login", limit: 8, windowSeconds: 600 },
  /** POST /api/contact: records an enquiry in the leads table. 5 an hour per caller address is a person writing, or an office behind one address, not a loop. */
  contact: { bucket: "contact", limit: 5, windowSeconds: HOUR },
  /** POST /api/csp-report: browsers post a violation report per blocked resource; report-only, so it can never break a page. Bounded so it cannot be a free write path. */
  csp_report: { bucket: "csp_report", limit: 120, windowSeconds: HOUR },
  /**
   * Every Supabase access-token lookup (lib/portal.ts `identify`): one outbound /auth/v1/user call per counted hit. Counted BEFORE the call, per
   * caller address (and /48), so an unauthenticated stranger sending bearer tokens cannot make this site hammer Supabase Auth. A repeated junk token is
   * answered from a short per-instance negative cache and is not counted. 300 per 10 min: a signed-in office behind one address loading portal
   * pages (a few lookups each) is well inside it; a loop is not.
   */
  auth_lookup: { bucket: "auth_lookup", limit: 300, windowSeconds: 600 },
  /** GET /api/usage: token-addressed reads of the account's own usage; polled by the portal. */
  usage_read: { bucket: "usage_read", limit: 240, windowSeconds: HOUR },
} as const satisfies Record<string, RatePolicy>;

export type RatePolicyName = keyof typeof RATE_POLICIES;

export type Provider = "engine" | "anthropic";

/** Engine paths the engine itself serves without a key and without metering (tier "public"). Everything else is metered. */
export const FREE_ENGINE_PATHS: ReadonlySet<string> = new Set(["/v1/qualify", "/v1/estimate"]);

interface ProviderBudget {
  /** Per caller, across EVERY route: a caller cannot get a second allowance by switching route. Absent where no per-caller bound is needed. */
  caller: RatePolicy;
  /** One shared ceiling for the whole class on that provider: many callers each inside their own allowance still cannot drain the credential. */
  aggregate: RatePolicy;
}

/**
 * PROVIDER level. Each ACTUAL provider call (one fetch, so each tool call and each SDK retry) costs one unit of the
 * caller's budget and one of the aggregate. Resources are kept apart: Anthropic requests are not engine units, and the
 * free engine tier is not metered units. `engine_public` is the shared ceiling the comparison routes already used.
 *
 * Bounds that follow from the route policies (checked in tests): chat runs at most CHAT_MAX_ANTHROPIC_CALLS Anthropic
 * calls and CHAT_MAX_ENGINE_CALLS free-tier engine calls per request, so 40 requests an hour can reach at most
 * 40 x 6 = 240 Anthropic calls; the per-caller Anthropic budget is set to that product, and is the binding limit.
 */
export const PROVIDER_BUDGETS = {
  "engine:public:metered": {
    caller: { bucket: "engine_public_caller", limit: 240, windowSeconds: HOUR },
    aggregate: { bucket: "engine_public", limit: 600, windowSeconds: HOUR },
  },
  "engine:public:free": {
    caller: { bucket: "engine_public_free_caller", limit: 360, windowSeconds: HOUR },
    aggregate: { bucket: "engine_public_free", limit: 3000, windowSeconds: HOUR },
  },
  "engine:customer:metered": {
    caller: { bucket: "engine_customer_caller", limit: 120, windowSeconds: HOUR },
    aggregate: { bucket: "engine_customer", limit: 600, windowSeconds: HOUR },
  },
  "engine:customer:free": {
    caller: { bucket: "engine_customer_free_caller", limit: 360, windowSeconds: HOUR },
    aggregate: { bucket: "engine_customer_free", limit: 3000, windowSeconds: HOUR },
  },
  // The registry's engine diff has its OWN budget and its own spend class: it never draws on the customer or public buckets that paying customers' fulfilment and the free tools depend on.
  "engine:registry:metered": {
    caller: { bucket: "engine_registry_caller", limit: 6, windowSeconds: HOUR },
    aggregate: { bucket: "engine_registry", limit: 40, windowSeconds: HOUR },
  },
  "engine:registry:free": {
    caller: { bucket: "engine_registry_free_caller", limit: 30, windowSeconds: HOUR },
    aggregate: { bucket: "engine_registry_free", limit: 150, windowSeconds: HOUR },
  },
  "anthropic:public": {
    caller: { bucket: "anthropic_public_caller", limit: 240, windowSeconds: HOUR },
    aggregate: { bucket: "anthropic_public", limit: 1500, windowSeconds: HOUR },
  },
  "anthropic:customer": {
    caller: { bucket: "anthropic_customer_caller", limit: 60, windowSeconds: HOUR },
    aggregate: { bucket: "anthropic_customer", limit: 600, windowSeconds: HOUR },
  },
} as const satisfies Record<string, ProviderBudget>;

type BudgetKey = keyof typeof PROVIDER_BUDGETS;

/** Upper bounds on one chat request's provider calls (lib/ai/agent.ts rounds + lib/extract.ts), asserted in tests. */
export const CHAT_MAX_ANTHROPIC_CALLS = 6;
export const CHAT_MAX_ENGINE_CALLS = 4;

// ---------------------------------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------------------------------

function refuse503(): NextResponse {
  return NextResponse.json(
    { ok: false, error: "This service is temporarily unavailable, so nothing was run. Try again shortly." },
    { status: 503, headers: { "Cache-Control": "no-store", "Retry-After": "60" } }
  );
}

function refuse429(retryAfter: number): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: `Too many requests. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`,
      retry_after_seconds: retryAfter,
    },
    { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfter) } }
  );
}

function responseFor(d: SpendDenial): NextResponse {
  return d.status === 429 ? refuse429(d.retryAfter ?? 60) : refuse503();
}

/** What a provider helper sees when the gate refuses: an HTTP error it already knows how to handle, never a thrown surprise. */
function refusedFetch(d: SpendDenial): Response {
  return new Response(JSON.stringify({ error: "provider spend limit" }), {
    status: d.status,
    headers: {
      "content-type": "application/json",
      "x-should-retry": "false", // the Anthropic SDK must not retry (and so re-count) a refusal
      ...(d.retryAfter ? { "retry-after": String(d.retryAfter) } : {}),
    },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// Who is calling
// ---------------------------------------------------------------------------------------------------------------------

export const isProduction = () => process.env.NODE_ENV === "production";

const HEADER_NAME = /^[a-z0-9-]{1,64}$/;

/**
 * The header that carries the caller's address as set by infrastructure WE control, or null if none is declared.
 *
 *   - GRIDFORGE_TRUSTED_IP_HEADER names it explicitly (e.g. fly-client-ip, cf-connecting-ip, or x-forwarded-for behind a
 *     proxy that appends). It is the operator's statement that this header is written by their proxy.
 *   - On Vercel (VERCEL=1, set by the platform) it is x-forwarded-for: Vercel's documented contract is that it overwrites
 *     the header with the connecting address rather than forwarding a client's value (vercel.com/docs/headers/request-headers).
 *     The last entry is read regardless, so even a deployment that appended would not be spoofable by a prepended address.
 *     A CDN or proxy placed in front of Vercel makes that address the proxy's: declare its header instead.
 *   - Anywhere else a forwarding header is just something the caller typed, so none is trusted.
 */
export function trustedIpHeader(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.GRIDFORGE_TRUSTED_IP_HEADER?.trim().toLowerCase();
  if (configured) return HEADER_NAME.test(configured) ? configured : null; // a malformed declaration trusts nothing
  if (env.VERCEL === "1") return "x-forwarded-for";
  return null;
}

/** The eight 16-bit groups of an IPv6 address (zone id and an embedded IPv4 tail handled), or null if it is not one. */
function v6Groups(raw: string): number[] | null {
  let s = raw.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone); // fe80::1%eth0 is the same host as fe80::1
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const o = tail.split(".").map(Number);
    if (o.length !== 4 || o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    s = `${s.slice(0, lastColon + 1)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 ? fill !== 0 : fill < 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill("0"), ...rest].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The address in a header value, as the identity a limit is keyed on. The LAST entry is the one the nearest trusted proxy
 * appended; anything to its left is whatever the client sent, so it is never read. Not an IP -> null.
 *
 * IPv6 is bucketed by its /64: that is the smallest block an ISP hands one subscriber, so a single host (or attacker) holding
 * a /64 can mint 2^64 distinct /128 addresses and would otherwise get a fresh allowance for each. It also carries the /48 as a
 * coarser identity (`coarse`), charged by the limiters as well (see the header). An IPv4-mapped IPv6
 * address (::ffff:a.b.c.d) is the IPv4 address it wraps, so the two spellings of one host are one caller. IPv4 is unchanged.
 */
function addressIn(raw: string | null): { fine: string; coarse?: string } | null {
  if (!raw) return null;
  const last = raw.split(",").pop()?.trim() ?? "";
  if (last.length > 64 || net.isIP(last) === 0) return null;
  if (net.isIP(last) === 4) return { fine: last };
  const g = v6Groups(last);
  if (!g) return null;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return { fine: `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}` };
  return { fine: `${g.slice(0, 4).map((x) => x.toString(16)).join(":")}::/64`, coarse: `${g.slice(0, 3).map((x) => x.toString(16)).join(":")}::/48` };
}

/** The HMAC key, or null when there is none to use (production without a configured secret). */
function hmacKey(): Buffer | null {
  const dedicated = process.env.RATE_LIMIT_HMAC_KEY;
  if (dedicated && dedicated.length >= 32) return crypto.createHash("sha256").update(`gf-rate-limit-key-v2:${dedicated}`).digest();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (key) return crypto.createHash("sha256").update(`gf-rate-limit-v1:${key}`).digest();
  return isProduction() ? null : devKey;
}
const devKey = crypto.randomBytes(32); // development and tests only: a per-process secret is never used in production

function hmac(input: string): string | null {
  const key = hmacKey();
  return key ? crypto.createHmac("sha256", key).update(input).digest("hex") : null;
}

/** Pseudonym of an arbitrary label (used for the "unattributed" caller and in tests). 64 hex characters. */
export function subjectOf(label: string): string | null {
  return hmac(label);
}

/** Pseudonym of a VERIFIED account's email. Callers must pass an email from verified identity, never one the client typed. */
export function accountSubject(verifiedEmail: string): string | null {
  return hmac(`acct:${verifiedEmail.trim().toLowerCase()}`);
}

export type CallerIdentity =
  | {
      ok: true;
      subject: string;
      /** IPv6 only: the pseudonym of the caller's /48. Charged in a second, coarser bucket (see the header). Absent for IPv4 and for "unattributed". */
      coarse?: string;
    }
  | { ok: false; reason: "no_trusted_source" | "no_secret" };

/**
 * Who is calling, as a pseudonym, or why that cannot be established.
 *
 * Production with no trusted address source is REFUSED rather than grouped under a made-up identity: every caller sharing
 * one counter would be a silent denial of service on the free tools, and trusting an unverified header would let any caller
 * pick their own identity. A request that did not carry the trusted header at all (it reached the origin without passing
 * through the declared proxy) is counted under one shared "unattributed" pseudonym, so it can never evade a limit by omission.
 * In development and tests (never production) x-real-ip then x-forwarded-for are read, so tests can vary the caller.
 */
export function callerIdentity(req: Request): CallerIdentity {
  const header = trustedIpHeader();
  let address: { fine: string; coarse?: string } | null;
  if (header) {
    address = addressIn(req.headers.get(header));
  } else if (isProduction()) {
    return { ok: false, reason: "no_trusted_source" };
  } else {
    address = addressIn(req.headers.get("x-real-ip")) ?? addressIn(req.headers.get("x-forwarded-for"));
  }
  const subject = hmac(address?.fine ?? "unattributed");
  if (!subject) return { ok: false, reason: "no_secret" };
  const coarse = address?.coarse ? hmac(address.coarse) : null;
  return coarse ? { ok: true, subject, coarse } : { ok: true, subject };
}

// ---------------------------------------------------------------------------------------------------------------------
// The coarser IPv6 bucket
// ---------------------------------------------------------------------------------------------------------------------

/**
 * How many /64 allowances one IPv6 /48 may use on any IP-keyed limiter. 8: a /48 is what a site or a campus is given, and a normal
 * caller sits on ONE /64 (refused by its own allowance long before this), while an office on several VLANs still fits; a caller
 * rotating through a /48's 65,536 /64s is held to 8 allowances instead of 65,536. It trades a little for a campus whose /64s all
 * lean on one route at once (they share 8 allowances) against an unbounded multiplier. Per-policy limits are scaled, not replaced.
 */
export const IPV6_48_FACTOR_DEFAULT = 8;

/** The /48 multiplier: GRIDFORGE_RATE_V6_48_FACTOR when it is an integer from 1 to 1024, else the default. Never "off". */
export function ipv6CoarseFactor(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GRIDFORGE_RATE_V6_48_FACTOR?.trim();
  if (!raw || !/^\d{1,4}$/.test(raw)) return IPV6_48_FACTOR_DEFAULT;
  const n = Number(raw);
  return n >= 1 && n <= 1024 ? n : IPV6_48_FACTOR_DEFAULT;
}

/** The /48 counterpart of a policy: its own bucket name, the same window, `factor` times the limit (the counter accepts at most 100000). */
function coarsePolicy(policy: RatePolicy): RatePolicy {
  return { bucket: `${policy.bucket}_v6_48`, limit: Math.min(100000, policy.limit * ipv6CoarseFactor()), windowSeconds: policy.windowSeconds };
}

// ---------------------------------------------------------------------------------------------------------------------
// The counter
// ---------------------------------------------------------------------------------------------------------------------

type Hit = { allowed: boolean; retryAfter: number; /** hits in the window including this one */ count: number };

// Development and tests only (see `hit`): a per-process counter used when no store is configured outside production.
// It is NOT distributed protection and is never consulted in production.
const memory = new Map<string, { count: number; windowEnd: number }>();
export function resetMemoryLimiter(): void {
  memory.clear();
}

function memoryHit(policy: RatePolicy, subject: string, now = Date.now()): Hit {
  const key = `${policy.bucket}:${subject}`;
  const windowMs = policy.windowSeconds * 1000;
  let cur = memory.get(key);
  if (!cur || cur.windowEnd <= now) {
    cur = { count: 0, windowEnd: (Math.floor(now / windowMs) + 1) * windowMs };
    memory.set(key, cur);
  }
  cur.count += 1;
  return { allowed: cur.count <= policy.limit, retryAfter: Math.max(1, Math.ceil((cur.windowEnd - now) / 1000)), count: cur.count };
}

/** One counted hit. `null` means the counter could not be read: the caller must refuse, not run. */
async function hit(policy: RatePolicy, subject: string): Promise<Hit | null> {
  if (!creds()) {
    if (isProduction()) {
      console.error("[GridForge] rate limit: no store configured on a production build; refusing");
      return null;
    }
    return memoryHit(policy, subject);
  }
  const r = await rpc<unknown>("gf_rate_limit_hit", {
    p_bucket: policy.bucket,
    p_subject: subject,
    p_limit: policy.limit,
    p_window_seconds: policy.windowSeconds,
  });
  if (!r.ok) {
    // 404 here is "migration 0024 is not applied". The store's own log line carries the status.
    console.error(`[GridForge] rate limit: the counter is unavailable (${r.status}); refusing`);
    return null;
  }
  const d = r.data as { allowed?: unknown; hits?: unknown; retry_after_seconds?: unknown } | null;
  if (!d || typeof d.allowed !== "boolean") {
    console.error("[GridForge] rate limit: the counter answered in an unexpected form; refusing");
    return null;
  }
  const retry = typeof d.retry_after_seconds === "number" && d.retry_after_seconds >= 1 ? Math.ceil(d.retry_after_seconds) : policy.windowSeconds;
  return { allowed: d.allowed, retryAfter: retry, count: typeof d.hits === "number" ? d.hits : d.allowed ? 0 : policy.limit + 1 };
}

/**
 * One counted hit for a named policy and an already-pseudonymised subject, for callers outside this file that have their
 * own response to give (the admin login). `null` means the counter could not be read: refuse, do not proceed. `now` only
 * moves the development/test in-memory window; the Postgres counter uses the database clock.
 */
export async function countHit(name: RatePolicyName, subject: string, now?: number): Promise<{ allowed: boolean; retryAfter: number; count: number } | null> {
  return countPolicyHit(RATE_POLICIES[name], subject, now);
}

/** `countHit` for the /48 bucket of a policy (an IPv6 caller's coarse identity, `callerIdentity(...).coarse`). */
export async function countCoarseHit(name: RatePolicyName, coarseSubject: string, now?: number): Promise<{ allowed: boolean; retryAfter: number; count: number } | null> {
  return countPolicyHit(coarsePolicy(RATE_POLICIES[name]), coarseSubject, now);
}

async function countPolicyHit(policy: RatePolicy, subject: string, now?: number): Promise<{ allowed: boolean; retryAfter: number; count: number } | null> {
  if (!creds() && !isProduction()) return memoryHit(policy, subject, now);
  return hit(policy, subject);
}

/**
 * Give back one hit to a counter this request charged, because the work it was charged for did not happen (the engine was not reached, or refused). Best effort and one-directional:
 * a refund that cannot be made leaves the hit counted (the safe side), and it is never applied above zero. Against the store it is a compare-and-swap on the newest window's row
 * (`hits` must still be what was read), so a concurrent hit is never overwritten; there is no migration for it, and it needs only the same table the counter writes.
 */
export async function refundHit(name: RatePolicyName, subject: string): Promise<boolean> {
  const policy = RATE_POLICIES[name];
  if (!creds()) {
    if (isProduction()) return false;
    const key = `${policy.bucket}:${subject}`;
    const cur = memory.get(key);
    if (!cur || cur.count < 1) return false;
    cur.count -= 1;
    return true;
  }
  const where = `bucket=eq.${encodeURIComponent(policy.bucket)}&subject=eq.${encodeURIComponent(subject)}`;
  for (let attempt = 0; attempt < 12; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, Math.random() * 25));       // another request changed the row first: back off a little and read again
    const g = await rest<{ window_start: string | number; hits: number }[]>("GET", `rate_limit_windows?${where}&select=window_start,hits&order=window_start.desc&limit=1`);
    const row = g.ok ? g.data[0] : undefined;
    if (!row || !(row.hits >= 1)) return false;
    // The table requires hits >= 1, so giving back the only hit deletes the row (still conditional on `hits` being what was read).
    const match = `rate_limit_windows?${where}&window_start=eq.${encodeURIComponent(String(row.window_start))}&hits=eq.${row.hits}`;
    const p = row.hits === 1 ? await rest<unknown[]>("DELETE", match) : await rest<unknown[]>("PATCH", match, { hits: row.hits - 1 });
    if (p.ok && Array.isArray(p.data) && p.data.length > 0) return true;
  }
  return false;
}

/** Count one hit against `policy` for `subject`, translating the outcome into the denial the caller must return. */
async function charge(policy: RatePolicy, subject: string): Promise<SpendDenial | null> {
  const h = await hit(policy, subject);
  if (!h) return { status: 503, retryAfter: null };
  return h.allowed ? null : { status: 429, retryAfter: h.retryAfter };
}

/** The /48 charge for an IPv6 caller: null when there is none to charge (IPv4, unattributed) or it is within the ceiling. */
async function chargeCoarse(policy: RatePolicy, coarse: string | null | undefined): Promise<SpendDenial | null> {
  return coarse ? charge(coarsePolicy(policy), coarse) : null;
}

/**
 * May this recipient be mailed now? Counts one message against a per-recipient DAILY cap that is shared by every route that
 * mails an address a visitor supplied, so the company's mail key cannot be used to flood a third party's inbox however many
 * addresses or callers the abuser rotates through. Durable and atomic when the store is configured (the same counter as
 * every other limit; the address is pseudonymised like a caller's and never stored); in development and tests without a
 * store it is the in-memory counter. FAILS CLOSED: a counter that cannot be read means no mail (the request itself carries on).
 */
export async function mailRecipientAllowed(recipient: string): Promise<boolean> {
  const subject = hmac(`mail-recipient:${recipient.trim().toLowerCase()}`);
  if (!subject) return false;
  const denial = await charge(RATE_POLICIES.mail_recipient, subject);
  if (denial) console.error(`[GridForge] mail: not sent to a recipient (${denial.status === 429 ? "daily cap reached" : "cap counter unavailable"})`);
  return !denial;
}

// ---------------------------------------------------------------------------------------------------------------------
// Request level
// ---------------------------------------------------------------------------------------------------------------------

export interface GuardOptions {
  /** `customer` for token-addressed or subscriber work, which is metered against its own provider budget. Default `public`. */
  cls?: Exclude<SpendClass, "trusted">;
  /**
   * A VERIFIED account to limit as well as the address (never an email the client supplied). Used where identity has been
   * proven first, so one subscriber cannot multiply their allowance across addresses.
   */
  account?: { verifiedEmail: string; policy: RatePolicyName };
  /**
   * With `account`: count the verified ACCOUNT only, not the caller's address. For routes that identify the caller (a verified bearer) BEFORE
   * counting, where an address is a poor key: an office or a school behind one NAT shares it. The caller's address is still resolved (the guard
   * fails closed without one) and still scopes provider spend; it just is not charged. Ignored without `account`.
   */
  accountOnly?: boolean;
}

export type Guard =
  | { denied: NextResponse }
  | {
      denied: null;
      /**
       * Run the provider work of this request. Every engineFetch/anthropicFetch made inside, however deep, is metered against
       * this caller. If any provider call is refused the WHOLE request answers that refusal (429/503) even when a helper
       * swallowed it, so a refusal can never be reported as a different failure or followed by a half-finished success.
       */
      run<T>(fn: () => Promise<T>): Promise<T | NextResponse>;
    };

/**
 * Admit one request: identify the caller, count it against the route's policy (and the verified account's), and return the
 * scope the provider work must run in. Call it AFTER the body has been size-checked, parsed and validated and after
 * authorisation, and BEFORE any provider is touched.
 */
export async function guardRequest(req: Request, name: RatePolicyName, opts: GuardOptions = {}): Promise<Guard> {
  const who = callerIdentity(req);
  if (!who.ok) {
    console.error(`[GridForge] rate limit: caller identity unavailable (${who.reason}); refusing`);
    return { denied: refuse503() };
  }
  if (!(opts.accountOnly && opts.account)) {
    const own = await charge(RATE_POLICIES[name], who.subject);
    if (own) return { denied: responseFor(own) };
    // The caller's /48 as well (IPv6 only): rotating through the /64s of one /48 must not mint a fresh allowance each time.
    const wide = await chargeCoarse(RATE_POLICIES[name], who.coarse);
    if (wide) return { denied: responseFor(wide) };
  }

  if (opts.account) {
    const acct = accountSubject(opts.account.verifiedEmail);
    if (!acct) return { denied: refuse503() };
    const byAccount = await charge(RATE_POLICIES[opts.account.policy], acct);
    if (byAccount) return { denied: responseFor(byAccount) };
  }

  const scope: SpendScope = { cls: opts.cls ?? "public", caller: who.subject, caller48: who.coarse ?? null, denial: null };
  return {
    denied: null,
    async run<T>(fn: () => Promise<T>): Promise<T | NextResponse> {
      try {
        const out = await runInSpendScope(scope, fn);
        return scope.denial ? responseFor(scope.denial) : out;
      } catch (err) {
        if (scope.denial) return responseFor(scope.denial);
        throw err;
      }
    },
  };
}

/**
 * Count one hit of a request-level policy against the caller (its address, and its /48 for IPv6) WITHOUT a spend scope, for work that is not
 * itself a provider call but must be bounded per caller before it happens (the Supabase Auth lookup in lib/portal.ts). Same identity, same
 * fail-closed rules as `guardRequest`: the denial to answer with (429 with a Retry-After, or 503 when the counter or the caller's identity
 * cannot be established), or null to proceed.
 */
export async function admitCaller(req: Request, name: RatePolicyName): Promise<SpendDenial | null> {
  const who = callerIdentity(req);
  if (!who.ok) {
    console.error(`[GridForge] rate limit: caller identity unavailable (${who.reason}); refusing`);
    return { status: 503, retryAfter: null };
  }
  return (await charge(RATE_POLICIES[name], who.subject)) ?? (await chargeCoarse(RATE_POLICIES[name], who.coarse));
}

// ---------------------------------------------------------------------------------------------------------------------
// Provider level
// ---------------------------------------------------------------------------------------------------------------------

function budgetFor(provider: Provider, cls: Exclude<SpendClass, "trusted">, url: string): BudgetKey | null {
  if (provider === "anthropic") return cls === "registry" ? null : `anthropic:${cls}`;       // the registry's diff has no business with Anthropic: refused below
  let path = "";
  try {
    path = new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    /* an unparseable URL is treated as metered */
  }
  return `engine:${cls}:${FREE_ENGINE_PATHS.has(path) ? "free" : "metered"}`;
}

/**
 * Count one provider call, or refuse it. Returns the refusal to hand back instead of calling the provider, or null.
 * Order: the caller's own budget first, so a refused caller does not consume the shared aggregate.
 */
async function admitProviderCall(provider: Provider, url: string): Promise<SpendDenial | null> {
  const scope = currentSpendScope();
  if (!scope) {
    if (isProduction()) {
      console.error(`[GridForge] spend gate: a ${provider} call was made outside any spend scope; refusing`);
      return { status: 503, retryAfter: null };
    }
    return null; // development and tests only: the guard is exercised explicitly in tests
  }
  if (scope.cls === "trusted") return null;
  if (scope.denial) return scope.denial; // already refused in this request: do no further work and count nothing more
  if (!scope.caller) {
    scope.denial = { status: 503, retryAfter: null };
    return scope.denial;
  }
  const key = budgetFor(provider, scope.cls, url);
  if (!key) {
    scope.denial = { status: 503, retryAfter: null };
    return scope.denial;
  }
  const budget = PROVIDER_BUDGETS[key];
  const shared = subjectOf("aggregate"); // the one shared subject for a bucket's ceiling, pseudonymised like any other
  const denial = shared
    ? ((await charge(budget.caller, scope.caller)) ?? (await chargeCoarse(budget.caller, scope.caller48)) ?? (await charge(budget.aggregate, shared)))
    : ({ status: 503, retryAfter: null } as SpendDenial);
  if (denial) scope.denial = denial;
  return denial;
}

/** True when a provider call in the CURRENT request was refused by the gate, so work that would record the failure can skip it. */
export function spendRefused(): boolean {
  return Boolean(currentSpendScope()?.denial);
}

/** `fetch`, but every call is counted against the current spend scope first and refused when over budget. */
export async function providerFetch(provider: Provider, input: string | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === "string" ? input : input.href;
  const denial = await admitProviderCall(provider, url);
  if (denial) return refusedFetch(denial);
  return fetch(url, init);
}

/** For the capacity engine under the platform credential. */
export const engineFetch = (input: string | URL, init?: RequestInit) => providerFetch("engine", input, init);

/**
 * For Anthropic: the SDK's `fetch` option. Receives the SDK's own (url, init) and counts every HTTP attempt, retries
 * included.
 */
export const anthropicFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
  providerFetch("anthropic", typeof input === "string" ? input : input instanceof URL ? input : (input as Request).url, init);
