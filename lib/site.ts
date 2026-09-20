// ============================================================================
// GridForge AI — single source of truth for site content.
// Every market figure here is sourced from public 2025–2026 research and is
// a claim about the MARKET, not about GridForge's track record. Capability
// and stage language is deliberately honest: this is a founder-led, pilot-
// stage engineering practice. Do not add fabricated customers or metrics.
// ============================================================================

import { PRODUCTS, eurFromCents, type ProductId } from "@/lib/products";

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

/**
 * Where a Stripe checkout is allowed to send somebody afterwards.
 *
 * The checkout routes built success_url and cancel_url from the request's own
 * Origin header, which the caller sets. So anyone could mint a real Checkout
 * Session against this merchant whose success page was their own domain: the
 * payment still reached us, but the customer finished their purchase on somebody
 * else's site, wearing our credibility on the way out.
 *
 * Nothing leaked — the session id in that URL is not a credential and no route
 * accepts one — so this is a phishing and brand vector rather than a theft
 * vector. It is also two lines to close.
 *
 * An origin is honoured only if it is the site's own. Everything else falls back
 * to SITE_URL, which a preview deployment sets through NEXT_PUBLIC_SITE_URL and
 * which is therefore already correct there.
 */
export function checkoutOrigin(requestOrigin: string | null | undefined): string {
  if (!requestOrigin) return SITE_URL;
  try {
    const given = new URL(requestOrigin);
    const mine = new URL(SITE_URL);
    if (given.origin === mine.origin) return given.origin;
  } catch {
    /* not a URL at all */
  }
  return SITE_URL;
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
  name: "Time to Power",
  tagline: "Power-Capacity Intelligence for AI Infrastructure",
  email: "power@gridforge.ai",
  founder: "Vincenzo Grimaldi",
  founderUrl: "https://igrimaldi.engineering",
  repo: "https://github.com/iceccarelli/GridForge-AI",
  baseLocation: "Frankfurt, DE · Toronto, CA",
};

// Market facts — each is publicly sourced (see docs/04_MARKET_EVIDENCE.md).
// Shown as the market reality the buyer already lives in, never as our own
// results.
export const MARKET_STATS = [
  {
    value: "82%",
    label: "Operators whose highest-density rack still runs below 30 kW",
    source: "Uptime Institute, 2025",
  },
  {
    value: "420 MW",
    label: "European AI-focused colo signings, H1 2026 (vs 89 MW H1 2025)",
    source: "CBRE, 2026",
  },
  {
    value: "160+ wks",
    label: "Transformer lead time, up from 120 weeks in 2024",
    source: "Data Center Knowledge, 2026",
  },
  {
    value: "6.4%",
    label: "FLAP-D colocation vacancy — supply is not the constraint",
    source: "JLL EMEA Data Centre Report, 2026",
  },
];

