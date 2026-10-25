// Evidence classes as the engine defines them (gridforge/validation/evidence.py). One table, so the chip, the legend and the
// tooltip cannot disagree. A computed value is never stronger than the weakest input it came from.
import type { EvidenceClass } from "@/lib/observatory/types";

export const EVIDENCE_CLASSES: EvidenceClass[] = ["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"];

export const EVIDENCE_LEGEND: Record<EvidenceClass, { name: string; meaning: string }> = {
  E0: { name: "Assumed", meaning: "No data; engineering judgement or a library default." },
  E1: { name: "Modelled", meaning: "Computed from a documented model on assumed inputs." },
  E2: { name: "Simulated", meaning: "Numerical simulation (hydraulic, thermal network or time series)." },
  E3: { name: "Estimated", meaning: "Model reviewed by a qualified engineer against practice." },
  E4: { name: "Test data", meaning: "Compared against lab, rig or vendor test data." },
  E5: { name: "Customer data", meaning: "The customer's own measured data, as supplied (not measured by us)." },
  E6: { name: "Field-validated", meaning: "Our model reconciled against measured site performance." },
  E7: { name: "Observed in operation", meaning: "Operating outcome observed after implementation." },
};

export function isEvidenceClass(v: unknown): v is EvidenceClass {
  return typeof v === "string" && (EVIDENCE_CLASSES as string[]).includes(v);
}

/** The weaker (lower) of two classes: arithmetic carries the weakest input class. */
export function weakest(a: EvidenceClass, b: EvidenceClass): EvidenceClass {
  return Number(a.slice(1)) <= Number(b.slice(1)) ? a : b;
}

export function evidenceTitle(c: EvidenceClass): string {
  const l = EVIDENCE_LEGEND[c];
  return l ? `${c}: ${l.name}. ${l.meaning}` : c;
}
