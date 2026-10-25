// Captions derived from the journey, so the on-screen caption and the WebVTT track are ONE text: a cue is exactly a step's
// caption over exactly that step's time span. Pure; integer milliseconds throughout so timing never drifts.

import type { JourneyStep } from "@/lib/observatory/types";

export interface Cue { startSec: number; endSec: number; text: string }

const toMs = (sec: number) => Math.round((Number.isFinite(sec) && sec > 0 ? sec : 0) * 1000);

/** One cue per step with a non-empty caption, contiguous and non-overlapping, in journey order. */
export function cuesFor(steps: JourneyStep[]): Cue[] {
  const cues: Cue[] = [];
  let startMs = 0;
  for (const s of steps) {
    const endMs = startMs + toMs(s.durationSec);
    if (endMs > startMs && s.caption.trim() !== "") cues.push({ startSec: startMs / 1000, endSec: endMs / 1000, text: s.caption });
    startMs = endMs;
  }
  return cues;
}

/** hh:mm:ss.mmm */
export function vttTime(sec: number): string {
  const total = toMs(sec);
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000) % 60;
  const h = Math.floor(total / 3600000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}.${p(ms, 3)}`;
}

/** WebVTT cue text may not contain "&", "<" or "-->" literally; ">" is escaped too, which also breaks any "-->". Newlines become spaces. */
export function escapeVtt(text: string): string {
  return text
    .replace(/\s*[\r\n]+\s*/g, " ")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .trim();
}

export function toWebVtt(steps: JourneyStep[]): string {
  const blocks = cuesFor(steps).map((c, i) => `${i + 1}\n${vttTime(c.startSec)} --> ${vttTime(c.endSec)}\n${escapeVtt(c.text)}`);
  return ["WEBVTT", ...blocks].join("\n\n") + "\n";
}

// ---------------------------------------------------------------------------------------------------------------------
// Honesty lint: the rules a caption must pass. Used by the tests on every caption the journey produces, and available to a
// build step; it returns the list of violations (empty = clean).
// ---------------------------------------------------------------------------------------------------------------------

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
// An amount of money next to a currency word, in either order, with or without "million"/"thousand" between.
const EUR_PRICE = /(€|\bEUR\b|\beuros?\b)\s?\d|\d[\d.,]*\s?(?:million|thousand|bn|m|k)?\s?(€|\bEUR\b|\beuros?\b)/i;
// The ONE form in which a euro figure may appear in a caption: the engine's modelled capital cost of a synthetic hall option,
// never a price of anything a visitor can buy. It must say "Modelled capital cost" and, when partial, "at least".
const MODELLED_CAPEX = /Modelled capital cost (?:at least )?\d+(?:\.\d+)? (?:million|thousand) euros/g;
const PURCHASE = /\b(buy|purchase|purchased|checkout|subscribe|subscription|order now|add to cart|per month|per year)\b/i;
/** "live" is allowed only when it is being denied ("not a live reading", "not live"): nothing in a caption is a live value. */
const LIVE = /\blive\b/gi;
const LIVE_DENIED = /\bnot (?:a |an )?$/i;

export function lintCaption(text: string): string[] {
  const problems: string[] = [];
  if (EMAIL.test(text)) problems.push("contains an email address");
  if (EUR_PRICE.test(text.replace(MODELLED_CAPEX, ""))) problems.push("contains a price in EUR");
  if (PURCHASE.test(text)) problems.push("contains a purchase or pricing word");
  if (/\bunlimited\b|not supported by the inputs/i.test(text)) problems.push('says "unlimited" or "not supported by the inputs" (a constraint with no finite limit passes)');
  if (/\bthis hour\b|\bright now\b|\bat the moment\b/i.test(text)) problems.push("claims a moment (a recorded caption cannot say now)");
  for (const m of text.matchAll(LIVE)) {
    if (!LIVE_DENIED.test(text.slice(Math.max(0, m.index - 8), m.index))) {
      problems.push('uses "live" for something that is not a live observation');
      break;
    }
  }
  return problems;
}
