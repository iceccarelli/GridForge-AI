"use client";

// The 2D stage: an inline-SVG single-line diagram of the SAME SceneModel the 3D view draws.
//
// Interactive (the page): two layouts are rendered and switched with CSS (so there is no hydration mismatch and no layout shift),
// a 4-column snake at md and up and a 2-column snake below; the hidden one is display:none, so it is neither focusable nor in the
// accessibility tree. Stage2DPresenter is the READ-ONLY landscape variant for the broadcast frame: a plain image with a label, no
// roles, no tab stops, no handlers.
//
// What a card says, and what it never says: the bar is load as found against capacity as found. The plan's reliefs raise
// capacities and the engine does not state a stage's capacity after the plan, so the after-plan load is shown as a plain figure
// ("After") and never as a ratio, and nothing here ever calls a stage "over capacity" because of it.
import { bindingTag, heatCss, nodeVisuals, rackRowVisuals, rackSquares, snakeSlots, wrapLabel, KIND_LABEL, type NodeVisual } from "@/components/observatory/scene-visuals";
import type { SceneModel } from "@/lib/observatory/types";
import { fmtNumber } from "@/components/observatory/format";

interface Props {
  model: SceneModel;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Id of the element holding the full text description. */
  describedBy?: string;
}

interface Dim {
  W: number;
  cols: number;
  cardW: number;
  gapX: number;
  cardH: number;
  gapY: number;
  maxChars: number;
  maxSquares: number;
  labelMax: number;
  /** Presenter: tighter rack block and a one-line legend. */
  compact: boolean;
}
const WIDE: Dim = { W: 720, cols: 4, cardW: 165, gapX: 20, cardH: 122, gapY: 26, maxChars: 20, maxSquares: 54, labelMax: 62, compact: false };
const NARROW: Dim = { W: 300, cols: 2, cardW: 144, gapX: 12, cardH: 122, gapY: 26, maxChars: 16, maxSquares: 22, labelMax: 32, compact: false };
const PRESENTER: Dim = { W: 760, cols: 5, cardW: 144, gapX: 10, cardH: 122, gapY: 20, maxChars: 17, maxSquares: 64, labelMax: 74, compact: true };

const PAD_TOP = 16;
const COLOR = {
  card: "#0E1524",
  cardSelected: "#131C2E",
  line: "#2A3650",
  ghost: "#F5F7FA",
  mute: "#8A94A6",
  power: "#00E5FF",
  queue: "#FFB020",
  flag: "#F87171",
  found: "#1193A8",
  ink: "#070B14",
};
const MONO = "var(--font-mono), monospace";

function evidenceFill(c: string): string {
  const n = Number(c.slice(1));
  return n <= 1 ? COLOR.queue : COLOR.power;
}

function nodeAriaLabel(v: NodeVisual): string {
  const q = (name: string, x: NodeVisual["capacity"]) =>
    x.known ? `${name} ${x.text}, evidence ${x.evidence}.` : `${name} ${x.text}${x.missing ? ` (${x.missing})` : ""}.`;
  const tag = bindingTag(v);
  return `${KIND_LABEL[v.kind]}: ${v.label}. ${q("Capacity as found", v.capacity)} ${q("Load as found", v.found)} ${q("Load after the plan", v.after)}${v.overFound ? " Load as found exceeds capacity as found." : ""}${tag ? ` ${tag}.` : ""}`;
}

/** A figure for a card line: the value, or "n/a" (the reason is in the aria label and the tables). */
const short = (q: NodeVisual["capacity"]) => (q.known ? q.text : "n/a");

interface DiagramProps extends Props {
  dim: Dim;
  variant: "wide" | "narrow" | "presenter";
  className: string;
  interactive: boolean;
}

