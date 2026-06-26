"use client";

import { useEffect, useMemo, useState } from "react";

// Cinematic background reel. Fixed full-screen layer behind all content. Six
// verified Unsplash images (data center + power infrastructure) slow-zoom with
// a Ken Burns drift and crossfade. Order is randomized per visit. A calibrated
// gradient keeps content crisp while the imagery still reads — Tesla-style:
// motion and depth behind, content always leading.

const IMAGES = [
  "1639066648921-82d4500abf1a",
  "1682559736721-c2e77ff4c650",
  "1451187580459-43490279c0fa",
  "1736517323453-6aec5ed21947",
  "1737524174470-6a5e3df3750b",
  "1558494949-ef010cbdcc31",
];

const SRC = (id: string, w = 2560) =>
  `https://images.unsplash.com/photo-${id}?w=${w}&q=85&auto=format&fit=crop`;

const PANS = [
  { from: "scale(1.06) translate(0%, 0%)",     to: "scale(1.24) translate(-2.5%, -1.8%)" }, // push in, drift up-left
  { from: "scale(1.20) translate(2%, 1.5%)",   to: "scale(1.05) translate(-1.5%, -1%)" },   // pull back, drift
  { from: "scale(1.08) translate(-2%, 0%)",    to: "scale(1.22) translate(2.5%, -1.5%)" },  // pan left-to-right, zoom
  { from: "scale(1.22) translate(0%, -2%)",    to: "scale(1.08) translate(1.5%, 2%)" },     // descend, pull back
  { from: "scale(1.06) translate(1.5%, 1.5%)", to: "scale(1.22) translate(-2%, -2.5%)" },   // diagonal push
  { from: "scale(1.18) translate(-1.5%, 1%)",  to: "scale(1.06) translate(2%, -1.5%)" },    // sweep right, settle
];
const EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)"; // filmic ease-out

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const HOLD_MS = 10000; // time each image is shown before crossfade

export function BackgroundReel() {
  const order = useMemo(() => shuffle(IMAGES), []);
  const [idx, setIdx] = useState(0);
  const [reduced, setReduced] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    setIsMobile(window.matchMedia("(max-width: 768px)").matches);
    // Preload all images so crossfades never flash.
    order.forEach((id) => { const img = new Image(); img.src = SRC(id, isMobile ? 1280 : 2560); });
    const t = setInterval(() => setIdx((i) => (i + 1) % order.length), HOLD_MS);
    return () => clearInterval(t);
  }, [order]);

  const animate = !reduced && !isMobile;
  return (
    <div aria-hidden className="fixed inset-0 -z-10 overflow-hidden bg-ink">
      <style>{`
        ${[0,1,2,3,4,5].map((k) => `
          @keyframes bgKB${k} {
            0%   { transform: ${PANS[k].from}; }
            100% { transform: ${PANS[k].to}; }
          }
        `).join("")}
      `}</style>
      {order.map((id, i) => {
        const active = i === idx;
        return (
        <div
          key={id}
          className="absolute inset-0"
          style={{
            opacity: active ? 1 : 0,
            transition: "opacity 1600ms ease-in-out",
          }}
        >
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${SRC(id, isMobile ? 1280 : 2560)})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              filter: "brightness(1.45) contrast(1.05) saturate(1.18)",
              transform: animate ? PANS[i % PANS.length].from : "scale(1.08)",
              animation: animate && active ? `bgKB${i % PANS.length} 17000ms ${EASE} forwards` : undefined,
              willChange: "transform, opacity",
            }}
          />
        </div>
        );
      })}
      {/* Calibrated overlay: dark enough for crisp text, light enough that the
          imagery still reads. Slightly stronger at top/bottom for nav + footer. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(6,9,18,0.74) 0%, rgba(6,9,18,0.30) 32%, rgba(6,9,18,0.28) 66%, rgba(6,9,18,0.78) 100%)",
        }}
      />
      {/* Faint brand tint for cohesion with the power-blue accent. */}
      <div
        className="absolute inset-0"
        style={{ background: "radial-gradient(1200px 600px at 70% 20%, rgba(56,189,248,0.06), transparent 60%)" }}
      />
    </div>
  );
}
