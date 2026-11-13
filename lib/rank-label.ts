/**
 * How a `rank` from the engine is shown.
 *
 * `rank` is null for a row that is not ranked: a hall with no deployable rack, a required input missing or an equipment bank not declared (POST
 * /v1/portfolio), and a bid that was set aside (POST /v1/bids, /v1/power/deploy/bids). It used to carry an ordinal that read as a place in a ranking
 * the row did not hold. A table cell that prints the field raw shows an empty cell for null; a row that is not ranked is shown as an em dash, the way
 * the bid comparison already does, and nothing is ever called `null`, `undefined` or `NaN`.
 */
export function rankLabel(rank: unknown): string {
  return typeof rank === "number" && Number.isFinite(rank) ? String(rank) : "—";
}
