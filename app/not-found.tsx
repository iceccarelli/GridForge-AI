import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";

// The 404 page's own metadata. Without it the page inherited the root layout's, so a missing URL was titled exactly like the home page and
// carried the layout's `robots: index, follow` beside the `noindex` Next itself injects on every not-found response: two contradictory
// robots tags on a page that answers 404.
//
//  - title: its own, wrapped by the root template like every other page ("Page not found · Time to Power").
//  - robots: null removes the inherited tag (a key present with a null value replaces the parent's in Next's metadata merge). The one
//    `<meta name="robots" content="noindex">` that remains is Next's own, written for every not-found response; this file does not repeat it,
//    because two tags would be two chances to disagree. The response status stays 404 (Next sets it; nothing here touches it).
export const metadata: Metadata = {
  title: "Page not found",
  robots: null,
};

export default function NotFound() {
  return (
    <div className="min-h-[80vh] flex items-center justify-center px-6 blueprint">
      <div className="text-center max-w-md">
        <div className="data text-power text-7xl font-semibold tracking-tight">
          404
        </div>
        <h1 className="text-2xl font-semibold tracking-tight mt-4 mb-3">
          No power at this address.
        </h1>
        <p className="text-mute mb-8">
          The page you're looking for isn't on the grid. Let's get you back to a
          live circuit.
        </p>
        <Link
          href="/"
          className="btn-primary px-7 py-3.5 rounded-xl text-sm inline-flex items-center gap-2"
        >
          <ArrowLeft size={16} /> Back home
        </Link>
      </div>
    </div>
  );
}
