/**
 * The 2D / 3D decision is a pure function. These tests pin the rule that decides whether three.js is ever downloaded.
 */
import { describe, expect, it } from "vitest";
import { INITIAL_DECISION, MIN_3D_CORES, MIN_3D_MEMORY_GB, MIN_3D_VIEWPORT_PX, decideStage, lowPowerHint, type StageSignals } from "@/components/observatory/stage-mode";

const capableDesktop: StageSignals = {
  webgl: true,
  saveData: false,
  viewportWidth: 1440,
  coarsePointer: false,
  cores: 8,
  memoryGb: 8,
  userChoice: null,
  contextFailed: false,
};
const sig = (over: Partial<StageSignals>): StageSignals => ({ ...capableDesktop, ...over });

describe("decideStage: the default", () => {
  it("a capable desktop gets 3D", () => {
    expect(decideStage(capableDesktop)).toMatchObject({ mode: "3d", canUse3d: true });
  });
  it("unknown cores and memory (the browser does not say) do not count against 3D", () => {
    expect(decideStage(sig({ cores: null, memoryGb: null })).mode).toBe("3d");
  });
  it("a narrow viewport gets 2D", () => {
    expect(decideStage(sig({ viewportWidth: MIN_3D_VIEWPORT_PX - 1 })).mode).toBe("2d");
    expect(decideStage(sig({ viewportWidth: MIN_3D_VIEWPORT_PX })).mode).toBe("3d");
    expect(decideStage(sig({ viewportWidth: 360 })).mode).toBe("2d");
  });
  it("a touch device (coarse pointer) gets 2D, even with a wide viewport", () => {
    expect(decideStage(sig({ coarsePointer: true, viewportWidth: 1366 })).mode).toBe("2d");
  });
  it("data saver gets 2D and says why", () => {
    const d = decideStage(sig({ saveData: true }));
    expect(d.mode).toBe("2d");
    expect(d.reason).toMatch(/data saver/i);
  });
  it("a low-power hint (few cores or little memory) gets 2D and says why", () => {
    for (const s of [sig({ cores: MIN_3D_CORES - 1 }), sig({ memoryGb: MIN_3D_MEMORY_GB - 1 })]) {
      const d = decideStage(s);
      expect(d.mode).toBe("2d");
      expect(d.reason).toMatch(/limited power/i);
      expect(d.canUse3d).toBe(true);
    }
    expect(lowPowerHint({ saveData: false, cores: MIN_3D_CORES, memoryGb: MIN_3D_MEMORY_GB })).toBe(false);
  });
});

describe("decideStage: the visitor's choice and failures", () => {
  it("an explicit 2D choice wins everywhere", () => {
    expect(decideStage(sig({ userChoice: "2d" })).mode).toBe("2d");
  });
  it("an explicit 3D choice wins over the default hints (phone, data saver, low power) when WebGL works", () => {
    expect(decideStage(sig({ userChoice: "3d", viewportWidth: 360, coarsePointer: true, saveData: true, cores: 2 })).mode).toBe("3d");
  });
  it("no WebGL: always 2D, and 3D is not offered, whatever was chosen", () => {
    for (const userChoice of [null, "2d", "3d"] as const) {
      const d = decideStage(sig({ webgl: false, userChoice }));
      expect(d).toMatchObject({ mode: "2d", canUse3d: false });
      expect(d.reason).toMatch(/WebGL/);
    }
  });
  it("a failed or lost context falls back to 2D for good, even against an explicit 3D choice", () => {
    const d = decideStage(sig({ contextFailed: true, userChoice: "3d" }));
    expect(d).toMatchObject({ mode: "2d", canUse3d: false });
    expect(d.reason).toMatch(/stopped/i);
  });
  it("before the browser has been probed the answer is 2D, nothing claimed", () => {
    expect(INITIAL_DECISION).toEqual({ mode: "2d", canUse3d: false, reason: null });
  });
  it("is deterministic: the same signals always give the same decision", () => {
    const s = sig({ cores: 6 });
    expect(decideStage(s)).toEqual(decideStage({ ...s }));
  });
});
