"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";

// Heavy, below-the-fold tools mount only when the reader scrolls near them. Their code is a separate chunk that is not requested at all
// until then, so none of it (the charting library, the live market feed, the three-parameter model) costs the first load or the first
// interaction. Each island reserves its height so nothing shifts when it arrives, and the page makes no request on its behalf before that.

const ISLANDS = {
  liveConsole: dynamic(() => import("@/components/LiveConsole").then((m) => m.LiveConsole), { ssr: false }),
  comparator: dynamic(() => import("@/components/TimeToPowerComparator").then((m) => m.TimeToPowerComparator), { ssr: false }),
  insights: dynamic(() => import("@/components/BindingConstraintInsights").then((m) => m.BindingConstraintInsights), { ssr: false }),
  liveScenario: dynamic(() => import("@/components/LiveScenario").then((m) => m.LiveScenario), { ssr: false }),
  timeToPower: dynamic(() => import("@/components/TimeToPower").then((m) => m.TimeToPower), { ssr: false }),
};

export type IslandName = keyof typeof ISLANDS;

/**
 * Pixels reserved before a tool mounts: one number, or one per width band (below md, from md, from lg). The heights are MEASURED, not
 * guessed: each tool's rendered height at 360, 390, 768, 1280 and 1440 px wide, taken in Chromium after mount (see the table at the call
 * sites in Sections.tsx). A box reserved too small makes the page jump when the tool arrives, and on a phone that jump was most of a screen.
 */
export type ReservedHeight = number | { base: number; md?: number; lg?: number };

function reserved(h: ReservedHeight): { style: React.CSSProperties; className: string } {
  if (typeof h === "number") return { style: { minHeight: h }, className: "" };
  const md = h.md ?? h.base;
  const lg = h.lg ?? md;
  return {
    style: { "--mh-base": `${h.base}px`, "--mh-md": `${md}px`, "--mh-lg": `${lg}px` } as React.CSSProperties,
    className: "min-h-[var(--mh-base)] md:min-h-[var(--mh-md)] lg:min-h-[var(--mh-lg)]",
  };
}

export function LazyIsland({
  which,
  minHeight,
  label,
  compact,
  rootMargin = "400px 0px",
}: {
  which: IslandName;
  /** Pixels reserved before the tool mounts, so its arrival does not move the content below it. */
  minHeight: ReservedHeight;
  /** What the placeholder says to a reader who has not scrolled there, and to assistive technology. */
  label: string;
  compact?: boolean;
  rootMargin?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || near) return;
    // No IntersectionObserver (very old browsers, some crawlers): mount straight away rather than never.
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [near, rootMargin]);

  const Island = ISLANDS[which] as React.ComponentType<{ compact?: boolean }>;
  const box = reserved(minHeight);
  return (
    <div ref={ref} style={box.style} className={box.className} aria-busy={!near}>
      {near ? (
        <Island compact={compact} />
      ) : (
        <p className="data text-[11px] text-faint">{label}</p>
      )}
    </div>
  );
}
