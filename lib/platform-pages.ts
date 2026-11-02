// Per-platform pages: one URL for each manufacturer-published rack platform in the library (public/reference/platforms.json).
//
// Everything on a page is either a figure from that library entry, with the sources it names, or arithmetic on those figures
// that is shown as arithmetic. A generic archetype has no manufacturer and no source, so it gets no page of its own. A platform
// whose rack power is unpublished is absent from the library by design and gets none either.

import type { PlatformEntry } from "@/lib/constraints";

/** The reference constraints a rack of this kind most directly presses on, as slugs of public/reference/constraints/. */
export const PLATFORM_CONSTRAINT_SLUGS: { slug: string; why: string }[] = [
  { slug: "rack-feed-tapoff-rating", why: "Each rack draws its feed current continuously; the tap-off box must be rated for it." },
  { slug: "busway-ampacity", why: "The busway carries the sum of every rack's feed on its run." },
  { slug: "cdu-capacity-site-conditions", why: "The coolant distribution unit has to move the liquid-captured heat at the hall's real facility-water temperature." },
  { slug: "residual-air-load-removal", why: "The share not captured by liquid still has to be removed by the hall's air system." },
  { slug: "floor-loading", why: "Rack mass over its footprint is a load the slab or raised floor has to carry." },
];

export interface PlatformDerived {
  /** rack_kW x liquid_fraction */
  liquid_kW: number;
  /** flow / liquid_kW, litres per minute for each kW the liquid loop captures */
  flow_l_per_min_per_liquid_kW: number;
  /** rack_mass_kg / rack_footprint_m2 */
  mass_over_footprint_kg_per_m2: number;
  /** whole racks of this platform in 1 MW of IT load at the published rack power, before any facility overhead */
  racks_per_MW_it: number;
}

export function derive(p: PlatformEntry): PlatformDerived {
  const liquid = p.rack_kW * p.liquid_fraction;
  return {
    liquid_kW: liquid,
    flow_l_per_min_per_liquid_kW: liquid > 0 ? p.flow_l_per_min_per_rack / liquid : 0,
    mass_over_footprint_kg_per_m2: p.rack_mass_kg / p.rack_footprint_m2,
    racks_per_MW_it: Math.floor(1000 / p.rack_kW),
  };
}

/** The platforms that get a page: manufacturer-published, with at least one named source. */
export function pageablePlatforms(all: PlatformEntry[]): PlatformEntry[] {
  return all.filter((p) => !p.generic && p.sources.length > 0);
}
