// The public site's navigation — one array, imported by Navbar (desktop bar
// and mobile drawer) and Footer alike, so a route renamed or added here
// updates every surface that lists it.
//
// NAV_LINKS is the PRIMARY commercial navigation — deliberately short (five links; with the "Sign in" menu the header carries six items).
// Not every route that exists belongs in the header: /dashboard, /account,
// /account/login, /watch/*, /intake/*, /deliverable/*, /api-access/* and
// /workspace are application/customer surfaces, reached from the Client
// portal entry point rather than the main nav (the footer's "Customer" group
// links /workspace, noindexed, so the project journey has an entry that is
// not hidden behind a chat panel). /power/compare and /power/deploy are the
// two free power tools; both are in the footer's "How it works" group.
// /constraints and /platforms
// are real technical-trust content but sit one click deeper, in the footer's
// "How it works" group, so the header stays to five items a visitor can scan
// in one glance: brand → product discovery → technical trust → purchase →
// account.
//
// `hash: true` marks an in-page anchor on "/" (e.g. "#services") rather than
// a route — Navbar resolves these with its own scrollTo(), Footer links them
// as plain <Link>s (Next.js follows a hash link to "/" then the browser's
// native anchor scroll takes over).

import { LADDER_PRODUCTS } from "@/lib/products";
import { PRODUCT_PAGES } from "@/lib/product-pages";

export interface NavLink {
  href: string;
  label: string;
  hash?: boolean;
}

/** The primary public IA, in header order. Single source for Navbar
 *  (desktop + mobile) and the Footer's "How it works" group. */
export const NAV_LINKS: NavLink[] = [
  { href: "/products", label: "Product" },
  { href: "#technology", label: "How it works", hash: true },
  { href: "/reference", label: "Reference" },
  { href: "/developers", label: "API and MCP" },
  { href: "/pricing", label: "Pricing" },
];

/** The free entry point. Kept separate from NAV_LINKS because every surface
 *  treats it as a CTA (a distinct button/link with its own styling), not a
 *  plain nav item — but still one constant, not a string typed in each file. */
export const QUALIFY_LINK: NavLink = { href: "/qualify", label: "Try the free capacity check" };

/** Asks the scoping assistant (components/ScopingAgent.tsx) to open. Below lg the floating launcher is not drawn; the mobile menu sends this. */
export const OPEN_SCOPING_AGENT_EVENT = "gridforge:open-scoping-agent";

/** Routes on which the scoping assistant is not offered at all: the full workspace IS that conversation, and the Observatory is a demonstration
 *  with nothing on it that leads to a sale. One list, read by the launcher (components/ScopingAgent.tsx) and by the mobile menu's entry. */
export const NO_SCOPING_AGENT_ON = ["/workspace", "/observatory"];

export function scopingAgentAvailable(pathname: string | null | undefined): boolean {
  return !(pathname && NO_SCOPING_AGENT_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`)));
}

/** The id of the mobile menu's button: the element focus returns to when the assistant closes on a screen where its launcher is not drawn. */
export const MOBILE_MENU_BUTTON_ID = "main-menu-toggle";

/** The routes on which no paid call to action may be drawn by the site's chrome (header, footer, sticky bar): they are demonstrations, and
 *  the page's own calm call to action is the free check. components/StickyMobileCTA.tsx hides itself on the same routes. */
export const NO_PAID_CTA_ON = ["/observatory"];

export function paidCtaAllowed(pathname: string | null | undefined): boolean {
  return !(pathname && NO_PAID_CTA_ON.some((p) => pathname === p || pathname.startsWith(`${p}/`)));
}

/** The customer/account entry point. Anonymous visitors and signed-in
 *  customers hit the same URL — /dashboard checks its own session and
 *  renders a sign-in prompt or the real engagement list, so this link
 *  never needs to know which one it's talking to. */
export const CLIENT_PORTAL_LINK: NavLink = { href: "/dashboard", label: "Client portal" };

/**
 * Every way to sign in, labelled by what it opens. They are two different places with two different sign-ins, and neither destination
 * changes here: the client portal (/dashboard) lists the engagements and deliverables bought with a card; the Intelligence account
 * (/account, reached through /account/login) is the subscription and siting dashboard. The header groups them in one "Sign in" menu and
 * the footer's Customer group uses the same labels, so one place cannot call a thing "dashboard" and another "portal".
 */
export const SIGN_IN_LABEL = "Sign in";
export const SIGN_IN_LINKS: (NavLink & { note: string })[] = [
  { ...CLIENT_PORTAL_LINK, note: "Your paid engagements and their deliverables." },
  { href: "/account/login", label: "Intelligence account", note: "Subscription and siting dashboard. An emailed sign-in link, no password." },
];

/**
 * Footer navigation, grouped by what a visitor is actually trying to do —
 * not a dump of NAV_LINKS into a column. Product names and the "real
 * catalogue price" destination are derived from lib/products.ts so a
 * renamed or repriced engagement can't drift from what the footer says is
 * for sale; every group links only to routes that exist in app/.
 */
export interface FooterGroup {
  heading: string;
  links: NavLink[];
}

export const FOOTER_GROUPS: FooterGroup[] = [
  {
    heading: "Product",
    links: [
      ...LADDER_PRODUCTS.map((p) => {
        const page = PRODUCT_PAGES.find((x) => x.productId === p.id);
        return { href: page ? `/products/${page.slug}` : "/pricing", label: p.name };
      }),
      { href: "/products", label: "All engagements" },
      { href: "/pricing", label: "Pricing" },
    ],
  },
  {
    heading: "How it works",
    links: [
      { href: "/power/compare", label: "Time-to-Power comparison" },
      { href: "/power/deploy", label: "Behind-the-meter power assessment" },
      { href: "/constraints", label: "Constraints" },
      { href: "/platforms", label: "Rack library" },
      { href: "/reference", label: "Reference" },
      { href: "/evidence", label: "Evidence classes" },
      { href: "/lead-times", label: "Lead times" },
      { href: "/observatory", label: "Observatory" },
      { href: "/intelligence", label: "Intelligence" },
      { href: "/developers", label: "API and MCP (machine interface)" },
    ],
  },
  {
    heading: "Customer",
    links: [
      { href: CLIENT_PORTAL_LINK.href, label: `${SIGN_IN_LABEL}: ${CLIENT_PORTAL_LINK.label}` },
      { href: "/workspace", label: "Project workspace" },
      { href: SIGN_IN_LINKS[1].href, label: `${SIGN_IN_LABEL}: ${SIGN_IN_LINKS[1].label}` },
      { href: "/developers", label: "API access" },
    ],
  },
  {
    heading: "Company",
    links: [
      { href: "/about", label: "About" },
      { href: "/contact", label: "Contact" },
      { href: "/for", label: "Who it is for" },
      { href: "/guides/nameplate-vs-useful-compute", label: "Guide: nameplate vs useful compute" },
      { href: "/guides/retrofit-order-of-limits", label: "Guide: the order of limits in a retrofit" },
      { href: "#faq", label: "FAQ", hash: true },
      { href: "/legal/security", label: "Security" },
    ],
  },
];
