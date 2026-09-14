import { SITE, SERVICES, FAQ } from "@/lib/site";
import { LADDER_PRODUCTS } from "@/lib/products";

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
      "Independent power and thermal engineering for AI data centers. We tell the owner of an existing data hall how much AI compute it can carry, which of thirteen electrical, thermal and physical constraints binds first, and what each step of extra density costs. We quote no equipment and take no margin on hardware.",
    founder: { "@type": "Person", name: SITE.founder, url: SITE.founderUrl },
    areaServed: "Global",
    knowsAbout: [
      "AI data center rack density",
      "Data hall capacity constraints",
      "Busway ampacity and tap-off ratings",
      "Direct liquid cooling retrofit",
      "Coolant distribution unit capacity at site conditions",
      "Transformer and UPS capacity for AI loads",
      "Grid interconnection queues",
      "Behind-the-meter power",
      "Data center floor loading",
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

  // The engagement catalogue, priced. Derived from the same product table that
  // drives checkout, so what a search engine is told an engagement costs cannot
  // drift from what it actually charges.
  const offers = {
    "@context": "https://schema.org",
    "@type": "OfferCatalog",
    name: "GridForge AI — Engagements",
    itemListElement: LADDER_PRODUCTS.map((p) => ({
      "@type": "Offer",
      name: p.name,
      description: p.description,
      priceCurrency: "EUR",
      price: (p.amountCents / 100).toFixed(0),
      availability: "https://schema.org/InStock",
      itemOffered: {
        "@type": "Service",
        name: p.name,
        description: p.deliverable,
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
      {jsonLdScript(offers)}
      {jsonLdScript(faqPage)}
    </>
  );
}
