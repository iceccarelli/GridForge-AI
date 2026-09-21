// The public site's navigation — one array, imported by Navbar (desktop bar
// and mobile drawer) and Footer alike, so a route renamed or added here
// updates every surface that lists it. Before this file, Navbar and Footer
// each hand-typed their own link list and had already drifted: Footer was
// missing /reference, /constraints, /platforms and /developers entirely, and
// neither listed /workspace.
//
// `hash: true` marks an in-page anchor on "/" (e.g. "#services") rather than
// a route — Navbar resolves these with its own scrollTo(), Footer links them
// as plain <Link>s (Next.js follows a hash link to "/" then the browser's
// native anchor scroll takes over).

export interface NavLink {
  href: string;
  label: string;
  hash?: boolean;
}

/** The public IA, in header order. Single source of truth for Navbar and
 *  Footer — see the module comment above. */
export const NAV_LINKS: NavLink[] = [
  { href: "#services", label: "Product", hash: true },
  { href: "#technology", label: "How it works", hash: true },
  { href: "/reference", label: "Reference" },
  { href: "/constraints", label: "Constraints" },
  { href: "/platforms", label: "Platforms" },
  { href: "/developers", label: "Developers" },
  { href: "/workspace", label: "Workspace" },
  { href: "/pricing", label: "Pricing" },
];

/** The free entry point. Kept separate from NAV_LINKS because every surface
 *  treats it as a CTA (a distinct button/link with its own styling), not a
 *  plain nav item — but still one constant, not a string typed in each file. */
export const QUALIFY_LINK: NavLink = { href: "/qualify", label: "Run free capacity check" };
