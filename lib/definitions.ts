// One plain sentence that says what a thing IS, for the top of a page: self-contained, so a person (or a model) who reads only that
// sentence has a true answer to "what is this". Built from the reference records the page already renders, with no figure of its own, no
// superlative and no claim about any hall. tests/site/definitions.test.ts holds every sentence to that.

import type { ConstraintDoc, PlatformEntry } from "@/lib/constraints";

const lcfirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const noFinalStop = (s: string) => s.trim().replace(/[.]+$/, "");

const DOMAIN_ADJECTIVE: Record<string, string> = { electrical: "electrical", thermal: "thermal", physical: "physical" };

/** "Busway ampacity is an electrical limit the engine checks in an existing data hall; what it limits is the continuous current a busway run carries, derated for ambient…". */
export function constraintDefinition(c: Pick<ConstraintDoc, "name" | "limits" | "domain">): string {
  const kind = DOMAIN_ADJECTIVE[c.domain] ?? c.domain;
  return `${c.name} is ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} limit the engine checks in an existing data hall; what it limits is ${lcfirst(noFinalStop(c.limits))}.`;
}

/** "The NVIDIA GB300 NVL72 is a rack platform in the library: 135 kW per rack, 90% of it captured by liquid, 72 GPUs, as published by its manufacturer." */
export function platformDefinition(p: Pick<PlatformEntry, "name" | "rack_kW" | "liquid_fraction" | "gpus_per_rack" | "generic">): string {
  const origin = p.generic ? "a generic archetype with no manufacturer" : "figures as published by its manufacturer";
  return (
    `${p.name} is a rack platform in the engine's platform library: ${p.rack_kW} kW per rack, ${(p.liquid_fraction * 100).toFixed(0)}% of that heat ` +
    `captured by liquid and ${p.gpus_per_rack} GPUs per rack, ${origin}.`
  );
}

/** The guide's two terms, as the guide uses them. */
export const NAMEPLATE_DEFINITION =
  "In this guide, nameplate power is the capacity written on a contract or a rating plate, and useful compute is the number of whole racks of one platform " +
  "that every stage between the utility connection and the rack can feed at the same time.";
