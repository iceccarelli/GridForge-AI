// Siting-region intelligence dataset. Each region carries a mix of LIVE feed
// data (where a real source exists) and MODELED estimates (documented, not
// invented). Every figure is labeled so subscribers know what's live vs modeled.
// Modeled values are grounded in published interconnection-queue reports and
// typical industrial tariff ranges as of early 2026 — directional, not bankable.

export type Provenance = "live" | "modeled";

export interface SitingRegion {
  id: string;
  market: string;        // ISO / market operator
  region: string;        // human label
  country: string;
  // Typical industrial / large-load power cost, €/MWh-equivalent (modeled band midpoint)
  powerCost: number;
  powerCostProvenance: Provenance;
  // Estimated interconnection queue wait, months (modeled from ISO queue reports)
  queueWaitMonths: number;
  // Estimated BTM time-to-energized, months (the GridForge alternative)
  btmMonths: number;
  // Renewable share %, live where grid feed exists else modeled
  renewablePct: number;
  renewableProvenance: Provenance;
  // Queue congestion 0-100 (modeled: higher = more backlogged)
  congestion: number;
  note: string;
}

// NOTE: powerCost/renewablePct for the DE row are overwritten with LIVE values
// at runtime from useMarket(); the static values here are fallbacks.
export const SITING_REGIONS: SitingRegion[] = [
  {
    id: "ercot-tx", market: "ERCOT", region: "Texas (West/Permian)", country: "US",
    powerCost: 38, powerCostProvenance: "modeled",
    queueWaitMonths: 42, btmMonths: 10, renewablePct: 31, renewableProvenance: "modeled",
    congestion: 72, note: "Deregulated, no FERC on BTM gen, strong gas + wind. Fast BTM path.",
  },
  {
    id: "pjm-va", market: "PJM", region: "Northern Virginia (Data Center Alley)", country: "US",
    powerCost: 52, powerCostProvenance: "modeled",
    queueWaitMonths: 60, btmMonths: 14, renewablePct: 11, renewableProvenance: "modeled",
    congestion: 94, note: "Most congested DC market on earth. Queue effectively closed; BTM is the unlock.",
  },
  {
    id: "miso-mw", market: "MISO", region: "Midwest (Indiana/Ohio)", country: "US",
    powerCost: 44, powerCostProvenance: "modeled",
    queueWaitMonths: 48, btmMonths: 12, renewablePct: 22, renewableProvenance: "modeled",
    congestion: 80, note: "Cheap land, industrial base, but multi-year queue. BTM competitive.",
  },
  {
    id: "spp-ks", market: "SPP", region: "Kansas / Oklahoma", country: "US",
    powerCost: 35, powerCostProvenance: "modeled",
    queueWaitMonths: 40, btmMonths: 10, renewablePct: 41, renewableProvenance: "modeled",
    congestion: 58, note: "Wind-rich, low cost, lighter queue. Strong hybrid BTM economics.",
  },
  {
    id: "de-eu", market: "EPEX (DE-LU)", region: "Germany / Central EU", country: "DE",
    powerCost: 90, powerCostProvenance: "live",
    queueWaitMonths: 54, btmMonths: 12, renewablePct: 45, renewableProvenance: "live",
    congestion: 76, note: "High wholesale + grid fees; BTM avoids both. Live EPEX feed below.",
  },
  {
    id: "nordics", market: "Nord Pool", region: "Nordics (Sweden/Finland)", country: "EU",
    powerCost: 48, powerCostProvenance: "modeled",
    queueWaitMonths: 36, btmMonths: 11, renewablePct: 68, renewableProvenance: "modeled",
    congestion: 49, note: "Cheap hydro/nuclear, cool climate, but remote. Lowest carbon option.",
  },
];

// Fastest-to-energize score: rewards low BTM time + low cost + low congestion.
// Higher = better place to put an AI site you need powered fast.
export function sitingScore(r: SitingRegion): number {
  const speed = Math.max(0, 100 - r.btmMonths * 5);      // 10mo -> 50
  const cost = Math.max(0, 100 - r.powerCost);            // lower €/MWh better
  const queue = 100 - r.congestion;                       // less congested better
  return Math.round(speed * 0.45 + cost * 0.3 + queue * 0.25);
}

// --- Cost-of-delay: the core hook. Quantifies what the interconnection queue
// costs vs. the BTM path, in euros. The per-MW-month value is the CUSTOMER's
// own stranded-value assumption (default conservative, fully adjustable) — a
// sophisticated buyer trusts a transparent model they can tune over a black box.
export interface DelayResult {
  monthsSaved: number;
  avoidedEur: number;
  queueCostEur: number;
  btmCostEur: number;
  valuePerMwMonth: number;
}

export function costOfDelay(
  mw: number,
  region: SitingRegion,
  valuePerMwMonth = 25000
): DelayResult {
  const monthsSaved = Math.max(0, region.queueWaitMonths - region.btmMonths);
  const queueCostEur = mw * valuePerMwMonth * region.queueWaitMonths;
  const btmCostEur = mw * valuePerMwMonth * region.btmMonths;
  return {
    monthsSaved,
    avoidedEur: mw * valuePerMwMonth * monthsSaved,
    queueCostEur,
    btmCostEur,
    valuePerMwMonth,
  };
}

export function eurCompact(n: number): string {
  if (n >= 1e9) return "€" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "€" + (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return "€" + (n / 1e3).toFixed(0) + "K";
  return "€" + Math.round(n).toLocaleString("en-IE");
}
