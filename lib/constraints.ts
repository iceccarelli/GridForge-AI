import fs from "node:fs/promises";
import path from "node:path";

/**
 * The public constraint reference, read from disk.
 *
 * Built by `gridforge reference` into public/reference/constraints.json and covered
 * by the drift guard in CI, so these pages cannot quietly contradict the engine a
 * reader is about to run their hall through. Read from the filesystem rather than
 * fetched from the engine on purpose: this is the most-read thing we publish and it
 * must not depend on a service being up.
 */

export interface WorkedExample {
  question: string;
  working: string;
  answer: string;
  consequence: string;
}

export interface CostBasis {
  key: string;
  basis: string;
  evidence: string;
  unit?: string;
  note: string;
}

export interface ConstraintDoc {
  id: string;
  slug: string;
  name: string;
  domain: "electrical" | "thermal" | "physical";
  headline: string;
  limits: string;
  relation: string;
  binds_when: string;
  relief: string;
  relief_risk: string;
  misconception: string;
  sources: string[];
  see_also: string[];
  lead_time_weeks: { low: number; high: number } | null;
  worked_example: WorkedExample | null;
  cost_basis: CostBasis | null;
}

export interface ConstraintReference {
  schema: string;
  count: number;
  notice: string;
  constraints: ConstraintDoc[];
  domains: string[];
}

export interface PlatformEntry {
  id: string;
  name: string;
  status: string;
  rack_kW: number;
  peak_rack_kW: number;
  liquid_fraction: number;
  residual_air_kW: number;
  max_inlet_liquid_C: number;
  flow_l_per_min_per_rack: number;
  rack_mass_kg: number;
  rack_footprint_m2: number;
  floor_loading_kg_per_m2: number;
  gpus_per_rack: number;
  voltage_domain: string;
  rack_feed_current_A: number | null;
  sources: string[];
  generic: boolean;
}

export interface PlatformLibrary {
  platforms: PlatformEntry[];
  deliberately_absent: Record<string, string>;
  notice: string;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(
      path.join(process.cwd(), "public", "reference", file),
      "utf8"
    );
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function constraintReference(): Promise<ConstraintReference | null> {
  return readJson<ConstraintReference>("constraints.json");
}

export async function platformLibrary(): Promise<PlatformLibrary | null> {
  return readJson<PlatformLibrary>("platforms.json");
}

export async function constraintBySlug(slug: string): Promise<ConstraintDoc | null> {
  const ref = await constraintReference();
  return ref?.constraints.find((c) => c.slug === slug) ?? null;
}

export const DOMAIN_LABEL: Record<string, string> = {
  electrical: "Electrical",
  thermal: "Thermal",
  physical: "Physical",
};
