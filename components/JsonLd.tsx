import { SITE, SERVICES, FAQ } from "@/lib/site";

/**
 * JSON-LD structured data. Sourced from the same SITE / SERVICES / FAQ content
 * rendered visibly on the page, so the structured data never drifts from what a
 * human sees (a Google requirement, and just honest). Emitted into the initial
 * SSR HTML. No fabricated ratings, reviews, or aggregate claims.
 */
const SITE_URL = "https://gridforge-ai.vercel.app";

function jsonLdScript(obj: unknown) {
  // Escape "<" to prevent any chance of a </script> breakout from content.
  const json = JSON.stringify(obj).replace(/</g, "\\u003c");
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}

export function JsonLd() {
  const organization = {
    "@context": "https://schema.org",
    "@type": "ProfessionalService",
    name: SITE.name,
    url: SITE_URL,
    description:
      "Independent power-systems engineering for AI data centers: behind-the-meter generation, DC distribution architecture, and physics-informed EMS that close the gap between a multi-year grid queue and an energized site.",
    founder: { "@type": "Person", name: SITE.founder, url: SITE.founderUrl },
    areaServed: "Global",
    knowsAbout: [
      "Behind-the-meter power",
      "Grid interconnection queues",
      "DC microgrids",
      "Battery energy storage systems",
      "Energy management systems",
      "AI data center power",
    ],
    sameAs: [SITE.repo, SITE.founderUrl],
  };

  const serviceCatalog = {
    "@context": "https://schema.org",
    "@type": "OfferCatalog",
    name: "GridForge AI — Engineering Services",
    itemListElement: SERVICES.map((s) => ({
      "@type": "Offer",
      itemOffered: {
        "@type": "Service",
        name: s.title,
        description: s.desc,
        provider: { "@type": "ProfessionalService", name: SITE.name, url: SITE_URL },
      },
    })),
  };

  const faqPage = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: FAQ.map((f) => ({
      "@type": "Question",
      name: f.q,
      acceptedAnswer: { "@type": "Answer", text: f.a },
    })),
  };

  return (
    <>
      {jsonLdScript(organization)}
      {jsonLdScript(serviceCatalog)}
      {jsonLdScript(faqPage)}
    </>
  );
}
