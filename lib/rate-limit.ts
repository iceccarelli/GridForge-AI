// Server-only: the guard in front of every public route that spends GRIDFORGE_API_KEY.
//
// A visitor who needs no account and no payment can still make the site call the engine with the company's
// own metered key. Without a limit, that is an open tap on the engine's units. `enforceRateLimit` is called
// BEFORE the engine, and a route that spends the platform key and does not call it is a defect.
//
// Fails closed. If the counter cannot be read -- the store is unconfigured on a production build, the
// migration (0024_rate_limit.sql) is not applied, the store is unreachable, or it answers something this file
// does not understand -- the request is refused with 503 and the engine is not called. The guard is therefore
// not "live" anywhere until 0024 is applied to that environment's database.
//
// Privacy: the counter's key is an HMAC-SHA256 of the caller's address under a server-side secret. The address
// is never stored, logged or sent to the database, and neither is a header or user agent.
//
// 429 here means "retry later". Quota exhaustion on a paid API plan is a different thing and answers 402.

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { creds, rpc } from "@/lib/projects";

export interface RatePolicy {
  /** Name of the counter. Stable: changing it resets everyone's allowance. */
  bucket: string;
  limit: number;
  windowSeconds: number;
}

/**
 * One entry per guarded route, limiting one caller. Every guarded call ALSO counts against the shared
 * ENGINE_SPEND_CEILING, which is what stops a caller who rotates addresses from draining the key.
 */
export const RATE_POLICIES = {
  ttp_compare: { bucket: "ttp_compare", limit: 20, windowSeconds: 600 },
  ttp_compare_save: { bucket: "ttp_compare_save", limit: 6, windowSeconds: 3600 },
} as const satisfies Record<string, RatePolicy>;

export type RatePolicyName = keyof typeof RATE_POLICIES;

export const ENGINE_SPEND_CEILING: RatePolicy = { bucket: "engine_public", limit: 600, windowSeconds: 3600 };

type Hit = { allowed: boolean; retryAfter: number };

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

/** The caller's address as the platform reports it. Never logged and never stored; only its HMAC leaves this file. */
export function callerAddress(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (fwd) return fwd.slice(0, 64);
  return "unknown";
}

const processSecret = crypto.randomBytes(32);

/** HMAC of an address under a key the database never sees. 64 hex characters. */
export function subjectOf(address: string): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const secret = key ? crypto.createHash("sha256").update(`gf-rate-limit-v1:${key}`).digest() : processSecret;
  return crypto.createHmac("sha256", secret).update(address).digest("hex");
}

// Development and tests only (see `hit`): a per-process counter used when no store is configured outside production.
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
    if (process.env.NODE_ENV === "production") {
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

/**
 * Call before spending the engine key. Returns a response to send (429 over the limit, 503 when the guard cannot
 * be evaluated) or `null` when the request may proceed. Order: the caller's own allowance first, so a refused
 * caller does not consume the shared ceiling.
 */
export async function enforceRateLimit(req: Request, name: RatePolicyName): Promise<NextResponse | null> {
  const policy = RATE_POLICIES[name];
  const subject = subjectOf(callerAddress(req));
  const own = await hit(policy, subject);
  if (!own) return refuse503();
  if (!own.allowed) return refuse429(own.retryAfter);
  const all = await hit(ENGINE_SPEND_CEILING, subjectOf("*"));
  if (!all) return refuse503();
  if (!all.allowed) return refuse429(all.retryAfter);
  return null;
}
