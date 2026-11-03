import { FAQ } from "@/lib/site";
import { engagementCatalogJsonLd } from "@/lib/jsonld";
import { entityGraph } from "@/lib/entity";

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
  // The entity itself (organisation, founder, website) comes from lib/entity.ts, the one definition every page references by @id.
  const entity = entityGraph();

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
      {jsonLdScript(entity)}
      {jsonLdScript(offers)}
      {jsonLdScript(faqPage)}
    </>
  );
}
