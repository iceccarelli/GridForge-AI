// STUB (replaced by the core workstream): captions derived from the journey, so the on-screen caption and the WebVTT track are one text.
import type { JourneyStep } from "@/lib/observatory/types";

export interface Cue { startSec: number; endSec: number; text: string }
export function cuesFor(_steps: JourneyStep[]): Cue[] {
  throw new Error("cuesFor: not implemented");
}
export function toWebVtt(_steps: JourneyStep[]): string {
  throw new Error("toWebVtt: not implemented");
}
