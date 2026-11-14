import type { FC } from "react";

export interface GridForgeVisualProps {
  slug: string;
  alt: string;
  caption?: string;
  priority?: boolean;
  className?: string;
  sizes?: string;
}

export const GridForgeVisual: FC<GridForgeVisualProps> = ({
  slug,
  alt,
  caption,
  priority = false,
  className = "w-full h-auto rounded-xl border border-line bg-ink",
  sizes = "(max-width: 768px) 100vw, (max-width: 1200px) 80vw, 1200px",
}) => {
  const picture = (
    <picture className="block">
      <source
        srcSet={`/images/visuals/${slug}.webp`}
        type="image/webp"
        sizes={sizes}
      />
      <img
        src={`/images/visuals/${slug}.png`}
        alt={alt}
        width={1600}
        height={900}
        loading={priority ? "eager" : "lazy"}
        decoding="async"
        className={className}
      />
    </picture>
  );

  if (!caption) return picture;

  return (
    <figure className="space-y-2">
      {picture}
      <figcaption className="data text-[11px] leading-relaxed text-faint tracking-wide">
        {caption}
      </figcaption>
    </figure>
  );
};
