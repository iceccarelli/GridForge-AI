import type { Metadata } from "next";
import { OG_BASE } from "@/lib/site";
import { pageImages } from "@/lib/page-cards";
import { IntelligenceClient } from "@/components/IntelligenceClient";

// Previously this route had no metadata export at all — a "use client" page
// cannot export one — so it silently inherited the root layout's home-page
// title and description instead of describing itself. Split into a thin
// server wrapper (same pattern as app/workspace/page.tsx) so this route gets
// its own title, description and canonical.
const TITLE = "GridForge Intelligence — siting by time to power";
const DESCRIPTION =
  "Interconnection-queue signal and modelled time-to-energize across regions, with behind-the-meter supply scored as one named relief option — a modelled intelligence subscription, not a verified-site portfolio.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: "/intelligence" },
  twitter: { card: "summary_large_image", images: pageImages("intelligence") },
  openGraph: {
    ...OG_BASE,
    images: pageImages("intelligence"),
    title: TITLE,
    description: DESCRIPTION,
    url: "/intelligence",
  },
};

export default function Page() {
  return <IntelligenceClient />;
}
