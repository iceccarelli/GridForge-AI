// Pure data: which existing paid products can be commissioned FOR a project, and what each
// one opens. Importable from client components (no server imports). Prices and names are NOT
// here — they stay in lib/products.ts, which this only refers to by kind.

/** Catalogue kinds (lib/products.ts) that can be commissioned FOR a project. These four
 * are the paid products that produce a deliverable, a watch or a study deposit for ONE
 * site; API plans, Intelligence, the portfolio deposit and the generic deposit are not
 * per-project, and a checkout that names a project for one of them is refused. */
export const PROJECT_ATTACHABLE_KINDS = [
  "density_screen",
  "envelope_study_deposit",
  "procurement_spec",
  "hall_watch",
] as const;

export function isProjectAttachable(kind: string): boolean {
  return (PROJECT_ATTACHABLE_KINDS as readonly string[]).includes(kind);
}

/** Which existing fulfilment object a paid kind opens; null when it opens none. */
export function purchaseObjectType(kind: string): "deliverable" | "watch" | null {
  if (kind === "hall_watch") return "watch";
  if (kind === "density_screen" || kind === "procurement_spec") return "deliverable";
  return null;
}
