// ============================================================================
// GridForge AI — single source of truth for site content.
// Every market figure here is sourced from public 2025–2026 research and is
// a claim about the MARKET, not about GridForge's track record. Capability
// and stage language is deliberately honest: this is a founder-led, pilot-
// stage engineering practice. Do not add fabricated customers or metrics.
// ============================================================================

/**
 * The site's own address, in one place.
 *
 * It was in six: layout metadata, JSON-LD, robots.txt, sitemap.xml, llms.txt and
 * the citation endpoint all hardcoded a Vercel preview domain, while every email,
 * Stripe success URL and deliverable link hardcoded the real one. Search engines
 * and AI crawlers were being told the canonical home of the site was a preview
 * URL, which splits authority away from the domain that actually serves it — and
 * the citation we ask people to use pointed at the wrong place.
 *
 * Set NEXT_PUBLIC_SITE_URL on a preview deployment. Everything else follows.
 */
export const SITE_URL: string = (
  process.env.NEXT_PUBLIC_SITE_URL ||
  process.env.SITE_URL ||
  "https://timetopower.ai"
).replace(/\/$/, "");

export function siteUrl(path = ""): string {
  if (!path) return SITE_URL;
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export const SITE = {
  url: SITE_URL,
  // Social profiles — fill in each URL as the account goes live.
  // Leave as empty string to keep the footer icon inactive (renders, links to #).
  social: {
    linkedin: "",
    x: "",
    youtube: "",
    medium: "",
    bluesky: "",
    instagram: "",
    facebook: "",
  },
  name: "GridForge AI",
  tagline: "Speed to Power for AI Data Centers",
  email: "power@gridforge.ai",
  founder: "Vincenzo Grimaldi",
  founderUrl: "https://igrimaldi.engineering",
  repo: "https://github.com/iceccarelli/GridForge-AI",
  baseLocation: "Frankfurt, DE · Toronto, CA",
};

// Market facts — each is publicly sourced. Shown as the market reality the
// buyer already lives in, never as GridForge's own results.
export const MARKET_STATS = [
  {
    value: "68 GW",
    label: "Global AI data-center power demand by 2027",
    source: "RAND, 2025",
  },
  {
    value: "~2,600 GW",
    label: "Capacity stuck in US interconnection queues",
    source: "FERC / LBNL, 2025",
  },
  {
    value: "5–8 yrs",
    label: "Typical grid interconnection wait in key US markets",
    source: "FERC / PJM, 2025",
  },
  {
    value: "18–24 mo",
    label: "On-site behind-the-meter power can deploy in",
    source: "Industry, 2026",
  },
];

export const PROBLEM_CARDS = [
  {
    kind: "queue" as const,
    label: "The queue",
    body: "Roughly 2,600 GW of generation sits in US interconnection queues — more than the entire installed US grid. Average waits in key markets now run 5 to 8 years from application to energized.",
    source: "FERC / LBNL, 2025",
  },
  {
    kind: "queue" as const,
    label: "The cost of waiting",
    body: "A data center can be built in two to three years — but it is useless until it can draw power. The IEA estimates ~20% of planned data-center projects globally face significant grid-driven delays.",
    source: "IEA Energy & AI, 2025",
  },
  {
    kind: "power" as const,
    label: "The shift",
    body: "Developers are moving behind-the-meter: on-site gas, hybrid storage, and co-location with generation can energize a site in 18–24 months instead of waiting on the queue.",
    source: "Industry analysis, 2026",
  },
];

/**
 * What can actually be bought.
 *
 * This advertised a Power Audit, a Feasibility Study with LCOE and IRR, an
 * Integration Design package ready to hand to an EPC, and commissioning of a
 * predictive control layer. None of it is a thing this practice does, two of them
 * would require owning energy assets that the capital rule forbids outright, and
 * the fee bands attached to them existed nowhere in the engine's catalogue.
 *
 * A services list describing a different company is not an aspiration. It is a
 * claim, and the first competent buyer to ask for a reference finds out.
 *
 * Prices are deliberately NOT here. They live in lib/products.ts, parity-tested
 * against gridforge/commercial.py, so a fee cannot be quoted on a page the engine
 * has never heard of.
 */
export const SERVICES = [
  {
    icon: "search",
    title: "Density Screen",
    desc: "One hall, five working days. What binds first, how many racks of your target platform it carries as it stands and after the costed ladder, which item sets the energisation date, and the inputs nobody has measured.",
    deliverable: "Screening document, the first six rungs of the ladder, and a data request",
    timeline: "5 working days",
    flagship: true,
  },
  {
    icon: "trending",
    title: "Capacity & Density Envelope Study",
    desc: "Five cooling architectures compared under one model, the full headroom ladder with costs and lead times, time to power, sensitivity, economics, and the provenance of every figure.",
    deliverable: "Envelope Study, a walkthrough with your engineers, and a model pack you keep",
    timeline: "25 working days",
    flagship: false,
  },
  {
    icon: "ruler",
    title: "Procurement Specification",
    desc: "The tender document the study implies: every duty derived from a constraint in your hall and quoted at your site's own conditions, never at a manufacturer's reference condition. We name no make and no model.",
    deliverable: "Specification, a response schedule, and your bids ranked in racks and weeks",
    timeline: "12 working days",
    flagship: false,
  },
  {
    icon: "check",
    title: "Hall Watch",
    desc: "The model stays live. Re-solved on a cadence and whenever you change an input, with a change note naming what moved and which input moved it — including when the movement came from our side.",
    deliverable: "A quarterly change note, and an unlimited re-run when your numbers change",
    timeline: "Continuous",
    flagship: false,
  },
];

// Reference ARCHITECTURES — engineering designs and capabilities, explicitly
// not delivered customer projects. Honest, and still demonstrates depth.
export const ARCHITECTURES = [
  {
    code: "REF-01",
    title: "Hybrid Behind-the-Meter Microgrid",
    spec: "Gas / fuel-cell + BESS + on-site renewables",
    summary:
      "Containerized, skid-mounted hybrid topology with DC-native coupling, sized for spiky GPU training loads up to ~120 MW per site. N+1 redundancy and bidirectional flow built in.",
    points: [
      "Bypasses multi-year interconnection queues",
      "Fuel-flexible, phased-capacity design",
      "Sized from a real load profile, not a rule of thumb",
    ],
  },
  {
    code: "REF-02",
    title: "High-Voltage DC Distribution",
    spec: "400–800 V DC bus · direct-to-rack",
    summary:
      "DC distribution architecture for GPU-dense clusters that removes AC↔DC conversion stages and exposes per-rack power telemetry, with hot-swap modular PDUs.",
    points: [
      "Cuts conversion-stage losses",
      "Native 48 V–800 V rack compatibility",
      "Per-rack power visibility for the EMS",
    ],
  },
  {
    code: "REF-03",
    title: "Physics-Informed EMS",
    spec: "Predictive control for spiky loads",
    summary:
      "A deterministic control layer that forecasts training / inference spikes from telemetry and physics, optimizing charge/discharge and enabling peak shaving — designed to integrate with existing BMS and grid EMS.",
    points: [
      "Predictive peak shaving, not reactive",
      "Second-life BESS integration support",
      "API-first for orchestration",
    ],
  },
];

export const TECH = [
  {
    title: "Hybrid microgrid architectures",
    body: "Containerized hybrid topologies with DC-native coupling, designed around the load profiles of AI training and inference clusters — phased so capacity tracks the build-out.",
  },
  {
    title: "Physics-informed control",
    body: "Deterministic models that combine physics with real-time telemetry to forecast and respond to GPU power spikes — enabling genuine peak shaving rather than oversized headroom.",
  },
  {
    title: "Second-life BESS integration",
    body: "BMS and thermal-management approaches for retired EV packs that lower capex while holding round-trip efficiency and warranty-grade safety.",
  },
  {
    title: "Founder-led engineering",
    body: "Every design starts from first principles — power-flow physics and control theory — not a vendor catalog. Background in grid intelligence and cyber-physical systems.",
  },
];

export const FAQ = [
  {
    q: "Are these systems already deployed?",
    a: "GridForge is pilot-stage and founder-led. The reference architectures shown are engineering designs — modelled and internally reviewed, not validated against a delivered project — and we say so plainly. We're actively seeking the first reference deployment, which is exactly why early partners get direct founder engagement.",
  },
  {
    q: "What can I actually buy today?",
    a: "Engineering services: Power Audits, Feasibility Studies, Integration Design packages, and commissioning support. These are concrete, fixed-scope deliverables a senior power-systems engineer produces for your specific site.",
  },
  {
    q: "How is on-site power faster than the grid?",
    a: "Interconnection queues in key markets run 5–8 years. On-site behind-the-meter generation (gas / fuel cell + storage) can be permitted and energized in roughly 18–24 months, decoupling your compute schedule from the utility's.",
  },
  {
    q: "Who is this for?",
    a: "AI data-center developers, colocation providers, and the investors backing them — anyone whose compute roadmap is gated by time-to-power in a constrained market.",
  },
];

// ============================================================================
// INTERACTIVE DEMO DATA
// Parameters for the on-site EMS load simulator. The simulator renders a
// DETERMINISTIC, illustrative model — not measured field data. Every figure
// it derives is computed live from these inputs in the browser; nothing here
// is presented as a delivered result. Labeled "illustrative model" in the UI.
// ============================================================================

export const EMS_SIM = {
  // Window of the simulated trace, in seconds.
  windowSeconds: 120,
  samples: 121,
  // Nominal cluster draw the stack is sized around (MW). User-adjustable.
  defaultLoadMW: 80,
  loadRangeMW: [20, 200] as const,
  // Share of average load covered by on-site renewables (user-adjustable).
  defaultRenewablePct: 25,
  // Physical response characteristics of each layer of the stack. These are
  // ordinary engineering ranges for the equipment class, used to shape the
  // illustrative curves — not a spec sheet for a specific product.
  stack: {
    gas: { label: "Gas baseload", color: "#FFB020", rampSecondsToFull: 300 },
    fuelCell: { label: "Fuel-cell firming", color: "#A78BFA", rampSecondsToFull: 12 },
    bess: { label: "BESS (sub-second)", color: "#00E5FF", rampSecondsToFull: 0.4 },
    renewables: { label: "On-site renewables", color: "#34D399", rampSecondsToFull: 0 },
  },
  // A training checkpoint/all-reduce causes a sharp, brief collective transient.
  // Public load studies of large training jobs show exactly this signature.
  spike: { magnitudePct: 38, widthSeconds: 4, source: "Meta/LLNL training-load studies, 2024–2025" },
} as const;

// Time-to-Power comparator defaults (drives the interactive sliders).
export const COMPARATOR = {
  defaultMW: 80,
  mwRange: [10, 250] as const,
  // Queue wait the user can dial in for their market, in months.
  defaultQueueMonths: 72,
  queueRange: [36, 108] as const,
  onSiteMonths: 18,
  // Illustrative revenue-at-risk per MW-year of delayed compute. User can edit.
  // Anchored to public colo lease ranges; labeled as an assumption, not a quote.
  defaultRevPerMWYear: 1_400_000,
  revSource: "Derived from public hyperscale colo lease ranges, 2025",
} as const;

// TWO BLOCKS WERE REMOVED HERE, AND WHY.
//
// CONFIG_VARIANTS described skid / containerized / campus builds to "120 MW+"
// with gensets, fuel cells, utility-scale BESS, PPAs and deployment months
// attached. We do not build, own or fund any of that, and the capital rule is
// explicit that physical deployment is customer-funded. Sizing envelopes for
// plant we would never supply are fictitious capacity wearing the clothes of a
// product sheet.
//
// PACKAGES was a second price list — Power Audit EUR 25k-45k, Feasibility Study
// EUR 45k-95k — which /pricing rendered ABOVE the real engagement ladder. A buyer
// met two unrelated fee structures from two different businesses on one page.
// Neither band existed anywhere in the engine's commercial catalogue, so the
// parity test could not see them and nothing failed.
//
// The catalogue in lib/products.ts, parity-tested against gridforge/commercial.py,
// is the only price list. Prices do not live in this file.
