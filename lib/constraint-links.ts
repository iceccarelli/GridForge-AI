// From a constraint NAME, as the engine prints it in a qualifier answer, to the constraint's page on this site.
//
// The qualifier answer carries names only (`as_found.binding_constraint`, `first_three_constraints[].name`), not ids. The published reference
// (public/reference/constraints.json, generated from the engine's registry) carries the id, the slug and ITS name for each constraint, and
// the two do not always agree: the engine prints "Firm supply (grid import + behind-the-meter)" where the reference says "... and ...", and
// it prints "CDU capacity (derated to site water temperature)" where the reference says "CDU capacity at site conditions". A comparison on
// the reference's own name therefore missed the supply constraint, which is the one that binds most often.
//
// The map is exact and closed: a reference name, plus the engine's own spellings listed below, each tied to a constraint id. A name that is
// in neither resolves to nothing, and a caller then renders text with no link; there is never a guessed or fuzzy match, and never a slug
// that is not a constraint page (the pages are generated from the same reference, app/constraints/[slug]/page.tsx generateStaticParams).
// tests/site/constraint-links.test.ts parses the engine's source for every name it can emit and fails if one resolves to no page.

import type { ConstraintReference } from "@/lib/constraints";

/** Engine spellings that differ from the reference's name, by constraint id. */
export const ENGINE_NAME_ALIASES: Record<string, string> = {
  "Firm supply (grid import + behind-the-meter)": "grid_firm_capacity",
  // The "not limiting" variants the engine prints when nothing of that kind is declared (gridforge/power/constraints.py, thermal/constraints.py).
  "UPS capacity": "ups_capacity",
  "CDU capacity": "cdu_capacity",
  "CDU capacity (derated to site water temperature)": "cdu_capacity",
};

/** Constraint name (reference or engine spelling) -> page slug. Plain data, so a server page can hand it to a client component. */
export type ConstraintSlugs = Record<string, string>;

export function constraintSlugsByName(ref: Pick<ConstraintReference, "constraints"> | null | undefined): ConstraintSlugs {
  const out: ConstraintSlugs = {};
  const byId = new Map<string, string>();
  for (const c of ref?.constraints ?? []) {
    if (typeof c.name !== "string" || typeof c.slug !== "string" || !c.name || !c.slug) continue;
    out[c.name] = c.slug;
    byId.set(c.id, c.slug);
  }
  for (const [name, id] of Object.entries(ENGINE_NAME_ALIASES)) {
    const slug = byId.get(id);
    if (slug && !Object.hasOwn(out, name)) out[name] = slug;
  }
  return out;
}

/** The page slug for a name, or null: an unknown, empty or non-string name (including an object key such as "constructor") links nowhere. */
export function slugForConstraint(slugs: ConstraintSlugs | null | undefined, name: unknown): string | null {
  if (!slugs || typeof name !== "string" || !Object.hasOwn(slugs, name)) return null;
  const slug = slugs[name];
  return typeof slug === "string" && slug ? slug : null;
}

export function constraintHref(slugs: ConstraintSlugs | null | undefined, name: unknown): string | null {
  const slug = slugForConstraint(slugs, name);
  return slug ? `/constraints/${slug}` : null;
}
