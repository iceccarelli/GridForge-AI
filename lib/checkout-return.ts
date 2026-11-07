// What a visitor sees when Stripe sends them back after cancelling (app/api/checkout/route.ts sets the cancel_url):
//   /qualify?purchase=cancelled   a catalogue product (the Density Screen, a study deposit, a plan) that was not bought;
//   /pricing?deposit=cancelled    the unattributed deposit, or a buyer who arrived from a shared project link.
// The page says plainly that nothing was charged and offers the way back to the product page they left, and the free check.
//
// Nothing reflected: the URL decides only WHETHER the notice shows (an exact match on one parameter) and, through `product`, WHICH row of
// the catalogue to name. The text and every link come from the catalogue, never from the query string, so a hostile value shows the generic
// notice. The product the visitor left is read from a catalogue id: the `product` query parameter if the checkout ever supplies one, else the
// id lib/ui.ts stored in sessionStorage just before the redirect; either way it is accepted only if it is a key of PRODUCTS.

import { PRODUCT_PAGES } from "@/lib/product-pages";
import { PRODUCTS, type ProductId } from "@/lib/products";

export { LAST_CHECKOUT_KEY } from "@/lib/checkout-return-key";
export { CANCEL_RETURNS, isCancelledReturn } from "@/lib/checkout-return-path";

export interface ProductBack {
  id: ProductId;
  name: string;
  /** A site-relative path built from the catalogue, never from input. */
  href: string;
}

const PAGE_FOR = new Map(PRODUCT_PAGES.map((p) => [p.productId, `/products/${p.slug}`]));

/** A catalogue product id (or product-page slug) to the page to send the visitor back to; null for anything not in the catalogue. */
export function productBack(raw: string | null | undefined): ProductBack | null {
  if (!raw || raw.length > 64) return null;
  const bySlug = PRODUCT_PAGES.find((p) => p.slug === raw)?.productId;
  const id = (Object.prototype.hasOwnProperty.call(PRODUCTS, raw) ? raw : bySlug) as ProductId | undefined;
  if (!id) return null;
  const href = PAGE_FOR.get(id);
  // A product with no page of its own (an API plan, say) has no "page I left"; the notice then offers the general list instead.
  if (!href) return null;
  return { id, name: PRODUCTS[id].name, href };
}
