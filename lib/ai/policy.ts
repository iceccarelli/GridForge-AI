// Scope and honesty rules the orchestration loop enforces in code, not only
// in the prompt. A system prompt is guidance a model can drift from over a
// long conversation; these checks are the backstop.

/**
 * Topics the scoping engineer must never engage with, however the caller
 * phrases the question. Mirrors "WHAT WE DO NOT DO" in prompts/system.ts —
 * kept here too so a caller can screen a user turn before it ever reaches
 * the model, and so an out-of-scope ask cannot accidentally trigger a paid
 * tool call.
 */
const OUT_OF_SCOPE_PATTERNS: RegExp[] = [
  /\bmicrogrid/i,
  /\bgenset/i,
  /\bgenerator set/i,
  /\bfuel cell/i,
  /\bbattery (storage|farm|system)\b/i,
  /\bfinanc(e|ing|ial model|e it|e the)\b/i,
  /\blend(er|ing)\b/i,
  /\bpower purchase agreement\b|\bppa\b/i,
  /\bown(s|ing)? (the )?(hall|energy asset|power plant)\b/i,
];

export function isOutOfScope(text: string): boolean {
  return OUT_OF_SCOPE_PATTERNS.some((re) => re.test(text));
}

export const OUT_OF_SCOPE_REPLY =
  "That's outside what Time to Power does — we specify duty and interfaces for an " +
  "existing hall, we don't build, own, finance or operate microgrids, gensets, fuel " +
  "cells, batteries or DC distribution. If you want a directional read on how much AI " +
  "compute your existing site can carry, tell me the platform, contracted MW and your " +
  "busway/tap-off ratings and I can run that now.";

/** Maximum tool calls the model may make in a single turn. Bounds both
 *  latency and the metered units a single chat turn can spend, even for an
 *  entitled caller. */
export const MAX_TOOL_CALLS_PER_TURN = 4;
