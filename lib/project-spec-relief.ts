/**
 * Which relief a Procurement Specification is written for.
 *
 * The engine (`POST /v1/spec`, gridforge/procurement/build.py `build_spec`) takes an optional `constraint`: the id of the
 * constraint whose relief the specification tenders. Left out, the engine picks one itself (`default_step`). The buyer
 * could not choose; this is the vocabulary they choose from.
 *
 * The ids and names are the engine's own constraint registry (gridforge/reference/catalogue.py), mirrored here as a literal
 * because the intake form is a client component and cannot read the filesystem. tests/site/spec-relief.test.ts fails if this
 * list drifts from public/reference/constraints.json, which `gridforge reference` generates from that registry and CI guards.
 *
 * Whether a given hall HAS a purchasable relief for a given id is the engine's call (it answers 422 naming what is
 * available for that hall); this list only says which ids exist.
 */

export const SPEC_RELIEF_CONSTRAINTS = [
  { id: "rack_feed_tapoff", name: "Rack feed / tap-off rating" },
  { id: "busway_ampacity", name: "Busway ampacity" },
  { id: "transformer_capacity", name: "Transformer capacity" },
  { id: "ups_capacity", name: "UPS capacity (protected load)" },
  { id: "grid_firm_capacity", name: "Firm supply (grid import and behind-the-meter)" },
  { id: "plant_capacity", name: "Chilled-water plant capacity" },
  { id: "cdu_capacity", name: "CDU capacity at site conditions" },
  { id: "hydraulic_flow", name: "Hydraulic flow capacity" },
  { id: "tcs_supply_achievable", name: "Achievable facility water temperature" },
  { id: "residual_air_removal", name: "Residual air load removal per rack" },
  { id: "architecture_capability", name: "Cooling architecture per-rack capability" },
  { id: "floor_space", name: "Available rack positions" },
  { id: "floor_loading", name: "Floor loading" },
] as const;

export type SpecReliefId = (typeof SPEC_RELIEF_CONSTRAINTS)[number]["id"];

export const SPEC_RELIEF_IDS: readonly string[] = SPEC_RELIEF_CONSTRAINTS.map((c) => c.id);

/** The only product a relief choice applies to. */
export const SPEC_RELIEF_KIND = "procurement_spec";

export type ParsedRelief = { ok: true; constraint: SpecReliefId | null } | { ok: false; error: string };

/**
 * Validate the buyer's optional choice. Absent (undefined, null or an empty string) is "let the engine choose", which is
 * exactly what the product did before the choice existed. Anything else must be one of the engine's constraint ids, exactly;
 * an unknown value is refused, naming the valid ones, and is never passed through.
 */
export function parseSpecRelief(value: unknown): ParsedRelief {
  if (value === undefined || value === null) return { ok: true, constraint: null };
  if (typeof value !== "string") {
    return { ok: false, error: `The relief must be one of: ${SPEC_RELIEF_IDS.join(", ")}.` };
  }
  const v = value.trim();
  if (v === "") return { ok: true, constraint: null };
  if ((SPEC_RELIEF_IDS as readonly string[]).includes(v)) return { ok: true, constraint: v as SpecReliefId };
  return {
    ok: false,
    error: `Unknown relief ${JSON.stringify(v.slice(0, 60))}. Valid reliefs: ${SPEC_RELIEF_IDS.join(", ")}.`,
  };
}

/** The buyer-facing name of a constraint id, or null when it is not one of the engine's. */
export function specReliefName(id: string | null | undefined): string | null {
  return SPEC_RELIEF_CONSTRAINTS.find((c) => c.id === id)?.name ?? null;
}
