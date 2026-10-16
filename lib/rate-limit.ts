// Server-only: the request guard in front of the public engine proxies.
//
// POST /api/power/compare and POST /api/power/deploy/cases are free, need no token, and call the capacity engine with
// the SITE's platform key (GRIDFORGE_API_KEY): every call spends metered engine units that belong to the business, not
// to the caller. This guard bounds that spend per caller and per route before the engine is asked.
//
// What makes it a real control rather than a gesture:
//   * The counter is in the database every instance shares (migration 0025_rate_limits.sql), incremented by ONE
//     atomic UPSERT (gf_rate_limit_hit). Serverless instances, cold starts and concurrent requests all see the same
//     row; a counter in process memory would see only its own instance and would reset on every cold start, so none
//     is used here, not even as a fallback.
//   * Caller identity comes only from a header the hosting platform is documented to set and overwrite. On Vercel that
//     is `x-vercel-forwarded-for` / `x-real-ip`: Vercel writes the client's public IP into them and does not forward
//     an external `X-Forwarded-For` ("to prevent IP spoofing", vercel.com/docs/headers/request-headers). Off Vercel a
//     caller-supplied forwarding header is never trusted; an operator who runs the site behind their own proxy names
//     the header that proxy sets (GF_TRUSTED_IP_HEADER; for a list, only its last element counts), and without one
//     every caller shares a single bucket. That bounds the engine spend but makes the free tool effectively one
//     person's worth of capacity for the whole world: do not deploy off Vercel without naming a trusted header.
//     Addresses are canonicalised (IPv4-mapped IPv6 -> IPv4, IPv6 -> its /64) so a caller cannot mint buckets.
//   * No IP address is stored or logged. The bucket is a keyed digest (HMAC-SHA256) of the IP, truncated; the key is
//     GF_RATE_LIMIT_KEY, or, absent that, derived from the service-role key. Rotating the key only resets the current
//     windows: callers start fresh, nothing else changes.
//   * It fails CLOSED. No store, a store error, a timeout or an unusable identity answers 503 with a reason code and
//     calls no engine. The only bypass is GF_RATE_LIMIT_DEV_BYPASS=1, honoured solely outside a production runtime
//     (NODE_ENV/VERCEL_ENV), logged on every request it lets through, and ignored in production.
//
// Limits are fixed windows, per caller and per route overall, overridable per route as "<hits>/<seconds>".

import crypto from "node:crypto";
import net from "node:net";
import { NextResponse } from "next/server";
import { isProductionRuntime } from "@/lib/power-deploy";
import { creds } from "@/lib/projects";
import { storeFault } from "@/lib/safe-log";

export interface RateLimitPolicy {
  /** Route label; part of every bucket name. */
  route: "compare" | "deploy";
  /** Per caller: hits per window. */
  caller: { limit: number; windowSeconds: number };
  /** Route-wide ceiling across every caller: the engine's real exposure. */
  all: { limit: number; windowSeconds: number };
}

export type HitResult =
  | { ok: true; allowed: boolean; remaining: number; limit: number; window_seconds: number; retry_after_seconds: number }
  | { ok: false; reason: "unconfigured" | "unavailable" | "timeout" | "malformed_answer" };

/** The one operation a backend provides. Injected in tests; the production backend is the database function. */
export interface RateLimiter {
  hit(bucket: string, limit: number, windowSeconds: number): Promise<HitResult>;
}

export type Identity =
  | { kind: "ip"; bucket: string }
  | { kind: "shared" }
  | { kind: "missing" }
  | { kind: "malformed" };

const MAX_WINDOW_SECONDS = 86_400;

function parseLimit(raw: string | undefined, fallback: { limit: number; windowSeconds: number }) {
  const m = /^(\d{1,6})\/(\d{1,7})$/.exec((raw ?? "").trim());
  if (!m) return fallback;
  const limit = Number(m[1]);
  const windowSeconds = Number(m[2]);
  // Windows are capped at a day: the database sweeps rows older than two days, so a longer window could be swept early.
  return limit >= 1 && windowSeconds >= 1 && windowSeconds <= MAX_WINDOW_SECONDS ? { limit, windowSeconds } : fallback;
}

/** The limits as deployed. Defaults are deliberately generous for a person and tight for a loop. */
export function policyFor(route: RateLimitPolicy["route"]): RateLimitPolicy {
  const env = process.env;
  if (route === "compare") {
    return {
      route,
      caller: parseLimit(env.GF_RATE_LIMIT_COMPARE, { limit: 20, windowSeconds: 600 }),
      all: parseLimit(env.GF_RATE_LIMIT_COMPARE_ALL, { limit: 300, windowSeconds: 600 }),
    };
  }
  return {
    route,
    caller: parseLimit(env.GF_RATE_LIMIT_DEPLOY, { limit: 10, windowSeconds: 600 }),
    all: parseLimit(env.GF_RATE_LIMIT_DEPLOY_ALL, { limit: 120, windowSeconds: 600 }),
  };
}

