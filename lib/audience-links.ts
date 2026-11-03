// Where each step of an audience's path leads and what it costs, read from the catalogue and the product pages so a repriced or renamed
// offer changes here by itself. The free qualifier has no catalogue entry; it is the one step that is not a product.

import { QUALIFY_LINK } from "@/lib/nav";
import { PRODUCT_PAGES } from "@/lib/product-pages";
import { PRODUCTS, eurFromCents, priceLine, type ProductId } from "@/lib/products";
import type { PathStep } from "@/lib/audiences";

export interface ResolvedStep {
  href: string;
  name: string;
  /** "Free" for the qualifier, else the catalogue's own price line. */
  price: string;
  /** Working days from a complete intake, where the catalogue states one worth showing. */
  turnaround: string | null;
  why: string;
  productId: ProductId | null;
}

const PAGE_FOR: Partial<Record<ProductId, string>> = Object.fromEntries(
  PRODUCT_PAGES.map((p) => [p.productId, `/products/${p.slug}`])
);

export function resolveStep(step: PathStep): ResolvedStep {
  if (step.kind === "qualifier") {
    return { href: QUALIFY_LINK.href, name: "Free capacity check", price: "Free, no card", turnaround: null, why: step.why, productId: null };
  }
  const p = PRODUCTS[step.kind];
  const href = PAGE_FOR[step.kind] ?? (p.apiUnits ? "/developers" : "/pricing");
  const turnaround =
    p.turnaroundDays > 0 && p.producesDeliverable ? `${p.turnaroundDays} working days from a complete intake` : null;
  return { href, name: p.name, price: priceLine(p), turnaround, why: step.why, productId: p.id };
}

/** The Density Screen's fee, for sentences that name it. Never typed beside the copy. */
export const SCREEN_FEE = eurFromCents(PRODUCTS.density_screen.amountCents);
