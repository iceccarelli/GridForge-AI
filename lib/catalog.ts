// Productized behind-the-meter power blocks — derived from REF-01 (hybrid
// containerized microgrid). These are reference configurations a senior
// power-systems engineer scopes and engineers per site, NOT off-the-shelf
// hardware we stock. Specs are honest engineering envelopes, not guarantees.

export interface PowerBlock {
  id: string;
  name: string;
  capacityMW: number;
  /** Typical firm (always-on) share for this block, %. */
  firmPct: number;
  generation: string;
  storage: string;
  cooling: string;
  footprint: string;
  /** Time-to-energized vs. a 5–8yr interconnection queue. */
  leadTime: string;
  redundancy: string;
  /** Who this block typically fits. */
  fitFor: string;
  /** Headline use case the market pays for. */
  tagline: string;
  flagship?: boolean;
}

export const POWER_BLOCKS: PowerBlock[] = [
  {
    id: "edge-1",
    name: "Edge Block · 1 MW",
    capacityMW: 1,
    firmPct: 90,
    generation: "Gas genset or fuel cell + PV tie-in",
    storage: "0.5–1 MWh BESS buffer",
    cooling: "Air / liquid-ready PDU interface",
    footprint: "1× 40ft container + pad",
    leadTime: "8–16 weeks to energized",
    redundancy: "N (optional N+1)",
    fitFor: "Edge inference, pilot clusters, single-rack-row sites",
    tagline: "Stand up a megawatt while the queue says 2031.",
  },
  {
    id: "pod-5",
    name: "Pod Block · 5 MW",
    capacityMW: 5,
    firmPct: 85,
    generation: "Gas + fuel-cell hybrid, PV-augmented",
    storage: "2–4 MWh BESS",
    cooling: "Liquid-to-rack CDU interface",
    footprint: "3–4 containers, skid-mounted",
    leadTime: "16–28 weeks to energized",
    redundancy: "N+1",
    fitFor: "Mid-size GPU pods, training annexes, colo expansion",
    tagline: "A self-sufficient power pod for a GPU hall.",
  },
  {
    id: "cluster-20",
    name: "Cluster Block · 20 MW",
    capacityMW: 20,
    firmPct: 80,
    generation: "Multi-unit gas + fuel cell, DC-native coupling",
    storage: "8–12 MWh BESS, bidirectional",
    cooling: "Direct-liquid, 400–800V DC bus option",
    footprint: "Containerized farm, ~0.5–1 acre",
    leadTime: "6–12 months to energized",
    redundancy: "N+1, phased capacity",
    fitFor: "Dedicated training clusters, neocloud build-outs",
    tagline: "Bypass the interconnection queue at cluster scale.",
    flagship: true,
  },
  {
    id: "campus-50",
    name: "Campus Block · 50+ MW",
    capacityMW: 50,
    firmPct: 75,
    generation: "Phased hybrid plant, fuel-flexible",
    storage: "20+ MWh BESS, grid-forming",
    cooling: "Full DC distribution, per-rack telemetry",
    footprint: "Multi-acre, modular phased build",
    leadTime: "12–24 months, phased online",
    redundancy: "N+1 to 2N, islandable",
    fitFor: "Hyperscale training campuses, sovereign AI sites",
    tagline: "Hyperscale power, energized years before the grid.",
  },
];
