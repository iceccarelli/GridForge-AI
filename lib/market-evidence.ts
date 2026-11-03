// The register of every market figure the site may state, with what was checked about it.
//
// A market figure is a claim about the market, never about this practice's results. Each record carries what a reader needs to
// judge it: the publisher, the date, the period and geography it measures, the definition, whether it is a fact, an estimate or a
// forecast, and how it was verified. A figure that could not be traced to a publisher is recorded here as "unverified" and is
// not allowed on a public page (tests/site/market-evidence.test.ts).
//
// Verification states, in order of strength. They describe what was actually done, not what was hoped:
//   primary    - the publisher's own page or report was opened and the figure read there
//   secondary  - the publisher's own page could not be opened; the figure is confirmed by independent press coverage that quotes it
//   qualified  - the figure exists but means something narrower or different from the wording first used; the corrected wording is
//                the one recorded here and the only one that may be shown
//   unverified - no original source was found; the figure must not appear on a public page
//
// "Checked" is a date, because a market figure goes stale: a later reader can see how old the check is.

export type Verification = "primary" | "secondary" | "qualified" | "unverified";
export type FigureKind = "fact" | "survey" | "estimate" | "forecast";

export interface MarketFigure {
  id: string;
  /** The wording that may appear on a page. */
  statement: string;
  /** The short value shown large on a stat tile, where one is used. */
  tile?: string;
  publisher: string;
  /** Publication date, as the publisher dated it. */
  published: string;
  period: string;
  geography: string;
  /** What is counted, and by whom. */
  definition: string;
  kind: FigureKind;
  verification: Verification;
  /** Where the original (or the coverage that quotes it) can be read. */
  url: string;
  /** What this verification could not establish. Empty only when nothing is outstanding. */
  caveat: string;
  /** Date the check was made (ISO). */
  checked: string;
}

