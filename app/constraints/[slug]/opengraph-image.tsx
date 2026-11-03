import { constraintBySlug, constraintReference } from "@/lib/constraints";
import { CARD_SIZE, CARD_TYPE, DEFAULT_CARD, cardAlt, renderCard } from "@/lib/share-card";
import { constraintCard } from "@/lib/share-content";

export const size = CARD_SIZE;
export const contentType = CARD_TYPE;

export async function generateStaticParams() {
  return ((await constraintReference())?.constraints ?? []).map((c) => ({ slug: c.slug }));
}

export async function generateImageMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const c = await constraintBySlug((await params).slug);
  return [{ id: "card", size, contentType, alt: cardAlt(c ? constraintCard(c) : DEFAULT_CARD) }];
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const c = await constraintBySlug((await params).slug);
  return renderCard(c ? constraintCard(c) : DEFAULT_CARD);
}
