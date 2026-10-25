// What both stages draw, derived from ONE SceneModel. Pure: no DOM, no three.js, so the 2D and 3D views cannot disagree
// about which stage binds, how full it is, or what a rack row looks like.
import type { PathNode, RackRow, SceneModel } from "@/lib/observatory/types";
import { utilisation, viewQuantity, weakestOf, type QuantityView } from "@/components/observatory/format";
import type { EvidenceClass } from "@/lib/observatory/types";

/** "Transformers (usable after redundancy and derating)" gives title "Transformers" and detail "usable after redundancy and derating". */
export function splitLabel(label: string): { title: string; detail: string | null } {
  const i = label.indexOf(" (");
  if (i <= 0) return { title: label, detail: null };
  const detail = label.slice(i + 1).trim().replace(/^\(/, "").replace(/\)$/, "").trim();
  return { title: label.slice(0, i).trim(), detail: detail || null };
}

export interface NodeVisual {
  id: string;
  kind: PathNode["kind"];
  /** The full label as the model gives it. */
  label: string;
  /** The short title (before the first parenthesis) and what the parenthesis said. */
  title: string;
  detail: string | null;
  index: number;
  capacity: QuantityView;
  found: QuantityView;
  after: QuantityView;
  /**
   * Load as found / capacity as found; null when not comparable (missing value, or different units). There is deliberately NO
   * after-plan ratio: the plan's reliefs raise capacities and the engine does not state a stage's capacity after the plan, so an
   * after-plan load divided by the as-found capacity would call a working design "over capacity".
   */
  utilFound: number | null;
  /** Load as found is above capacity as found (true only when both are known and comparable). */
  overFound: boolean;
  /** Evidence of the as-found ratio: the weakest of the two quantities it came from. */
  utilEvidence: EvidenceClass | null;
  bindsFound: boolean;
  bindsAfter: boolean;
}

export function nodeVisuals(model: SceneModel): NodeVisual[] {
  return model.nodes.map((n, index) => {
    const utilFound = utilisation(n.capacity, n.loadAsFound);
    return {
      id: n.id,
      kind: n.kind,
      label: n.label,
      title: splitLabel(n.label).title,
      detail: splitLabel(n.label).detail,
      index,
      capacity: viewQuantity(n.capacity),
      found: viewQuantity(n.loadAsFound),
      after: viewQuantity(n.loadAfterPlan),
      utilFound,
      overFound: utilFound !== null && utilFound > 1,
      utilEvidence: weakestOf([n.capacity, n.loadAsFound]),
      bindsFound: model.bindingAsFound === n.id,
      bindsAfter: model.bindingAfterPlan === n.id,
    };
  });
}

export const KIND_LABEL: Record<PathNode["kind"], string> = {
  utility: "Utility",
  transformer: "Transformer",
  switchgear: "Switchgear",
  ups: "UPS",
  busway: "Busway",
  rack_feed: "Rack feed",
  rack: "Racks",
  cooling: "Cooling",
};

/** Said wherever an after-plan load is shown: the reason there is no after-plan ratio, and why "over capacity" is never said of it. */
export const AFTER_PLAN_NOTE = "the engine does not state the stage's capacity after the plan";

export function bindingTag(v: Pick<NodeVisual, "bindsFound" | "bindsAfter">): string | null {
  if (v.bindsFound && v.bindsAfter) return "Binds as found and after the plan";
  if (v.bindsFound) return "Binds as found";
  if (v.bindsAfter) return "Binds after the plan";
  return null;
}

/** A boustrophedon grid: row 0 left to right, row 1 right to left, so consecutive stages are always adjacent. */
export interface GridSlot {
  index: number;
  row: number;
  col: number;
}
export function snakeSlots(n: number, cols: number): GridSlot[] {
  const out: GridSlot[] = [];
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / cols);
    const k = i % cols;
    out.push({ index: i, row, col: row % 2 === 0 ? k : cols - 1 - k });
  }
  return out;
}

/** Greedy word wrap to at most `lines` lines; the last line ends with an ellipsis if text was cut. */
export function wrapLabel(text: string, maxChars: number, lines = 2): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const all: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length <= maxChars || !cur) cur = next;
    else {
      all.push(cur);
      cur = w;
    }
  }
  if (cur) all.push(cur);
  if (all.length <= lines) return all.map((l) => (l.length > maxChars ? `${l.slice(0, maxChars - 1).trimEnd()}…` : l));
  const head = all.slice(0, lines - 1);
  const tail = all.slice(lines - 1).join(" ");
  head.push(tail.length > maxChars ? `${tail.slice(0, maxChars - 1).trimEnd()}…` : tail);
  return head;
}

// ---- rack rows ---------------------------------------------------------------------------------------------------

export interface RackRowVisual {
  id: string;
  label: string;
  racks: number;
  kwFound: number | null;
  kwAfter: number | null;
  /** 0..1 shading level against the densest value in the model; null when the density is unknown. */
  heatFound: number | null;
  heatAfter: number | null;
}

export function rackRowVisuals(rows: RackRow[]): RackRowVisual[] {
  let max = 0;
  for (const r of rows) {
    for (const v of [r.kwPerRackAsFound, r.kwPerRackAfterPlan]) if (v !== null && Number.isFinite(v) && v > max) max = v;
  }
  const level = (v: number | null) => (v === null || !Number.isFinite(v) || max <= 0 ? null : Math.max(0, Math.min(1, v / max)));
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    racks: r.racks,
    kwFound: r.kwPerRackAsFound,
    kwAfter: r.kwPerRackAfterPlan,
    heatFound: level(r.kwPerRackAsFound),
    heatAfter: level(r.kwPerRackAfterPlan),
  }));
}

/** How many squares to draw for `racks` racks and how many racks each stands for. */
export function rackSquares(racks: number, maxSquares: number): { squares: number; perSquare: number } {
  const n = Math.max(0, Math.floor(racks));
  if (n <= maxSquares) return { squares: n, perSquare: 1 };
  const perSquare = Math.ceil(n / maxSquares);
  return { squares: Math.ceil(n / perSquare), perSquare };
}

// The low end is #2A6C9C (3.2:1 against the card, #0E1524) so even the least dense square is a visible mark, not a hole.
const LOW: [number, number, number] = [0x2a, 0x6c, 0x9c];
const HIGH: [number, number, number] = [0x00, 0xe5, 0xff];
/** One-hue sequential ramp from a dark teal to the site's power cyan. Unknown density is a neutral grey. */
export function heatRgb(t: number | null): [number, number, number] {
  if (t === null) return [0x4a, 0x55, 0x68];
  const k = Math.max(0, Math.min(1, t));
  return [0, 1, 2].map((i) => Math.round(LOW[i] + (HIGH[i] - LOW[i]) * k)) as [number, number, number];
}
export function heatCss(t: number | null): string {
  const [r, g, b] = heatRgb(t);
  return `rgb(${r},${g},${b})`;
}
export function heatHex(t: number | null): number {
  const [r, g, b] = heatRgb(t);
  return (r << 16) | (g << 8) | b;
}