export const PROBLEM_CARDS = [
  {
    kind: "queue" as const,
    label: "The grid is the asset",
    body: "In core European metros, new grid connections are blocked for years — Frankfurt has essentially no chance of a new large connection before 2030, Amsterdam's queue runs ~10 years. The only fast way to add AI capacity is to get more useful compute out of power a site already has.",
    source: "Mainova / TNW, 2026",
  },
  {
    kind: "power" as const,
    label: "The density gap",
    body: "82% of operators' densest rack still runs below 30 kW, and fewer than 4% of facilities can host 100 kW+ racks. Nobody in the building can say, in writing, the highest kW/rack they will commit to today — or what stops them at that number.",
    source: "Uptime Institute, 2025",
  },
  {
    kind: "power" as const,
    label: "The binding constraint is usually electrical",
    body: "At high density, power distribution creates more problems than cooling: busway, tap-off units, transformer lead time, floor loading. A thermal-only or power-only answer is wrong by construction — the envelope has to be solved together.",
    source: "Uptime Institute (Bizo), 2026",
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
 * Prices are deliberately NOT typed here. Each card names a catalogue id and
 * serviceCards() resolves the name, the fee, the turnaround and what the buyer
 * receives out of lib/products.ts, which is parity-tested against
 * gridforge/commercial.py. A card can therefore describe only something that is
 * genuinely for sale, at the price checkout genuinely charges.
 */
export interface ServiceCard {
  productId: ProductId;
  icon: "search" | "trending" | "ruler" | "check";
  desc: string;
  flagship: boolean;
}

export const SERVICES: ServiceCard[] = [
  {
    productId: "density_screen",
    icon: "search",
    desc:
      "One hall, five working days. What binds first, how many racks of your target platform it carries as it stands and after the costed ladder, which item sets the energisation date, and the inputs nobody has measured.",
    flagship: true,
  },
  {
    productId: "envelope_study_deposit",
    icon: "trending",
    desc:
      "Five cooling architectures compared under one model, the full headroom ladder with costs and lead times, time to power, sensitivity, economics, and the provenance of every figure.",
    flagship: false,
  },
  {
    productId: "procurement_spec",
    icon: "ruler",
    desc:
      "The tender document the study implies: every duty derived from a constraint in your hall and quoted at your site's own conditions, never at a manufacturer's reference condition. We name no make and no model.",
    flagship: false,
  },
  {
    productId: "hall_watch",
    icon: "check",
    desc:
      "The model stays live. Re-solved on a cadence and whenever you change an input, with a change note naming what moved and which input moved it — including when the movement came from our side.",
    flagship: false,
  },
];

/**
 * A service card, resolved against the catalogue.
 *
 * `title`, `deliverable`, the fee and the turnaround all come from
 * lib/products.ts. They used to be typed here as well, which meant the home page
 * said "5 working days" in one file and `turnaroundDays: 5` in another, and the
 * only thing keeping them equal was that nobody had edited either recently.
 */
export function serviceCards() {
  return SERVICES.map((s) => {
    const p = PRODUCTS[s.productId];
    return {
      ...s,
      title: p.name,
      deliverable: p.deliverable,
      price: eurFromCents(p.amountCents),
      recurring: p.recurring
        ? p.recurring.intervalCount === 3
          ? "per quarter"
          : `per ${p.recurring.interval}`
        : null,
      timeline: p.recurring
        ? "Continuous"
        : `${p.turnaroundDays} working days`,
    };
  });
}

// The technology underneath the ladder. No hardware, no owned plant — the
// engine and the two assets that compound with every engagement.
export const TECH = [
  {
    title: "A deterministic constraint engine",
    body: "Thirteen constraint families — busway, transformer, UPS, grid firm capacity, CDU, hydraulics, floor loading and more — solved jointly over one envelope. The binding constraint is the minimum; a single wrong assumption cannot hide behind a good-looking average.",
  },
  {
    title: "Evidence class and provenance on every number",
    body: "Every figure carries an evidence class, E0 (assumed) to E7 (observed in operation), and a provenance chain back to its source. Arithmetic propagates the weakest input — a conclusion can never read as more certain than what it was built from.",
  },
  {
    title: "The Headroom Ladder",
    body: "Each rung relieves one binding constraint, priced and lead-timed, with the racks it unlocks. Time to power names the single item that sets your energisation date — not a vendor's typical lead time, yours.",
  },
  {
    title: "A calibration ledger that says so when it's empty",
    body: "Every modelled envelope is checked against measured outcomes as they arrive. Today the ledger reads UNCALIBRATED on most constraints, and every deliverable says so. That honesty is the point — and the reason it gets harder to copy with every hall we screen.",
  },
];

export const FAQ = [
  {
    q: "Is the calibration ledger real, or is this a demo?",
    a: "Time to Power is pilot-stage and founder-led, and the calibration ledger says so on every deliverable: most constraints read UNCALIBRATED today, because the field-validation dataset is still thin. That is the honest state of the model, not a marketing gap — it is the first thing we work to fix on every paid engagement, and it is published rather than hidden.",
  },
  {
    q: "What can I actually buy today?",
    a: "Fixed-fee engagements, all priced on the pricing page before we start. Most halls begin with the Density Screen: one hall, five working days, what binds it first, how many racks of your target platform it carries as it stands and after the costed ladder, and the list of inputs nobody has measured. It credits in full against the Capacity & Density Envelope Study. Above that sit the Procurement Specification, the Portfolio Screen and Hall Watch. Nothing is billed by the hour, and we quote no equipment and take no margin on hardware.",
  },
  {
    q: "Do you sell or install equipment?",
    a: "No. We sell the decision — what binds your hall, what relieves it, what that costs, and when the compute goes live. We name no make and no model, we hold no inventory, and we own no megawatts. Physical work, if any, is procured and funded by you.",
  },
  {
    q: "Who is this for?",
    a: "Operators of an existing hall being asked for AI-density racks they cannot yet confirm, and the investors or tenants evaluating whether a site can actually take the load — anyone whose compute roadmap is gated by a physical constraint nobody in the building has named yet.",
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
