// Where a product is sold on the site. Kept apart from lib/product-pages.ts (whose content dates the product pages in the sitemap manifest)
// because a link helper is not page content.

import { PRODUCT_PAGES } from "@/lib/product-pages";
import type { ProductId } from "@/lib/products";

/** The page that sells a product (the existing purchase path: its Commission button), or null when the product has none. */
export function productPageHref(id: ProductId): string | null {
  const page = PRODUCT_PAGES.find((p) => p.productId === id);
  return page ? `/products/${page.slug}` : null;
}
