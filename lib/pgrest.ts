// Server-only: the one PostgREST-over-fetch client every store module shares.
//
// It lives in its own leaf module (it imports nothing from this repository) so the rate limiter, the provider-spend gate
// and the engine helpers can use the store without importing lib/projects.ts, which imports the engine helpers.
// lib/projects.ts re-exports everything here, so existing imports keep working.

export type Fail = { ok: false; status: number; error: string };
export type Ok<T> = { ok: true } & T;
export type Result<T> = Ok<T> | Fail;

export const STORE_UNCONFIGURED: Fail = {
  ok: false,
  status: 503,
  error:
    "The project record is not available: Supabase is not configured on this deployment. " +
    "Nothing was saved.",
};

export function creds(): { url: string; headers: Record<string, string> } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  const auth: Record<string, string> = key.startsWith("sb_secret_")
    ? { apikey: key }
    : { apikey: key, Authorization: `Bearer ${key}` };
  return { url, headers: { ...auth, "Content-Type": "application/json" } };
}

export type Rest<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; code?: string };

/** One PostgREST call. Never throws: a transport failure and a non-2xx are both
 * `ok: false`, because `fetch` does not reject on 4xx/5xx and an unchecked 404 on a
 * table that does not exist is exactly how a write gets reported as saved. */
export async function rest<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<Rest<T>> {
  const c = creds();
  if (!c) return { ok: false, status: 503, error: STORE_UNCONFIGURED.error };
  try {
    const res = await fetch(`${c.url}/rest/v1/${path}`, {
      method,
      headers: method === "GET" ? c.headers : { ...c.headers, Prefer: "return=representation" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const code = (parsed as { code?: string } | null)?.code;
      console.error(`[GridForge] project store ${method} ${path.split("?")[0]} -> ${res.status}${code ? ` ${code}` : ""}`);
      return { ok: false, status: res.status, error: `store ${res.status}`, code };
    }
    return { ok: true, status: res.status, data: parsed as T };
  } catch (err) {
    console.error(`[GridForge] project store ${method} ${path.split("?")[0]} unreachable:`, err);
    return { ok: false, status: 502, error: "store unreachable" };
  }
}

/** Call one of the gf_* functions. The record and its event commit or roll back
 * together; the caller never has to compensate for half a write. */
export async function rpc<T = unknown>(name: string, args: Record<string, unknown>): Promise<Rest<T>> {
  return rest<T>("POST", `rpc/${name}`, args);
}
