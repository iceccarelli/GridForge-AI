// Response headers for the whole site, and stricter ones for the routes whose URL is itself the credential.
//
// The site sent none of these before. They are chosen to be safe without a nonce-based script policy: a full Content-Security-Policy would
// need every inline script (the JSON-LD blocks and Next's own bootstrap) to carry a per-request nonce, which is a separate change with its own
// risk of breaking checkout, so only the directives that need no nonce are ENFORCED here. A broader policy runs beside it as
// Content-Security-Policy-Report-Only (see cspReportOnly), which blocks nothing and reports to /api/csp-report.
//
// A token URL (/q/<token>, /intake/<token>, /deliverable/<token>, /watch/<token>, /p/<token>, /power/deploy/<token>) is a bearer credential. Such
// a page must not be stored by a shared cache, must not be indexed even if a crawler is handed the link, and must not leak its address in a
// Referer header to anything it links to. robots.txt and a page-level noindex already cover indexing; the header repeats it because a header
// still applies when a page fails to render its own metadata.

export interface HeaderRule {
  source: string;
  /** Next's `has`: the rule applies only to a request that carries these query keys (any value). Absent: every request to `source`. */
  has?: { type: "query"; key: string }[];
  headers: { key: string; value: string }[];
}

/**
 * API routes that take, mint or return a bearer credential (the account portal token, a newly minted API key, or a link that opens a portal)
 * without it appearing in their own path. /api/keys and /api/usage are exact patterns (Next matches that route and nothing under it);
 * /api/payg/* (enable and card return a Stripe Checkout link and set the return cookie, cap returns a newly minted key, return redirects to
 * the portal) and /api/billing/* (the Stripe billing portal link and its return) use the same ":path*" prefix style as the token pages, as do
 * the prefixes below whose own path contains the token.
 * Responses are never cached, never sent as a referrer and never indexed.
 */
export const TOKEN_API_ROUTES = [
  "/api/keys",
  "/api/usage",
  // /api/engagements answers the signed-in buyer with the document, intake and watch tokens of what they bought (documentToken, intakeToken,
  // watches[].token) in its body: the response is a credential list, so it is never cached, referred or indexed. The handler sets the same
  // headers itself (app/api/engagements/route.ts), so the route is private even where these rules are not applied.
  "/api/engagements",
  "/api/payg/:path*",
  "/api/billing/:path*",
  // The routes whose PATH carries the bearer token (app/api/<prefix>/[token]/...): a released deliverable, an intake and its evidence, a
  // project (the owner token is a credential too), a watch, a qualification's follow-up and the Power Deploy case update. Their JSON is as
  // private as the page the same link opens, so it gets the same headers. A new `[token]` route under app/api must fall under one of these:
  // tests/site/security-headers.test.ts walks app/api and fails if one does not.
  "/api/deliverable/:path*",
  "/api/intake/:path*",
  "/api/watch/:path*",
  "/api/projects/:path*",
  "/api/qualify/:path*",
  "/api/power/deploy/cases/:path*",
] as const;

/**
 * Pages whose credential is in the QUERY STRING, not the path. /commissioned?session_id=cs_... is the checkout success page: the Stripe session
 * id is the credential for it, and for an API plan or Hall Watch the page shows the portal link. /workspace?project=<token> opens a project: the
 * token is its owner/edit credential (app/workspace/WorkspaceClient.tsx reads it from the URL; the save route hands out the link). Never cached,
 * never sent as a referrer, never indexed. /workspace is a page nobody indexes (robots.txt and its own metadata say so), so it gets the headers
 * on every request.
 */
export const QUERY_TOKEN_PAGES = ["/commissioned", "/workspace"] as const;

/**
 * A PUBLIC page that also accepts a credential in its query string. /power/compare is the free Time-to-Power comparison: it is in the sitemap, the
 * navigation and llms.txt, and is cached (revalidate = 300), so it must stay cacheable and indexable as it is. But /power/compare?project=<token>
 * (ProjectPanel, EvidenceLadderCard) opens the comparison for a saved project and the token is that project's owner/edit credential. The token
 * headers therefore apply only to a request that carries the key (Next's `has`), and robots.txt closes that URL form (app/robots.ts), not the page.
 */
