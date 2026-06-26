"use client";

import { useEffect, useMemo, useState } from "react";

// Cinematic background reel. Fixed full-screen layer behind all content. Six
// verified Unsplash images (data center + power infrastructure) slow-zoom with
// a Ken Burns drift and crossfade. Order is randomized per visit. A calibrated
// gradient keeps content crisp while the imagery still reads — Tesla-style:
// motion and depth behind, content always leading.

const IMAGES = [
  "1639066648921-82d4500abf1a", // server racks, blue-lit
  "1682559736721-c2e77ff4c650", // wires into a server
  "1451187580459-43490279c0fa", // network / earth, blue-toned
  "1736517323453-6aec5ed21947", // modern data center building
  "1737524174470-6a5e3df3750b", // data center building, cool tone
  "1666723342543-8d2f7e0e1a2e", // server hall, cyan
];

const SRC = (id: string) =>
  `https://images.unsplash.com/photo-${id}?w=2400&q=80&auto=format&fit=crop`;

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const HOLD_MS = 9000; // time each image is shown before crossfade

export function BackgroundReel() {
  const order = useMemo(() => shuffle(IMAGES), []);
  const [idx, setIdx] = useState(0);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    setReduced(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    // Preload all images so crossfades never flash.
    order.forEach((id) => { const img = new Image(); img.src = SRC(id); });
    const t = setInterval(() => setIdx((i) => (i + 1) % order.length), HOLD_MS);
    return () => clearInterval(t);
  }, [order]);

  return (
    <div aria-hidden className="fixed inset-0 -z-10 overflow-hidden bg-ink">
      {order.map((id, i) => (
        <div
          key={id}
          className="absolute inset-0"
          style={{
            opacity: i === idx ? 1 : 0,
            transition: "opacity 2200ms ease-in-out",
          }}
        >
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${SRC(id)})`,
              backgroundSize: "cover",
              backgroundPosition: "center",
              filter: "brightness(1.3) contrast(1.06) saturate(1.15)",
              transform: i === idx && !reduced ? "scale(1.16)" : "scale(1.05)",
              transition: reduced ? "none" : "transform 11000ms ease-out",
              willChange: "transform, opacity",
            }}
          />
        </div>
      ))}
      {/* Calibrated overlay: dark enough for crisp text, light enough that the
          imagery still reads. Slightly stronger at top/bottom for nav + footer. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(6,9,18,0.80) 0%, rgba(6,9,18,0.42) 30%, rgba(6,9,18,0.40) 68%, rgba(6,9,18,0.82) 100%)",
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
