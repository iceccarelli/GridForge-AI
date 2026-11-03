// The numbers the "nameplate against useful compute" guide shows, read from the engine's published model pack of the synthetic reference hall.
// Nothing here is typed: the page prints what the pack says, so it cannot drift from the engine (CI rebuilds the pack and fails on a difference),
// and the guide's claims are checked against the pack in tests/site/guide.test.ts.

import fs from "node:fs/promises";
import path from "node:path";

export interface PackConstraint {
  id: string;
  name: string;
  domain: string;
  gate: boolean;
  racks_permitted: number | null;
  basis: string;
}

export interface PackScenario {
  id: string;
  name: string;
  as_found: { racks: number; binding: string; binding_name: string; basis: string };
  after_ladder: { racks: number; binding: string };
  constraints: PackConstraint[];
}

export interface Pack {
  synthetic: boolean;
  generated: string;
  intake: { document: { grid: { contracted_MW: number; firm_capacity_MVA: number; current_site_peak_MW: { value: number }; current_it_load_MW: number }; compute: { platform: string } } };
  scenarios: PackScenario[];
}

export async function modelPack(): Promise<Pack | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(process.cwd(), "public", "reference", "model_pack.json"), "utf8")) as Pack;
  } catch {
    return null;
  }
}

/** The scenario the guide walks through. Chosen by id so that a reordering of the pack cannot change which one is shown. */
export const GUIDE_SCENARIO_ID = "hybrid_dlc";

export function guideScenario(p: Pack): PackScenario | undefined {
  return p.scenarios.find((s) => s.id === GUIDE_SCENARIO_ID);
}

/**
 * The constraints in the order a reader should meet them: the ones that cap the rack count, smallest first, then the hard gates that set it to
 * zero or pass, then the ones the pack does not express as a count. A gate is a pass/fail test; a count is a ceiling.
 */
export function orderedConstraints(s: PackScenario): { counted: PackConstraint[]; gates: PackConstraint[]; uncounted: PackConstraint[] } {
  const counted = s.constraints.filter((c) => c.racks_permitted !== null).sort((a, b) => (a.racks_permitted as number) - (b.racks_permitted as number));
  const gates = counted.filter((c) => c.gate);
  return {
    counted: counted.filter((c) => !c.gate),
    gates,
    uncounted: s.constraints.filter((c) => c.racks_permitted === null),
  };
}
