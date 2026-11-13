// How a turnaround is written in prose: the ONE place a number of working days becomes words.
//
// The catalogue (lib/products.ts) owns the number, `turnaroundDays`, and tests/test_catalogue_single_source.py pins it to the engine's
// `turnaround_days`. Prose that said "five working days" typed the number again in a sentence, where nothing compared it with the catalogue:
// change the catalogue and the sentence stayed behind (lib/site.ts twice, app/api/audit/route.ts twice, lib/products.ts once).
// Every such sentence now calls this, and tests/site/turnaround-copy.test.ts fails if "five working days" or "5 working days" is typed anywhere
// else in the site's source.
//
// No imports: lib/products.ts uses it, so it must not read the catalogue itself.

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"] as const;

/**
 * A whole number of working days as the site writes it in a sentence: "five working days", "one working day"; above ten, and for anything that is
 * not a whole number of days, digits ("25 working days"). The caller supplies the number from the catalogue and the words around it.
 */
export function workingDays(days: number): string {
  if (!Number.isInteger(days) || days < 0) return `${days} working days`;
  const n = days <= 10 ? WORDS[days] : String(days);
  return `${n} working ${days === 1 ? "day" : "days"}`;
}
