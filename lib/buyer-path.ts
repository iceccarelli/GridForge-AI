// Pure data: the next step in the buying path, read from the product catalogue.
//
// Nothing here is typed by hand. Which products can be commissioned for a project is PROJECT_ATTACHABLE_KINDS, the order
// is the catalogue's own `ladderOrder`, and every price, turnaround, credit and deposit band is the Product record.
// Importable from client components.

import { LADDER_PRODUCTS, PRODUCTS, type Product, type ProductId } from "@/lib/products";
import { isProjectAttachable } from "@/lib/project-products";

/** The engagements that can be commissioned for one project, in the order the catalogue sells them. */
export function projectLadder(): Product[] {
  return LADDER_PRODUCTS.filter((p) => isProjectAttachable(p.kind));
}

export interface BuyerStep {
  product: Product;
  /** The product this one is credited against when the buyer goes further, from `creditsAgainst`. */
  creditsAgainst: Product | null;
}

/**
 * The recommended next engagement and the alternatives, given the kinds already commissioned for the project.
 * `next` is the first rung of the ladder not yet bought; it is null once every rung has been.
 */
export function buyerPath(commissionedKinds: string[]): { next: BuyerStep | null; others: BuyerStep[] } {
  const bought = new Set(commissionedKinds);
  const open = projectLadder().filter((p) => !bought.has(p.kind));
  const step = (p: Product): BuyerStep => ({ product: p, creditsAgainst: p.creditsAgainst ? PRODUCTS[p.creditsAgainst as ProductId] : null });
  return { next: open[0] ? step(open[0]) : null, others: open.slice(1).map(step) };
}
