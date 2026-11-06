// The decision logic of the home page's FIG. 01 scenario reel (components/TimeToPower.tsx), kept free of React and the DOM so it can be tested.
//
// WCAG 2.2.2 (Pause, Stop, Hide) and 2.3.3 (Animation from Interactions):
//   - a visitor who prefers reduced motion gets no autoplay (they may still press Play),
//   - the reel can always be paused and resumed, and
//   - the first time the visitor changes an input the reel stops for good: it never resumes over what they typed.

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** playing: the reel advances; paused: it does not (the visitor, or their preference, said so); stopped: the visitor changed an input, for good. */
export type AutoplayMode = "playing" | "paused" | "stopped";

export type AutoplayAction =
  | { type: "mount"; reduced: boolean }
  | { type: "reduced_changed"; reduced: boolean }
  | { type: "pause" }
  | { type: "play" }
  | { type: "user_adjusted" };

/** Does the visitor ask for reduced motion? False when it cannot be read: the visible Pause control is then the way out. */
export function prefersReducedMotion(win: { matchMedia?: (query: string) => { matches: boolean } } | undefined): boolean {
  try {
    return Boolean(win?.matchMedia?.(REDUCED_MOTION_QUERY).matches);
  } catch {
    return false;
  }
}

export function autoplayReducer(mode: AutoplayMode, action: AutoplayAction): AutoplayMode {
  if (mode === "stopped") return "stopped"; // permanent: nothing restarts it
  switch (action.type) {
    case "user_adjusted":
      return "stopped";
    case "mount":
      return action.reduced ? "paused" : "playing";
    case "reduced_changed":
      return action.reduced ? "paused" : mode;
    case "pause":
      return "paused";
    case "play":
      return "playing";
  }
}
