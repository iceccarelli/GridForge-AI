"use client";

import React, { useEffect, useState } from "react";

/**
 * Sticky section rail. Appears once the user scrolls past the hero and tracks
 * the active section with an IntersectionObserver (scroll-spy). Gives a buyer a
 * way to jump straight to the tool they care about on a now-long page.
 * Rendered only on the home page, where these section ids exist.
 */
const SECTIONS = [
  { id: "problem", label: "Problem" },
  { id: "intelligence", label: "Live data" },
  { id: "comparator", label: "Comparator" },
  { id: "simulator", label: "Simulator" },
  { id: "services", label: "Services" },
  { id: "how", label: "How it works" },
  { id: "architectures", label: "Architectures" },
  { id: "configure", label: "Configure" },
  { id: "single-line", label: "Architecture" },
  { id: "faq", label: "FAQ" },
];

const NAV_OFFSET = 124; // main navbar + this rail

export function SectionNav() {
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState<string>("");

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > 620);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter(
      (el): el is HTMLElement => el !== null
    );
    const obs = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) setActive(e.target.id);
        });
      },
      { rootMargin: "-130px 0px -65% 0px", threshold: 0 }
    );
    els.forEach((el) => obs.observe(el));
    return () => obs.disconnect();
  }, []);

  const go = (id: string) => {
    const el = document.getElementById(id);
    if (!el) return;
    const top = el.getBoundingClientRect().top + window.scrollY - NAV_OFFSET;
    window.scrollTo({ top, behavior: "smooth" });
  };

  return (
    <div
      className={`fixed inset-x-0 z-40 top-16 sm:top-20 transition-all duration-300 ${
        visible
          ? "opacity-100 translate-y-0"
          : "opacity-0 -translate-y-2 pointer-events-none"
      }`}
      aria-hidden={!visible}
    >
      <div className="nav-glass border-b border-line">
        <div className="max-w-7xl mx-auto px-4 sm:px-6">
          <div className="flex items-center gap-1 h-11 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <span className="eyebrow text-[9px] text-faint pr-3 hidden sm:inline shrink-0">
              JUMP TO
            </span>
            {SECTIONS.map((s) => {
              const on = active === s.id;
              return (
                <button
                  key={s.id}
                  onClick={() => go(s.id)}
                  className={`relative shrink-0 px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                    on ? "text-power" : "text-mute hover:text-ghost"
                  }`}
                >
                  {s.label}
                  {on && (
                    <span className="absolute left-3 right-3 -bottom-px h-px bg-power" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
