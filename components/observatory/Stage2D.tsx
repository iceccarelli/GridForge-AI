"use client";

// The 2D stage: an inline-SVG single-line diagram of the SAME SceneModel the 3D view draws. Two layouts are rendered and
// switched with CSS (so there is no hydration mismatch and no layout shift): a 4-column snake at md and up, a 2-column snake
// below. The hidden one is display:none, so it is neither focusable nor in the accessibility tree.
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
}
const WIDE: Dim = { W: 720, cols: 4, cardW: 165, gapX: 20, cardH: 134, gapY: 28, maxChars: 21, maxSquares: 54 };
const NARROW: Dim = { W: 300, cols: 2, cardW: 144, gapX: 12, cardH: 134, gapY: 28, maxChars: 17, maxSquares: 22 };

const PAD_TOP = 18;
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

function evidenceFill(c: string): string {
  const n = Number(c.slice(1));
  return n <= 1 ? COLOR.queue : COLOR.power;
}

function nodeAriaLabel(v: NodeVisual): string {
  const q = (name: string, x: NodeVisual["capacity"]) =>
    x.known ? `${name} ${x.text}, evidence ${x.evidence}.` : `${name} ${x.text}${x.missing ? ` (${x.missing})` : ""}.`;
  const tag = bindingTag(v);
  return `${KIND_LABEL[v.kind]}: ${v.label}. ${q("Capacity", v.capacity)} ${q("Load as found", v.found)} ${q("Load after the plan", v.after)}${(v.utilFound ?? 0) > 1 || (v.utilAfter ?? 0) > 1 ? " Load exceeds capacity." : ""}${tag ? ` ${tag}.` : ""}`;
}

