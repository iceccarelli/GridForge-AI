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

const PANS = [
  { from: "scale(1.06) translate(0%, 0%)",     to: "scale(1.24) translate(-2.5%, -1.8%)" }, // push in, drift up-left
  { from: "scale(1.20) translate(2%, 1.5%)",   to: "scale(1.05) translate(-1.5%, -1%)" },   // pull back, drift
  { from: "scale(1.08) translate(-2%, 0%)",    to: "scale(1.22) translate(2.5%, -1.5%)" },  // pan left-to-right, zoom
  { from: "scale(1.22) translate(0%, -2%)",    to: "scale(1.08) translate(1.5%, 2%)" },     // descend, pull back
  { from: "scale(1.06) translate(1.5%, 1.5%)", to: "scale(1.22) translate(-2%, -2.5%)" },   // diagonal push
  { from: "scale(1.18) translate(-1.5%, 1%)",  to: "scale(1.06) translate(2%, -1.5%)" },    // sweep right, settle
];
const EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)"; // filmic ease-out

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
    const t = setInterval(() => setIdx((i) => (i + 1) % order.length), 9000);
    return () => clearInterval(t);
  }, [order]);

  const animate = !reduced && !isMobile;
  return (
    <div className="absolute inset-0 overflow-hidden">
      <style>{`
        ${[0,1,2,3,4,5].map((k) => `
          @keyframes heroKB${k} {
            0%   { transform: ${PANS[k].from}; }
            100% { transform: ${PANS[k].to}; }
          }
        `).join("")}
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
              transform: animate ? PANS[i % PANS.length].from : "scale(1.08)",
              animation: animate && active ? `heroKB${i % PANS.length} 16000ms ${EASE} forwards` : undefined,
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
