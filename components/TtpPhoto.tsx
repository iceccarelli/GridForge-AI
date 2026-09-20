import Image from "next/image";
import { TTP_IMAGES, TtpImageId } from "@/lib/ttp-images";

interface TtpPhotoProps {
  id: TtpImageId;
  /** Applied to the aspect-ratio box that crops the image (e.g. "rounded-2xl
   * overflow-hidden border border-line aspect-[16/9]"). Must set a size or
   * an aspect-ratio — the image inside is absolutely positioned (`fill`). */
  className?: string;
  priority?: boolean;
  sizes?: string;
  objectPosition?: string;
  /** Hide the visible caption line (the alt text and provenance still travel
   * with the image via `alt`/`title`) — use only for small decorative crops
   * that sit right beside a visible caption elsewhere on the same card. */
  hideCaption?: boolean;
  captionClassName?: string;
}

/**
 * Renders one Time to Power reference photograph with its honesty caption.
 * Every render carries: "Reference photography — not a customer site; not
 * measured evidence." per the gridforge / honesty-kernel skills — do not
 * render TTP_IMAGES directly with next/image, use this wrapper instead.
 */
export function TtpPhoto({
  id,
  className,
  priority,
  sizes = "(min-width: 1024px) 50vw, 100vw",
  objectPosition = "50% 50%",
  hideCaption,
  captionClassName,
}: TtpPhotoProps) {
  const image = TTP_IMAGES[id];
  return (
    <figure>
      <div className={`relative ${className ?? ""}`}>
        <Image
          src={image.src}
          alt={image.alt}
          title={image.caption}
          fill
          priority={priority}
          sizes={sizes}
          style={{ objectFit: "cover", objectPosition }}
        />
      </div>
      {!hideCaption && (
        <figcaption
          className={
            captionClassName ??
            "data text-[10px] text-faint mt-1.5 tracking-wide"
          }
        >
          {image.caption}
        </figcaption>
      )}
    </figure>
  );
}
