// The link card: the 1200x630 image every platform (Facebook, LinkedIn, WhatsApp, Slack, iMessage, Telegram, Discord, X, Bluesky) shows
// when a page of this site is shared, drawn from the page's own data so it can never say something the page does not.
//
// Layout (safe area kept inside 80 px of every edge, because some platforms crop to 1:1 or 4:3 on mobile):
//   mark + wordmark                                           timetopower.ai
//   KICKER
//   Title (up to three lines)
//   subtitle (up to three lines)
//   fact · fact · fact
//
// next/og draws it with a flexbox subset of CSS and the bundled font only, so: every container is display:flex, there is no grid, and
// text is clamped before it is drawn (a long line is shortened with an ellipsis, never allowed to run off the card).

import { ImageResponse } from "next/og";
import { SITE } from "@/lib/site";

export const CARD_SIZE = { width: 1200, height: 630 } as const;
export const CARD_TYPE = "image/png" as const;

const INK = "#070B14";
const PANEL = "#0E1726";
const POWER = "#00E5FF";
const TEXT = "#F3F7FB";
const MUTE = "#9FB3C8";

export interface CardContent {
  /** Small caps line above the title: what kind of page this is. */
  kicker: string;
  title: string;
  subtitle?: string;
  /** Short facts drawn as chips under the text. Each must be a figure or phrase that is on the page. */
  facts?: string[];
}

/** Shorten to at most `max` characters on a word boundary, with an ellipsis. */
export function clamp(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[ ,;:.\-–—]+$/, "")}…`;
}

/** Title size steps down as the title grows, so a long platform or constraint name still fits in three lines. */
export function titleSize(title: string): number {
  return title.length <= 28 ? 76 : title.length <= 48 ? 64 : title.length <= 72 ? 54 : 46;
}

export function cardElement(c: CardContent) {
  const title = clamp(c.title, 96);
  const subtitle = c.subtitle ? clamp(c.subtitle, 170) : "";
  const facts = (c.facts ?? []).slice(0, 4).map((f) => clamp(f, 38));
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        padding: "64px 80px",
        background: `linear-gradient(135deg, ${INK} 0%, ${PANEL} 100%)`,
        color: TEXT,
        fontFamily: "sans-serif",
        borderLeft: `10px solid ${POWER}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <svg width="52" height="52" viewBox="0 0 64 64">
            <rect width="64" height="64" rx="16" fill={POWER} />
            <path d="M35 12 L18 36 H30 L26 52 L46 26 H33 Z" fill={INK} stroke={INK} strokeWidth="1.5" strokeLinejoin="round" />
          </svg>
          <div style={{ display: "flex", marginLeft: 18, fontSize: 28, fontWeight: 700, letterSpacing: 4, textTransform: "uppercase" }}>{SITE.name}</div>
        </div>
        <div style={{ display: "flex", fontSize: 26, color: MUTE }}>{new URL(SITE.url).host}</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", fontSize: 24, letterSpacing: 5, textTransform: "uppercase", color: POWER, marginBottom: 22 }}>{clamp(c.kicker, 60)}</div>
        <div style={{ display: "flex", fontSize: titleSize(title), fontWeight: 700, lineHeight: 1.08, maxHeight: 3 * titleSize(title) * 1.08 }}>{title}</div>
        {subtitle ? (
          <div style={{ display: "flex", marginTop: 26, fontSize: 30, lineHeight: 1.3, color: MUTE, maxWidth: 980 }}>{subtitle}</div>
        ) : null}
      </div>

      <div style={{ display: "flex" }}>
        {facts.map((f) => (
          <div
            key={f}
            style={{ display: "flex", marginRight: 16, padding: "10px 20px", border: `2px solid ${POWER}`, borderRadius: 999, fontSize: 24, color: TEXT }}
          >
            {f}
          </div>
        ))}
      </div>
    </div>
  );
}

export function renderCard(c: CardContent): ImageResponse {
  return new ImageResponse(cardElement(c), { ...CARD_SIZE });
}

/** The alt text for the card (what a screen reader or a platform's alt field says): the same words, in a sentence. */
export function cardAlt(c: CardContent): string {
  return clamp([c.kicker, c.title, c.subtitle].filter(Boolean).join(". "), 200);
}

/** The site-wide card: the home page, and every page that does not draw its own. */
export const DEFAULT_CARD: CardContent = {
  kicker: "Power-capacity intelligence for AI infrastructure",
  title: "How much AI compute can your hall carry, and when?",
  subtitle: "Thirteen constraints solved jointly. The one that binds first, named, with an evidence class on every number.",
  facts: ["Free capacity check", "Fixed-fee engagements", "Machine interface"],
};
