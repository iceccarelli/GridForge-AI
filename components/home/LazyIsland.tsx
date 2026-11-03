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
  timeToPower: dynamic(() => import("@/components/TimeToPower").then((m) => m.TimeToPower), { ssr: false }),
};

export type IslandName = keyof typeof ISLANDS;

export function LazyIsland({
  which,
  minHeight,
  label,
  compact,
  rootMargin = "400px 0px",
}: {
  which: IslandName;
  /** Pixels reserved before the tool mounts, so its arrival does not move the content below it. */
  minHeight: number;
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
  return (
    <div ref={ref} style={{ minHeight }} aria-busy={!near}>
      {near ? (
        <Island compact={compact} />
      ) : (
        <p className="data text-[11px] text-faint">{label}</p>
      )}
    </div>
  );
}
