import dynamic from "next/dynamic";
import { AnswerCard } from "./AnswerCard";
import { displayUnit } from "@/lib/quantity-text";
import { BindingConstraintCard } from "./BindingConstraintCard";
import { CapacityCard } from "./CapacityCard";
import { CommercialActionCard } from "./CommercialActionCard";
import { EvidenceCard } from "./EvidenceCard";
import { MissingInputCard } from "./MissingInputCard";
import { NextActionCard } from "./NextActionCard";
import type { ResponseBlock } from "./types";

// The two charted cards pull in the charting library (about 100 kB transferred). A workspace visitor sees no chart until an answer
// contains one, so the library is its own chunk, requested only when such a block is first rendered.
const ChartPlaceholder = () => (
  <div className="panel p-5 data text-[11px] text-faint" role="status">
    Loading chart…
  </div>
);
const HeadroomLadderCard = dynamic(() => import("./HeadroomLadderCard").then((m) => m.HeadroomLadderCard), {
  ssr: false,
  loading: ChartPlaceholder,
});
const TimeToPowerCard = dynamic(() => import("./TimeToPowerCard").then((m) => m.TimeToPowerCard), {
  ssr: false,
  loading: ChartPlaceholder,
});

/**
 * The single place that maps a response block to its card. Every block in the
 * shared contract (answer | metric | constraint | missingInput | evidence |
 * commercialAction | nextAction) has exactly one renderer here — adding a new
 * block shape means adding one case, not touching the callers.
 */
export function BlockRenderer({
  block,
  onPrompt,
}: {
  block: ResponseBlock;
  onPrompt?: (prompt: string) => void;
}) {
  switch (block.type) {
    case "answer":
      return <AnswerCard block={block} />;
    case "constraint":
      return <BindingConstraintCard block={block} />;
    case "missingInput":
      return <MissingInputCard block={block} />;
    case "evidence":
      return <EvidenceCard block={block} />;
    case "commercialAction":
      return <CommercialActionCard block={block} />;
    case "nextAction":
      return <NextActionCard block={block} onPrompt={onPrompt} />;
    case "metric":
      switch (block.metricKind) {
        case "capacity":
          return <CapacityCard block={block} />;
        case "headroomLadder":
          return <HeadroomLadderCard block={block} />;
        case "timeToPower":
          return <TimeToPowerCard block={block} />;
        case "generic":
          return (
            <div className="panel p-5">
              <div className="eyebrow mb-1">{block.label.toUpperCase()}</div>
              <div className="data text-2xl font-semibold text-ghost">
                {block.quantity.value.toLocaleString()}
                <span className="text-sm text-faint ml-1">{displayUnit(block.quantity.unit)}</span>
              </div>
            </div>
          );
      }
  }
}