export const QUERY_TOKEN_WHEN_PRESENT = [{ source: "/power/compare", key: "project" }] as const;

/** The route patterns whose path contains a bearer token, then the pages whose query carries one, then the API routes that authenticate with one. */
export const TOKEN_ROUTES = [
  "/q/:token*",
  "/intake/:token*",
  "/deliverable/:token*",
  "/watch/:token*",
  "/p/:token*",
  "/power/deploy/:token*",
  "/account/invite/:token*",
  "/api-access/:token*",
  ...QUERY_TOKEN_PAGES,
  ...TOKEN_API_ROUTES,
] as const;

/** The engine the pricing page's cost estimator calls from the browser when GRIDFORGE_API_URL is not set (the same default the page uses). */
const DEFAULT_ENGINE_ORIGIN = "https://gridforge-engine.fly.dev";

/**
 * The origin of a configured URL, or null. Only a plain host is accepted: letters, digits, dots and hyphens, then an optional :port, and
 * the same must hold AFTER percent-decoding (so `a.com%3Bscript-src` is refused, not decoded into a directive). No wildcard, no user-info, no
 * IPv6 literal, no whitespace, quote, `;` or `,`. Anything else is ignored, so a setting can never add a source, a directive or break a header.
 */
function originOf(value: string | undefined): string | null {
  const m = value ? /^(https?):\/\/([^/?#]*)(?:[/?#]|$)/i.exec(value) : null;
  if (!m) return null;
  let host: string;
  try {
    host = decodeURIComponent(m[2]);
  } catch {
    return null;
  }
  const PLAIN = /^[A-Za-z0-9.-]+(?::\d{1,5})?$/;
  if (!PLAIN.test(m[2]) || !PLAIN.test(host)) return null;
  try {
    return new URL(`${m[1].toLowerCase()}://${host}`).origin;
  } catch {
    return null;
  }
}

/**
 * The Content-Security-Policy-Report-Only value. REPORT-ONLY: the browser blocks nothing and posts violations to /api/csp-report, so this is
 * how we learn what an enforced policy would break before enforcing one.
 *
 * What the site's own pages use, found by reading the code and not by guessing: first-party scripts, styles, fonts (self-hosted woff2) and
 * images; Next's inline bootstrap script and the JSON-LD blocks (hence 'unsafe-inline' for scripts and NO 'unsafe-eval' - an enforced script
 * policy needs a per-request nonce, which is a separate change); inline `style=` attributes; images.unsplash.com (next.config remotePatterns);
 * data: and blob: images (inline SVG, canvas); browser calls to the GridForge engine (the pricing cost estimator, GET /v1/estimate) and, on the
 * account sign-in page, to the Supabase auth host. Stripe Checkout is a full-page redirect, not an embed, so no Stripe script or frame is listed.
 * The engine and auth origins come from this deployment's own settings (origin only, never a path or query).
 */
export function cspReportOnly(env: Record<string, string | undefined> = process.env): string {
  const connect = new Set(["'self'", DEFAULT_ENGINE_ORIGIN]);
  for (const o of [originOf(env.GRIDFORGE_API_URL), originOf(env.NEXT_PUBLIC_SUPABASE_URL)]) if (o) connect.add(o);
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://images.unsplash.com",
    "font-src 'self' data:",
    `connect-src ${[...connect].join(" ")}`,
    "media-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "form-action 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "report-uri /api/csp-report",
  ].join("; ");
}

export const GLOBAL_HEADERS: { key: string; value: string }[] = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), usb=(), interest-cohort=()" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'self'; base-uri 'self'; object-src 'none'" },
  { key: "Content-Security-Policy-Report-Only", value: cspReportOnly() },
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
    ...QUERY_TOKEN_WHEN_PRESENT.map(({ source, key }) => ({ source, has: [{ type: "query" as const, key }], headers: TOKEN_HEADERS })),
  ];
}
