import { SITE, SITE_URL, FAQ } from "@/lib/site";
import { engagementCatalogJsonLd } from "@/lib/jsonld";

/**
 * JSON-LD structured data. Sourced from the same SITE / SERVICES / FAQ content
 * rendered visibly on the page, so the structured data never drifts from what a
 * human sees (a Google requirement, and just honest). Emitted into the initial
 * SSR HTML. No fabricated ratings, reviews, or aggregate claims.
 */


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
      "Contracted grid capacity utilisation",
      "Data center floor loading",
    ],
    sameAs: [SITE.repo, SITE.founderUrl],
  };

  // ONE priced catalogue, derived from the product table that drives checkout (lib/jsonld.ts). It used to be two
  // overlapping OfferCatalogs describing the same four or five engagements, one unpriced and one priced; a machine
  // read them as two sets of offers.
  const offers = engagementCatalogJsonLd();

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
      {jsonLdScript(offers)}
      {jsonLdScript(faqPage)}
    </>
  );
}
