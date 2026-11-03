import { productPageBySlug, productForPage, PRODUCT_PAGES } from "@/lib/product-pages";
import { CARD_SIZE, CARD_TYPE, DEFAULT_CARD, cardAlt, renderCard } from "@/lib/share-card";
import { productCard } from "@/lib/share-content";

export const size = CARD_SIZE;
export const contentType = CARD_TYPE;

function content(slug: string) {
  const page = productPageBySlug(slug);
  return page ? productCard(page, productForPage(page)) : DEFAULT_CARD;
}

export function generateStaticParams() {
  return PRODUCT_PAGES.map((p) => ({ slug: p.slug }));
}

export async function generateImageMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return [{ id: "card", size, contentType, alt: cardAlt(content((await params).slug)) }];
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  return renderCard(content((await params).slug));
}
