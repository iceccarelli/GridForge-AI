// Evidence classes as the engine defines them (gridforge/validation/evidence.py). One table, so the chip, the legend and the
// tooltip cannot disagree. A computed value is never stronger than the weakest input it came from.
import type { EvidenceClass } from "@/lib/observatory/types";

export const EVIDENCE_CLASSES: EvidenceClass[] = ["E0", "E1", "E2", "E3", "E4", "E5", "E6", "E7"];

export const EVIDENCE_LEGEND: Record<EvidenceClass, { name: string; meaning: string }> = {
  E0: { name: "Assumed", meaning: "No data; engineering judgement or a library default." },
  E1: { name: "Modelled", meaning: "Computed from a documented model on assumed inputs." },
  E2: { name: "Simulated", meaning: "Numerical simulation (hydraulic, thermal network or time series)." },
  // On THIS page E3 and E5 are overridden, because next to invented inputs the engine's own wording would over-claim:
  // E3 is an engine estimate with no engineer review here; E5 is a supplied input that is invented here, not measured.
  E3: { name: "Engine estimate", meaning: "No engineer review in this demonstration." },
  E4: { name: "Test data", meaning: "Compared against lab, rig or vendor test data." },
  E5: { name: "Supplied input", meaning: "Invented here; not measured." },
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
