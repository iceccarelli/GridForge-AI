// Response headers for the whole site, and stricter ones for the routes whose URL is itself the credential.
//
// The site sent none of these before. They are chosen to be safe without a nonce-based script policy: a full Content-Security-Policy would
// need every inline script (the JSON-LD blocks and Next's own bootstrap) to carry a per-request nonce, which is a separate change with its own
// risk of breaking checkout, so only the directives that need no nonce are set here, and the rest is listed as outstanding in the release notes.
//
// A token URL (/q/<token>, /intake/<token>, /deliverable/<token>, /watch/<token>, /p/<token>, /power/deploy/<token>) is a bearer credential. Such
// a page must not be stored by a shared cache, must not be indexed even if a crawler is handed the link, and must not leak its address in a
// Referer header to anything it links to. robots.txt and a page-level noindex already cover indexing; the header repeats it because a header
// still applies when a page fails to render its own metadata.

export interface HeaderRule {
  source: string;
  headers: { key: string; value: string }[];
}

/**
 * API routes that take a bearer token in a header or body (and, for one more release, a query string). Their path has no token segment, so the
 * pattern is the exact route: Next matches `/api/keys` and nothing under it. Responses are never cached, never sent as a referrer and never indexed.
 */
export const TOKEN_API_ROUTES = ["/api/keys", "/api/usage"] as const;

/** The route patterns whose path contains a bearer token, then the API routes that authenticate with one. */
export const TOKEN_ROUTES = [
  "/q/:token*",
  "/intake/:token*",
  "/deliverable/:token*",
  "/watch/:token*",
  "/p/:token*",
  "/power/deploy/:token*",
  "/account/invite/:token*",
  "/api-access/:token*",
  ...TOKEN_API_ROUTES,
] as const;

export const GLOBAL_HEADERS: { key: string; value: string }[] = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), usb=(), interest-cohort=()" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'" },
];

export const TOKEN_HEADERS: { key: string; value: string }[] = [
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cache-Control", value: "private, no-store, max-age=0" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
];

export function securityHeaderRules(): HeaderRule[] {
  return [
    { source: "/:path*", headers: GLOBAL_HEADERS },
    // Later rules win for a key both define, so the token routes' Referrer-Policy replaces the global one.
    ...TOKEN_ROUTES.map((source) => ({ source, headers: TOKEN_HEADERS })),
  ];
}
