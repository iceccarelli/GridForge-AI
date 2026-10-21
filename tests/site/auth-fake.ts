/**
 * A stand-in for Supabase Auth's /auth/v1/user, layered over a PostgrestFake.
 *
 * A bearer token of the form `tok:<email>` verifies as that email; anything else
 * is a 401, like a forged or expired JWT. Everything that is not the auth
 * endpoint goes to the database fake. `authCalls` counts verifications so a test
 * can prove a route asked Supabase rather than trusting the caller.
 */
import type { PostgrestFake } from "./postgrest-fake";

export const tokenFor = (email: string) => `tok:${email}`;
export const bearerFor = (email: string) => ({ authorization: `Bearer ${tokenFor(email)}` });
/** A session whose address Supabase has NOT confirmed (no email_confirmed_at): it identifies, but cannot grant or manage a seat. */
export const unconfirmedBearerFor = (email: string) => ({ authorization: `Bearer unv:${email}` });

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
      const m = /^Bearer (tok|unv):(.+)$/.exec(h.get("authorization") ?? "");
      if (!m) return new Response("{}", { status: 401 });
      const stamp = m[1] === "tok" ? { email_confirmed_at: "2026-01-01T00:00:00Z" } : {};
      return new Response(JSON.stringify({ email: m[2], ...stamp }), { status: 200 });
    }
    return dbFetch(input, init);
  }) as typeof fetch;
  return { restore: () => { globalThis.fetch = dbFetch; }, authCalls: () => calls };
}
