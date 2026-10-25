// Browser-side probes for the stage decision. Client only; every probe is wrapped, because any of them can throw in a
// locked-down or embedded browser, and a failed probe must mean "do not claim the capability".
import type { StageSignals } from "@/components/observatory/stage-mode";

/** Create and immediately release a WebGL context. Returns false on any failure. */
export function detectWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    const gl =
      (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return false;
    try {
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    } catch {
      /* the probe context is garbage anyway */
    }
    return true;
  } catch {
    return false;
  }
}

interface NetworkInformationLike {
  saveData?: boolean;
  effectiveType?: string;
}

export function readSignals(userChoice: StageSignals["userChoice"]): StageSignals {
  let saveData = false;
  let cores: number | null = null;
  let memoryGb: number | null = null;
  let coarsePointer = false;
  try {
    const nav = navigator as Navigator & { connection?: NetworkInformationLike; deviceMemory?: number };
    saveData = Boolean(nav.connection?.saveData) || nav.connection?.effectiveType === "slow-2g" || nav.connection?.effectiveType === "2g";
    cores = typeof nav.hardwareConcurrency === "number" && nav.hardwareConcurrency > 0 ? nav.hardwareConcurrency : null;
    memoryGb = typeof nav.deviceMemory === "number" && nav.deviceMemory > 0 ? nav.deviceMemory : null;
  } catch {
    /* unknown stays unknown */
  }
  try {
    coarsePointer = window.matchMedia("(pointer: coarse)").matches;
  } catch {
    /* unknown */
  }
  return {
    webgl: detectWebGL(),
    saveData,
    viewportWidth: typeof window !== "undefined" ? window.innerWidth : 0,
    coarsePointer,
    cores,
    memoryGb,
    userChoice,
    contextFailed: false,
  };
}

const KEY = "gf-observatory-view";
export function readStoredChoice(): "2d" | "3d" | null {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "2d" || v === "3d" ? v : null;
  } catch {
    return null;
  }
}
export function storeChoice(v: "2d" | "3d"): void {
  try {
    window.localStorage.setItem(KEY, v);
  } catch {
    /* a per-viewer convenience only */
  }
}
