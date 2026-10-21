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
// KEY ROTATION AND RETENTION. Rows are (bucket, subject, window start) -> hits and nothing else; windows are at most one
// hour long and the function deletes rows older than a day on ~1% of calls. Changing RATE_LIMIT_HMAC_KEY (or, when that is
// unset, SUPABASE_SERVICE_ROLE_KEY, from which the key is derived) re-pseudonymises every caller: existing counters are
// orphaned and each caller starts a fresh allowance once. Nothing needs migrating, and the old pseudonyms stop matching
// anyone. Set RATE_LIMIT_HMAC_KEY (32+ characters) so rotating the database credential does not silently rotate this too.

import crypto from "node:crypto";
import net from "node:net";
import { NextResponse } from "next/server";
import { creds, rpc } from "@/lib/pgrest";
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
} as const satisfies Record<string, RatePolicy>;

export type RatePolicyName = keyof typeof RATE_POLICIES;

export type Provider = "engine" | "anthropic";

/** Engine paths the engine itself serves without a key and without metering (tier "public"). Everything else is metered. */
export const FREE_ENGINE_PATHS: ReadonlySet<string> = new Set(["/v1/qualify"]);

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

/**
 * The address in a header value. The LAST entry is the one the nearest trusted proxy appended; anything to its left is
 * whatever the client sent, so it is never read. Not an IP -> null.
 */
function addressIn(raw: string | null): string | null {
  if (!raw) return null;
  const last = raw.split(",").pop()?.trim() ?? "";
  return last.length <= 45 && net.isIP(last) !== 0 ? last : null;
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

export type CallerIdentity = { ok: true; subject: string } | { ok: false; reason: "no_trusted_source" | "no_secret" };

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
  let address: string | null;
  if (header) {
    address = addressIn(req.headers.get(header));
  } else if (isProduction()) {
    return { ok: false, reason: "no_trusted_source" };
  } else {
    address = addressIn(req.headers.get("x-real-ip")) ?? addressIn(req.headers.get("x-forwarded-for"));
  }
  const subject = hmac(address ?? "unattributed");
  return subject ? { ok: true, subject } : { ok: false, reason: "no_secret" };
}

// ---------------------------------------------------------------------------------------------------------------------
// The counter
// ---------------------------------------------------------------------------------------------------------------------

type Hit = { allowed: boolean; retryAfter: number };

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
  return { allowed: cur.count <= policy.limit, retryAfter: Math.max(1, Math.ceil((cur.windowEnd - now) / 1000)) };
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
  const d = r.data as { allowed?: unknown; retry_after_seconds?: unknown } | null;
  if (!d || typeof d.allowed !== "boolean") {
    console.error("[GridForge] rate limit: the counter answered in an unexpected form; refusing");
    return null;
  }
  const retry = typeof d.retry_after_seconds === "number" && d.retry_after_seconds >= 1 ? Math.ceil(d.retry_after_seconds) : policy.windowSeconds;
  return { allowed: d.allowed, retryAfter: retry };
}

/** Count one hit against `policy` for `subject`, translating the outcome into the denial the caller must return. */
async function charge(policy: RatePolicy, subject: string): Promise<SpendDenial | null> {
  const h = await hit(policy, subject);
  if (!h) return { status: 503, retryAfter: null };
  return h.allowed ? null : { status: 429, retryAfter: h.retryAfter };
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
  const own = await charge(RATE_POLICIES[name], who.subject);
  if (own) return { denied: responseFor(own) };

  if (opts.account) {
    const acct = accountSubject(opts.account.verifiedEmail);
    if (!acct) return { denied: refuse503() };
    const byAccount = await charge(RATE_POLICIES[opts.account.policy], acct);
    if (byAccount) return { denied: responseFor(byAccount) };
  }

  const scope: SpendScope = { cls: opts.cls ?? "public", caller: who.subject, denial: null };
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

// ---------------------------------------------------------------------------------------------------------------------
// Provider level
// ---------------------------------------------------------------------------------------------------------------------

function budgetFor(provider: Provider, cls: Exclude<SpendClass, "trusted">, url: string): BudgetKey {
  if (provider === "anthropic") return `anthropic:${cls}`;
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
  const budget = PROVIDER_BUDGETS[budgetFor(provider, scope.cls, url)];
  const shared = subjectOf("aggregate"); // the one shared subject for a bucket's ceiling, pseudonymised like any other
  const denial = shared
    ? ((await charge(budget.caller, scope.caller)) ?? (await charge(budget.aggregate, shared)))
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
