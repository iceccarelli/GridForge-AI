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

export function installWithAuth(db: PostgrestFake): { restore: () => void; authCalls: () => number } {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://stub.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test";
  const restoreDb = db.install();
  const dbFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/auth/v1/user")) {
      calls++;
      const h = new Headers(init?.headers);
      const m = /^Bearer tok:(.+)$/.exec(h.get("authorization") ?? "");
      if (!m) return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ email: m[1] }), { status: 200 });
    }
    return dbFetch(input, init);
  }) as typeof fetch;
  return { restore: () => restoreDb(), authCalls: () => calls };
}
