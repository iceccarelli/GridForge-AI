// Provenance wording for the market and grid context. SERVER ONLY (it imports the data layer's own freshness rule, which lives in
// lib/observatory/sources.ts, so the page and the data layer can never disagree about what is fresh); the interactive panels never
// import this file.
import type { Basis, Freshness, Observed, Provenance } from "@/lib/observatory/types";
import { reassessFreshness } from "@/lib/observatory/sources";
import { fmtAge, fmtDate, fmtUtc } from "@/components/observatory/format";

/**
 * Freshness at `now`, by the data layer's rule (freshnessOf, via reassessFreshness): no value, an unparseable time, a time further
 * in the future than the allowed skew, or no time at all where a limit applies, is "unavailable"; past its limit is "stale". The
 * result is never better than what the data layer said when it labelled the value, so a cached page cannot upgrade a reading.
 */
export function effectiveFreshness(obs: Observed<unknown>, now: Date): Freshness {
  if (obs.value === null || obs.value === undefined) return "unavailable";
  if (obs.freshness === "unavailable" || obs.freshness === "not_applicable") return obs.freshness;
  const r = reassessFreshness(obs, now);
  return r === "fresh" && obs.freshness === "stale" ? "stale" : r;
}

/** A reading younger than this is the only thing that may be called "live". Older readings are "the latest reading". */
export const LIVE_MAX_AGE_SECONDS = 20 * 60;

/** "Live" wording: an observation, fresh now, AND recent by a tight limit (a reading hours old is not live even inside its allowance). */
export function isLive(obs: Observed<unknown>, now: Date): boolean {
  if (obs.provenance.basis !== "observed" || effectiveFreshness(obs, now) !== "fresh") return false;
  const ref = obs.provenance.observedAt ?? obs.provenance.retrievedAt;
  const t = ref ? Date.parse(ref) : NaN;
  return Number.isFinite(t) && now.getTime() - t <= LIVE_MAX_AGE_SECONDS * 1000;
}

/** "12 min before this page was generated": the age of a retrieval relative to the page, which does not go stale in a cached page. */
export function retrievedBefore(iso: string | null | undefined, now: Date): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const sec = Math.max(0, (now.getTime() - t) / 1000);
  return sec < 60 ? "less than a minute before this page was generated" : `${fmtAge(sec)} before this page was generated`;
}

export const BASIS_WORDS: Record<Basis, string> = {
  observed: "A reading of the real world for a stated interval.",
  day_ahead_auction:
    "A price published by the day-ahead auction for one delivery period. It is a price set in advance, not a measurement of now.",
  published_report: "A figure from a dated public report. It is current as of that date only.",
  engine_modelled: "Computed by the GridForge engine from the stated inputs.",
  synthetic_input: "An invented demonstration input.",
  assumed: "An assumption or library default (evidence class E0).",
};

export interface ProvenanceView {
  live: boolean;
  headline: string;
  freshness: Freshness;
  freshnessText: string;
  basisText: string;
  source: string;
  observedAt: string;
  retrievedAt: string;
  /** "12 min before this page was generated", or null when there is no retrieval time. */
  retrievedAgo: string | null;
  caveat: string | null;
}

function headlineFor(p: Provenance, fresh: Freshness, live: boolean): string {
  if (fresh === "unavailable") return "Unavailable";
  if (live) return "Live reading";
  switch (p.basis) {
    case "observed":
      return fresh === "stale" ? "Latest reading, stale" : "Latest reading";
    case "day_ahead_auction":
      return "Published auction price for this delivery hour";
    case "published_report":
      return `Published report as of ${fmtDate(p.observedAt)}`;
    case "engine_modelled":
      return "Computed by the GridForge engine";
    case "synthetic_input":
      return "Invented demonstration input";
    default:
      return "Assumed value (E0)";
  }
}

export function viewProvenance(obs: Observed<unknown>, now: Date): ProvenanceView {
  const p = obs.provenance;
  const fresh = effectiveFreshness(obs, now);
  const live = isLive(obs, now);
  const limit = p.maxAgeSeconds === null ? null : fmtAge(p.maxAgeSeconds);
  const freshnessText =
    fresh === "fresh"
      ? limit ? `Fresh: within the allowed ${limit}` : "Fresh"
      : fresh === "stale"
        ? limit ? `Stale: older than the allowed ${limit}` : "Stale"
        : fresh === "unavailable"
          ? "Unavailable"
          : "Not applicable";
  return {
    live,
    headline: headlineFor(p, fresh, live),
    freshness: fresh,
    freshnessText,
    basisText: BASIS_WORDS[p.basis] ?? "Basis not stated.",
    source: p.source,
    observedAt: fmtUtc(p.observedAt),
    retrievedAt: fmtUtc(p.retrievedAt),
    retrievedAgo: retrievedBefore(p.retrievedAt, now),
    caveat: p.caveat ?? null,
  };
}
