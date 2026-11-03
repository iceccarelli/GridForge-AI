// The four plain-language bands the site uses to explain the engine's eight evidence classes, and which class belongs to which band.
// Defined over the engine's codes (lib/evidence-classes.ts), so a class added there without a band here fails tests/site/diagrams.test.ts.

import { EVIDENCE_CLASSES } from "@/lib/evidence-classes";

export type BandId = "assumed" | "modelled" | "measured" | "observed";

export interface EvidenceBand {
  id: BandId;
  label: string;
  /** What a reader may and may not conclude from a figure in this band. */
  reading: string;
  codes: string[];
  /** Whether Time to Power has delivered any figure at this level. Stated, not implied. */
  today: string;
}

export const EVIDENCE_BANDS: EvidenceBand[] = [
  {
    id: "assumed",
    label: "Assumed",
    reading: "A library default or a judgement. It is a placeholder, listed in the data request, and the result says it was not supplied.",
    codes: ["E0"],
    today: "Present in every result where an input was not supplied.",
  },
  {
    id: "modelled",
    label: "Modelled",
    reading: "Computed from a documented model, a simulation, or a model reviewed by an engineer. A calculation on inputs, not an observation of the hall.",
    codes: ["E1", "E2", "E3"],
    today: "The class of the engine's output. The claim floors set which class a claim needs before it reaches a customer.",
  },
  {
    id: "measured",
    label: "Measured or tested",
    reading: "Compared with test data (E4) or the client's own measured data as supplied (E5). The client's data is carried as supplied; it was not surveyed by us.",
    codes: ["E4", "E5"],
    today: "E5 only where a client supplies measured data. No vendor-test comparison is claimed.",
  },
  {
    id: "observed",
    label: "Field-validated or observed",
    reading: "The model reconciled against measured site performance (E6), or an outcome seen in operation after the work (E7).",
    codes: ["E6", "E7"],
    today: "None. The calibration ledger is empty and no outcome has been observed.",
  },
];

export function bandOf(code: string): EvidenceBand | undefined {
  return EVIDENCE_BANDS.find((b) => b.codes.includes(code));
}

/** Every engine class must sit in exactly one band. Returns the codes that do not. */
export function unbandedCodes(): string[] {
  return EVIDENCE_CLASSES.map((c) => c.code).filter((code) => EVIDENCE_BANDS.filter((b) => b.codes.includes(code)).length !== 1);
}
