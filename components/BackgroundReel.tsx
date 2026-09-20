"use client";

// Sitewide background chrome. Static CSS gradient + a faint engineering grid —
// no photography, no external requests. Replaces an earlier version that
// hotlinked six Unsplash stock photos behind every page; this is deliberately
// restrained (Bloomberg terminal x engineering desk, not a photo carousel),
// so it never competes with content and never loads anything remote.

export function BackgroundReel() {
  return (
    <div aria-hidden className="fixed inset-0 -z-10 overflow-hidden bg-ink">
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(1400px 800px at 78% -8%, rgba(0,229,255,0.10), transparent 60%), " +
            "radial-gradient(1100px 700px at 8% 105%, rgba(0,229,255,0.06), transparent 55%), " +
            "linear-gradient(180deg, #070b14 0%, #0a0f1c 45%, #070b14 100%)",
        }}
      />
      {/* Faint technical grid, the kind of thing on an engineering desk, not a stock photo. */}
      <div
        className="absolute inset-0 opacity-[0.05]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(148,163,184,0.5) 1px, transparent 1px), " +
            "linear-gradient(90deg, rgba(148,163,184,0.5) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, rgba(6,9,18,0.35) 0%, rgba(6,9,18,0.05) 32%, rgba(6,9,18,0.05) 66%, rgba(6,9,18,0.55) 100%)",
        }}
      />
    </div>
  );
}
