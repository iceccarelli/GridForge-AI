// Server-only: how a request presents the account portal token.
//
// The portal token reads an account's email and company and, with POST /api/keys, mints or rotates a live API key. It is a bearer credential,
// so it belongs in the Authorization header (or a POST body), never in a URL: a URL lands in access logs, browser history, proxies and
// Referer headers. The query form is kept for ONE release so a caller that already uses it does not break; its response is marked
// `Deprecation: true` and one log line says so, without the token. Remove `fromQuery` (and the query branch below) in the next release.

/** The token from `Authorization: Bearer <token>`, or "" when the header is absent or is not a Bearer credential. */
export function bearerToken(req: Request): string {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "");
  return m ? m[1] : "";
}

/**
 * The token for a GET. A request that sends an Authorization header is read from it alone: the query is consulted only when there is NO such
 * header, so a stale link cannot override a caller's explicit credential. `deprecatedQuery` is true when the token came from the URL.
 */
export function tokenForRead(req: Request): { token: string; deprecatedQuery: boolean } {
  if (req.headers.has("authorization")) return { token: bearerToken(req), deprecatedQuery: false };
  const q = new URL(req.url).searchParams.get("token") || "";
  return { token: q, deprecatedQuery: q !== "" };
}

/**
 * Finish a response from a token route: never cached (it carries an account's address and company, or a key), and, when the token was
 * presented in the URL, marked deprecated. `route` is a fixed route name chosen by the caller, never request data.
 */
export function sealPortalResponse<T extends Response>(res: T, route: "/api/keys" | "/api/usage", deprecatedQuery = false): T {
  res.headers.set("Cache-Control", "no-store");
  if (deprecatedQuery) {
    res.headers.set("Deprecation", "true");
    console.warn(`[GridForge] deprecated: ${route} was called with the portal credential in the query string; send it in the Authorization header`);
  }
  return res;
}
