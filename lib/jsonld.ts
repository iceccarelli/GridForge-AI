import type { ConstraintDoc, ConstraintReference } from "@/lib/constraints";
import { capabilityById } from "@/lib/capability-registry";
import { API_PRODUCTS, LADDER_PRODUCTS, PAYG, eurFromCents, type Product } from "@/lib/products";
import { FREE_ALLOWANCE_TEXT, billingRuleText, eurExact } from "@/lib/payg-pricing";
import { SITE, SITE_URL, siteUrl } from "@/lib/site";
import { WEBSITE_ID, orgRef } from "@/lib/entity";

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

const ORG = orgRef();

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
    provider: orgRef(),
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

// ---------------------------------------------------------------------------------------------------------------
// The metered engine API as a schema.org WebAPI with its Offers: the free allowance, pay-as-you-go and the monthly plans.
//
// Every amount, currency, quantity and sentence is read from the catalogue (PAYG and API_PRODUCTS in lib/products.ts; the billing rule
// and the free-allowance sentence from lib/payg-pricing.ts, which the Python engine's text is pinned to). Nothing is typed here.
// What the markup does NOT say: no `availability` (whether a route is callable follows the deployed engine, which the catalogue does not
// know), no rating, review or count of anything, and no price for anything the catalogue does not price. The per-route unit weights are
// not repeated here; they are on the page and in /openapi.json.
// ---------------------------------------------------------------------------------------------------------------

const API_CURRENCY = PAYG.currency.toUpperCase();

/** The free monthly allowance: a price of nothing, for a quantity the catalogue states. */
export function apiFreeAllowanceOfferJsonLd() {
  return {
    "@type": "Offer",
    name: "Free allowance",
    description: FREE_ALLOWANCE_TEXT,
    price: priceString(0),
    priceCurrency: API_CURRENCY,
    eligibleQuantity: { "@type": "QuantitativeValue", value: PAYG.freeAllowanceUnits, unitText: "units per month" },
  };
}

/** Pay-as-you-go: the price of one unit, with the billing rule (which carries the minimum invoice and the cap behaviour) as the description. */
export function apiPaygOfferJsonLd() {
  return {
    "@type": "Offer",
    name: "Pay-as-you-go",
    description: `${billingRuleText()} The monthly spending cap is yours to set, from ${eurExact(PAYG.minCapEur * 100)} to ${eurExact(PAYG.maxCapEur * 100)}.`,
    priceCurrency: API_CURRENCY,
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price: priceString(PAYG.unitPriceCents),
      priceCurrency: API_CURRENCY,
      referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitText: "unit" },
      unitText: "per unit",
    },
  };
}

/** A monthly API plan: its price per month and the units it includes, both from the catalogue. */
export function apiPlanOfferJsonLd(p: Product) {
  const units = p.apiUnits ?? 0;
  return {
    "@type": "Offer",
    name: p.name,
    description: `${units} metered units a month on a signed API key, billed monthly. Past those units the engine answers 402.`,
    priceCurrency: API_CURRENCY,
    priceSpecification: {
      "@type": "UnitPriceSpecification",
      price: priceString(p.amountCents),
      priceCurrency: API_CURRENCY,
      billingDuration: "P1M",
      referenceQuantity: { "@type": "QuantitativeValue", value: 1, unitCode: "MON" },
      unitText: "per month",
    },
  };
}

/**
 * The engine API as a WebAPI. `plans` is true where the page shows the monthly plans (/developers); /pricing shows the free allowance and
 * pay-as-you-go and points to /developers for the plans, so its markup carries what its page carries.
 */
export function apiServiceJsonLd(opts: { plans: boolean }) {
  return {
    "@context": "https://schema.org",
    "@type": "WebAPI",
    name: "Time to Power engine API",
    description:
      "The capacity and density engine as a JSON API and an MCP server: constraint screening for an existing AI data hall, with an evidence class on each headline figure. Screening-mode output, not an issued engineering opinion.",
    url: siteUrl("/developers"),
    documentation: siteUrl("/developers"),
    provider: orgRef(),
    offers: [apiFreeAllowanceOfferJsonLd(), apiPaygOfferJsonLd(), ...(opts.plans ? API_PRODUCTS.map(apiPlanOfferJsonLd) : [])],
  };
}

/** A breadcrumb trail. Each crumb is a real page of this site; the last one is the current page. */
export function breadcrumbJsonLd(trail: { name: string; path: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: siteUrl(c.path),
    })),
  };
}

/**
 * The free capacity qualifier as a web application. What it states is only what /qualify itself says: free, no card, no call, no
 * contact details required, directional output. No rating, review or usage figure is claimed.
 */
export function qualifierJsonLd() {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: "Time to Power capacity qualifier",
    url: siteUrl("/qualify"),
    applicationCategory: "BusinessApplication",
    operatingSystem: "Any (web browser)",
    description:
      "Seven numbers about an existing AI data hall in, the constraint that binds first out. Directional output from the same power-and-thermal engine that produces the paid capacity study.",
    isAccessibleForFree: true,
    offers: { "@type": "Offer", price: "0", priceCurrency: "EUR" },
    provider: orgRef(),
  };
}

/** A page whose only structured content is where it sits and what it is about (WebPage + the breadcrumb is added by the caller). */
export function webPageJsonLd(path: string, name: string, description: string) {
  return {
    "@context": "https://schema.org",
    "@type": "WebPage",
    name,
    description,
    url: siteUrl(path),
    isPartOf: { "@type": "WebSite", "@id": WEBSITE_ID, name: SITE.name, url: SITE_URL },
  };
}

/**
 * A page that is a set of documents or pages (the sample deliverables, the platform library). `parts` are real URLs of this site; each is
 * described only by its name and what the page itself says of it. Nothing here claims a rating, a review or a customer.
 */
export function collectionPageJsonLd(
  path: string,
  name: string,
  description: string,
  parts: { name: string; path: string; description?: string; format?: string }[],
) {
  return {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name,
    description,
    url: siteUrl(path),
    isPartOf: { "@type": "WebSite", "@id": WEBSITE_ID, name: SITE.name, url: SITE_URL },
    hasPart: parts.map((x) => ({
      "@type": "CreativeWork",
      name: x.name,
      url: siteUrl(x.path),
      ...(x.description ? { description: x.description } : {}),
      ...(x.format ? { encodingFormat: x.format } : {}),
      isAccessibleForFree: true,
    })),
  };
}

/**
 * A published data file as a Dataset: where it is, in what format, who publishes it, and the caveat the page carries. No licence is
 * stated because none has been chosen for the data (an invented one would be a legal claim), and no measurement is implied.
 */
export function datasetJsonLd(path: string, name: string, description: string, file: { path: string; format: string }) {
  return {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name,
    description,
    url: siteUrl(path),
    isAccessibleForFree: true,
    creator: orgRef(),
    distribution: [{ "@type": "DataDownload", encodingFormat: file.format, contentUrl: siteUrl(file.path) }],
  };
}
