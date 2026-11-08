// Which requests the bundle measurement must NOT let through: Next's link prefetching.
//
// Next's <Link> prefetches other routes with an RSC fetch as soon as the link is in view. That fetch makes the browser load the target
// route's client chunks, and whether those loads finish before "networkidle" depends on how loaded the machine is. The same build
// therefore measured 157.7 kB on one run and 188.6 kB on another (/pricing). Those bytes are not part of the page's own first load: the
// reader did not ask for them. So the measurement aborts every prefetch, and a page's number is the document, its own scripts and styles,
// and what those load. A real visitor on a fast link will prefetch more; this is a lab figure for comparing builds, not field data.
//
// Pure, so tests/site/perf-budget.test.ts can pin it with fixtures.

/** @param {{ url: string, headers: Record<string, string> }} req  header names in any case */
export function isPrefetchRequest(req) {
  const h = {};
  for (const [k, v] of Object.entries(req.headers || {})) h[k.toLowerCase()] = String(v);
  if ("next-router-prefetch" in h) return true; // the App Router's prefetch fetch (a <Link> in view warming another route)
  if (h["purpose"] === "prefetch" || h["sec-purpose"]?.startsWith("prefetch")) return true; // browser-level prefetch / prerender hints
  // NOT aborted, on purpose: a plain RSC fetch (`rsc: 1` with no next-router-prefetch). That is a real client navigation, for example
  // /account redirecting itself to /account/login. Aborting it makes Next fall back to a hard navigation and load the page twice.
  return false;
}
