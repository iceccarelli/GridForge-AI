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

import { normaliseEmail } from "./subscribers";

export type Identity =
  | { ok: true; email: string }
  | { ok: false; status: 401 | 503; error: string };

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
    return { ok: false, status: 401, error: "Your session has expired. Sign in again." };
  }
  if (!res.ok) {
    console.error("[GridForge] portal identity failed:", res.status, await res.text());
    return { ok: false, status: 503, error: "Could not check your session just now." };
  }

  const body = (await res.json().catch(() => ({}))) as { email?: string };
  const email = normaliseEmail(body?.email);
  if (!email) return { ok: false, status: 401, error: "That session carries no email address." };
  return { ok: true, email };
}
