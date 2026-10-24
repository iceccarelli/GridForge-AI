import type { ConstraintDoc, ConstraintReference } from "@/lib/constraints";
import { capabilityById } from "@/lib/capability-registry";
import { LADDER_PRODUCTS, eurFromCents, type Product } from "@/lib/products";
import { SITE, SITE_URL, siteUrl } from "@/lib/site";

/**
 * Dataset-shaped structured data for the constraint reference.
 *
 * The pages already carry `TechArticle` JSON-LD — good for "this is an article
 * about X" — but a crawler citing a number needs more than that: which machine-
 * readable copy to fetch, and the caveat that travels with every figure here
 * (modelled, not measured — see `ref.notice` / `/api/cite`). This is that layer,
 * kept to `Dataset` and `PropertyValue`, both of which describe "here is a value
 * and where it came from" without implying a measurement or a fact-check we have
 * not done. Do not add a `Claim` or a schema that reads as verification — the
 * honesty kernel's rule against inventing measurement language applies to
 * structured data exactly as it applies to prose.
 */

const ORG = { "@type": "Organization", name: "Time to Power", url: siteUrl() };

export function constraintCatalogueJsonLd(ref: ConstraintReference) {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: "Time to Power — capacity and density constraint reference",
    description: ref.notice,
    url: siteUrl("/constraints"),
    identifier: ref.schema,
    creator: ORG,
    publisher: ORG,
    license: siteUrl("/api/cite"),
    citation: siteUrl("/api/cite"),
    variableMeasured: ref.constraints.map((c) => c.name),
    distribution: [
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: siteUrl("/reference/constraints.json"),
      },
      {
        "@type": "DataDownload",
        encodingFormat: "application/json",
        contentUrl: siteUrl("/api/constraints"),
      },
    ],
  };
}

export function constraintRecordJsonLd(c: ConstraintDoc, ref: ConstraintReference | null) {
  const variableMeasured: Record<string, unknown>[] = [];
  if (c.lead_time_weeks) {
    variableMeasured.push({
      "@type": "PropertyValue",
      name: "Indicative relief lead time",
      minValue: c.lead_time_weeks.low,
      maxValue: c.lead_time_weeks.high,
      unitText: "weeks",
    });
  }
  if (c.cost_basis) {
    variableMeasured.push({
      "@type": "PropertyValue",
      name: "Cost basis evidence class",
      value: c.cost_basis.evidence,
      description: c.cost_basis.note,
    });
  }
  if (c.worked_example) {
    variableMeasured.push({
      "@type": "PropertyValue",
      name: "Worked example",
      description: `${c.worked_example.question} ${c.worked_example.working}`,
      value: c.worked_example.answer,
    });
  }

  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: `${c.name} — constraint record`,
    description: `${c.headline} ${ref?.notice ?? ""}`.trim(),
    url: siteUrl(`/constraints/${c.slug}`),
    identifier: c.id,
    creator: ORG,
    publisher: ORG,
    license: siteUrl("/api/cite"),
    citation: siteUrl("/api/cite"),
    isPartOf: {
      "@type": "Dataset",
      name: "Time to Power — capacity and density constraint reference",
      url: siteUrl("/constraints"),
    },
    variableMeasured,
    distribution: {
      "@type": "DataDownload",
      encodingFormat: "application/json",
      contentUrl: siteUrl(`/api/constraints?slug=${c.slug}`),
    },
  };
}

/**
 * The Time-to-Power comparison as a web application. "Free" is read from the capability registry, not typed here, so the
 * page cannot say it is free once the registry says it is not; no rating, review or usage figure is claimed.
 */
export function comparisonToolJsonLd() {
  const cap = capabilityById("ttp_compare");
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Time-to-Power scenario comparison",
    description:
      "Compares cooling and supply scenarios for one data-centre hall: racks as found and after relief, the binding constraint, the date to full capacity with its band and evidence class, and capital. A scenario whose lead time is unknown gets no date. Screening-level engineering, not an issued opinion.",
    url: siteUrl("/power/compare"),
    applicationCategory: "BusinessApplication",
    operatingSystem: "Any",
    isAccessibleForFree: cap?.status === "free",
    provider: ORG,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The engagement catalogue as schema.org Offers (the homepage's only OfferCatalog).
//
// Derived from lib/products.ts, never typed. What each product IS decides what the markup may say:
//   * a deposit (a product that opens a scoped band) is agreed with a person after payment, there is no intake form and
//     no stock to hold, so it carries NO `availability`: InStock would tell a machine it can be bought off the shelf
//     like a document. Its name says "deposit" and its description says what it is a deposit against.
//   * a recurring product (Hall Watch) carries a UnitPriceSpecification with its billing duration and reference
//     quantity, and no bare top-level `price`, so a machine cannot read the amount as a one-off.
//   * everything else is a fixed-fee engagement bought at checkout.
// No rating, review or count of anything is ever claimed.
// ---------------------------------------------------------------------------------------------------------------

/** "4500", or "4500.50" when the catalogue amount is not a whole euro. */
function priceString(cents: number): string {
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/** A product that is a deposit against a scoped fee: a person agrees the work with the buyer after payment. */
export function isDepositProduct(p: Pick<Product, "opensBandCents">): boolean {
  return p.opensBandCents !== undefined;
}

export function engagementOfferJsonLd(p: Product) {
  const deposit = isDepositProduct(p);
  const name = deposit && !/deposit/i.test(p.name) ? `${p.name} — deposit` : p.name;
  const description = deposit
    ? `${p.description} This is a deposit, not the full fee: the work is scoped with you by a person after payment` +
      `${p.opensBandCents ? `, in a band of ${eurFromCents(p.opensBandCents[0])} to ${eurFromCents(p.opensBandCents[1])}` : ""}.`
    : p.description;
  const itemOffered = {
    "@type": "Service",
    name,
    description: p.deliverable,
    provider: { "@type": "ProfessionalService", name: SITE.name, url: SITE_URL },
  };

  if (p.recurring) {
    const { interval, intervalCount } = p.recurring;
    return {
      "@type": "Offer",
      name,
      description,
      priceCurrency: "EUR",
      priceSpecification: {
        "@type": "UnitPriceSpecification",
        price: priceString(p.amountCents),
        priceCurrency: "EUR",
        // Billed every `intervalCount` months/years: the price is for that whole period, not one-off.
        billingDuration: `P${intervalCount}${interval === "year" ? "Y" : "M"}`,
        referenceQuantity: {
          "@type": "QuantitativeValue",
          value: intervalCount,
          unitCode: interval === "year" ? "ANN" : "MON",
        },
        unitText: intervalCount === 1 ? `per ${interval}` : `per ${intervalCount} ${interval}s`,
      },
      availability: "https://schema.org/InStock",
      itemOffered,
    };
  }

  return {
    "@type": "Offer",
    name,
    description,
    priceCurrency: "EUR",
    price: priceString(p.amountCents),
    ...(deposit ? {} : { availability: "https://schema.org/InStock" }),
    itemOffered,
  };
}

export function engagementCatalogJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "OfferCatalog",
    name: `${SITE.name} — Engagements`,
    itemListElement: LADDER_PRODUCTS.map(engagementOfferJsonLd),
  };
}
