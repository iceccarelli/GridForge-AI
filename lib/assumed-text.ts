// Pure and import-free on purpose: a client component renders this, and lib/qualify.ts pulls in server-only modules.
/**
 * How an assumed value reads in the "assumed, because nobody supplied it" table. The engine reports an empty schedule
 * (transformers, UPS) as the literal text "[]", which a buyer reads as a rendering fault; say what it means instead.
 */
export function assumedText(assumed: string): string {
  const t = (assumed ?? "").trim();
  if (t === "" || t === "[]" || t === "{}" || t === "null") return "Nothing supplied: a labelled library assumption is used";
  return t;
}
