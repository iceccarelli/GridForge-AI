// Text an anonymous caller typed, made safe to place inside a message the company sends or posts.
//
// Two rules sit behind this file:
//
//   1. A message that goes to an ADDRESS THE CALLER TYPED is fixed wording. It never echoes a free-text field, because
//      the sender is the company's domain and anyone could otherwise send a stranger text and links of their choosing
//      (app/api/qualify/[token]/follow-up/route.ts, app/api/audit/route.ts).
//   2. A message that goes to our OWN desk (mail) or channel (Slack) may quote the caller, but only as inert plain text:
//      one line, no control characters, no link a mail client or Slack will make clickable, no `<...>` Slack control
//      sequence, and no @-mention that pings a channel.
//
// This is hygiene for what the caller typed. It does not make the text trustworthy, and a person reading it still decides.

/** Control characters (C0, DEL, C1) and the Unicode line/paragraph separators, plus bidirectional overrides and zero-width joiners. */
const UNSAFE_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

/**
 * One inert line of plain text: control and direction-override characters become spaces, runs of whitespace collapse, the length
 * is capped, and anything a mail client or Slack would turn into a link is broken (`https://x` -> `https[://]x`, `www.` -> `www[.]`).
 * A bare domain name can still be linkified by a client that guesses; that is why this is only used where our own staff read it.
 */
export function plainLine(value: unknown, max = 200): string {
  const s = String(value ?? "")
    .replace(UNSAFE_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/:\/\//g, "[://]")
    .replace(/\bwww\./gi, "www[.]")
    .replace(/\b(mailto|javascript|data|file):/gi, "$1[:]");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * The same, for Slack's `text` field. Slack reads `<...>` as a control sequence (`<!channel>`, `<@U123>`, `<https://x|label>`), so
 * `&`, `<` and `>` are escaped exactly as Slack documents (`&amp;`, `&lt;`, `&gt;`), and an `@` that begins a word (where a mention
 * would begin) is replaced by the full-width commercial at (U+FF20). An `@` inside an address (`a@b.example`) is left alone.
 */
export function slackSafe(value: unknown, max = 200): string {
  return plainLine(value, max)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/(^|[^\w.+-])@/g, "$1\uFF20");
}
