import type { Metadata } from "next";
import { LegalShell, Note } from "@/components/LegalShell";
import { SITE, OG_BASE } from "@/lib/site";
import { pageImages } from "@/lib/page-cards";

export const metadata: Metadata = {
  title: "Security",
  description:
    "How Time to Power handles enquiries, API keys and deliverables.",
  alternates: { canonical: "/legal/security" },
  twitter: { card: "summary_large_image", images: pageImages("security") },
  openGraph: {
    ...OG_BASE,
    images: pageImages("security"), url: "/legal/security", title: "Security", description: "How Time to Power handles enquiries, API keys and deliverables.", },
};

export default function Security() {
  return (
    <LegalShell title="Security" updated="June 2026">
      <p>
        We take the confidentiality of your site information seriously. Enquiries
        are transmitted over TLS and processed by the services listed on the
        privacy page. We hold no security certification (no SOC 2, ISO 27001 or
        similar).
      </p>
      <h2 className="text-xl font-semibold text-ghost pt-2">Confidentiality</h2>
      <p>
        Site, load, and interconnection details are treated as confidential. An NDA
        is available on request before you share anything sensitive.
      </p>
      <h2 className="text-xl font-semibold text-ghost pt-2">Disclosure</h2>
      <p>
        If you believe you've found a security issue with this site, please email
        {" "}{SITE.email}. We'll acknowledge responsible reports promptly.
      </p>
      <Note />
    </LegalShell>
  );
}
