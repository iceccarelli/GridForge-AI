import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildJourney, durationFor, frameAt, totalDuration } from "@/lib/observatory/journey";
import { cuesFor, escapeVtt, lintCaption, toWebVtt, vttTime } from "@/lib/observatory/captions";
import type { JourneyStep, ScenarioFile } from "@/lib/observatory/types";
import { FIXTURE_FILE, FIXTURE_HALL_A, FIXTURE_HALL_B } from "./observatory-fixtures";

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));
const THREE: ScenarioFile = { ...FIXTURE_FILE, scenarios: [FIXTURE_HALL_A, FIXTURE_HALL_B, { ...clone(FIXTURE_HALL_B), id: "fixture-hall-c", title: "Fixture Hall C" }] };

describe("buildJourney: the tour", () => {
  const steps = buildJourney(THREE);

  it("follows the agreed order for three halls, with unique ids", () => {
    expect(steps.map((s) => s.id)).toEqual([
      "overview",
      "hall-1-path",
      "hall-1-binding",
      "hall-1-constraints",
      "hall-1-plan",
      "hall-1-alternative",
      "context",
      "hall-2-path",
      "hall-2-outcome",
      "hall-3-path",
      "hall-3-outcome",
      "close",
    ]);
    expect(new Set(steps.map((s) => s.id)).size).toBe(steps.length);
    expect(steps.map((s) => s.panel)).toEqual(["outcomes", "path", "path", "constraints", "outcomes", "outcomes", "context", "path", "outcomes", "path", "outcomes", "outcomes"]);
  });

  it("is roughly a three to four minute tour for three halls", () => {
    const total = totalDuration(steps);
    expect(total).toBeGreaterThanOrEqual(180);
    expect(total).toBeLessThanOrEqual(240);
  });

  it("two halls and one hall tour the same way, shorter; no halls gives one explanatory step", () => {
    const two = buildJourney(FIXTURE_FILE);
    expect(two.map((s) => s.id)).toEqual(["overview", "hall-1-path", "hall-1-binding", "hall-1-constraints", "hall-1-plan", "hall-1-alternative", "context", "hall-2-path", "hall-2-outcome", "close"]);
    expect(two[0].caption).toMatch(/^Two synthetic demonstration halls/);
    const one = buildJourney({ ...FIXTURE_FILE, scenarios: [FIXTURE_HALL_A] });
    expect(one[0].caption).toMatch(/^One synthetic demonstration hall,/);
    expect(one.at(-1)?.id).toBe("close");
    const none = buildJourney({ ...FIXTURE_FILE, scenarios: [] });
    expect(none).toHaveLength(1);
    expect(none[0].caption).toMatch(/No demonstration halls/);
    expect(frameAt(none, 5).step.id).toBe("overview");
  });

  it("only the first three halls are toured", () => {
    const four = buildJourney({ ...THREE, scenarios: [...THREE.scenarios, { ...clone(FIXTURE_HALL_B), id: "d", title: "Fixture Hall D" }] });
    expect(four.map((s) => s.id)).toEqual(steps.map((s) => s.id));
    expect(JSON.stringify(four)).not.toContain("Fixture Hall D");
  });

  it("focuses on the binding stage as found, from the data", () => {
    expect(steps[0].focus).toBeNull();
    expect(steps.find((s) => s.id === "hall-1-binding")?.focus).toBe("a-transformer");
    expect(steps.find((s) => s.id === "hall-1-constraints")?.focus).toBe("transformer");
    expect(steps.find((s) => s.id === "hall-1-plan")?.focus).toBe("a-cooling");
    expect(steps.find((s) => s.id === "hall-2-path")?.focus).toBeNull(); // hall B: nothing is flagged, nothing is guessed
    expect(steps.find((s) => s.id === "hall-2-path")?.caption).toMatch(/does not identify which stage binds/);
  });

  it("scenario and outcome ids always refer to real things", () => {
    for (const s of steps) {
      const sc = THREE.scenarios.find((x) => x.id === s.scenarioId);
      expect(sc, s.id).toBeTruthy();
      expect(sc!.outcomes.some((o) => o.id === s.outcomeId), s.id).toBe(true);
    }
  });

  it("says 'not dated' wherever the file says an outcome is not dated, and states weeks only where it is dated", () => {
    const plan = steps.find((s) => s.id === "hall-1-plan")!;
    expect(plan.caption).toContain("Programme time is 52 weeks, from supplied lead times.");
    expect(plan.caption).not.toMatch(/not dated/i);
    for (const id of ["hall-1-alternative", "hall-2-outcome", "hall-3-outcome"]) {
      const c = steps.find((s) => s.id === id)!.caption;
      expect(c, id).toContain("Not dated");
      expect(c, id).not.toMatch(/\d+ weeks/);
    }
    // a dated flag without a number is still not a date
    const odd = clone(FIXTURE_FILE);
    odd.scenarios[0].outcomes[0].weeksToCapacity.value = null;
    expect(buildJourney(odd).find((s) => s.id === "hall-1-plan")?.caption).toContain("Not dated");
  });

  it("an undated outcome never gets a week count even if the file carries one", () => {
    const odd = clone(FIXTURE_FILE);
    odd.scenarios[0].outcomes[0].dated = false;
    const c = buildJourney(odd).find((s) => s.id === "hall-1-plan")!.caption;
    expect(c).toContain("Not dated");
    expect(c).not.toMatch(/52/);
  });

  it("the context step speaks the provenance of the price", () => {
    const c = steps.find((s) => s.id === "context")!;
    expect(c.panel).toBe("context");
    expect(c.caption).toContain("a day-ahead auction price for an hour in Germany's market, a published result, not a live reading");
    expect(c.caption).not.toMatch(/this hour|\bnow\b|today|right now/i);
    expect(c.caption).not.toMatch(/\d/); // no figure that could age
    expect(c.caption).toContain("none of it is where these halls are");
  });

  it("closes with the free qualifier as the next step, caption only", () => {
    const last = steps[steps.length - 1];
    expect(last.id).toBe("close");
    expect(last.caption).toMatch(/free capacity qualifier/);
    expect(last.caption).toMatch(/next step/);
    expect(last.caption).not.toMatch(/\b(buy|purchase|price|pay|plan|subscribe|checkout)\b/i);
  });

  it("an engine key with no stage in the view is reported as the engine gave it, not explained away", () => {
    expect(steps.find((s) => s.id === "hall-2-outcome")?.caption).toContain('After the plan the engine names "grid-queue-position" as the limit, which this view does not model.');
  });

  it("degenerate data does not throw: no constraints, no outcomes", () => {
    const bare = clone(FIXTURE_FILE);
    bare.scenarios[0].constraints = [];
    bare.scenarios[0].outcomes = [];
    const s = buildJourney(bare);
    expect(s.find((x) => x.id === "hall-1-constraints")?.caption).toMatch(/lists no constraints/);
    expect(s.find((x) => x.id === "hall-1-plan")?.caption).toMatch(/no plan or outcome/);
    expect(s.find((x) => x.id === "hall-1-plan")?.outcomeId).toBe("");
  });

  it("ranks constraints by racks allowed ascending, unsupported last, ties by key", () => {
    const c = steps.find((s) => s.id === "hall-1-constraints")!.caption;
    expect(c).toContain("Transformer 100 (E1), UPS 110 (E1) and Cooling plant 128 (E2)");
    expect(c).toContain("Floor loading does not limit the hall (passes).");
    expect(c).toContain("The limit is Transformer.");
    const withNull = clone(FIXTURE_FILE);
    withNull.scenarios[0].constraints.forEach((x) => {
      x.racksAllowed = x.key === "floor" ? 90 : x.key === "ups" ? null : x.racksAllowed;
      x.passes = x.racksAllowed === null; // the contract: passes iff racksAllowed is null
    });
    expect(buildJourney(withNull).find((s) => s.id === "hall-1-constraints")!.caption).toContain("Floor loading 90 (E0), Transformer 100 (E1) and Cooling plant 128 (E2)");
  });
});

