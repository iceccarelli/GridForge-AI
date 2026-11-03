"use client";

import type { SupabaseClient } from "@supabase/supabase-js";

// The browser Supabase client is about 47 kB transferred. A signed-out visitor to /dashboard or /account/login has no session to read and
// has asked for no sign-in yet, so the client is imported only when one of those is true: a stored session exists, the URL carries a
// sign-in redirect (the emailed link lands with tokens in the hash or a code in the query), or the visitor submits the sign-in form.

/** True when the browser holds a Supabase session, or the current URL is the return leg of a sign-in. */
export function mayHaveSession(): boolean {
  try {
    const { hash, search } = window.location;
    if (/access_token=|refresh_token=|[?&]code=|token_hash=|[?&]error_description=/.test(hash + search)) return true;
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i) ?? "";
      if (k.startsWith("sb-") && k.endsWith("-auth-token")) return true;
    }
    return false;
  } catch {
    // Storage blocked: we cannot tell, so ask the client, which is the behaviour before this optimisation.
    return true;
  }
}

/** The shared client, imported on first use. */
export async function loadSupabase(): Promise<SupabaseClient> {
  const { getSupabase } = await import("@/lib/supabase-client");
  return getSupabase();
}
