import type { ConstraintDoc, ConstraintReference } from "@/lib/constraints";
import { siteUrl } from "@/lib/site";

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
