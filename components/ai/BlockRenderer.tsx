import { AnswerCard } from "./AnswerCard";
import { BindingConstraintCard } from "./BindingConstraintCard";
import { CapacityCard } from "./CapacityCard";
import { CommercialActionCard } from "./CommercialActionCard";
import { EvidenceCard } from "./EvidenceCard";
import { HeadroomLadderCard } from "./HeadroomLadderCard";
import { MissingInputCard } from "./MissingInputCard";
import { NextActionCard } from "./NextActionCard";
import { TimeToPowerCard } from "./TimeToPowerCard";
import type { ResponseBlock } from "./types";

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
                <span className="text-sm text-faint ml-1">{block.quantity.unit}</span>
              </div>
            </div>
          );
      }
  }
}