/**
 * The canonical form a caller is counted under, or null when the text is not an address we will count.
 *   IPv4                     as is.
 *   IPv4-mapped IPv6         the IPv4 address (::ffff:203.0.113.7 and 203.0.113.7 are one caller).
 *   IPv6                     its /64 prefix, lower-case, expanded: a single subscriber is routinely handed a whole /64,
 *                            so counting per full address would hand an attacker 2^64 buckets and no limit at all.
 *   anything with a zone id  refused (fe80::1%eth0 names an interface, not a client).
 */
export function canonicalAddress(raw: string): string | null {
  let ip = raw.trim();
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  if (!ip || ip.includes("%") || !net.isIP(ip)) return null;
  if (net.isIPv4(ip)) return ip;
  const lower = ip.toLowerCase();
  const mapped = /^(?:0{0,4}:){0,5}:?(?:0{0,4}:)?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower) ?? /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (mapped && net.isIPv4(mapped[1])) return mapped[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16), lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  // Expand "::" to a full eight-group form, then keep the first four groups (the /64).
  const [head, tail = ""] = lower.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = lower.includes("::") ? [...h, ...Array(8 - h.length - t.length).fill("0"), ...t] : h;
  if (groups.length !== 8) return null;
  return "v6/64:" + groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "").padStart(4, "0")).join(":");
}

/**
 * Who is asking, from a source the deployment vouches for. Never a caller-supplied `X-Forwarded-For`.
 *   Vercel (VERCEL=1):            x-vercel-forwarded-for, else x-real-ip -- platform-written, a single address.
 *   GF_TRUSTED_IP_HEADER=<name>:  the header the operator's own proxy sets. If it is a list (an appending
 *                                 X-Forwarded-For), the LAST element is the one the nearest trusted proxy observed;
 *                                 every element before it was supplied by the client or an earlier hop and is ignored.
 *   otherwise:                    no trusted source -> one shared bucket for every caller.
 */
export function callerIdentity(req: Request): Identity {
  let raw: string | null = null;
  let trusted = false;
  if (process.env.VERCEL === "1") {
    raw = req.headers.get("x-vercel-forwarded-for") ?? req.headers.get("x-real-ip");
    trusted = true;
  } else if (process.env.GF_TRUSTED_IP_HEADER) {
    raw = req.headers.get(process.env.GF_TRUSTED_IP_HEADER.toLowerCase());
    trusted = true;
  }
  if (!trusted) return { kind: "shared" };
  if (raw === null || raw.trim() === "") return { kind: "missing" };
  const parts = raw.split(",");
  const addr = canonicalAddress(parts[parts.length - 1]);
  if (addr === null) return { kind: "malformed" };
  return { kind: "ip", bucket: ipBucket(addr) };
}

function bucketKey(): Buffer | null {
  const explicit = process.env.GF_RATE_LIMIT_KEY;
  if (explicit) return Buffer.from(explicit, "utf8");
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!svc) return null;
  return crypto.createHmac("sha256", svc).update("gridforge/rate-limit/1").digest();
}

/** A stable pseudonym for an address: HMAC-SHA256 under the deployment's key, truncated. Not reversible, not logged. */
export function ipBucket(ip: string): string {
  const key = bucketKey();
  if (!key) return "nokey";          // never reached when a store is configured: creds() requires the service key
  return crypto.createHmac("sha256", key).update(ip).digest("hex").slice(0, 32);
}

const HIT_TIMEOUT_MS = 3_000;

/** The production backend: gf_rate_limit_hit through PostgREST, with a hard timeout. */
export const supabaseLimiter: RateLimiter = {
  async hit(bucket, limit, windowSeconds) {
    const c = creds();
    if (!c) return { ok: false, reason: "unconfigured" };
    try {
      const res = await fetch(`${c.url}/rest/v1/rpc/gf_rate_limit_hit`, {
        method: "POST",
        headers: c.headers,
        body: JSON.stringify({ p_bucket: bucket, p_limit: limit, p_window_seconds: windowSeconds }),
        signal: AbortSignal.timeout(HIT_TIMEOUT_MS),
        cache: "no-store",
      });
      if (!res.ok) {
        console.error("[GridForge] rate limiter store refused the hit:", await storeFault(res));
        return { ok: false, reason: "unavailable" };
      }
      const d = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!d || typeof d.allowed !== "boolean" || typeof d.retry_after_seconds !== "number") {
        console.error("[GridForge] rate limiter store answered in an unexpected shape");
        return { ok: false, reason: "malformed_answer" };
      }
      return {
        ok: true,
        allowed: d.allowed,
        remaining: Number(d.remaining ?? 0),
        limit: Number(d.limit ?? limit),
        window_seconds: Number(d.window_seconds ?? windowSeconds),
        retry_after_seconds: Math.max(1, Math.ceil(d.retry_after_seconds)),
      };
    } catch (err) {
      const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
      console.error(timeout ? "[GridForge] rate limiter store timed out" : "[GridForge] rate limiter store unreachable");
      return { ok: false, reason: timeout ? "timeout" : "unavailable" };
    }
  },
};

