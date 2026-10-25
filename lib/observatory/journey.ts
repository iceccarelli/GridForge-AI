// STUB (replaced by the core workstream): the deterministic presenter journey.
import type { JourneyFrame, JourneyStep, ScenarioFile } from "@/lib/observatory/types";

export function buildJourney(_file: ScenarioFile): JourneyStep[] {
  throw new Error("buildJourney: not implemented");
}
export function totalDuration(_steps: JourneyStep[]): number {
  throw new Error("totalDuration: not implemented");
}
/** Pure: the same steps and t always give the same frame. t is clamped to [0, total]. */
export function frameAt(_steps: JourneyStep[], _t: number): JourneyFrame {
  throw new Error("frameAt: not implemented");
}
