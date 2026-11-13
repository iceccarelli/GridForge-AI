// The evidence classes E0-E7, as the engine defines them (gridforge/validation/evidence.py). They are restated here so the website can
// explain them; tests/site/evidence-pages.test.ts parses that Python file and fails if a class, its number, its meaning or a claim floor
// below differs, so this table cannot drift from what the engine actually enforces.

/**
 * What E3 means, in the words the engine's own comment uses (gridforge/validation/evidence.py; tests/site/evidence-pages.test.ts pins the two together).
 * The engine caps its own arithmetic at E3 for every hall, so the class cannot mean that an engineer reviewed the hall; it means the engine estimated
 * the figure by its documented method from the stated inputs. The first sentence below is the Python comment's text; the other two say what E3 is not.
 */
export const E3_ESTIMATE = "Estimated by the engine's documented method from the stated inputs; the highest class the engine's own arithmetic can carry.";
export const E3_NOT_SIGNOFF = "It is not a named engineer's sign-off on a hall.";
export const E3_REVIEW_RECORDED = "A named engineer's review of a released document is recorded with the release and does not raise a figure's class.";
export const E3_MEANING = `${E3_ESTIMATE} ${E3_NOT_SIGNOFF} ${E3_REVIEW_RECORDED}`;

export interface EvidenceClassDoc {
  code: string;      // "E0"
  name: string;      // the engine's member name
  verb: string;      // how a figure of this class is described in a document
  meaning: string;   // what has been done to the number
}

export const EVIDENCE_CLASSES: EvidenceClassDoc[] = [
  { code: "E0", name: "E0_ASSUMPTION", verb: "assumed", meaning: "No data: engineering judgement or a library default." },
  { code: "E1", name: "E1_MODEL", verb: "modelled", meaning: "Computed from a documented model on assumed inputs." },
  { code: "E2", name: "E2_SIMULATION", verb: "simulated", meaning: "Numerical simulation (hydraulic, thermal network, time series)." },
  { code: "E3", name: "E3_ENGINEERING_ESTIMATE", verb: "estimated", meaning: E3_MEANING },
  { code: "E4", name: "E4_EXPERIMENTAL", verb: "validated against test data", meaning: "Compared against lab, rig or vendor test data." },
  { code: "E5", name: "E5_CUSTOMER_DATA", verb: "supplied by the client (not measured or surveyed by us)", meaning: "The customer's own figures as supplied (a declared rating, contract term, design value or their own data); not measured or surveyed by us." },
  { code: "E6", name: "E6_FIELD_VALIDATED", verb: "field-validated", meaning: "Our model reconciled against measured site performance." },
  { code: "E7", name: "E7_DEPLOYED", verb: "observed in operation", meaning: "An operating outcome observed after implementation." },
];

/** The minimum class a claim of each kind may carry before it reaches a customer (CLAIM_FLOOR in the engine). */
export const CLAIM_FLOORS: { kind: string; label: string; floor: string }[] = [
  { kind: "electrical_capacity", label: "Electrical capacity", floor: "E3" },
  { kind: "cooling_performance", label: "Cooling performance", floor: "E2" },
  { kind: "capex", label: "Capital cost", floor: "E1" },
  { kind: "schedule", label: "Schedule", floor: "E1" },
];
