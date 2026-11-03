import { platformLibrary } from "@/lib/constraints";
import { pageablePlatforms } from "@/lib/platform-pages";
import { CARD_SIZE, CARD_TYPE, DEFAULT_CARD, cardAlt, renderCard } from "@/lib/share-card";
import { platformCard } from "@/lib/share-content";

export const size = CARD_SIZE;
export const contentType = CARD_TYPE;

async function find(id: string) {
  const lib = await platformLibrary();
  return lib ? pageablePlatforms(lib.platforms).find((p) => p.id === id) : undefined;
}

export async function generateStaticParams() {
  const lib = await platformLibrary();
  return (lib ? pageablePlatforms(lib.platforms) : []).map((p) => ({ id: p.id }));
}

export async function generateImageMetadata({ params }: { params: Promise<{ id: string }> }) {
  const p = await find((await params).id);
  return [{ id: "card", size, contentType, alt: cardAlt(p ? platformCard(p) : DEFAULT_CARD) }];
}

export default async function Image({ params }: { params: Promise<{ id: string }> }) {
  const p = await find((await params).id);
  return renderCard(p ? platformCard(p) : DEFAULT_CARD);
}
