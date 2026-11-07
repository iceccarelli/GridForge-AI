import type { Metadata } from "next";
import SitesWorkspace from "@/components/SitesWorkspace";

// A signed-in screen: the shell is rendered on the server and carries no data. The sign-in session lives in the browser (Supabase's own
// client, the same as /account), so the workspace below identifies the caller with the bearer token and every list, form and table is
// fetched from /api/orgs, /api/sites and /api/halls, which verify the address and check membership on the server. Nothing about a person's
// organisations is in this HTML.
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Sites and halls",
  description: "Your organisation's sites and halls, and the figures recorded about each, with where every figure came from.",
  robots: { index: false, follow: false },
};

export default function SitesPage() {
  return (
    <div className="bg-ink min-h-screen pt-28 pb-24">
      <div className="max-w-6xl mx-auto px-6">
        <SitesWorkspace />
      </div>
    </div>
  );
}