export const MARKET_EVIDENCE: MarketFigure[] = [
  {
    id: "uptime-density-2025",
    statement: "More than 80% of surveyed operators say their highest rack density is below 30 kW.",
    tile: ">80%",
    publisher: "Uptime Institute, Global Data Center Survey 2025",
    published: "2025-07",
    period: "Survey fielded April to May 2025",
    geography: "Global",
    definition: "Share of respondents (owners and operators, more than 800) reporting that the highest rack power density they deploy is below 30 kW.",
    kind: "survey",
    verification: "secondary",
    url: "https://www.theregister.com/2025/08/03/capacity_planning_concern_datacenter_ops/",
    caveat:
      "Self-reported by respondents. The survey report itself was not opened; the figure is read from press coverage that quotes it as 'more than 80 percent'. The earlier wording on this site, a precise 82%, is not used.",
    checked: "2026-11-03",
  },
  {
    id: "cbre-europe-ai-colo-2026",
    statement: "European AI-focused colocation signings reached 420 MW in the first half of 2026, up from 89 MW in the first half of 2025.",
    tile: "420 MW",
    publisher: "CBRE, press release",
    published: "2026-08-17",
    period: "H1 2026 against H1 2025",
    geography: "Europe",
    definition: "Signings of colocation capacity for AI-focused customers, as tracked by CBRE.",
    kind: "fact",
    verification: "secondary",
    url: "https://www.cbre.co.uk/press-releases/ai-demand-drives-record-data-centre-signings-across-europe",
    caveat: "The CBRE page refused an automated fetch, so the figure is confirmed from three independent reports that quote it. It measures signings (contracts), not capacity energised.",
    checked: "2026-11-03",
  },
  {
    id: "jll-flapd-vacancy-q2-2026",
    statement: "Colocation vacancy across the FLAP-D markets was 6.4% in the second quarter of 2026, down from a 2021 peak of 16.9%.",
    tile: "6.4%",
    publisher: "JLL, EMEA Data Centre Report, mid-year 2026",
    published: "2026-08-03",
    period: "Q2 2026",
    geography: "Frankfurt, London, Amsterdam, Paris, Dublin",
    definition: "Colocation vacancy as measured by JLL. The page read does not define the denominator.",
    kind: "fact",
    verification: "primary",
    url: "https://www.jll.com/en-uk/insights/emea-data-centre-report",
    caveat:
      "Other brokers publish different vacancy figures for the same markets and period (a lower French edition of the same report, a higher CBRE Q1 figure), because definitions differ. Treat it as one broker's measure.",
    checked: "2026-11-03",
  },
  {
    id: "mainova-frankfurt-connections",
    statement: "Mainova, Frankfurt's utility, has said new high-power grid connections in the city will probably not be available again until about the mid-2030s.",
    tile: "mid-2030s",
    publisher: "Mainova AG, as reported in the German trade press",
    published: "2026",
    period: "Forward-looking statement",
    geography: "Frankfurt and the Rhine-Main region",
    definition: "Availability of new high-power (data-centre scale) grid connections.",
    kind: "forecast",
    verification: "secondary",
    url: "https://www.it-daily.net/shortnews/rechenzentren-strom-wird-knapp/?page=2",
    caveat:
      "A utility's own forecast, read from press reports and not from a Mainova document. One report gives 2035. The earlier wording on this site, 'before 2030', contradicted it and has been withdrawn.",
    checked: "2026-11-03",
  },
  {
    id: "transformer-lead-time",
    statement: "Transformer lead times are reported at roughly 130 to 160 weeks or more, depending on the type of transformer.",
    publisher: "Mixed trade and analyst reporting (Wood Mackenzie and others)",
    published: "2026",
    period: "2024 to 2026",
    geography: "Mainly the United States",
    definition: "Order-to-delivery time; the figure differs between standard large power, generator step-up and substation transformers.",
    kind: "estimate",
    verification: "unverified",
    url: "",
    caveat:
      "The earlier wording, '160+ weeks, up from 120 weeks in 2024, Data Center Knowledge 2026', could not be traced: no such article was found, and reported 2024 figures are 140 to 143 weeks, not 120. Not shown on any page until a primary source and an equipment class are read. The engine's own library range is a separate, labelled assumption.",
    checked: "2026-11-03",
  },
  {
    id: "facilities-100kw",
    statement: "Fewer than 4% of facilities can host racks of 100 kW or more.",
    publisher: "Not found",
    published: "",
    period: "",
    geography: "",
    definition: "",
    kind: "survey",
    verification: "unverified",
    url: "",
    caveat:
      "No source states this. Nearby published figures differ (about 1% of operators run racks above 100 kW in one Uptime reading; 9% report racks above 50 kW in the 2025 survey). Withdrawn from the site.",
    checked: "2026-11-03",
  },
  {
    id: "amsterdam-queue",
    statement: "Amsterdam's grid queue runs about ten years.",
    publisher: "Not found",
    published: "",
    period: "",
    geography: "Amsterdam",
    definition: "",
    kind: "estimate",
    verification: "unverified",
    url: "",
    caveat: "No source found for this wording. Withdrawn from the site; a grid operator's own congestion reporting would be the place to source a replacement.",
    checked: "2026-11-03",
  },
];

export function marketFigure(id: string): MarketFigure {
  const f = MARKET_EVIDENCE.find((m) => m.id === id);
  if (!f) throw new Error(`no market figure ${id}`);
  return f;
}

/** A figure may be shown on a public page only when something was actually read for it. */
export function isPublishable(f: MarketFigure): boolean {
  return f.verification !== "unverified";
}

export const PUBLISHABLE_FIGURES: MarketFigure[] = MARKET_EVIDENCE.filter(isPublishable);

/** "Uptime Institute, Global Data Center Survey 2025 (survey, July 2025)" - the line printed under a figure. */
export function figureCitation(f: MarketFigure): string {
  const when = f.published ? `, ${f.published}` : "";
  return `${f.publisher}${when}`;
}

/** How a reader is told how strongly the figure was checked. Plain words, never a badge that implies more. */
export function verificationLabel(v: Verification): string {
  switch (v) {
    case "primary":
      return "Read at the publisher";
    case "secondary":
      return "Confirmed in press coverage; the original was not opened";
    case "qualified":
      return "Wording narrowed to what the source says";
    case "unverified":
      return "No source found";
  }
}
