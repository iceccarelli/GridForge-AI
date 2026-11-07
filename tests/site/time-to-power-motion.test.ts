/**
 * FIG. 01 on the home page autoplays through scenarios. WCAG 2.2.2 (Pause, Stop, Hide) and 2.3.3 (Animation from Interactions) need:
 *   - no autoplay for a visitor who asks for reduced motion,
 *   - a visible control to pause and resume it, and
 *   - no overwriting of what the visitor typed: once they change an input, the reel stops for good.
 * The decision logic is a pure module (lib/ttp-autoplay.ts) so it is tested here with matchMedia stubs; the rendered behaviour (timers, sliders,
 * 390 px and 1440 px) is driven in a browser by tests/e2e/trust-journey.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { REDUCED_MOTION_QUERY, autoplayReducer, prefersReducedMotion, type AutoplayMode } from "@/lib/ttp-autoplay";

const media = (matches: boolean) => ({ matchMedia: (q: string) => ({ matches: q === REDUCED_MOTION_QUERY ? matches : false }) });

describe("prefersReducedMotion", () => {
  it("reads the real media query through matchMedia", () => {
    expect(REDUCED_MOTION_QUERY).toBe("(prefers-reduced-motion: reduce)");
    expect(prefersReducedMotion(media(true))).toBe(true);
    expect(prefersReducedMotion(media(false))).toBe(false);
  });
  it("is false when there is no window or no matchMedia, and when matchMedia throws (the page then falls back to the safe controls, not to a crash)", () => {
    expect(prefersReducedMotion(undefined)).toBe(false);
    expect(prefersReducedMotion({})).toBe(false);
    expect(prefersReducedMotion({ matchMedia: () => { throw new Error("blocked"); } })).toBe(false);
  });
});

describe("autoplayReducer", () => {
  const run = (from: AutoplayMode, ...actions: Parameters<typeof autoplayReducer>[1][]) => actions.reduce(autoplayReducer, from);

  it("nothing plays before the page has read the visitor's preference", () => {
    expect(run("paused")).toBe("paused");
  });
  it("starts on mount only when the visitor has NOT asked for reduced motion", () => {
    expect(run("paused", { type: "mount", reduced: false })).toBe("playing");
    expect(run("paused", { type: "mount", reduced: true })).toBe("paused");
  });
  it("a reduced-motion preference switched on later pauses a running reel; switching it off does not start one", () => {
    expect(run("playing", { type: "reduced_changed", reduced: true })).toBe("paused");
    expect(run("paused", { type: "reduced_changed", reduced: false })).toBe("paused");
  });
  it("Pause and Play are explicit and reversible, so a reduced-motion visitor may still choose to play it", () => {
    expect(run("playing", { type: "pause" })).toBe("paused");
    expect(run("paused", { type: "play" })).toBe("playing");
    expect(run("paused", { type: "mount", reduced: true }, { type: "play" })).toBe("playing");
  });
  it("choosing a scenario dot only pauses the reel (Play resumes it); it is a selection, not an edit, and never un-stops a stopped one", () => {
    expect(run("playing", { type: "scenario_selected" })).toBe("paused");
    expect(run("paused", { type: "scenario_selected" }, { type: "play" })).toBe("playing");
    expect(run("stopped", { type: "scenario_selected" })).toBe("stopped");
  });
  it("the first change to an input stops the reel for good: no later Play, mount or media change restarts it", () => {
    const stopped = run("playing", { type: "user_adjusted" });
    expect(stopped).toBe("stopped");
    for (const a of [{ type: "play" }, { type: "pause" }, { type: "mount", reduced: false }, { type: "reduced_changed", reduced: false }] as const) {
      expect(autoplayReducer(stopped, a), a.type).toBe("stopped");
    }
    expect(run("paused", { type: "user_adjusted" })).toBe("stopped");
  });
});

describe("the rendered panel", () => {
  it("starts without autoplay and offers a visible Play control whose accessible name contains its visible word", async () => {
    const { TimeToPower } = await import("@/components/TimeToPower");
    const html = renderToStaticMarkup(React.createElement(TimeToPower));
    const m = /<button[^>]*aria-label="([^"]*scenario autoplay)"[^>]*>(.*?)<\/button>/.exec(html);
    expect(m, "no Pause/Play control").not.toBeNull();
    expect(m![1]).toBe("Play scenario autoplay");
    expect(m![2]).toContain("Play");
    expect(m![1]).toContain("Play");
  });
  it("keeps all four sliders and labels them", async () => {
    const { TimeToPower } = await import("@/components/TimeToPower");
    const html = renderToStaticMarkup(React.createElement(TimeToPower));
    expect((html.match(/type="range"/g) ?? []).length).toBe(4);
  });
});

describe("the component no longer resumes over the visitor's inputs", () => {
  const src = fs.readFileSync(path.resolve(__dirname, "../../components/TimeToPower.tsx"), "utf8");
  it("has no timed resume (the old 20 s `pausedUntil`), and consults the preference before it schedules anything", () => {
    expect(src).not.toMatch(/pausedUntil/);
    expect(src).not.toMatch(/20000/);
    expect(src).toMatch(/prefersReducedMotion\(/);
    expect(src).toMatch(/useReducer\(autoplayReducer/);
  });
  it("only an input whose value actually changed goes through the stop-for-good path; a bare press and a scenario dot do not", () => {
    expect(src).toMatch(/user_adjusted/);
    expect(src).toMatch(/if \(next !== value\) onNudge\?\.\(\)/);
    expect(src).not.toMatch(/onPointerDown/);
    const dot = /onClick=\{\(\) => \{ cancelGlide\(\);.*?applyScenario\(i\); \}\}/.exec(src)?.[0] ?? "";
    expect(dot).toContain('dispatch({ type: "scenario_selected" })');
    expect(dot).not.toMatch(/nudge\(/);
  });
});
