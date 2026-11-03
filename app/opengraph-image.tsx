import { CARD_SIZE, CARD_TYPE, DEFAULT_CARD, cardAlt, renderCard } from "@/lib/share-card";
import { SITE } from "@/lib/site";

// The default card, used by every page that does not draw its own.
export const alt = cardAlt({ ...DEFAULT_CARD, title: `${SITE.name}: ${DEFAULT_CARD.title}` });
export const size = CARD_SIZE;
export const contentType = CARD_TYPE;

export default function Image() {
  return renderCard(DEFAULT_CARD);
}
