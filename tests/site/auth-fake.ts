/**
 * A stand-in for Supabase Auth's /auth/v1/user, layered over a PostgrestFake.
 *
 * A JWT-shaped bearer (three base64url segments, a JSON payload with a future `exp`, the email in the payload) verifies as that email; anything else
 * is a 401, like a forged or expired JWT. The SHAPE matters: lib/portal.ts refuses locally, without asking Supabase and without spending the caller's
 * lookup budget, any bearer that cannot be a Supabase access token. Everything that is not the auth
 * endpoint goes to the database fake. `authCalls` counts verifications so a test
 * can prove a route asked Supabase rather than trusting the caller.
 */
import type { PostgrestFake } from "./postgrest-fake";

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const FAR_FUTURE = 4102444800; // 2100-01-01, seconds

/** A JWT-shaped access token for `email` (placeholder signature: this fake is its only verifier, as Supabase is in production). */
export function jwtFor(email: string, opts: { confirmed?: boolean; exp?: number; nonce?: string } = {}): string {
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ email, confirmed: opts.confirmed !== false, exp: opts.exp ?? FAR_FUTURE, ...(opts.nonce ? { jti: opts.nonce } : {}) })}.${Buffer.from("stand-in").toString("base64url")}`;
}
/** JWT-shaped junk: well-formed, a FUTURE exp, but not a token this fake issued (the fake answers 401). It cannot be told from a real token without asking. */
export const junkJwt = (nonce: string | number) => `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: `junk-${nonce}`, exp: FAR_FUTURE })}.${Buffer.from("x").toString("base64url")}`;

export const tokenFor = (email: string) => jwtFor(email);
export const bearerFor = (email: string) => ({ authorization: `Bearer ${tokenFor(email)}` });
/** A session whose address Supabase has NOT confirmed (no email_confirmed_at): it identifies, but cannot grant or manage a seat. */
export const unconfirmedBearerFor = (email: string) => ({ authorization: `Bearer ${jwtFor(email, { confirmed: false })}` });

export function installWithAuth(db: PostgrestFake): { restore: () => void; authCalls: () => number } {
  const restoreDb = db.install();
  const auth = installAuth();
  return { restore: () => { auth.restore(); restoreDb(); }, authCalls: auth.authCalls };
}

/** Only the auth endpoint, layered over whatever fetch is installed now (a database fake, or a gateway to a real one). */
export function installAuth(): { restore: () => void; authCalls: () => number } {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test";
  const dbFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/v1/user")) {
      calls++;
      const h = new Headers(init?.headers);
      let who: { email?: string; confirmed?: boolean } | null = null;
      try {
        who = JSON.parse(Buffer.from((/^Bearer ([^.]+)\.([^.]+)\.([^.]+)$/.exec(h.get("authorization") ?? "")?.[2]) ?? "", "base64url").toString("utf8"));
      } catch { /* not ours */ }
      if (!who || typeof who.email !== "string") return new Response("{}", { status: 401 });
      const stamp = who.confirmed !== false ? { email_confirmed_at: "2026-01-01T00:00:00Z" } : {};
      return new Response(JSON.stringify({ email: who.email, ...stamp }), { status: 200 });
    }
    return dbFetch(input, init);
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = dbFetch; }, authCalls: () => calls };
}
