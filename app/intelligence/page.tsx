import type { Metadata } from "next";
import { OG_BASE } from "@/lib/site";
import { pageImages } from "@/lib/page-cards";
import { IntelligenceClient } from "@/components/IntelligenceClient";
import { PageJsonLd } from "@/components/PageJsonLd";
import { breadcrumbJsonLd, webPageJsonLd } from "@/lib/jsonld";

// Previously this route had no metadata export at all — a "use client" page
// cannot export one — so it silently inherited the root layout's home-page
// title and description instead of describing itself. Split into a thin
// server wrapper (same pattern as app/workspace/page.tsx) so this route gets
// its own title, description and canonical.
const TITLE = "GridForge Intelligence: regional siting";
const DESCRIPTION =
  "A modelled ranking of regions by time to energize, with US interconnection-queue history and day-ahead prices. A modelled subscription, not verified sites.";

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
  return (
    <>
      <PageJsonLd
        data={[
          webPageJsonLd("/intelligence", TITLE, DESCRIPTION),
          breadcrumbJsonLd([
            { name: "Time to Power", path: "/" },
            { name: "Intelligence", path: "/intelligence" },
          ]),
        ]}
      />
      <IntelligenceClient />
    </>
  );
}
