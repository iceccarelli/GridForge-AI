// What a qualify request may declare ASSUMED (class E0), and how to check that the engine really did what the request asked.
//
// A plain module (no React, no server code) shared by the route, the form and the tests.
//
// WHY THE CHECK. The engine ignores a request key it does not know. The site learns what the engine can do from /v1/version, which it caches for
// minutes, and a POST can reach a different machine from the one that answered /v1/version (a rolling deploy or a rollback). An engine that
// ignored `assumed_fields` answers with the template's numbers classed as customer data (E5), and a page that then said "assumed (E0)" would be
// asserting a class nothing recorded. So the claim is made only from the engine's OWN record: the answer must carry `inputs_declared_assumed`
// and it must list exactly the figures the request declared, each recorded as E0.

/** The seven figures, by the form's name, and the engine's name for each (gridforge/api/server.py QUALIFY_FIELDS). In the qualifier's order. */
export const QUALIFY_ASSUMABLE = {
  contractedMW: "contracted_MW",
  currentPeakMW: "current_site_peak_MW",
  currentItLoadMW: "current_it_load_MW",
  buswayAmpacityA: "busway_ampacity_A",
  tapoffMaxA: "tapoff_max_A",
  plantSupplyC: "plant_supply_C",
  positionsAvailable: "positions_available",
} as const;
export type QualifyAssumable = keyof typeof QUALIFY_ASSUMABLE;

/** The intake path the engine records each figure under (QUALIFY_FIELDS values), which is what `inputs_declared_assumed[].path` carries. */
export const QUALIFY_ENGINE_PATH: Record<QualifyAssumable, string> = {
  contractedMW: "grid.contracted_MW",
  currentPeakMW: "grid.current_site_peak_MW",
  currentItLoadMW: "grid.current_it_load_MW",
  buswayAmpacityA: "lv.busway_ampacity_A",
  tapoffMaxA: "lv.tapoff_max_A",
  plantSupplyC: "thermal.plant.design_supply_C",
  positionsAvailable: "hall.positions_available",
};

/**
 * True only when the engine's answer records EXACTLY the declared figures as assumed: `inputs_declared_assumed` is present, has one entry per
 * declared figure and no other, and every entry says E0. Anything else (absent, partial, extra, another class, not a list) is false, and so is a
 * request that declared nothing but whose answer lists some: nothing is claimed that the record does not say.
 */
export function assumedRecordMatches(result: unknown, declared: readonly QualifyAssumable[]): boolean {
  const rec = (result as { inputs_declared_assumed?: unknown } | null)?.inputs_declared_assumed;
  if (declared.length === 0) return rec === undefined;
  if (!Array.isArray(rec) || rec.length !== declared.length) return false;
  const want = new Set(declared.map((k) => QUALIFY_ENGINE_PATH[k]));
  const seen = new Set<string>();
  for (const r of rec) {
    const row = r as { path?: unknown; evidence?: unknown } | null;
    if (!row || typeof row.path !== "string" || row.evidence !== "E0" || !want.has(row.path) || seen.has(row.path)) return false;
    seen.add(row.path);
  }
  return seen.size === want.size;
}
