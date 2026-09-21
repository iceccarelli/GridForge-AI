import type { Metadata } from "next";
import { IntelligenceClient } from "@/components/IntelligenceClient";

// Previously this route had no metadata export at all — a "use client" page
// cannot export one — so it silently inherited the root layout's home-page
// title and description instead of describing itself. Split into a thin
// server wrapper (same pattern as app/workspace/page.tsx) so this route gets
// its own title, description and canonical.
const TITLE = "GridForge Intelligence — siting by time to power";
const DESCRIPTION =
  "Interconnection-queue signal and modelled time-to-energize across regions, with behind-the-meter supply scored as one named relief option — an intelligence subscription in progress, not a verified-site portfolio.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/intelligence" },
  openGraph: {
    title: TITLE,
    description: DESCRIPTION,
    url: "/intelligence",
  },
};

export default function Page() {
  return <IntelligenceClient />;
}
