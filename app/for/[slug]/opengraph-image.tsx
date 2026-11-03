import { AUDIENCES, audienceBySlug } from "@/lib/audiences";
import { CARD_SIZE, CARD_TYPE, DEFAULT_CARD, cardAlt, renderCard } from "@/lib/share-card";
import { audienceCard } from "@/lib/share-content";

export const size = CARD_SIZE;
export const contentType = CARD_TYPE;

function content(slug: string) {
  const a = audienceBySlug(slug);
  return a ? audienceCard(a) : DEFAULT_CARD;
}

export function generateStaticParams() {
  return AUDIENCES.map((a) => ({ slug: a.slug }));
}

export async function generateImageMetadata({ params }: { params: Promise<{ slug: string }> }) {
  return [{ id: "card", size, contentType, alt: cardAlt(content((await params).slug)) }];
}

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  return renderCard(content((await params).slug));
}
