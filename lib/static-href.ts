// A link to a FILE in public/ (a sample .html or .md, a .json pack) is not a Next route. next/link would prefetch it as a route
// (`GET /reference/x.html?_rsc=...`), which 404s: a console error and a wasted request on every page that shows the link, and a failed
// client navigation on click. Such a link must be a plain <a>. Pure, so a test can pin it.

const STATIC_EXT = /\.(html?|md|json|txt|xml|pdf|csv|xlsx|docx|pptx|png|jpe?g|svg|webp|ico|woff2?)$/i;

/** True when an internal href points at a static file (the part before any ? or # decides). */
export function isStaticFileHref(href: string): boolean {
  if (!href.startsWith("/") || href.startsWith("//")) return false;
  const p = href.split("#")[0].split("?")[0];
  return STATIC_EXT.test(p);
}
