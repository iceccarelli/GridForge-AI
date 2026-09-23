// The public site's navigation — one array, imported by Navbar (desktop bar
// and mobile drawer) and Footer alike, so a route renamed or added here
// updates every surface that lists it.
//
// NAV_LINKS is the PRIMARY commercial navigation — deliberately short.
// Not every route that exists belongs in the header: /dashboard, /account,
// /account/login, /watch/*, /intake/*, /deliverable/*, /api-access/* and
// /workspace are application/customer surfaces, reached from the Client
// portal entry point rather than the main nav. /constraints and /platforms
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

export interface NavLink {
  href: string;
  label: string;
  hash?: boolean;
}

/** The primary public IA, in header order. Single source for Navbar
 *  (desktop + mobile) and the Footer's "How it works" group. */
export const NAV_LINKS: NavLink[] = [
  { href: "#services", label: "Product", hash: true },
  { href: "#technology", label: "How it works", hash: true },
  { href: "/reference", label: "Reference" },
  { href: "/developers", label: "Developers" },
  { href: "/pricing", label: "Pricing" },
];

/** The free entry point. Kept separate from NAV_LINKS because every surface
 *  treats it as a CTA (a distinct button/link with its own styling), not a
 *  plain nav item — but still one constant, not a string typed in each file. */
export const QUALIFY_LINK: NavLink = { href: "/qualify", label: "Run free capacity check" };

/** The customer/account entry point. Anonymous visitors and signed-in
 *  customers hit the same URL — /dashboard checks its own session and
 *  renders a sign-in prompt or the real engagement list, so this link
 *  never needs to know which one it's talking to. */
export const CLIENT_PORTAL_LINK: NavLink = { href: "/dashboard", label: "Client portal" };

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
      ...LADDER_PRODUCTS.map((p) => ({ href: "/pricing", label: p.name })),
      { href: "/pricing", label: "Pricing" },
    ],
  },
  {
    heading: "How it works",
    links: [
      { href: "#technology", label: "How it works", hash: true },
      { href: "/constraints", label: "Constraints" },
      { href: "/platforms", label: "Platforms" },
      { href: "/reference", label: "Reference" },
      { href: "/developers", label: "Developers / machine interface" },
    ],
  },
  {
    heading: "Customer",
    links: [
      CLIENT_PORTAL_LINK,
      { href: "/account/login", label: "Sign in" },
      { href: "/developers", label: "API access" },
    ],
  },
  {
    heading: "Company",
    links: [
      { href: "#about", label: "About", hash: true },
      { href: "#faq", label: "FAQ", hash: true },
      { href: "/legal/security", label: "Security" },
    ],
  },
];
