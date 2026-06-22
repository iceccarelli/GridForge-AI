// ============================================================================
// GridForge AI — single source of truth for site content.
// Every market figure here is sourced from public 2025–2026 research and is
// a claim about the MARKET, not about GridForge's track record. Capability
// and stage language is deliberately honest: this is a founder-led, pilot-
// stage engineering practice. Do not add fabricated customers or metrics.
// ============================================================================

export const SITE = {
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

// What GridForge actually sells today — real, deliverable engineering work.
export const SERVICES = [
  {
    icon: "search",
    title: "Power Audit & Site Assessment",
    desc: "Behind-the-meter feasibility, load profiling, interconnection-status review, and risk modeling for a candidate site. A clear, evidence-based go / no-go.",
    deliverable: "Go / no-go decision + preliminary sizing",
    timeline: "10–14 days",
    flagship: true,
  },
  {
    icon: "trending",
    title: "Feasibility Study & Financial Model",
    desc: "LCOE, IRR, and sensitivity analysis across fuel, storage, and incentive scenarios. Built to survive an investment committee, not a pitch deck.",
    deliverable: "Bankable financial model + offtake options",
    timeline: "3–5 weeks",
    flagship: false,
  },
  {
    icon: "ruler",
    title: "Integration Design & Engineering",
    desc: "Single-line diagrams, protection coordination, EMS architecture, and vendor selection for a hybrid behind-the-meter system. Ready to hand to an EPC.",
    deliverable: "Ready-to-permit design package",
    timeline: "Scoped per site",
    flagship: false,
  },
  {
    icon: "check",
    title: "Commissioning & EMS Tuning",
    desc: "On-site or remote commissioning support, performance validation, and tuning of the predictive control layer against real load telemetry.",
    deliverable: "Validated performance + tuned controls",
    timeline: "Engagement-based",
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
    a: "GridForge is pilot-stage and founder-led. The reference architectures shown are validated engineering designs, not delivered customer projects — and we say so plainly. We're actively seeking the first reference deployment, which is exactly why early partners get direct founder engagement.",
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

// Modular configurator reference variants. These map to the REF-0x designs in
// ARCHITECTURES — indicative sizing envelopes, not fixed quotes.
export const CONFIG_VARIANTS = [
  {
    code: "REF-01-S",
    name: "Skid · sub-40 MW",
    mwMax: 40,
    firmMix: "Gas baseload + BESS",
    deployMonths: 14,
    note: "Single-skid hybrid for a first phase or edge training pod.",
  },
  {
    code: "REF-01-M",
    name: "Containerized · 40–120 MW",
    mwMax: 120,
    firmMix: "Gas + fuel-cell firming + BESS + renewables",
    deployMonths: 18,
    note: "Phased containerized build; capacity tracks the cluster ramp.",
  },
  {
    code: "REF-01-L",
    name: "Campus · 120 MW+",
    mwMax: 9_999,
    firmMix: "Multi-genset + fuel cell + utility-scale BESS + PPA",
    deployMonths: 24,
    note: "Campus-scale hybrid with grid as secondary reliability layer.",
  },
] as const;

// Indicative pricing bands for the productized services. Fixed-scope entry
// points; ranges, not quotes — every engagement is scoped to the site.
export const PACKAGES = [
  { tier: "Power Audit & Site Assessment", band: "€25k–€45k", basis: "Fixed scope · 10–14 days", anchor: true },
  { tier: "Feasibility Study & Financial Model", band: "€45k–€95k", basis: "Per site · 3–5 weeks" },
  { tier: "Integration Design & Engineering", band: "Scoped per site", basis: "Quoted after feasibility" },
] as const;
