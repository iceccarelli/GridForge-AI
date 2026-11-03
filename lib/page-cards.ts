// The link card of every STATIC page, as a fixed registry. Dynamic pages (constraint, platform, engagement) draw theirs from their own
// data through the opengraph-image file convention; these pages have no per-page data to draw from, so what each card says is authored
// here, once, next to the others, and served by app/cards/[file]/route.tsx. A registry and not a free-form image generator: only these
// files exist, so the endpoint cannot be asked to draw anything else.
//
// A page that sets its own `openGraph` replaces the root's, including the root's card, so each of them names its image
// (`images: pageImages("id")`). tests/site/share-cards.test.ts fails for a page that does neither this nor has an image file of its own.

import { eurFromCents, PRODUCTS } from "@/lib/products";
import { cardAlt, CARD_SIZE, DEFAULT_CARD, type CardContent } from "@/lib/share-card";
import { SITE } from "@/lib/site";

export const PAGE_CARDS: Record<string, CardContent> = {
  about: {
    kicker: "About",
    title: SITE.name,
    subtitle: "A founder-led engineering practice for existing AI data halls: what we sell, what we do not, and how to reach us.",
    facts: [SITE.baseLocation, "Sells no equipment"],
  },
  pricing: {
    kicker: "Pricing",
    title: "Priced before you start",
    subtitle: "A free capacity check, metered software with a cap you set, and fixed-fee engineering engagements. No hourly billing.",
    facts: [`Engagements from ${eurFromCents(PRODUCTS.density_screen.amountCents)}`, "Free allowance", "Cap you set"],
  },
  products: {
    kicker: "Engagements",
    title: "Fixed-fee engineering for an existing hall",
    subtitle: "Each page states what you receive, what we need from you and what it is not.",
    facts: ["Density Screen", "Envelope Study", "Procurement Specification", "Hall Watch"],
  },
  platforms: {
    kicker: "Platform library",
    title: "What an existing hall is asked to carry",
    subtitle: "Published rack power, liquid share, flow and floor loading, with sources, and the platforms deliberately left out.",
    facts: ["Manufacturer-published", "Sources listed"],
  },
  constraints: {
    kicker: "Constraint reference",
    title: "The constraints that stop a hall taking AI racks",
    subtitle: "Electrical, thermal and physical limits, one page each: what runs out, the relation, a worked example, the relief.",
    facts: ["Electrical", "Thermal", "Physical", "Worked examples"],
  },
  qualify: {
    kicker: "Free capacity check",
    title: "What actually stops your hall?",
    subtitle: "Seven numbers in, the constraint that binds first out. No account, no card.",
    facts: ["Free", "No account", "Directional"],
  },
  evidence: {
    kicker: "Method",
    title: "How much has the world tested this number?",
    subtitle: "Evidence classes E0 to E7, and the calibration record that says how far the model has been checked against real sites.",
    facts: ["E0 assumed", "E7 observed in operation"],
  },
  "lead-times": {
    kicker: "Time to power",
    title: "How long does it take to relieve each constraint?",
    subtitle: "Indicative lead-time ranges from a reference library. Ranges, not quotations.",
    facts: ["Indicative", "Library ranges"],
  },
  developers: {
    kicker: "Machine interface",
    title: "Call the engine from your own software",
    subtitle: "JSON over HTTPS, MCP for agents and an OpenAPI description, with published unit pricing and an evidence class on every number.",
    facts: ["MCP", "OpenAPI", "Free allowance"],
  },
  reference: {
    kicker: "Worked example",
    title: "The deliverable, in full",
    subtitle: "A complete Envelope Study of a synthetic reference hall: the constraints, the costed ladder, the dates and their evidence.",
    facts: ["Synthetic reference hall", "Every figure labelled"],
  },
  observatory: {
    kicker: "Observatory",
    title: "What limits a synthetic AI hall",
    subtitle: "An invented hall followed from the grid connection to the rack, engine-modelled, with an evidence class on every figure.",
    facts: ["Synthetic", "Engine-modelled"],
  },
  intelligence: {
    kicker: "Intelligence",
    title: "Siting by time to power",
    subtitle: "Interconnection-queue signal and modelled time-to-energize across regions. A modelled subscription, not a verified-site portfolio.",
    facts: ["Modelled", "Subscription"],
  },
  compare: {
    kicker: "Free comparison",
    title: "Time-to-Power scenario comparison",
    subtitle: "Racks, the binding constraint and the date with its evidence class, dated only where the lead times support it.",
    facts: ["Free", "Evidence class on every date"],
  },
  deploy: {
    kicker: "Behind-the-meter",
    title: "Power deployment assessment",
    subtitle: "Grid, generation and storage architectures under a real contingency test, priced and dated where declared.",
    facts: ["Contingency tested", "Priced where declared"],
  },
  privacy: { kicker: "Legal", title: "Privacy", subtitle: "What this site collects, where it is stored, who processes it and how long it is kept.", facts: [SITE.name] },
  terms: { kicker: "Legal", title: "Terms", subtitle: "The terms on which engagements, subscriptions and metered API access are sold.", facts: [SITE.name] },
  security: { kicker: "Legal", title: "Security", subtitle: "How customer data, API keys and deliverables are protected, and what is not claimed to be certified.", facts: [SITE.name] },
};

export function pageImages(id: string) {
  const c = PAGE_CARDS[id] ?? DEFAULT_CARD;
  return [{ url: `/cards/${id}.png`, width: CARD_SIZE.width, height: CARD_SIZE.height, alt: cardAlt(c), type: "image/png" }];
}
