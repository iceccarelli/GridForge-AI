// What the Portfolio Screen stores as its ranking file (`ranking.json`, beside the document and one model pack per hall).
//
// The engine's /v1/portfolio answer says more than the four figures this file used to copy. Since the comparability work it also says
// which halls are NOT comparable (`rankable`, `required_gaps`, `incomparable_halls`), which halls share one grid connection
// (`shares_site_connection`, `total_racks_upper_bound`), the total that is actually comparable (`comparable_total_racks`, null when no hall
// is comparable: no total is not zero racks) and the warnings that qualify it. A buyer who gets only `total_racks` gets a number the engine
// itself no longer stands behind without those qualifiers. So the file carries EVERYTHING the engine answered except the two parts that are
// delivered as their own files (`document`, `model_packs`), and the original four keys stay first and in their old order.
//
// Pure: no I/O, no environment. Pinned by tests/site/portfolio-ranking-file.test.ts.

/** The parts of the engine's answer that are delivered as separate files and so are not repeated in the ranking file. */
const DELIVERED_ELSEWHERE = new Set(["document", "model_packs"]);

/** The four keys this file always had, in the order it always had them. */
const LEADING_KEYS = ["objective", "halls", "total_racks", "total_racks_evidence"] as const;

/** The ranking file's text for one engine /v1/portfolio answer. */
export function portfolioRankingFile(answer: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const k of LEADING_KEYS) out[k] = answer[k];
  for (const [k, v] of Object.entries(answer)) {
    if (k in out || DELIVERED_ELSEWHERE.has(k) || v === undefined) continue;
    out[k] = v;
  }
  return JSON.stringify(out, null, 2);
}