describe("determinism and the clock", () => {
  it("buildJourney is a pure function of the file", () => {
    const a = buildJourney(THREE);
    const b = buildJourney(clone(THREE));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("the journey, scene, caption and source-free modules never read the clock or randomness", () => {
    for (const f of ["journey.ts", "captions.ts", "scene-model.ts"]) {
      const src = readFileSync(`lib/observatory/${f}`, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(src, f).not.toMatch(/Date\.now|new Date\(|Math\.random|performance\.now|toLocale|Intl\./);
    }
  });

  it("durationFor is whole seconds and never shorter than reading time", () => {
    expect(durationFor(10, "one two three")).toBe(10);
    const long = Array.from({ length: 50 }, () => "word").join(" ");
    expect(durationFor(10, long)).toBe(20); // ceil(50 / 3) + 3
    expect(Number.isInteger(durationFor(7, "a b c d e f g"))).toBe(true);
  });
});

describe("frameAt", () => {
  const steps = buildJourney(THREE);
  const total = totalDuration(steps);

  it("totalDuration is the sum of the steps", () => {
    expect(total).toBe(steps.reduce((a, s) => a + s.durationSec, 0));
    expect(totalDuration([])).toBe(0);
  });

  it("the same t gives an equal frame, every time", () => {
    for (const t of [0, 1, 17.5, 100, total - 0.001, total]) {
      expect(frameAt(steps, t)).toEqual(frameAt(steps, t));
      expect(JSON.stringify(frameAt(steps, t))).toBe(JSON.stringify(frameAt(buildJourney(THREE), t)));
    }
  });

  it("clamps: before the start, after the end, NaN and infinities", () => {
    expect(frameAt(steps, -50)).toMatchObject({ t: 0, stepIndex: 0, progress: 0, done: false });
    expect(frameAt(steps, Number.NaN)).toMatchObject({ t: 0, stepIndex: 0 });
    expect(frameAt(steps, Number.NEGATIVE_INFINITY)).toMatchObject({ t: 0, stepIndex: 0 });
    const end = frameAt(steps, total);
    expect(end).toMatchObject({ t: total, stepIndex: steps.length - 1, progress: 1, done: true });
    expect(frameAt(steps, total + 1000)).toEqual(end);
    expect(frameAt(steps, Number.POSITIVE_INFINITY)).toEqual(end);
  });

  it("boundaries: the instant a step ends the next begins at progress 0; just before it is the old step near 1", () => {
    let start = 0;
    steps.forEach((s, i) => {
      const f = frameAt(steps, start);
      expect(f.stepIndex, s.id).toBe(i);
      expect(f.progress, s.id).toBe(0);
      expect(f.done).toBe(false);
      if (i > 0) {
        const before = frameAt(steps, start - 1e-6);
        expect(before.stepIndex).toBe(i - 1);
        expect(before.progress).toBeGreaterThan(0.99);
      }
      start += s.durationSec;
    });
  });

  it("walks monotonically through every step with progress in [0, 1)", () => {
    let last = -1;
    const seen = new Set<number>();
    for (let t = 0; t < total; t += 0.5) {
      const f = frameAt(steps, t);
      expect(f.stepIndex).toBeGreaterThanOrEqual(last);
      expect(f.progress).toBeGreaterThanOrEqual(0);
      expect(f.progress).toBeLessThan(1);
      expect(f.done).toBe(false);
      last = f.stepIndex;
      seen.add(f.stepIndex);
    }
    expect(seen.size).toBe(steps.length);
  });

  it("zero-length and invalid-duration steps are skipped, not divided by", () => {
    const odd: JourneyStep[] = [
      { ...steps[0], id: "a", durationSec: 0 },
      { ...steps[1], id: "b", durationSec: 10 },
      { ...steps[2], id: "c", durationSec: -5 },
      { ...steps[3], id: "d", durationSec: Number.NaN },
      { ...steps[4], id: "e", durationSec: 10 },
    ];
    expect(totalDuration(odd)).toBe(20);
    expect(frameAt(odd, 0).step.id).toBe("b");
    expect(frameAt(odd, 10).step.id).toBe("e");
    expect(frameAt(odd, 20)).toMatchObject({ done: true, progress: 1 });
    expect(Number.isFinite(frameAt(odd, 5).progress)).toBe(true);
  });

  it("an empty journey is a programming error, said plainly", () => {
    expect(() => frameAt([], 0)).toThrow(RangeError);
  });
});

describe("captions: cues and WebVTT from the same text", () => {
  const steps = buildJourney(THREE);
  const cues = cuesFor(steps);

  it("one cue per step, exactly the step caption over exactly the step's time", () => {
    expect(cues).toHaveLength(steps.length);
    let t = 0;
    steps.forEach((s, i) => {
      expect(cues[i].text).toBe(s.caption);
      expect(cues[i].startSec).toBe(t);
      expect(cues[i].endSec).toBe(t + s.durationSec);
      t += s.durationSec;
    });
    expect(cues[cues.length - 1].endSec).toBe(totalDuration(steps));
  });

  it("no overlaps, strictly increasing", () => {
    for (let i = 0; i < cues.length; i++) {
      expect(cues[i].endSec).toBeGreaterThan(cues[i].startSec);
      if (i > 0) expect(cues[i].startSec).toBeGreaterThanOrEqual(cues[i - 1].endSec);
    }
  });

  it("frameAt(t) and the cue at t name the same caption", () => {
    for (let t = 0; t < totalDuration(steps); t += 3.7) {
      const cue = cues.find((c) => t >= c.startSec && t < c.endSec)!;
      expect(cue.text).toBe(frameAt(steps, t).step.caption);
    }
  });

  it("toWebVtt is a valid WEBVTT file", () => {
    const vtt = toWebVtt(steps);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(vtt.endsWith("\n")).toBe(true);
    expect(vtt).not.toMatch(/\r/);
    const blocks = vtt.trimEnd().split("\n\n");
    expect(blocks[0]).toBe("WEBVTT");
    expect(blocks).toHaveLength(cues.length + 1);
    const timing = /^(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3}) --> (\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})$/;
    let prevEnd = -1;
    blocks.slice(1).forEach((b, i) => {
      const lines = b.split("\n");
      expect(lines).toHaveLength(3); // id, timing, one line of text (no blank line can end a cue early)
      expect(lines[0]).toBe(String(i + 1));
      const m = timing.exec(lines[1]);
      expect(m, lines[1]).not.toBeNull();
      const ms = (h: string, mi: string, s: string, x: string) => ((+h * 60 + +mi) * 60 + +s) * 1000 + +x;
      const start = ms(m![1], m![2], m![3], m![4]);
      const end = ms(m![5], m![6], m![7], m![8]);
      expect(end).toBeGreaterThan(start);
      expect(start).toBeGreaterThanOrEqual(prevEnd);
      expect(start).toBe(cues[i].startSec * 1000);
      expect(end).toBe(cues[i].endSec * 1000);
      prevEnd = end;
      expect(lines[2]).not.toContain("-->");
    });
  });

  it("time formatting: hh:mm:ss.mmm, hours roll, milliseconds exact", () => {
    expect(vttTime(0)).toBe("00:00:00.000");
    expect(vttTime(1.5)).toBe("00:00:01.500");
    expect(vttTime(61.001)).toBe("00:01:01.001");
    expect(vttTime(3600)).toBe("01:00:00.000");
    expect(vttTime(3723.045)).toBe("01:02:03.045");
    expect(vttTime(-4)).toBe("00:00:00.000");
    expect(vttTime(Number.NaN)).toBe("00:00:00.000");
  });

  it("escapes '-->', '&', '<' and '>' and flattens newlines", () => {
    expect(escapeVtt("a --> b & c < d > e")).toBe("a --&gt; b &amp; c &lt; d &gt; e");
    expect(escapeVtt("line one\n\nline two\r\nthree")).toBe("line one line two three");
    const hostile: JourneyStep[] = [
      { id: "x", durationSec: 5, scenarioId: "s", outcomeId: "o", focus: null, panel: "path", caption: "R&D <b>bold</b> a --> b\n\nWEBVTT" },
      { id: "y", durationSec: 5, scenarioId: "s", outcomeId: "o", focus: null, panel: "path", caption: "second" },
    ];
    const vtt = toWebVtt(hostile);
    expect(vtt).toBe(
      "WEBVTT\n\n1\n00:00:00.000 --> 00:00:05.000\nR&amp;D &lt;b&gt;bold&lt;/b&gt; a --&gt; b WEBVTT\n\n2\n00:00:05.000 --> 00:00:10.000\nsecond\n",
    );
    // the only "-->" in the whole file are the timing lines
    expect(vtt.match(/-->/g)).toHaveLength(2);
  });

  it("zero-length steps and empty captions produce no cue; an empty journey is a header only", () => {
    const base: JourneyStep = { id: "a", durationSec: 5, scenarioId: "s", outcomeId: "o", focus: null, panel: "path", caption: "kept" };
    const cs = cuesFor([{ ...base, durationSec: 0 }, base, { ...base, caption: "  " }, { ...base, caption: "after" }]);
    expect(cs.map((c) => c.text)).toEqual(["kept", "after"]);
    expect(cs[1].startSec).toBe(10); // the blank step still took its 5 seconds
    expect(toWebVtt([])).toBe("WEBVTT\n");
  });
});

describe("honesty lint of every caption", () => {
  it("lintCaption catches what it must and lets the denials through", () => {
    expect(lintCaption("Write to alice@example.com")).toContain("contains an email address");
    for (const bad of ["It costs EUR 500 a month", `from ${String.fromCharCode(0x20ac)}99`, "99 EUR", "about 1,200 euros", "5 euro"]) {
      expect(lintCaption(bad), bad).toContain("contains a price in EUR");
    }
    for (const bad of ["Buy it now", "purchase the report", "go to checkout", "subscribe today"]) {
      expect(lintCaption(bad), bad).toContain("contains a purchase or pricing word");
    }
    for (const bad of ["Live market data", "the live price", "a live reading", "now live", "is live: 5"]) {
      expect(lintCaption(bad), bad).toContain('uses "live" for something that is not a live observation');
    }
    for (const ok of ["a published auction result, not a live reading", "this is not live", "it is not a live reading", "Alive and well", "Olive, delivered"]) {
      expect(lintCaption(ok), ok).toEqual([]);
    }
    expect(lintCaption("A capex of EUR 2,400,000 for a hall")).toContain("contains a price in EUR");
  });

  function assertClean(label: string, steps: JourneyStep[]) {
    expect(steps.length).toBeGreaterThan(0);
    for (const s of steps) {
      expect(lintCaption(s.caption), `${label} / ${s.id}: ${s.caption}`).toEqual([]);
      expect(s.caption.length, `${s.id} is two short sentences, not a paragraph`).toBeLessThanOrEqual(420);
      expect(s.caption, s.id).not.toMatch(/\n/);
      expect(s.caption, s.id).toBe(s.caption.trim());
      expect(s.caption, s.id).not.toMatch(/\s{2,}/);
      expect(s.caption, s.id).not.toMatch(/undefined|null|NaN/);
    }
  }

  it("every caption of the fixture tours (1, 2, 3 halls, degenerate data) passes", () => {
    assertClean("one", buildJourney({ ...FIXTURE_FILE, scenarios: [FIXTURE_HALL_A] }));
    assertClean("two", buildJourney(FIXTURE_FILE));
    assertClean("three", buildJourney(THREE));
    const bare = clone(FIXTURE_FILE);
    bare.scenarios.forEach((s) => ((s.constraints = []), (s.outcomes = []), (s.powerPath = [])));
    assertClean("bare", buildJourney(bare));
    assertClean("none", buildJourney({ ...FIXTURE_FILE, scenarios: [] }));
  });

  it("money appears only as the modelled capital cost of an option, 'at least' when partial, never as a raw EUR figure", () => {
    const all = buildJourney(THREE).map((s) => s.caption).join(" ");
    expect(all).not.toMatch(/\bEUR\b|€|2,400,000|capex/);
    expect(all).toContain("Modelled capital cost at least 2.4 million euros, priced lines only, at library placeholder prices.");
  });

  it("the lint would catch a file that smuggled an email or a price into a title", () => {
    const hostile = clone(FIXTURE_FILE);
    hostile.scenarios[0].title = "Mail me at x@y.com for EUR 500";
    const problems = buildJourney(hostile).flatMap((s) => lintCaption(s.caption));
    expect(problems).toEqual(expect.arrayContaining(["contains an email address", "contains a price in EUR"]));
  });

  it("the generated scenario file, when it exists, tours cleanly too", () => {
    const path = "public/observatory/scenarios.json";
    if (!existsSync(path)) return; // produced by the data workstream; absent here is not a failure of this module
    const file = JSON.parse(readFileSync(path, "utf8")) as ScenarioFile;
    const steps = buildJourney(file);
    assertClean("generated", steps);
    expect(totalDuration(steps)).toBeGreaterThan(0);
  });
});