export type DenyCode = "rate_limited" | "rate_limiter_unavailable" | "rate_limiter_unconfigured" | "caller_identity_unavailable";

export type Verdict =
  | { ok: true; headers: Record<string, string>; bypassed: boolean }
  | { ok: false; response: NextResponse; code: DenyCode };

const NO_STORE = { "Cache-Control": "no-store" };
let warnedBypass = false;

function unavailable(code: Exclude<DenyCode, "rate_limited">, retryAfter = 5): Verdict {
  // Said plainly, with a machine-readable reason and no internals: the free tool is paused, nothing was computed.
  return {
    ok: false,
    code,
    response: NextResponse.json(
      { ok: false, error: "This free tool is temporarily unavailable. Nothing was computed; please try again shortly.", code },
      { status: 503, headers: { ...NO_STORE, "Retry-After": String(retryAfter) } }
    ),
  };
}

/**
 * Decide before the engine is asked. Both counters must admit the request: the caller's own first (a caller over its
 * limit cannot consume route-wide seats), then the route-wide ceiling. A refusal is 429 with Retry-After and a stable
 * body; a guard that cannot decide is 503, never a pass. A seat taken from one counter and then refused by the next is
 * not given back: the guard errs towards counting.
 */
export async function enforceRateLimit(
  req: Request,
  policy: RateLimitPolicy,
  limiter: RateLimiter = supabaseLimiter
): Promise<Verdict> {
  if (!creds()) {
    if (!isProductionRuntime() && process.env.GF_RATE_LIMIT_DEV_BYPASS === "1") {
      if (!warnedBypass) {
        console.warn("[GridForge] rate limiting BYPASSED: GF_RATE_LIMIT_DEV_BYPASS=1 outside a production runtime");
        warnedBypass = true;
      }
      return { ok: true, headers: {}, bypassed: true };
    }
    return unavailable("rate_limiter_unconfigured");
  }
  const who = callerIdentity(req);
  if (who.kind === "missing" || who.kind === "malformed") {
    console.error("[GridForge] rate limiter: caller identity %s under the trusted-proxy policy", who.kind);
    return unavailable("caller_identity_unavailable");
  }
  // The caller's own counter first. A caller already over its limit is refused WITHOUT touching the route-wide ceiling,
  // so a single address cannot drain the seats everybody else shares by sending requests it knows will be refused.
  const checks: { scope: "all" | "caller"; bucket: string; limit: number; windowSeconds: number }[] = [
    { scope: "caller", bucket: who.kind === "ip" ? `${policy.route}:ip:${who.bucket}` : `${policy.route}:shared`, ...policy.caller },
    { scope: "all", bucket: `${policy.route}:all`, ...policy.all },
  ];
  let remaining = Number.POSITIVE_INFINITY;
  for (const c of checks) {
    const r = await limiter.hit(c.bucket, c.limit, c.windowSeconds);
    if (!r.ok) return unavailable(r.reason === "unconfigured" ? "rate_limiter_unconfigured" : "rate_limiter_unavailable");
    if (!r.allowed) {
      return {
        ok: false,
        code: "rate_limited",
        response: NextResponse.json(
          {
            ok: false,
            error:
              c.scope === "caller"
                ? `Too many requests from this connection in a short time. Try again in ${r.retry_after_seconds} seconds.`
                : `This free tool is busy right now. Try again in ${r.retry_after_seconds} seconds.`,
            code: "rate_limited",
            scope: c.scope,
            limit: r.limit,
            window_seconds: r.window_seconds,
            retry_after_seconds: r.retry_after_seconds,
          },
          {
            status: 429,
            headers: {
              ...NO_STORE,
              "Retry-After": String(r.retry_after_seconds),
              "RateLimit-Limit": String(r.limit),
              "RateLimit-Remaining": "0",
              "RateLimit-Reset": String(r.retry_after_seconds),
            },
          }
        ),
      };
    }
    remaining = Math.min(remaining, r.remaining);
  }
  return {
    ok: true,
    bypassed: false,
    headers: Number.isFinite(remaining) ? { "RateLimit-Remaining": String(remaining) } : {},
  };
}
