// The headroom ladder as a figure: one row per step, in the order the engine relieves the limits, with the racks the hall carries after that step.
// Server-rendered SVG: no script, no animation. Every plotted value is in the table that follows the figure on the page (the caption says so),
// so the figure is never the only way to read it. The bar starts at zero; a thin mark shows the count before the step; a step that adds nothing
// is drawn as a short amber tick, not as an absent bar; a step the engine did not take is outlined, not filled. Meaning does not rest on colour
// alone: every row also carries its numbers as text.

export interface LadderBarStep {
  step: number;
  name: string;
  before: number;
  after: number;
  taken: boolean;
}

const W = 440;
const ROW = 42;
const PAD = 8;
const NUMBERS_W = 92;
const TOP = 6;

export function LadderBars({ steps, idPrefix, heading, eyebrow }: { steps: LadderBarStep[]; idPrefix: string; heading: string; eyebrow: string }) {
  const max = Math.max(1, ...steps.map((s) => s.after), ...steps.map((s) => s.before));
  const barW = W - PAD * 2 - NUMBERS_W;
  const x = (racks: number) => PAD + (racks / max) * barW;
  const H = TOP + steps.length * ROW + 4;
  const desc = steps
    .map((s) => `Step ${s.step}, ${s.name}: ${s.before} racks before, ${s.after} after${s.taken ? "" : " (not taken)"}.`)
    .join(" ");
  return (
    <figure className="panel p-4 sm:p-6">
      <figcaption className="mb-4 max-w-2xl">
        <div className="eyebrow mb-2">{eyebrow}</div>
        <h3 className="text-lg font-semibold text-ghost">{heading}</h3>
      </figcaption>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-labelledby={`${idPrefix}-t ${idPrefix}-d`} className="h-auto w-full max-w-xl" style={{ fontFamily: "var(--font-mono)" }}>
        <title id={`${idPrefix}-t`}>Racks the hall carries after each step of the headroom ladder</title>
        <desc id={`${idPrefix}-d`}>{desc}</desc>
        {steps.map((s, i) => {
          const y0 = TOP + i * ROW;
          const barY = y0 + 20;
          const flat = s.after === 0;
          return (
            <g key={s.step}>
              <text x={PAD} y={y0 + 13} fontSize={12} fill="#F5F7FA">{`${s.step}. ${s.name}`}</text>
              <line x1={PAD} x2={PAD + barW} y1={barY + 5} y2={barY + 5} stroke="#1E2942" strokeWidth={1} />
              {flat ? (
                <rect x={PAD} y={barY} width={4} height={10} fill="#FFB020" />
              ) : s.taken ? (
                <rect x={PAD} y={barY} width={Math.max(2, x(s.after) - PAD)} height={10} fill="#00E5FF" />
              ) : (
                <rect x={PAD + 0.5} y={barY + 0.5} width={Math.max(2, x(s.after) - PAD - 1)} height={9} fill="none" stroke="#00E5FF" strokeWidth={1} strokeDasharray="3 3" />
              )}
              {s.before > 0 ? <line x1={x(s.before)} x2={x(s.before)} y1={barY - 3} y2={barY + 13} stroke="#8A94A6" strokeWidth={2} /> : null}
              <text x={W - PAD} y={barY + 9} textAnchor="end" fontSize={12} fill="#8A94A6">{`${s.before} → ${s.after}`}</text>
            </g>
          );
        })}
      </svg>
      <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-[13px] text-mute" aria-label="Legend">
        <li><span aria-hidden className="mr-2 inline-block h-2.5 w-6 bg-power align-middle" />Racks after the step</li>
        <li><span aria-hidden className="mr-2 inline-block h-3 w-0.5 bg-mute align-middle" />Racks before it</li>
        <li><span aria-hidden className="mr-2 inline-block h-2.5 w-1 bg-queue align-middle" />Zero racks after the step</li>
        <li><span aria-hidden className="mr-2 inline-block h-2.5 w-6 border border-dashed border-power align-middle" />Next limit, not relieved in this example</li>
      </ul>
    </figure>
  );
}
