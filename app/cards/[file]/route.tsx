import { PAGE_CARDS } from "@/lib/page-cards";
import { renderCard } from "@/lib/share-card";

// Prerendered at build, one PNG per entry of the registry. dynamicParams = false: any other name is a 404, so this is not an image generator.
export const dynamic = "force-static";
export const dynamicParams = false;

export function generateStaticParams() {
  return Object.keys(PAGE_CARDS).map((id) => ({ file: `${id}.png` }));
}

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const m = /^([a-z-]+)\.png$/.exec((await params).file);
  const id = m?.[1] ?? "";
  const card = id && Object.prototype.hasOwnProperty.call(PAGE_CARDS, id) ? PAGE_CARDS[id] : null;
  if (!card) return new Response("Not found", { status: 404 });
  const res = renderCard(card);
  res.headers.set("cache-control", "public, max-age=86400, stale-while-revalidate=604800");
  return res;
}
