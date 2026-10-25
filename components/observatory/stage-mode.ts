// Which stage to show: the 3D scene or the 2D diagram. Pure, so the rule is testable and the same everywhere.
//
// The 3D bundle (three.js) is downloaded ONLY when this returns "3d". The default is 2D unless the device looks capable,
// and the visitor's own choice always wins, except when 3D cannot run at all.

export interface StageSignals {
  /** A WebGL context could be created in a probe. */
  webgl: boolean;
  /** navigator.connection.saveData, or a 2g-class connection. */
  saveData: boolean;
  /** window.innerWidth in CSS px. */
  viewportWidth: number;
  /** (pointer: coarse): a phone or tablet. */
  coarsePointer: boolean;
  /** navigator.hardwareConcurrency, when the browser reports it. */
  cores: number | null;
  /** navigator.deviceMemory in GB, when the browser reports it. */
  memoryGb: number | null;
  /** The visitor pressed the 2D / 3D toggle. */
  userChoice: "2d" | "3d" | null;
  /** WebGL context creation failed, or the context was lost, after we tried 3D. */
  contextFailed: boolean;
}

export type StageMode = "2d" | "3d";

export interface StageDecision {
  mode: StageMode;
  /** Whether the 3D choice is offered at all (false when WebGL is missing or has failed). */
  canUse3d: boolean;
  /** Plain words for the visible note; null when there is nothing to say. */
  reason: string | null;
}

export const MIN_3D_VIEWPORT_PX = 900;
export const MIN_3D_CORES = 4;
export const MIN_3D_MEMORY_GB = 4;

/** True when the device hints it should not be asked to render a 3D scene by default. */
export function lowPowerHint(s: Pick<StageSignals, "saveData" | "cores" | "memoryGb">): boolean {
  if (s.saveData) return true;
  if (s.cores !== null && s.cores < MIN_3D_CORES) return true;
  if (s.memoryGb !== null && s.memoryGb < MIN_3D_MEMORY_GB) return true;
  return false;
}

export function decideStage(s: StageSignals): StageDecision {
  if (s.contextFailed) {
    return { mode: "2d", canUse3d: false, reason: "The 3D view stopped (the graphics context failed or was lost), so the 2D view is shown." };
  }
  if (!s.webgl) {
    return { mode: "2d", canUse3d: false, reason: "3D needs WebGL, which this browser does not provide here, so the 2D view is shown." };
  }
  if (s.userChoice === "2d") return { mode: "2d", canUse3d: true, reason: null };
  if (s.userChoice === "3d") return { mode: "3d", canUse3d: true, reason: null };
  if (s.saveData) return { mode: "2d", canUse3d: true, reason: "Data saver is on, so the lighter 2D view is shown. Choose 3D to load it." };
  if (s.viewportWidth < MIN_3D_VIEWPORT_PX) return { mode: "2d", canUse3d: true, reason: null };
  if (s.coarsePointer) return { mode: "2d", canUse3d: true, reason: null };
  if (lowPowerHint(s)) return { mode: "2d", canUse3d: true, reason: "This device reports limited power, so the lighter 2D view is shown. Choose 3D to load it." };
  return { mode: "3d", canUse3d: true, reason: null };
}

/** Before the browser has been probed (server render, first paint): 2D, nothing downloaded, nothing claimed. */
export const INITIAL_DECISION: StageDecision = { mode: "2d", canUse3d: false, reason: null };