function Diagram({ dim, variant, model, selectedId, onSelect, describedBy, className, interactive }: DiagramProps) {
  const visuals = nodeVisuals(model);
  const slots = snakeSlots(visuals.length, dim.cols);
  const rows = Math.max(1, Math.ceil(visuals.length / dim.cols));
  const cardsBottom = PAD_TOP + rows * dim.cardH + (rows - 1) * dim.gapY;
  const rackRows = rackRowVisuals(model.rackRows);
  const rackTop = cardsBottom + (dim.compact ? 26 : 34);
  // Rack rows keep their full label (it says things like "design density, not measured"), wrapped to at most three lines.
  let ry = rackTop + (dim.compact ? 18 : 20);
  const rackLayout = rackRows.map((r) => {
    const lines = wrapLabel(r.label, dim.labelMax, 3);
    const sq = rackSquares(r.racks, dim.maxSquares);
    const stripY = (lines.length - 1) * 14 + 9;
    const textY = stripY + (dim.compact ? 36 : 38);
    const y = ry;
    ry += textY + (sq.perSquare > 1 && !dim.compact ? 12 : 0) + (dim.compact ? 14 : 20);
    return { r, lines, sq, y, stripY, textY };
  });
  const legendTop = ry + (dim.compact ? 2 : 6);
  const H = legendTop + (dim.compact ? 14 : 80);
  const idp = `s2d-${variant}`;
  const pos = (i: number) => ({
    x: slots[i].col * (dim.cardW + dim.gapX),
    y: PAD_TOP + slots[i].row * (dim.cardH + dim.gapY),
  });

  const connectors = visuals.slice(1).map((v, i) => {
    const a = pos(i);
    const b = pos(i + 1);
    const dashed = v.kind === "cooling";
    let d: string;
    if (a.y === b.y) {
      const y = a.y + dim.cardH / 2;
      d = b.x > a.x ? `M${a.x + dim.cardW} ${y} L${b.x - 2} ${y}` : `M${a.x} ${y} L${b.x + dim.cardW + 2} ${y}`;
    } else {
      const x = a.x + dim.cardW / 2;
      d = `M${x} ${a.y + dim.cardH} L${x} ${b.y - 2}`;
    }
    return <path key={v.id} d={d} fill="none" stroke={COLOR.mute} strokeWidth={1.5} strokeDasharray={dashed ? "4 3" : undefined} markerEnd={`url(#${idp}-arrow)`} />;
  });

  const a11y = interactive
    ? {
        role: "group" as const,
        "aria-label": "Power path, 2D diagram: one card per stage from the utility to the racks. Select a stage for its detail.",
        "aria-describedby": describedBy,
      }
    : {
        role: "img" as const,
        "aria-label": "Power path diagram: one card per stage from the utility to the racks, then the rack rows. The stage that binds is marked.",
      };

  return (
    <svg
      viewBox={`0 0 ${dim.W} ${H}`}
      className={className}
      {...a11y}
      preserveAspectRatio="xMidYMin meet"
      style={{ fontFamily: "var(--font-sans), system-ui, sans-serif" }}
      data-viewbox-w={dim.W}
      data-viewbox-h={H}
    >
      <defs>
        <marker id={`${idp}-arrow`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 L8 4 L0 8 z" fill={COLOR.mute} />
        </marker>
      </defs>
      {connectors}
      {visuals.map((v, i) => {
        const { x, y } = pos(i);
        const w = dim.cardW;
        const h = dim.cardH;
        const selected = selectedId === v.id;
        const innerW = w - 20;
        const bind = v.bindsFound || v.bindsAfter;
        // Binding is the engine's call and is drawn in amber (as found) or cyan (after the plan). "Selected" is a separate white
        // inner ring, so the two can never be mistaken for each other.
        const stroke = v.bindsFound ? COLOR.queue : v.bindsAfter ? COLOR.power : COLOR.line;
        const tag = v.bindsFound && v.bindsAfter ? "BINDS: FOUND + AFTER" : v.bindsFound ? "BINDS AS FOUND" : v.bindsAfter ? "BINDS AFTER PLAN" : null;
        const pillW = tag ? Math.min(w - 4, tag.length * 6.4 + 14) : 0;
        const label = wrapLabel(v.title, dim.maxChars, 2);
        const frac = v.utilFound;
        const fw = frac === null ? 0 : Math.min(1, Math.max(0, frac)) * innerW;
        const line = (yy: number, name: string, q: NodeVisual["capacity"]) => (
          <g>
            <text x={10} y={yy} fontSize={11.5} fontFamily={MONO} fill={COLOR.mute}>
              {name}
            </text>
            <text x={50} y={yy} fontSize={11.5} fontFamily={MONO} fill={q.known ? COLOR.ghost : COLOR.mute}>
              {short(q)}
            </text>
            {q.evidence ? (
              <text x={w - 10} y={yy} textAnchor="end" fontSize={11} fontWeight={700} fontFamily={MONO} fill={evidenceFill(q.evidence)}>
                {q.evidence}
              </text>
            ) : null}
          </g>
        );
        const interact = interactive
          ? {
              role: "button" as const,
              tabIndex: 0,
              "aria-pressed": selected,
              "aria-label": nodeAriaLabel(v),
              className: "group cursor-pointer outline-none",
              onClick: () => onSelect(v.id),
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelect(v.id);
                }
              },
            }
          : {};
        return (
          <g key={v.id} transform={`translate(${x} ${y})`} data-node={v.id} {...interact}>
            {interactive ? (
              <rect x={-5} y={-5} width={w + 10} height={h + 10} rx={13} fill="none" stroke="#FFFFFF" strokeWidth={2.5} className="opacity-0 group-focus-visible:opacity-100" />
            ) : null}
            <rect width={w} height={h} rx={10} fill={selected ? COLOR.cardSelected : COLOR.card} stroke={stroke} strokeWidth={bind ? 2.5 : 1} />
            {selected ? <rect x={4} y={4} width={w - 8} height={h - 8} rx={7} fill="none" stroke="#FFFFFF" strokeWidth={1.5} /> : null}
            <text x={10} y={19} fontSize={10.5} letterSpacing="0.1em" fontFamily={MONO} fill={COLOR.mute}>
              {KIND_LABEL[v.kind].toUpperCase()}
            </text>
            {label.map((l, k) => (
              <text key={k} x={10} y={36 + k * 14} fontSize={13} fontWeight={600} fill={COLOR.ghost}>
                {l}
              </text>
            ))}
            {v.overFound ? (
              <text x={w - 10} y={60} textAnchor="end" fontSize={10} fontWeight={700} fontFamily={MONO} fill={COLOR.flag}>
                OVER AS FOUND
              </text>
            ) : null}
            <rect x={10} y={64} width={innerW} height={8} rx={4} fill={COLOR.ink} stroke={COLOR.line} strokeWidth={0.75} strokeDasharray={frac === null ? "3 2" : undefined} />
            {frac !== null ? <rect x={10} y={64} width={fw} height={8} rx={4} fill={frac > 1 ? COLOR.flag : COLOR.found} /> : null}
            {line(88, "Cap", v.capacity)}
            {line(102, "Found", v.found)}
            {line(116, "After", v.after)}
            {tag ? (
              <g transform={`translate(${w - pillW - 6} -9)`}>
                <rect width={pillW} height={17} rx={8.5} fill={v.bindsFound ? COLOR.queue : COLOR.power} />
                <text x={pillW / 2} y={12} textAnchor="middle" fontSize={10} fontWeight={700} fontFamily={MONO} fill={COLOR.ink}>
                  {tag}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}

      <text x={0} y={rackTop} fontSize={10.5} letterSpacing="0.12em" fontFamily={MONO} fill={COLOR.mute}>
        RACK ROWS · SYNTHETIC HALL
      </text>
      {rackLayout.map(({ r, lines, sq, y, stripY, textY }) => {
        const s = 9;
        const g = 3;
        const strip = (heat: number | null, yy: number) =>
          Array.from({ length: sq.squares }, (_, k) => <rect key={k} x={k * (s + g)} y={yy} width={s} height={8} rx={1.5} fill={heatCss(heat)} />);
        const kw = (v: number | null) => (v === null ? "none" : `${fmtNumber(v)} kW`);
        return (
          <g key={r.id} transform={`translate(0 ${y})`}>
            {lines.map((l, k) => (
              <text key={k} x={0} y={k * 14} fontSize={12.5} fontWeight={600} fill={COLOR.ghost}>
                {l}
              </text>
            ))}
            <text x={dim.W} y={0} textAnchor="end" fontSize={11.5} fontFamily={MONO} fill={COLOR.mute}>
              {fmtNumber(r.racks)} racks
            </text>
            <g transform={`translate(0 ${stripY})`}>{strip(r.heatFound, 0)}</g>
            <g transform={`translate(0 ${stripY + 11})`}>{strip(r.heatAfter, 0)}</g>
            <text x={0} y={textY} fontSize={11} fontFamily={MONO} fill={COLOR.mute}>
              {`kW per rack: found ${kw(r.kwFound)} · after plan ${kw(r.kwAfter)}${sq.perSquare > 1 && dim.compact ? ` · 1 square = ${sq.perSquare} racks` : ""}`}
            </text>
            {sq.perSquare > 1 && !dim.compact ? (
              <text x={0} y={textY + 12} fontSize={11} fontFamily={MONO} fill={COLOR.mute}>
                {`1 square = ${sq.perSquare} racks`}
              </text>
            ) : null}
          </g>
        );
      })}
      {dim.compact ? (
        <text x={0} y={legendTop + 10} fontSize={10.5} fontFamily={MONO} fill={COLOR.mute}>
          Bar: load as found against capacity as found. After: load after the plan (its capacity is not stated). Strips: upper as found, lower after.
        </text>
      ) : (
        <g transform={`translate(0 ${legendTop})`}>
          {[
            "Bar: load as found against capacity as found.",
            "After: load after the plan. The engine does not",
            "state a stage's capacity after the plan, so no",
            "after-plan ratio is drawn.",
            "Rack strips: upper = as found, lower = after.",
          ].map((t, k) => (
            <text key={k} x={0} y={k * 13} fontSize={10.5} fontFamily={MONO} fill={COLOR.mute}>
              {t}
            </text>
          ))}
          {[0, 0.25, 0.5, 0.75, 1].map((t, k) => (
            <rect key={k} x={k * 14} y={70} width={12} height={8} rx={1.5} fill={heatCss(t)} />
          ))}
          <text x={80} y={78} fontSize={10.5} fontFamily={MONO} fill={COLOR.mute}>
            kW per rack: lower to higher
          </text>
        </g>
      )}
    </svg>
  );
}

export function Stage2D(props: Props) {
  return (
    <div className="h-full w-full" data-stage="2d">
      <Diagram {...props} dim={WIDE} variant="wide" interactive className="hidden h-full w-full md:block" />
      <Diagram {...props} dim={NARROW} variant="narrow" interactive className="mx-auto block h-auto w-full max-w-[420px] md:hidden" />
    </div>
  );
}

/** Read-only, landscape: the broadcast frame's diagram. No roles, tab stops or handlers; one image with a plain label. */
export function Stage2DPresenter({ model, focusId }: { model: SceneModel; focusId: string | null }) {
  return (
    <div className="h-full w-full" data-stage="2d-presenter">
      <Diagram model={model} selectedId={focusId} onSelect={() => {}} dim={PRESENTER} variant="presenter" interactive={false} className="block h-full w-full" />
    </div>
  );
}
