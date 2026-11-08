// Client-safe, pure, and free of any validation library: the words and the catalogue of a supplier quotation claim.
//
// Split out of cost-evidence-claims.ts so a surface that only DISPLAYS quotations (the reviewer's queue, the effect panel) does not ship zod to
// the browser. lib/cost-evidence-claims.ts re-exports everything here, so existing imports keep working; read that file for what a claim is and
// for the honesty line every surface carries (GridForge sells no equipment, takes no margin and quotes no equipment itself).

/** The words the engine uses for a cost basis (gridforge/costs.py BASIS_LABEL). A contract test pins these to that file. */
export const ENGINE_BASIS_LABEL: Record<string, string> = {
  library_default: "library placeholder (not a price)",
  published_benchmark: "published benchmark",
  engineering_estimate: "engineering estimate",
  budgetary_quote: "budgetary supplier quote",
  firm_quote: "firm supplier quote",
  contracted: "contracted / paid cost",
};

/** The label for a basis key, exactly as the engine writes it; an unknown key is shown as it came, never guessed. */
export const basisLabel = (basis: string): string => ENGINE_BASIS_LABEL[basis] ?? basis.replace(/_/g, " ");

/**
 * What the submitter claims the quotation IS. "Indicative" is the submitter's word; the engine has no such basis. A reviewer who accepts the
 * record chooses the basis the engine receives (budgetary_quote, firm_quote or contracted), and an indicative claim can only become a
 * budgetary quote or stay unaccepted unless the reviewer decides otherwise on the document.
 */
export const QUOTE_TYPES = ["firm_quote", "indicative_quote"] as const;
export type QuoteType = (typeof QUOTE_TYPES)[number];
export const QUOTE_TYPE_LABEL: Record<QuoteType, string> = {
  firm_quote: "Firm quotation (the supplier states it is an offer open for acceptance until the validity date)",
  indicative_quote: "Indicative quotation (a budgetary price; not an offer)",
};
/** The engine basis a reviewer is most likely to choose for a claim. A suggestion only: the reviewer decides, and may choose any basis. */
export const SUGGESTED_BASIS: Record<QuoteType, "firm_quote" | "budgetary_quote"> = {
  firm_quote: "firm_quote",
  indicative_quote: "budgetary_quote",
};

export interface QuotableItem {
  /** The engine's cost key. */
  key: string;
  label: string;
  /** The units a quotation may be entered in: the engine's own unit for the line, and "EUR" (a lump) where the engine scales a lump. */
  units: readonly string[];
  /** What a lump's quantity is counted in (the unit the engine prices the step in); null when the engine does not scale a lump. */
  quantityUnit: string | null;
}

/**
 * The cost lines of the ladder that a supplier's quotation can price (gridforge/power/constraints.py, thermal/constraints.py,
 * site/constraints.py). A line the engine prices per unit takes a per-unit price or a EUR lump with the quantity it covers in that unit; a line
 * the engine prices as one lump takes a lump. A key outside this list would be held by the engine and applied to nothing, so it is refused here.
 * tests/site/cost-evidence-claims.test.ts pins every key and unit to the engine's source.
 */
export const QUOTABLE_ITEMS: readonly QuotableItem[] = [
  { key: "transformer.replacement", label: "Transformer and switchgear uprate", units: ["EUR/MVA", "EUR"], quantityUnit: "MVA" },
  { key: "ups.per_kW", label: "UPS module addition", units: ["EUR/kW", "EUR"], quantityUnit: "kW" },
  { key: "busway.replacement", label: "Busway and tap-off works", units: ["EUR/run", "EUR"], quantityUnit: "run" },
  { key: "tapoff.unit", label: "Tap-off unit and rack feed", units: ["EUR/rack"], quantityUnit: null },
  { key: "floor.load_spreading", label: "Structural works (floor loading)", units: ["EUR/m2", "EUR"], quantityUnit: "m2" },
  { key: "plant.uprate", label: "Chilled-water plant uprate", units: ["EUR/kW", "EUR"], quantityUnit: "kW" },
  { key: "pump.uprate", label: "Pump and secondary pipework uprate", units: ["EUR/lpm", "EUR"], quantityUnit: "lpm" },
  { key: "cdu.addition", label: "Coolant distribution units (CDU), supplied and mechanically installed", units: ["EUR/unit", "EUR"], quantityUnit: "unit" },
  { key: "inrow_rdhx.per_rack", label: "In-row / rear-door heat exchanger", units: ["EUR/rack"], quantityUnit: null },
  { key: "trim_chiller.adiabatic", label: "Adiabatic trim chiller", units: ["EUR"], quantityUnit: null },
  { key: "grid.reinforcement", label: "Grid reinforcement works (not a utility connection offer)", units: ["EUR"], quantityUnit: null },
];
export const QUOTABLE_KEYS = QUOTABLE_ITEMS.map((i) => i.key) as [string, ...string[]];
export const itemFor = (key: string): QuotableItem | undefined => QUOTABLE_ITEMS.find((i) => i.key === key);

/** The statement every surface that shows these claims carries. */
export const NO_EQUIPMENT_STATEMENT =
  "GridForge sells no equipment, takes no margin on any purchase and quotes no equipment itself. These are your own supplier's quotations: we " +
  "record them, a reviewer checks the stored document and the record (the reviewer's name is text typed under a shared admin password, not a verified " +
  "identity), and we apply them to the engine's comparison for your project.";

/** Why a quotation is not counted yet, in the words a project holder reads. */
export const NOT_COUNTED_REASON: Record<string, string> = {
  validated: "Not yet counted: it is waiting for a reviewer. Until a person has verified the file and accepted the record, it changes no number.",
  invalid: "Not counted: it did not pass the engine's checks.",
  rejected: "Not counted: a reviewer rejected it.",
  superseded: "Not counted: a newer accepted quotation replaced it.",
  withdrawn: "Not counted: it was withdrawn after acceptance.",
};

/** The standing of a quotation's file, as the project holder reads it. */
export const FILE_STATUS_TEXT: Record<string, string> = {
  unverified: "file not yet verified",
  verified: "file verified (its bytes are unchanged since upload)",
  rejected: "file rejected by a reviewer",
};

/** How the date the quotation supports is described; the quoted lead time is the submitter's claim and the engine's cost overlay does not take it. */
export const LEAD_TIME_NOTE =
  "A quoted lead time is recorded as the submitter's claim beside the quotation. The engine's cost overlay prices the works and does not take a " +
  "lead time from a quotation, so it does not move the date. The date moves only when the hall's own lead-time figure is entered in the hall form.";
