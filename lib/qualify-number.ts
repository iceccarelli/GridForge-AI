// A number a visitor TYPED, for the forms whose figures go to the engine. No React, no I/O: importable by the server schema and the browser form alike.
//
// z.coerce.number() is Number(value), and Number() reads a value the visitor never gave as zero: null, "", "   ", false and [] are all 0
// (and true is 1, [5] is 5). For a figure where zero is a real answer (zero free rack positions, a 0 degC plant supply, a peak or IT load of
// zero) that turns "not given" into a number that is sent to the engine as the visitor's own. So a figure is read here only if it IS a number
// or a decimal numeric string; everything else is left alone and the number schema refuses it by name (expected number, received null / string /
// boolean / array). A genuine zero, 0 or "0", still passes.

import { z } from "zod";

/** A decimal numeric string: optional sign, digits with an optional fraction (or a bare fraction), optional exponent, surrounding spaces. Not hex, not "Infinity", not "". */
const DECIMAL = /^\s*[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?\s*$/;

/** The value a number schema should see: a numeric string becomes its number, anything else is passed through untouched (and is refused). */
export function typedNumberInput(v: unknown): unknown {
  return typeof v === "string" && DECIMAL.test(v) ? Number(v) : v;
}

/** `typedNumber(z.number().positive().max(2000))`: the bounds are the caller's, the reading of the input is this module's. */
export function typedNumber<S extends z.ZodType<number>>(bounds: S) {
  return z.preprocess(typedNumberInput, bounds);
}
