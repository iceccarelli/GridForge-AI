import type { ProductId } from "@/lib/products";

/**
 * The URL slug of each product's page at /products/<slug>, on its own so a client component can link to a page without importing the pages'
 * long copy (lib/product-pages.ts) into the browser bundle. tests/site/product-page-conversion.test.ts pins this map to PRODUCT_PAGES, so it
 * cannot drift from the pages themselves.
 */
export const PRODUCT_PAGE_SLUGS: Partial<Record<ProductId, string>> = {
  density_screen: "density-screen",
  envelope_study_deposit: "envelope-study",
  procurement_spec: "procurement-specification",
  portfolio_screen_deposit: "portfolio-screen",
  hall_watch: "hall-watch",
};
