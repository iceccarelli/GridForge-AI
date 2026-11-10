// Who is actually asking, for the client portal. Server-only.
//
// The portal used to be a demo: a hardcoded password in the navbar
// (demo@gridforge.ai / demo2026) wrote `gridforge_demo` into sessionStorage, and
// /dashboard rendered invented customers, invented uptime and an invented
// "$2.9M energy savings". Nothing needed an identity because nothing shown was
// real.
//
// Showing somebody their actual engagements needs a real one. The weaker pattern
// was already in the building — /api/subscription-status takes an email out of
// the request body and answers questions about it, which means anyone can ask
// about anyone. That is a tolerable-ish leak for "does this address subscribe".
// It is not tolerable for engagements, which carry the client's company, what
// they paid, and the token that opens their engineering opinion.
//
// So the portal verifies the caller's Supabase access token with Supabase itself
// and takes the email from the answer. The caller never states who they are.

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { normaliseEmail } from "./subscribers";
import { storeFault } from "@/lib/safe-log";
import { admitCaller } from "@/lib/rate-limit";

export type Identity =
  | {
      ok: true;
      email: string;
      /**
       * Supabase has confirmed this address belongs to the person signed in (they followed the emailed link). Granting a
       * seat or managing one requires it; reading the dashboard keeps its existing, address-only rule.
       */
      verified: boolean;
    }
  | {
      ok: false;
      /** 429: the caller has used its lookup budget (see `identify`); `retryAfter` says when it resets. */
      status: 401 | 429 | 503;
      error: string;
      retryAfter?: number;
    };

/**
 * The response for a refused identity. A 401 or 503 keeps the body every route already gave ({ ok:false, ...extra, error }); a 429 is the
 * repo's standard shape (lib/rate-limit.ts): { ok:false, error:"Too many requests. Try again in N seconds.", retry_after_seconds }, with
 * Retry-After and no-store. Routes use this instead of building { error: who.error } themselves, so a 429 never loses its Retry-After.
 */
export function identityRefusal(who: Extract<Identity, { ok: false }>, extra: Record<string, unknown> = {}): NextResponse {
  if (who.status !== 429) return NextResponse.json({ ok: false, ...extra, error: who.error }, { status: who.status });
  const retryAfter = who.retryAfter ?? 60;
  return NextResponse.json(
    { ok: false, ...extra, error: who.error, retry_after_seconds: retryAfter },
    { status: 429, headers: { "Cache-Control": "no-store", "Retry-After": String(retryAfter) } }
  );
}

/**
 * Tokens Supabase Auth has just rejected, remembered by a SHA-256 of the token (the token itself is never stored) so that the same junk
 * token sent again is answered here instead of costing one outbound call each. IN MEMORY, PER INSTANCE: N server instances can each ask once
 * per window. Short on purpose (a rejected token is not going to become valid, but a clock-skewed one might within a minute or two) and
 * bounded in size, so a flood of distinct junk tokens cannot grow it without limit (the per-caller counter is what bounds the flood itself).
 */
export const IDENTITY_REJECTION_TTL_MS = 60_000;
const REJECTION_CACHE_MAX = 2000;
const rejected = new Map<string, number>(); // sha256(token) hex -> expiry (ms since epoch); Map order is insertion order

const tokenKey = (token: string) => crypto.createHash("sha256").update(token).digest("hex");

function recentlyRejected(key: string, now: number): boolean {
  const until = rejected.get(key);
  if (until === undefined) return false;
  if (until > now) return true;
  rejected.delete(key);
  return false;
}

function remember(key: string, now: number): void {
  if (rejected.size >= REJECTION_CACHE_MAX) {
    for (const [k, until] of rejected) if (until <= now) rejected.delete(k);
    // still full: drop the oldest entries (the first inserted) to make room
    for (const k of rejected.keys()) {
      if (rejected.size < REJECTION_CACHE_MAX) break;
      rejected.delete(k);
    }
  }
  rejected.set(key, now + IDENTITY_REJECTION_TTL_MS);
}

/** Test seam: forget every remembered rejection. Never called in a request path. */
export function resetIdentityCache(): void {
  rejected.clear();
}

/** Test seam: the keys held (hashes, never tokens). */
export function rejectedTokenKeys(): string[] {
  return [...rejected.keys()];
}

const SESSION_EXPIRED = "Your session has expired. Sign in again.";

/** The bearer token on a request, if it carries one. */
export function bearer(req: Request): string {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : "";
}

/**
 * Resolve a Supabase access token to a verified email address.
 *
 * Asks Supabase's own /auth/v1/user, so a forged or expired token fails at the
 * only place that can actually tell. Deliberately does NOT decode the JWT here:
 * reading the claims out of an unverified token and trusting the `email` in them
 * is the same as trusting the caller, dressed up as cryptography.
 *
 * EVERY LOOKUP COSTS AN OUTBOUND CALL TO A THIRD PARTY, and any visitor can send a bearer token, so two things stand in front of it:
 * a token Supabase rejected a moment ago is answered from a short in-memory cache (keyed on a SHA-256 of the token; per instance; see
 * above), and every other lookup is first counted against the caller's `auth_lookup` budget (lib/rate-limit.ts; the shared counter, per
 * address and per IPv6 /48) and refused with 429 when it is spent, or 503 when the counter or the caller's address cannot be established
 * (fail closed: no counter, no lookup). A valid token is never cached: its lookup, and what it returns, is unchanged.
 *
 * An unreachable auth service is a 503, never a 401. Telling a customer their
 * session is invalid because our network blipped is how somebody logs in three
 * times and then emails to ask whether they have been cancelled.
 */
export async function identify(req: Request): Promise<Identity> {
  const token = bearer(req);
  if (!token) return { ok: false, status: 401, error: "Sign in to see your engagements." };

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    return { ok: false, status: 503, error: "Sign-in is not configured on this deployment." };
  }

  const key = tokenKey(token);
  if (recentlyRejected(key, Date.now())) return { ok: false, status: 401, error: SESSION_EXPIRED };

  const denial = await admitCaller(req, "auth_lookup");
  if (denial) {
    if (denial.status === 429) {
      const retryAfter = denial.retryAfter ?? 60;
      return { ok: false, status: 429, error: `Too many requests. Try again in ${retryAfter} second${retryAfter === 1 ? "" : "s"}.`, retryAfter };
    }
    return { ok: false, status: 503, error: "Could not check your session just now." };
  }

  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/$/, "")}/auth/v1/user`, {
      headers: { apikey: anon, Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
  } catch (err) {
    console.error("[GridForge] portal identity unreachable:", err);
    return { ok: false, status: 503, error: "Could not check your session just now." };
  }

  if (res.status === 401 || res.status === 403) {
    remember(key, Date.now());
    return { ok: false, status: 401, error: SESSION_EXPIRED };
  }
  if (!res.ok) {
    console.error("[GridForge] portal identity failed:", await storeFault(res));
    return { ok: false, status: 503, error: "Could not check your session just now." };
  }

  const body = (await res.json().catch(() => ({}))) as {
    email?: string;
    email_confirmed_at?: string | null;
  };
  const email = normaliseEmail(body?.email);
  if (!email) return { ok: false, status: 401, error: "That session carries no email address." };
  return { ok: true, email, verified: Boolean(body?.email_confirmed_at) };
}
