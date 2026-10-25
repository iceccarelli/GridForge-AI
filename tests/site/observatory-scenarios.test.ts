// The Observatory's scenario file: the committed public/observatory/scenarios.json must satisfy the contract, and the validator
// must refuse every kind of corruption that would let a renderer draw a number the honesty rules forbid.
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  contentFingerprint,
  isIsoDate,
  loadScenarioFile,
  parseScenarioFile,
  resetScenarioFileCache,
} from "@/lib/observatory/scenario-data";

const FILE = path.join(process.cwd(), "public", "observatory", "scenarios.json");
const committed = (): any => JSON.parse(fs.readFileSync(FILE, "utf8"));

/** Apply a corruption to a fresh copy of the committed file and expect the parser to refuse it, naming `fragment`. */
function refuses(corrupt: (f: any) => void, fragment: string | RegExp) {
  const f = committed();
  corrupt(f);
  let message = "";
  try {
    parseScenarioFile(f);
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message, "the corrupted file was accepted").not.toBe("");
  if (typeof fragment === "string") expect(message).toContain(fragment);
  else expect(message).toMatch(fragment);
}

const hallA = (f: any) => f.scenarios[0];
const outcomeOf = (s: any, id: string) => s.outcomes.find((o: any) => o.id === id);

describe("the committed scenario file", () => {
  it("is accepted", () => {
    const parsed = parseScenarioFile(committed());
    expect(parsed.schema).toBe("gridforge/observatory-scenarios/1");
    expect(parsed.synthetic).toBe(true);
    expect(parsed.calibration.state).toBe("empty");
    expect(parsed.scenarios).toHaveLength(3);
  });

  it("holds three synthetic halls with thirteen constraints each and exactly one binding stage", () => {
    for (const s of parseScenarioFile(committed()).scenarios) {
      expect(s.synthetic).toBe(true);
      expect(s.title).toMatch(/^Synthetic Hall [ABC]$/);
      expect(s.hall.name).toBe(s.title);
      expect(s.hall.region).toBe("invented site (no location)");
      expect(s.constraints).toHaveLength(13);
      expect(s.constraints.filter((c) => c.binds)).toHaveLength(1);
      expect(s.powerPath.filter((n) => n.binds)).toHaveLength(1);
      expect(s.powerPath.map((n) => n.kind)).toEqual(
        ["utility", "transformer", "switchgear", "ups", "busway", "rack_feed", "rack", "cooling", "cooling"],
      );
    }
  });

  it("never dates an outcome on an assumed lead time, and gives no weeks without a date", () => {
    for (const s of parseScenarioFile(committed()).scenarios) {
      for (const o of s.outcomes) {
        expect(o.dated).toBe(o.weeksToCapacity.value !== null);
        if (o.weeksToCapacity.value === null) expect(o.weeksToCapacity.missingReason).toBeTruthy();
      }
    }
  });

  it("states a missing capex rather than a zero for an outcome that deploys no rack", () => {
    const zero = parseScenarioFile(committed()).scenarios.flatMap((s) => s.outcomes).filter((o) => o.racksAfterPlan === 0);
    expect(zero.length).toBeGreaterThan(0);
    for (const o of zero) {
      expect(o.capexEur.value).toBeNull();
      expect(o.capexEur.missingReason).toBeTruthy();
    }
  });

  it("places no hall in a real city and never says a constraint is unlimited", () => {
    const text = fs.readFileSync(FILE, "utf8");
    expect(text).not.toMatch(/Frankfurt|Dublin|Oslo|Ireland|Norway|Germany/i);
    expect(text).not.toMatch(/unlimited/i);
  });

  it("marks a constraint as passing exactly when the engine reports no finite limit", () => {
    for (const s of parseScenarioFile(committed()).scenarios) {
      expect(s.constraints.some((c) => c.passes)).toBe(true);
      for (const c of s.constraints) {
        expect(c.passes).toBe(c.racksAllowed === null);
        if (c.passes) expect(c.binds).toBe(false);
      }
    }
  });

  it("states whether each capex is complete and what its priced lines rest on", () => {
    const outcomes = parseScenarioFile(committed()).scenarios.flatMap((s) => s.outcomes);
    for (const o of outcomes) {
      expect(o.capexPricing === "none").toBe(o.capexEur.value === null);
      if (o.unpricedComponents.length > 0) expect(o.capexComplete).toBe(false);
      if (o.capexEur.value === null) expect(o.capexComplete).toBe(false);
    }
    expect(new Set(outcomes.map((o) => o.capexPricing))).toEqual(new Set(["none", "placeholder", "partly_supplied"]));
  });

  it("carries a content fingerprint that this loader reproduces from the generator's output", () => {
    const f = committed();
    expect(f.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(contentFingerprint(f)).toBe(f.contentSha256);
  });

  it("fingerprints exactly as scripts/build-observatory.py does (shared test vector)", () => {
    const vector = { b: [1, 2.5, 12000, 0.97, null, true, false, 'x"\u00e9\n\u2014', -0, 0.1], a: { z: "\u2014", y: 3 }, contentSha256: "ignored" };
    expect(contentFingerprint(vector)).toBe("867c1bb12efd6ad3c2aaf3c4d364c3f5f613b3c8d9f94e18ed25f74838316f7f");
    expect(contentFingerprint({ ...vector, contentSha256: "something else" })).toBe(contentFingerprint(vector));
    expect(() => contentFingerprint({ x: 1e-7 })).toThrow(/exponent/);
    expect(() => contentFingerprint({ x: 2 ** 60 })).toThrow(/out of range/);
  });

  it("is loaded, validated and memoised by loadScenarioFile", () => {
    resetScenarioFileCache();
    const a = loadScenarioFile();
    const b = loadScenarioFile();
    expect(b).toBe(a);
    expect(a).toEqual(parseScenarioFile(committed()));
  });
});

describe("parseScenarioFile refuses", () => {
  beforeEach(() => resetScenarioFileCache());

  it("anything that is not an object", () => {
    for (const raw of [null, undefined, 1, "x", [], {}]) expect(() => parseScenarioFile(raw)).toThrow(/not a valid Observatory scenario file/);
  });

  it("an unknown schema", () => {
    refuses((f) => (f.schema = "gridforge/observatory-scenarios/2"), "schema");
    refuses((f) => delete f.schema, "schema");
  });

  it("a file or a scenario that is not synthetic", () => {
    refuses((f) => (f.synthetic = false), "synthetic");
    refuses((f) => (f.scenarios[1].synthetic = false), "scenarios.1.synthetic");
    refuses((f) => delete f.scenarios[2].synthetic, "synthetic");
  });

  it("a hall whose title or name does not say it is synthetic", () => {
    refuses((f) => (hallA(f).title = "Hall A"), "synthetic");
    refuses((f) => (hallA(f).hall.name = "Hall A"), "synthetic");
  });

  it("a quantity with a value but no evidence class", () => {
    refuses((f) => delete hallA(f).powerPath[0].capacity.evidence, "powerPath.0.capacity.evidence");
    refuses((f) => delete outcomeOf(hallA(f), "hybrid_dlc").capexEur.evidence, "capexEur.evidence");
    refuses((f) => (hallA(f).powerPath[0].capacity.evidence = "E9"), "evidence");
  });

  it("a quantity with no value and no reason, or a range that contradicts itself", () => {
    refuses((f) => delete hallA(f).powerPath[2].capacity.missingReason, "must say why");
    refuses((f) => {
      const c = hallA(f).powerPath[0].capacity;
      [c.low, c.high] = [c.high + 1, c.low];
    }, /inverted|outside/);
    refuses((f) => (hallA(f).powerPath[0].capacity.high = hallA(f).powerPath[0].capacity.value - 1), "outside its own range");
  });

  it("a stage the engine does not model that states a capacity or binds", () => {
    refuses((f) => {
      const n = hallA(f).powerPath[2];
      expect(n.constraintKey).toBeNull();
      n.capacity = { value: 5000, low: 5000, high: 5000, unit: "kW", evidence: "E3" };
    }, "cannot state a capacity");
    refuses((f) => (hallA(f).powerPath[2].binds = true), "cannot bind");
  });

  it("a claim of measurement or field validation (E6/E7)", () => {
    refuses((f) => (hallA(f).constraints[0].evidence = "E6"), "E6/E7");
    refuses((f) => (outcomeOf(hallA(f), "hybrid_dlc").evidence = "E7"), "E6/E7");
    refuses((f) => (hallA(f).powerPath[0].capacity.evidence = "E7"), "E6/E7");
  });

  it("a dated outcome with no weeks, weeks without a date, or a date resting on an assumed lead time", () => {
    refuses((f) => (outcomeOf(hallA(f), "hybrid_dlc").dated = true), "dated outcome must have weeksToCapacity");
    refuses((f) => {
      const o = outcomeOf(hallA(f), "hybrid_dlc");
      o.weeksToCapacity = { value: 160, low: 80, high: 210, unit: "weeks", evidence: "E0" };
    }, "not dated");
    refuses((f) => {
      const o = outcomeOf(hallA(f), "hybrid_dlc");
      o.dated = true;
      o.weeksToCapacity = { value: 160, low: 80, high: 210, unit: "weeks", evidence: "E0" };
    }, "assumed (E0)");
  });

  it("a dated outcome that is legitimately supported is accepted once re-sealed (the rule is not simply 'never dated')", () => {
    const f = committed();
    const o = outcomeOf(hallA(f), "hybrid_dlc");
    o.dated = true;
    o.weeksToCapacity = { value: 40, low: 30, high: 50, unit: "weeks", evidence: "E3" };
    expect(() => parseScenarioFile(f)).toThrow(/contentSha256/); // schema-valid, but not what the generator wrote
    f.contentSha256 = contentFingerprint(f);
    expect(() => parseScenarioFile(f)).not.toThrow();
  });

  it("a constraint whose passes flag disagrees with racksAllowed, or a passing constraint that binds", () => {
    refuses((f) => {
      const c = hallA(f).constraints.find((x: any) => x.racksAllowed === null);
      c.passes = false;
    }, "passes must be true exactly when racksAllowed is null");
    refuses((f) => {
      const c = hallA(f).constraints.find((x: any) => x.racksAllowed !== null);
      c.passes = true;
    }, "passes must be true exactly when racksAllowed is null");
    refuses((f) => delete hallA(f).constraints[0].passes, "passes");
    refuses((f) => {
      const c = hallA(f).constraints.find((x: any) => x.racksAllowed === null);
      c.binds = true;
    }, /cannot bind|more than one constraint binds/);
  });

  it("a capex whose pricing or completeness contradicts its figure", () => {
    refuses((f) => (outcomeOf(hallA(f), "hybrid_dlc").capexPricing = "none"), 'cannot have capexPricing "none"');
    refuses((f) => (outcomeOf(hallA(f), "retained_air").capexPricing = "placeholder"), 'capexPricing "none"');
    refuses((f) => (outcomeOf(hallA(f), "retained_air").capexComplete = true), "cannot have a complete capex");
    refuses((f) => {
      const o = outcomeOf(hallA(f), "hybrid_dlc");
      expect(o.unpricedComponents.length).toBeGreaterThan(0);
      o.capexComplete = true;
    }, "not complete");
    refuses((f) => (outcomeOf(hallA(f), "hybrid_dlc").capexPricing = "cheap"), "capexPricing");
    refuses((f) => delete outcomeOf(hallA(f), "hybrid_dlc").capexComplete, "capexComplete");
  });

  it("a schema-valid hand edit of an engine figure (the content seal no longer verifies)", () => {
    const shift = (q: any, d: number) => {
      for (const k of ["value", "low", "high"]) if (q[k] !== null) q[k] += d;
    };
    const edits: [string, (f: any) => void][] = [
      ["racks after the plan", (f) => (outcomeOf(hallA(f), "hybrid_dlc").racksAfterPlan += 1)],
      ["racks as found", (f) => (outcomeOf(hallA(f), "hybrid_dlc").racksAsFound += 1)],
      ["a stage capacity", (f) => shift(hallA(f).powerPath[0].capacity, 1)],
      ["a stage capacity range", (f) => (hallA(f).powerPath[0].capacity.high += 1)],
      ["a load after the plan", (f) => shift(hallA(f).powerPath[1].loadAfterPlan, -1)],
      ["a constraint limit", (f) => (hallA(f).constraints.find((c: any) => c.racksAllowed !== null).racksAllowed += 1)],
      ["a capex", (f) => shift(outcomeOf(hallA(f), "hybrid_dlc").capexEur, 1)],
      ["an IT load", (f) => shift(outcomeOf(hallA(f), "hybrid_dlc").itLoadKwAfterPlan, 1)],
      ["the hall's contracted power", (f) => (hallA(f).hall.contractedMW += 1)],
      ["a rack row", (f) => (hallA(f).rackRows[0].racks += 1)],
      ["an evidence class", (f) => (hallA(f).constraints[0].evidence = "E3")],
      ["the engine hash", (f) => (f.engine.codeSha256 = "1".repeat(64))],
      ["the date", (f) => (f.generatedAt = "2026-09-15")],
      ["a limitation sentence", (f) => (hallA(f).limitations[2] += " (edited)")],
    ];
    for (const [what, edit] of edits) {
      const f = committed();
      edit(f);
      let message = "";
      try {
        parseScenarioFile(f);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, `a hand edit of ${what} was accepted`).toMatch(/contentSha256/);
    }
  });

  it("a missing or malformed content seal", () => {
    refuses((f) => delete f.contentSha256, "contentSha256");
    refuses((f) => (f.contentSha256 = "abc"), "contentSha256");
  });

  it("a capex figure on an outcome that deploys no rack", () => {
    refuses((f) => {
      const o = outcomeOf(hallA(f), "retained_air");
      expect(o.racksAfterPlan).toBe(0);
      o.capexEur = { value: 0, low: 0, high: 0, unit: "EUR", evidence: "E0" };
    }, "no capex");
  });

  it("an outcome stronger than the weakest thing it rests on", () => {
    refuses((f) => (outcomeOf(hallA(f), "hybrid_dlc").evidence = "E5"), "stronger than its weakest input");
  });

  it("a date that is not ISO 8601", () => {
    for (const bad of ["14/09/2026", "2026-13-40", "2026-02-30", "Sept 14 2026", "", "20260914", "2026-09-14T25:00:00Z"]) {
      refuses((f) => (f.generatedAt = bad), "generatedAt");
    }
    expect(isIsoDate("2026-09-14")).toBe(true);
    expect(isIsoDate("2026-09-14T08:30:00Z")).toBe(true);
    expect(isIsoDate("2024-02-29")).toBe(true);
    expect(isIsoDate("2025-02-29")).toBe(false);
  });

  it("a headline outcome that names no outcome", () => {
    refuses((f) => (hallA(f).headlineOutcome = "quantum_dlc"), "headlineOutcome");
  });

  it("a binding key that is not one of the constraints", () => {
    refuses((f) => (outcomeOf(hallA(f), "hybrid_dlc").bindingAfterPlan = "not_a_constraint"), "bindingAfterPlan");
    refuses((f) => (hallA(f).powerPath[0].constraintKey = "not_a_constraint"), "constraintKey");
  });

  it("a node that binds where the constraint does not, or two binding constraints", () => {
    refuses((f) => {
      const s = hallA(f);
      s.powerPath.forEach((n: any) => (n.binds = false));
      s.powerPath[1].binds = true; // transformer: not the binding constraint in hall A
    }, "does not");
    refuses((f) => (hallA(f).constraints[1].binds = true), "more than one constraint binds");
  });

  it("duplicate ids", () => {
    refuses((f) => (f.scenarios[1].id = f.scenarios[0].id), "duplicate scenario id");
    refuses((f) => (hallA(f).outcomes[1].id = hallA(f).outcomes[0].id), "duplicate outcome id");
    refuses((f) => (hallA(f).powerPath[1].id = hallA(f).powerPath[0].id), "duplicate path node id");
    refuses((f) => (hallA(f).constraints[1].key = hallA(f).constraints[0].key), "duplicate constraint key");
    refuses((f) => (hallA(f).rackRows[1].id = hallA(f).rackRows[0].id), "duplicate rack row id");
  });

  it("a string that looks like an email address or a web address", () => {
    refuses((f) => (hallA(f).summary += " Contact ops@example-datacentre.com for the site."), "email address");
    refuses((f) => (hallA(f).limitations.push("See https://example.org/hall for more.")), "URL");
    refuses((f) => (hallA(f).limitations.push("See www.somehall.net")), /web address|domain name/);
    refuses((f) => (hallA(f).hall.region = "Frankfurt, DE (acme-colo.de)"), "domain name");
    refuses((f) => (f.calibration.statement += " ftp://files.internal/x"), "URL");
  });

  it("limitations that do not say the calibration ledger is empty", () => {
    refuses((f) => (hallA(f).limitations = hallA(f).limitations.filter((l: string) => !/calibration ledger is empty/i.test(l))), "calibration ledger is empty");
  });

  it("a calibration state other than empty, and a malformed engine block", () => {
    refuses((f) => (f.calibration.state = "calibrated"), "calibration.state");
    refuses((f) => (f.engine.codeSha256 = "abc"), "codeSha256");
    refuses((f) => (f.engine.routes = []), "routes");
  });

  it("unknown keys, so a drifting generator is noticed", () => {
    refuses((f) => (f.liveNow = true), /Unrecognized key/);
    refuses((f) => (hallA(f).hall.customer = "Acme"), /Unrecognized key/);
  });
});
