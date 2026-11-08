// One plain sentence that says what a thing IS, for the top of a page: self-contained, so a person (or a model) who reads only that
// sentence has a true answer to "what is this". Built from the reference records the page already renders, with no figure of its own, no
// superlative and no claim about any hall. tests/site/definitions.test.ts holds every sentence to that.

import type { ConstraintDoc, PlatformEntry } from "@/lib/constraints";
import { classWithWord, type EngineeringAssumption } from "@/lib/engineering-constants";

const lcfirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
const noFinalStop = (s: string) => s.trim().replace(/[.]+$/, "");

const DOMAIN_ADJECTIVE: Record<string, string> = { electrical: "electrical", thermal: "thermal", physical: "physical" };

/** "Busway ampacity is an electrical limit the engine checks in an existing data hall; what it limits is the continuous current a busway run carries, derated for ambient…". */
export function constraintDefinition(c: Pick<ConstraintDoc, "name" | "limits" | "domain">): string {
  const kind = DOMAIN_ADJECTIVE[c.domain] ?? c.domain;
  return `${c.name} is ${/^[aeiou]/.test(kind) ? "an" : "a"} ${kind} limit the engine checks in an existing data hall; what it limits is ${lcfirst(noFinalStop(c.limits))}.`;
}

/**
 * What the library's figures are, in one sentence, for every place that describes a platform page or the library. The record holds the
 * sources it cites (vendor and OEM material is marked [V]) and the library marks every figure as an assumption with a band
 * (gridforge/compute/library.py: ASSUMED); a few, such as the liquid heat-capture share and the feed current, are the library's own
 * working values. So a figure is "as stated in the cited sources", never "the manufacturer's published value".
 */
export const PLATFORM_FIGURES_NOTE =
  "The figures are taken from the sources cited and held in the library as assumptions, each with a band; the liquid heat-capture share, the maximum inlet temperature, " +
  "the flow and the feed current are the library's working values. None is a measurement.";

/** "NVIDIA GB300 NVL72 is a rack platform in the engine's platform library: 135 kW per rack and 72 GPUs, with figures taken from the cited sources and held as library assumptions; the 90% liquid heat-capture share is one of them." */
export function platformDefinition(p: Pick<PlatformEntry, "name" | "rack_kW" | "liquid_fraction" | "gpus_per_rack" | "generic">): string {
  const origin = p.generic
    ? "a generic archetype with no manufacturer, its figures held as library assumptions"
    : "with figures taken from the cited sources and held as library assumptions";
  return (
    `${p.name} is a rack platform in the engine's platform library: ${p.rack_kW} kW per rack and ${p.gpus_per_rack} GPUs, ${origin}; ` +
    `the ${(p.liquid_fraction * 100).toFixed(0)}% liquid heat-capture share is one of those assumptions.`
  );
}

/** The guide's two terms, as the guide uses them. */
export const NAMEPLATE_DEFINITION =
  "In this guide, nameplate power is the capacity written on a contract or a rating plate, and useful compute is the number of whole racks of one platform " +
  "that every stage between the utility connection and the rack can feed at the same time.";

/**
 * What an engineering assumption IS, in one sentence, built from the single typed source (lib/engineering-constants.ts) and carrying no figure of its own.
 * It names the class the engine labels the value with and says what the value is not: a measurement, a quotation or a market figure.
 */
export function engineeringAssumptionDefinition(a: Pick<EngineeringAssumption, "title" | "classCode" | "headline">): string {
  return `${a.title} is an engineering assumption the engine uses, labelled class ${classWithWord(a.classCode)}: ${noFinalStop(a.headline)}; it is not a measurement, a quotation or a market figure.`;
}

/** One line for the top of the section that lists them. */
export const ENGINEERING_ASSUMPTIONS_NOTE =
  "These are the engine's own library assumptions, each with the class it is labelled with, where it applies and what replaces it. Each is read from the engine's code and published files " +
  "and checked against them by test; where the code does something other than a common description of it, this page says what the code does.";