function Diagram({ dim, variant, model, selectedId, onSelect, describedBy, className }: Props & { dim: Dim; variant: "wide" | "narrow"; className: string }) {
  const visuals = nodeVisuals(model);
  const slots = snakeSlots(visuals.length, dim.cols);
  const rows = Math.max(1, Math.ceil(visuals.length / dim.cols));
  const cardsBottom = PAD_TOP + rows * dim.cardH + (rows - 1) * dim.gapY;
  const rackRows = rackRowVisuals(model.rackRows);
  const rackTop = cardsBottom + 34;
  // Rack rows keep their full label (it says things like "design density, not measured"), wrapped to at most three lines.
  const labelMax = dim.W > 400 ? 62 : 32;
  let ry = rackTop + 20;
  const rackLayout = rackRows.map((r) => {
    const lines = wrapLabel(r.label, labelMax, 3);
    const sq = rackSquares(r.racks, dim.maxSquares);
    const stripY = (lines.length - 1) * 14 + 9;
    const textY = stripY + 38;
    const y = ry;
    ry += textY + (sq.perSquare > 1 ? 12 : 0) + 20;
    return { r, lines, sq, y, stripY, textY };
  });
  const legendTop = ry + 6;
  const H = legendTop + 44;
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

  return (
    <svg
      viewBox={`0 0 ${dim.W} ${H}`}
      className={className}
      role="group"
      aria-label="Power path, 2D diagram: one card per stage from the utility to the racks. Select a stage for its detail."
      aria-describedby={describedBy}
      preserveAspectRatio="xMidYMin meet"
      style={{ fontFamily: "var(--font-sans), system-ui, sans-serif" }}
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
        const stroke = v.bindsFound ? COLOR.queue : v.bindsAfter ? COLOR.power : selected ? COLOR.power : COLOR.line;
        const tag = v.bindsFound && v.bindsAfter ? "BINDS: FOUND + AFTER" : v.bindsFound ? "BINDS AS FOUND" : v.bindsAfter ? "BINDS AFTER PLAN" : null;
        const pillW = tag ? Math.min(w - 4, tag.length * 6 + 12) : 0;
        const label = wrapLabel(v.title, dim.maxChars, 2);
        const bar = (frac: number | null, yy: number, fill: string) => {
          const fw = frac === null ? 0 : Math.min(1, Math.max(0, frac)) * innerW;
          return (
            <g>
              <rect x={10} y={yy} width={innerW} height={6} rx={3} fill={COLOR.ink} stroke={COLOR.line} strokeWidth={0.75} strokeDasharray={frac === null ? "3 2" : undefined} />
              {frac !== null ? <rect x={10} y={yy} width={fw} height={6} rx={3} fill={frac > 1 ? COLOR.flag : fill} /> : null}
            </g>
          );
        };
        const line = (yy: number, name: string, q: NodeVisual["capacity"]) => (
          <g>
            <text x={10} y={yy} fontSize={10.5} fontFamily="var(--font-mono), monospace" fill={COLOR.mute}>
              {name}
            </text>
            <text x={name === "Cap" ? 34 : 44} y={yy} fontSize={10.5} fontFamily="var(--font-mono), monospace" fill={q.known ? COLOR.ghost : COLOR.mute}>
              {q.text}
            </text>
            {q.evidence ? (
              <text x={w - 10} y={yy} textAnchor="end" fontSize={10} fontWeight={700} fontFamily="var(--font-mono), monospace" fill={evidenceFill(q.evidence)}>
                {q.evidence}
              </text>
            ) : null}
          </g>
        );
        return (
          <g
            key={v.id}
            transform={`translate(${x} ${y})`}
            role="button"
            tabIndex={0}
            aria-pressed={selected}
            aria-label={nodeAriaLabel(v)}
            data-node={v.id}
            className="group cursor-pointer outline-none"
            onClick={() => onSelect(v.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(v.id);
              }
            }}
          >
            <rect x={-5} y={-5} width={w + 10} height={h + 10} rx={13} fill="none" stroke="#FFFFFF" strokeWidth={2.5} className="opacity-0 group-focus-visible:opacity-100" />
            <rect width={w} height={h} rx={10} fill={selected ? COLOR.cardSelected : COLOR.card} stroke={stroke} strokeWidth={bind ? 2.5 : selected ? 2 : 1} />
            <text x={10} y={18} fontSize={9.5} letterSpacing="0.12em" fontFamily="var(--font-mono), monospace" fill={COLOR.mute}>
              {KIND_LABEL[v.kind].toUpperCase()}
            </text>
            {(v.utilFound ?? 0) > 1 || (v.utilAfter ?? 0) > 1 ? (
              <text x={w - 10} y={58} textAnchor="end" fontSize={9} fontWeight={700} letterSpacing="0.06em" fontFamily="var(--font-mono), monospace" fill={COLOR.flag}>
                OVER CAPACITY
              </text>
            ) : null}
            {label.map((l, k) => (
              <text key={k} x={10} y={34 + k * 14} fontSize={12.5} fontWeight={600} fill={COLOR.ghost}>
                {l}
              </text>
            ))}
            {bar(v.utilFound, 62, COLOR.found)}
            {bar(v.utilAfter, 72, COLOR.power)}
            {line(96, "Cap", v.capacity)}
            {line(110, "Found", v.found)}
            {line(124, "After", v.after)}
            {tag ? (
              <g transform={`translate(${w - pillW - 6} -9)`}>
                <rect width={pillW} height={16} rx={8} fill={v.bindsFound ? COLOR.queue : COLOR.power} />
                <text x={pillW / 2} y={11.5} textAnchor="middle" fontSize={9} fontWeight={700} fontFamily="var(--font-mono), monospace" fill={COLOR.ink}>
                  {tag}
                </text>
              </g>
            ) : null}
          </g>
        );
      })}

      <text x={0} y={rackTop} fontSize={10} letterSpacing="0.14em" fontFamily="var(--font-mono), monospace" fill={COLOR.mute}>
        RACK ROWS · SYNTHETIC HALL
      </text>
      {rackLayout.map(({ r, lines, sq, y, stripY, textY }) => {
        const s = 9;
        const g = 3;
        const strip = (heat: number | null, yy: number) =>
          Array.from({ length: sq.squares }, (_, k) => <rect key={k} x={k * (s + g)} y={yy} width={s} height={8} rx={1.5} fill={heatCss(heat)} />);
        const kw = (v: number | null) => (v === null ? "not stated" : `${fmtNumber(v)} kW`);
        return (
          <g key={r.id} transform={`translate(0 ${y})`}>
            {lines.map((l, k) => (
              <text key={k} x={0} y={k * 14} fontSize={12} fontWeight={600} fill={COLOR.ghost}>
                {l}
              </text>
            ))}
            <text x={dim.W} y={0} textAnchor="end" fontSize={11} fontFamily="var(--font-mono), monospace" fill={COLOR.mute}>
              {fmtNumber(r.racks)} racks
            </text>
            <g transform={`translate(0 ${stripY})`}>{strip(r.heatFound, 0)}</g>
            <g transform={`translate(0 ${stripY + 11})`}>{strip(r.heatAfter, 0)}</g>
            <text x={0} y={textY} fontSize={10} fontFamily="var(--font-mono), monospace" fill={COLOR.mute}>
              {`kW per rack: found ${kw(r.kwFound)} · after plan ${kw(r.kwAfter)}`}
            </text>
            {sq.perSquare > 1 ? (
              <text x={0} y={textY + 12} fontSize={10} fontFamily="var(--font-mono), monospace" fill={COLOR.mute}>
                {`1 square = ${sq.perSquare} racks`}
              </text>
            ) : null}
          </g>
        );
      })}
      <g transform={`translate(0 ${legendTop})`}>
        <text x={0} y={0} fontSize={10} fontFamily="var(--font-mono), monospace" fill={COLOR.mute}>
          Strips and card bars: upper = as found,
        </text>
        <text x={0} y={13} fontSize={10} fontFamily="var(--font-mono), monospace" fill={COLOR.mute}>
          lower = after the plan.
        </text>
        {[0, 0.25, 0.5, 0.75, 1].map((t, k) => (
          <rect key={k} x={k * 14} y={22} width={12} height={8} rx={1.5} fill={heatCss(t)} />
        ))}
        <text x={80} y={30} fontSize={10} fontFamily="var(--font-mono), monospace" fill={COLOR.mute}>
          kW per rack: lower to higher
        </text>
      </g>
    </svg>
  );
}

export function Stage2D(props: Props) {
  return (
    <div className="h-full w-full" data-stage="2d">
      <Diagram {...props} dim={WIDE} variant="wide" className="hidden h-full w-full md:block" />
      <Diagram {...props} dim={NARROW} variant="narrow" className="mx-auto block h-auto w-full max-w-[420px] md:hidden" />
    </div>
  );
}
