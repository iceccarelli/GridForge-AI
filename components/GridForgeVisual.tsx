import Image from "next/image";
import type { FC } from "react";

export interface GridForgeVisualProps {
  slug: string;
  alt: string;
  priority?: boolean;
  className?: string;
  sizes?: string;
}

export const GridForgeVisual: FC<GridForgeVisualProps> = ({
  slug,
  alt,
  priority = false,
  className = "w-full h-auto rounded-xl border border-line bg-ink",
  sizes = "(max-width: 768px) 100vw, (max-width: 1200px) 80vw, 1200px",
}) => {
  return (
    <picture className="block">
      <source
        srcSet={`/images/visuals/${slug}.webp`}
        type="image/webp"
        sizes={sizes}
      />
      <Image
        src={`/images/visuals/${slug}.png`}
        alt={alt}
        width={1600}
        height={900}
        priority={priority}
        sizes={sizes}
        className={className}
        quality={90}
      />
    </picture>
  );
};
