// The vocabulary of the site and hall registry (migrations 0049-0051), shared by the server (lib/sites.ts) and the page.
// Plain data, no server imports: the browser bundle may import it.
//
// ORIGIN is where a figure came from; the evidence CLASS (E0..E7, lib/evidence-classes.ts) is what has been done to it. They are two axes
// and neither implies the other. The database enforces the rules between them (0050); the lists here only let the form offer the same words.

export const ORIGINS = ["measured", "observed", "vendor", "quotation", "modelled", "assumed", "missing"] as const;
export type Origin = (typeof ORIGINS)[number];

export const EVIDENCE_CLASS_CODES = ["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"] as const;
export type EvidenceClassCode = (typeof EVIDENCE_CLASS_CODES)[number];

export const DATA_ORIGINS = ["production", "test", "synthetic"] as const;
export type DataOrigin = (typeof DATA_ORIGINS)[number];

export const ROLES = ["owner", "editor", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** Origins that MUST cite a source file (the database refuses them without one). */
export const ORIGINS_NEEDING_A_SOURCE: readonly Origin[] = ["measured", "observed", "quotation"];

/** Origins that may not claim a class above this one (the database refuses it). */
export const ORIGINS_CAPPED_AT_E3: readonly Origin[] = ["assumed", "modelled"];

export const ORIGIN_MEANING: Record<Origin, string> = {
  measured: "Read from an instrument or a metered record. Needs a source file.",
  observed: "Seen or confirmed on site or in a document. Needs a source file.",
  vendor: "A figure a supplier declares (a datasheet, a brochure). A file is welcome, not required.",
  quotation: "A figure from a written quotation. Needs a source file.",
  modelled: "Computed from a model on assumed inputs. Cannot claim a class above E3.",
  assumed: "Judgement or a default. Cannot claim a class above E3.",
  missing: "Not known. Recorded as missing: no value, no source, class E0.",
};

export const DATA_ORIGIN_MEANING: Record<DataOrigin, string> = {
  production: "A real asset.",
  test: "A rehearsal or a trial; not a real asset.",
  synthetic: "Made up for a demonstration; not a real asset.",
};

/** The intake's own paths: the figures a hall record is expected to hold before anything is concluded from it. A path with no recorded
 *  input is shown as "missing", never left blank. */
export const EXPECTED_HALL_FIELDS: { path: string; label: string; unit: string }[] = [
  { path: "grid.firm_capacity_mva", label: "Firm connection capacity", unit: "MVA" },
  { path: "grid.contracted_mw", label: "Contracted capacity", unit: "MW" },
  { path: "grid.current_site_peak_mw", label: "Current site peak", unit: "MW" },
  { path: "hall.net_white_space_m2", label: "Net white space", unit: "m2" },
  { path: "hall.floor_loading_kpa", label: "Floor loading", unit: "kPa" },
  { path: "hall.design_density_kw_per_rack", label: "Design density", unit: "kW/rack" },
  { path: "hall.rack_positions", label: "Rack positions", unit: "" },
  { path: "thermal.plant.chilled_water_capacity_kw", label: "Chilled-water capacity", unit: "kW" },
];

/** Same shape as the database's hall_inputs_field_path check (0050): lower-case dotted, with optional list indexes. The intake's own paths read the same
 *  once lower-cased (grid.firm_capacity_MVA is stored as grid.firm_capacity_mva), so two spellings are one field. */
export const FIELD_PATH_PATTERN = /^[a-z][a-z0-9_]*(\[[0-9]{1,3}\])?(\.[a-z][a-z0-9_]*(\[[0-9]{1,3}\])?){0,5}$/;

/** Same alphabet as the database's hall_inputs_unit check: letters, digits, % / . _ ^ * + ( ) space -, and the signs micro, degree, superscript 2 and 3, middle dot, ohm. */
export const UNIT_PATTERN = /^[A-Za-z0-9%/._^*+() \u00b5\u00b0\u00b2\u00b3\u00b7\u03a9-]+$/;
