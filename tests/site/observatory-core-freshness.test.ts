import { describe, expect, it } from "vitest";
import {
  CLOCK_SKEW_SECONDS,
  MAX_AGE_SECONDS,
  freshnessOf,
  mayBeCalledLive,
  observed,
  type FreshnessInput,
} from "@/lib/observatory/sources";
import type { Provenance } from "@/lib/observatory/types";

const NOW = new Date("2026-10-25T12:00:00.000Z");
const at = (offsetSec: number) => new Date(NOW.getTime() + offsetSec * 1000).toISOString();

function f(over: Partial<FreshnessInput>) {
  return freshnessOf({ hasValue: true, observedAt: at(0), retrievedAt: null, maxAgeSeconds: 600, now: NOW, ...over });
}

describe("freshnessOf: the one rule", () => {
  it("the published thresholds", () => {
    expect(MAX_AGE_SECONDS).toEqual({ dayAheadPrice: 3600, generationMix: 10800, queue: 120 * 86400, usDemand: 21600 });
    expect(CLOCK_SKEW_SECONDS).toBe(120);
  });

  it("age boundary: equal to the limit is fresh, one millisecond over is stale", () => {
    expect(f({ observedAt: at(-600) })).toBe("fresh");
    expect(f({ observedAt: new Date(NOW.getTime() - 600_001).toISOString() })).toBe("stale");
    expect(f({ observedAt: new Date(NOW.getTime() - 599_999).toISOString() })).toBe("fresh");
    expect(f({ observedAt: at(-86400) })).toBe("stale");
  });

  it("clock skew: slightly in the future is fresh, beyond the skew is unavailable (never fresh)", () => {
    expect(f({ observedAt: at(30) })).toBe("fresh");
    expect(f({ observedAt: at(CLOCK_SKEW_SECONDS) })).toBe("fresh");
    expect(f({ observedAt: new Date(NOW.getTime() + CLOCK_SKEW_SECONDS * 1000 + 1).toISOString() })).toBe("unavailable");
    expect(f({ observedAt: at(3600) })).toBe("unavailable");
    expect(f({ observedAt: at(3600), maxAgeSeconds: null })).toBe("unavailable");
  });

  it("a retrievedAt in the future is not believable either", () => {
    expect(f({ observedAt: at(-10), retrievedAt: at(3600) })).toBe("unavailable");
    expect(f({ observedAt: at(-10), retrievedAt: at(-5) })).toBe("fresh");
  });

  it("not_applicable and unavailable take precedence in that order", () => {
    expect(f({ applicable: false, hasValue: false })).toBe("not_applicable");
    expect(f({ applicable: false })).toBe("not_applicable");
    expect(f({ hasValue: false })).toBe("unavailable");
  });

  it("falls back to retrievedAt when there is no observation time", () => {
    expect(f({ observedAt: null, retrievedAt: at(-100) })).toBe("fresh");
    expect(f({ observedAt: null, retrievedAt: at(-700) })).toBe("stale");
  });

  it("no time at all: fine without a limit, unavailable with one (the age cannot be established)", () => {
    expect(f({ observedAt: null, retrievedAt: null, maxAgeSeconds: null })).toBe("fresh");
    expect(f({ observedAt: null, retrievedAt: null, maxAgeSeconds: 600 })).toBe("unavailable");
  });

  it("no limit means an old observation is not stale, but a future one is still unavailable", () => {
    expect(f({ observedAt: at(-10 * 365 * 86400), maxAgeSeconds: null })).toBe("fresh");
  });

  it("garbage in -> unavailable", () => {
    expect(f({ observedAt: "not a date" })).toBe("unavailable");
    expect(f({ retrievedAt: "nope" })).toBe("unavailable");
    expect(f({ maxAgeSeconds: -1 })).toBe("unavailable");
    expect(f({ maxAgeSeconds: Number.NaN })).toBe("unavailable");
    expect(f({ now: new Date(Number.NaN) })).toBe("unavailable");
  });
});

describe("observed(): value is dropped whenever it may not be shown", () => {
  const prov = (over: Partial<Provenance> = {}): Provenance => ({
    source: "test",
    basis: "observed",
    observedAt: at(-10),
    retrievedAt: at(-5),
    maxAgeSeconds: 600,
    ...over,
  });

  it("fresh and stale keep the value; unavailable and not_applicable drop it", () => {
    expect(observed({ value: 7, provenance: prov(), now: NOW })).toMatchObject({ value: 7, freshness: "fresh" });
    expect(observed({ value: 7, provenance: prov({ observedAt: at(-9999) }), now: NOW })).toMatchObject({ value: 7, freshness: "stale" });
    expect(observed({ value: 7, provenance: prov({ observedAt: at(9999) }), now: NOW })).toMatchObject({ value: null, freshness: "unavailable" });
    expect(observed({ value: null, provenance: prov(), now: NOW })).toMatchObject({ value: null, freshness: "unavailable" });
    expect(observed({ value: 7, provenance: prov(), now: NOW, applicable: false })).toMatchObject({ value: null, freshness: "not_applicable" });
  });

  it("only a fresh observation may be called live", () => {
    expect(mayBeCalledLive(observed({ value: 1, provenance: prov(), now: NOW }))).toBe(true);
    expect(mayBeCalledLive(observed({ value: 1, provenance: prov({ observedAt: at(-9999) }), now: NOW }))).toBe(false);
    expect(mayBeCalledLive(observed({ value: 1, provenance: prov({ basis: "day_ahead_auction" }), now: NOW }))).toBe(false);
    expect(mayBeCalledLive(observed({ value: 1, provenance: prov({ basis: "published_report" }), now: NOW }))).toBe(false);
  });
});
