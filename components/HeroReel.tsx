"use client";

import { useEffect, useMemo, useState } from "react";

// Hero-only background reel. Six power-grid / transmission images, distinct from
// the site-wide BackgroundReel (data centers). Renders inside the hero at z-0,
// above the global reel, so the first section has its own identity.

const HERO_IMAGES = [
  "1473341304170-971dccb5ac1e",
  "1413882353314-73389f63b6fd",
  "1610028290816-5d937a395a49",
  "1543489816-c87b0f5f7dd4",
  "1639066648921-82d4500abf1a",
  "1451187580459-43490279c0fa",
];

const SRC = (id: string, w = 2560) => `https://images.unsplash.com/photo-${id}?w=${w}&q=85&auto=format&fit=crop`;

function shuffle<T>(a: T[]): T[] {
  const r = [...a];
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
  return r;
}

export function HeroReel() {
  const order = useMemo(() => shuffle(HERO_IMAGES), []);
  const [idx, setIdx] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    setIsMobile(window.matchMedia("(max-width: 768px)").matches);
    order.forEach((id) => { const i = new Image(); i.src = SRC(id); });
    const t = setInterval(() => setIdx((i) => (i + 1) % order.length), 8000);
    return () => clearInterval(t);
  }, [order]);

  const animate = !reduced && !isMobile;
  return (
    <div className="absolute inset-0 overflow-hidden">
      <style>{`
        @keyframes heroKenBurns {
          0%   { transform: scale(1.04) translate(0, 0); }
          100% { transform: scale(1.20) translate(-1.5%, -1%); }
        }
      `}</style>
      {order.map((id, i) => {
        const active = i === idx;
        return (
          <div key={id} className="absolute inset-0" style={{ opacity: active ? 1 : 0, transition: "opacity 1500ms ease-in-out" }}>
            <div className="absolute inset-0" style={{
              backgroundImage: `url(${SRC(id, isMobile ? 1280 : 2560)})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              filter: "brightness(1.45) contrast(1.05) saturate(1.18)",
              transform: animate ? undefined : "scale(1.06)",
              animation: animate && active ? "heroKenBurns 9000ms ease-out forwards" : undefined,
              willChange: "transform, opacity",
            }} />
          </div>
        );
      })}
      <div className="absolute inset-0" style={{ background: "linear-gradient(90deg, rgba(6,9,18,0.88) 0%, rgba(6,9,18,0.42) 45%, rgba(6,9,18,0.12) 100%)" }} />
      <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(6,9,18,0.55) 0%, rgba(6,9,18,0.10) 35%, rgba(6,9,18,0.35) 100%)" }} />
      <div className="absolute inset-0 blueprint opacity-15" />
    </div>
  );
}
