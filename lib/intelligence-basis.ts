// What the Intelligence signal is made of, one row per input: where it comes from, what KIND of number it is, and what it is not.
// The /intelligence page renders this list, so the sales page can promise exactly the inputs the dashboard uses and no more. Names and
// dates are read from the registries that hold them (the siting dataset, the queue evidence file); the two market feeds are named by
// their publishers, and tests/site/intelligence-page.test.ts checks those names against the provenance the data layer attaches to the
// same figures, so this list cannot drift from what the dashboard shows.

import { QUEUE_EVIDENCE_SOURCE } from "@/lib/queue-evidence";
import { SCORE_WEIGHTS, SITING_DATASET, SITING_REGIONS } from "@/lib/siting";

export type SignalKind = "MODELLED" | "MEASURED" | "ASSUMED" | "PUBLISHED PRICE" | "OBSERVED";

export interface SignalInput {
  id: "ranking" | "queue" | "btm" | "price" | "mix";
  kind: SignalKind;
  name: string;
  source: string;
  /** The time the figure describes, in words; "none" when the input is hand-set and has no date. */
  asOf: string;
  /** What it is NOT, so it cannot be mistaken for something it is not. */
  notThis: string;
}

const measuredMarkets = SITING_REGIONS.filter((r) => r.queueBasis === "measured").map((r) => r.market);

export const SIGNAL_INPUTS: SignalInput[] = [
  {
    id: "ranking",
    kind: "MODELLED",
    name: `Time-to-energize score across ${SITING_REGIONS.length} regions`,
    source: `${SITING_DATASET.label} Weights: ${Math.round(SCORE_WEIGHTS.speed * 100)}% speed, ${Math.round(SCORE_WEIGHTS.cost * 100)}% cost, ${Math.round(SCORE_WEIGHTS.queue * 100)}% congestion.`,
    asOf: "none: hand-set, not dated",
    notThis: "Not a verified-site portfolio, and not a measurement at any site. The calibration ledger against instrumented sites is empty.",
  },
  {
    id: "queue",
    kind: "MEASURED",
    name: `Queue wait for ${measuredMarkets.join(", ")}`,
    source: `${QUEUE_EVIDENCE_SOURCE.attribution}.`,
    asOf: `measured ${QUEUE_EVIDENCE_SOURCE.measuredOn}; ${QUEUE_EVIDENCE_SOURCE.contextLabel}`,
    notThis: "The median for generation and storage projects that reached operation. Not a load-connection time and not the probability that a request is connected; most requests never are.",
  },
  {
    id: "btm",
    kind: "ASSUMED",
    name: "Behind-the-meter time-to-energized",
    source: "An assumption set for the comparison, per region.",
    asOf: "none: assumed",
    notThis: "Not a quotation, a lead time or a delivery date.",
  },
  {
    id: "price",
    kind: "PUBLISHED PRICE",
    name: "Day-ahead power price, Germany/Luxembourg",
    source: "EPEX Spot day-ahead auction via aWATTar.",
    asOf: "the delivery hour shown, with the time it was retrieved; or Unavailable",
    notThis: "A price set in advance for one hour: context, not a measurement of now and not headroom at any site.",
  },
  {
    id: "mix",
    kind: "OBSERVED",
    name: "German generation mix",
    source: "Fraunhofer ISE Energy-Charts.",
    asOf: "the interval the feed reports, with the time it was retrieved; or Unavailable",
    notThis: "Germany's grid, shown as context. Not the mix at any site and not cooling or compute load.",
  },
];
