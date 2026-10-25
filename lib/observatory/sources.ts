// STUB (replaced by the core workstream): live market/grid/queue context, each value with its provenance and freshness.
import type { LiveContext } from "@/lib/observatory/types";

export interface SourceDeps { fetch?: typeof fetch; now?: () => Date; env?: Record<string, string | undefined> }
export async function getLiveContext(_deps?: SourceDeps): Promise<LiveContext> {
  throw new Error("getLiveContext: not implemented");
}
