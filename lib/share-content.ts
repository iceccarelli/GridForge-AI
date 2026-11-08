import type { Audience } from "@/lib/audiences";
// What each dynamic page's link card says. Pure functions of the page's own data (the constraint reference, the platform library, the
// catalogue), kept apart from the drawing so tests can read every card without rendering an image.

import type { ConstraintDoc, PlatformEntry } from "@/lib/constraints";
import { DOMAIN_LABEL } from "@/lib/constraints";
import type { CardContent } from "@/lib/share-card";
import { eurFromCents, priceLine, type Product } from "@/lib/products";
import type { ProductPage } from "@/lib/product-pages";

export function constraintCard(c: ConstraintDoc): CardContent {
  const facts: string[] = [];
  if (c.lead_time_weeks) facts.push(`Relief ${c.lead_time_weeks.low} to ${c.lead_time_weeks.high} weeks (indicative)`);
  if (c.worked_example) facts.push("Worked example");
  facts.push(`${DOMAIN_LABEL[c.domain] ?? c.domain} constraint`);
  return { kicker: `Constraint reference · ${DOMAIN_LABEL[c.domain] ?? c.domain}`, title: c.name, subtitle: c.headline, facts };
}

export function platformCard(p: PlatformEntry): CardContent {
  return {
    kicker: "Platform library · cited sources",
    title: p.name,
    subtitle: "What one rack asks of an existing hall: power, liquid share, flow and floor loading, from cited sources held as library assumptions.",
    facts: [`${p.rack_kW} kW per rack`, `${Math.round(p.liquid_fraction * 100)}% liquid`, `${p.flow_l_per_min_per_rack} l/min`, `${Math.round(p.floor_loading_kg_per_m2).toLocaleString("en-IE")} kg/m²`],
  };
}

export function audienceCard(a: Audience): CardContent {
  return { kicker: "Who it is for", title: a.name, subtitle: a.summary, facts: ["Free first step", "Evidence class on every figure"] };
}

export function productCard(page: ProductPage, p: Product): CardContent {
  const facts = p.opensBandCents
    ? [`${eurFromCents(p.amountCents)} deposit`, `Opens ${eurFromCents(p.opensBandCents[0])} to ${eurFromCents(p.opensBandCents[1])}`]
    : [priceLine(p)];
  if (!p.opensBandCents && !p.recurring && p.turnaroundDays) facts.push(`${p.turnaroundDays} working days from intake`);
  return { kicker: "Fixed-fee engagement", title: p.name.replace(/ — deposit$/, ""), subtitle: page.decision, facts };
}
