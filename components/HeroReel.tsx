import Image from "next/image";
import { TTP_IMAGES } from "@/lib/ttp-images";

// Hero background: the Time to Power reference photograph of an existing
// data-center campus and its electrical connection (ttp-01). Static, not a
// rotating stock-photo reel — the pack's own cropping guidance keeps the
// electrical yard center-right and leaves the left third as negative space
// for the headline. This is generated reference photography, not a customer
// site or measured evidence; the honesty caption is rendered by the caller
// in the hero copy (see app/page.tsx), and the alt/title text below carries
// it as well for anyone landing on the image directly.
const HERO = TTP_IMAGES["ttp-01"];

export function HeroReel() {
  return (
    <div className="absolute inset-0 overflow-hidden">
      <Image
        src={HERO.src}
        alt={HERO.alt}
        title={HERO.caption}
        fill
        priority
        sizes="100vw"
        style={{ objectFit: "cover", objectPosition: "70% 50%" }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(90deg, rgba(6,9,18,0.92) 0%, rgba(6,9,18,0.55) 45%, rgba(6,9,18,0.18) 100%)",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(6,9,18,0.55) 0%, rgba(6,9,18,0.10) 35%, rgba(6,9,18,0.35) 100%)",
        }}
      />
      <div className="absolute inset-0 blueprint opacity-15" />
    </div>
  );
}
