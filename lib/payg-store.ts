// Server-only: PostgREST access for the billing modules, with an explicit `Prefer` (ignore-duplicates, return=minimal).
//
// lib/pgrest.ts `rest` always asks for return=representation; billing needs ON CONFLICT DO NOTHING semantics and conditional
// updates whose answer ("did a row match?") is the whole point. Same rules as there: never throws, a non-2xx is a failure, and a
// log line carries the status and the machine code, never a body.

import { creds, rpc, type Rest } from "@/lib/pgrest";

export { rpc };
export type { Rest };

export async function pg<T = unknown>(
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  prefer = "return=representation"
): Promise<Rest<T>> {
  const c = creds();
  if (!c) return { ok: false, status: 503, error: "store not configured" };
  try {
    const res = await fetch(`${c.url}/rest/v1/${path}`, {
      method,
      headers: method === "GET" ? c.headers : { ...c.headers, Prefer: prefer },
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
      console.error(`[GridForge] billing store ${method} ${path.split("?")[0]} -> ${res.status}${code ? ` ${code}` : ""}`);
      return { ok: false, status: res.status, error: `store ${res.status}`, code };
    }
    return { ok: true, status: res.status, data: parsed as T };
  } catch {
    console.error(`[GridForge] billing store ${method} ${path.split("?")[0]} unreachable`);
    return { ok: false, status: 502, error: "store unreachable" };
  }
}

export const enc = encodeURIComponent;
