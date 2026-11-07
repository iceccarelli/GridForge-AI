// Search-result metadata that fits: a result shows about 60 characters of title and about 160 of description, and what is cut is
// usually the specific part. These helpers are for the pages whose text is assembled from data (a constraint's headline, a platform's
// figures, a product's price) rather than written by hand, so a longer datum cannot silently push a page over the limit.
// tests/site/metadata-limits.test.ts measures every sitemap page as rendered.

/** The root layout's title template is "%s · Time to Power": this is what it adds. */
export const TITLE_SUFFIX = " · Time to Power";
export const TITLE_MAX = 60;
export const DESCRIPTION_MAX = 160;

/**
 * The first candidate whose wrapped title fits, as a plain string (the layout adds the site name). When none fits wrapped, the first
 * that fits on its own is used as an absolute title, which drops the site name rather than cutting the specific words; the last
 * resort is a cut at a word boundary.
 */
export function pageTitle(...candidates: string[]): string | { absolute: string } {
  const wrapped = candidates.find((c) => c.length + TITLE_SUFFIX.length <= TITLE_MAX);
  if (wrapped) return wrapped;
  const bare = candidates.find((c) => c.length <= TITLE_MAX);
  if (bare) return { absolute: bare };
  return { absolute: fitText(candidates[candidates.length - 1], TITLE_MAX) };
}

/**
 * `primary` when it fits wrapped; otherwise `primary` on its own as an absolute title when that fits (the site name is dropped rather than
 * the words that tell two pages apart); otherwise whatever `pageTitle` makes of `fallbacks`.
 */
export function pageTitleKeeping(primary: string, ...fallbacks: string[]): string | { absolute: string } {
  if (primary.length + TITLE_SUFFIX.length <= TITLE_MAX) return primary;
  if (primary.length <= TITLE_MAX) return { absolute: primary };
  return pageTitle(...fallbacks);
}

/** `text` unchanged when it fits; otherwise the longest run of whole sentences that fits, or failing that a cut at a word boundary with an ellipsis. */
export function fitText(text: string, max: number = DESCRIPTION_MAX): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf("? "), head.lastIndexOf("! "));
  if (sentence >= Math.floor(max / 2)) return head.slice(0, sentence + 1);
  const word = t.slice(0, max - 1).replace(/\s+\S*$/, "").replace(/[\s,;:—-]+$/, "");
  return `${word}…`;
}
